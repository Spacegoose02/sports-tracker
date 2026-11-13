const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub node-fetch before anything loads it, so these tests never hit ESPN.
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-stats-'));
const calls = [];
let responses = () => ({});
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch',
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: async (url) => {
    calls.push(String(url));
    const body = responses(String(url));
    if (body === 404) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const express = require('express');
const players = require('../src/players');
const leaders = require('../src/leaders');
const espn = require('../src/espn');
const { resolveSport } = require('../src/sports');

async function withApi(fn) {
  const app = express();
  app.use('/api', require('../src/routes/stats'));
  app.use('/api', require('../src/routes/api'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const athlete = (id, name, extra = {}) => ({
  id, displayName: name, jersey: '2', position: { abbreviation: 'QB', displayName: 'Quarterback' },
  displayHeight: "6' 2\"", displayWeight: '215 lbs', headshot: { href: `https://a.espncdn.com/${id}.png` }, ...extra,
});

test('football rosters keep their position groups, other sports come as one list', () => {
  const grouped = players.parseRoster({
    athletes: [
      { position: 'offense', items: [athlete('1', 'Kyron Drones', { experience: { years: 3, displayValue: 'Junior' }, birthPlace: { city: 'Houston', state: 'TX' } })] },
      { position: 'defense', items: [athlete('2', 'Some Linebacker', { injuries: [{ status: 'Out' }] })] },
      { position: 'specialTeam', items: [] },
    ],
    coach: [{ firstName: 'Brent', lastName: 'Pry' }],
  });
  assert.deepStrictEqual(grouped.groups.map((g) => g.name), ['Offense', 'Defense']);
  assert.strictEqual(grouped.coach, 'Brent Pry');
  const qb = grouped.groups[0].athletes[0];
  assert.strictEqual(qb.experience, 'Junior');
  assert.strictEqual(qb.hometown, 'Houston, TX');
  assert.strictEqual(qb.position, 'QB');
  assert.strictEqual(grouped.groups[1].athletes[0].injury, 'Out');

  const flat = players.parseRoster({ athletes: [athlete('3', 'Jalen Brunson', { experience: { years: 0 } })] });
  assert.strictEqual(flat.groups.length, 1);
  assert.strictEqual(flat.groups[0].athletes[0].experience, 'Rookie');
});

test('career stats become one table per category, game log is newest first', () => {
  const career = players.parseCareerStats({
    teams: { 259: { abbreviation: 'VT' } },
    categories: [
      { displayName: 'Passing', labels: ['GP', 'YDS', 'TD'], statistics: [{ season: { year: 2025, displayName: '2025' }, teamId: '259', stats: ['12', '2,400', 18] }], totals: ['12', '2,400', '18'] },
      { displayName: 'Empty', labels: [], statistics: [] },
    ],
  });
  assert.strictEqual(career.length, 1);
  assert.deepStrictEqual(career[0].rows[0], { season: '2025', teamId: '259', team: 'VT', stats: ['12', '2,400', '18'] });
  assert.deepStrictEqual(career[0].totals, ['12', '2,400', '18']);

  const log = players.parseGameLog({
    labels: ['CMP', 'YDS'],
    events: {
      10: { gameDate: '2026-09-01T00:00Z', atVs: 'vs', gameResult: 'W', score: '31-10', opponent: { id: '99', abbreviation: 'ODU', displayName: 'Old Dominion' } },
      11: { gameDate: '2026-09-08T00:00Z', atVs: '@', gameResult: 'L', score: '17-20', opponent: { id: '98', abbreviation: 'UVA' } },
    },
    seasonTypes: [{ displayName: '2026 Regular Season', categories: [{ events: [{ eventId: '10', stats: ['20', '250'] }, { eventId: '11', stats: ['15', '180'] }] }] }],
  });
  assert.deepStrictEqual(log.labels, ['CMP', 'YDS']);
  assert.deepStrictEqual(log.games.map((g) => g.eventId), ['11', '10']);
  assert.strictEqual(log.games[0].opponent.abbreviation, 'UVA');
});

test('player route returns bio even when stats and game log are missing', async () => {
  responses = (url) => {
    if (url.endsWith('/athletes/4567')) return { athlete: athlete('4567', 'Test Player', { team: { id: '259', displayName: 'Virginia Tech Hokies', color: '630031', logos: [{ href: 'https://x/vt.png' }] } }) };
    return 404;
  };
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/player/4567?sport=cfb`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.player.name, 'Test Player');
    assert.strictEqual(body.player.team.color, '#630031');
    assert.deepStrictEqual(body.careerStats, []);
    assert.deepStrictEqual(body.gameLog.games, []);
    assert.ok(calls.some((u) => u.startsWith('https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/4567')));

    assert.strictEqual((await fetch(`${base}/api/player/..%2Fx`)).status, 400);
    assert.strictEqual((await fetch(`${base}/api/team/52/roster?sport=ufc`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/player/1?sport=curling`)).status, 400);
  });
});

test('roster route uses the sport path', async () => {
  responses = (url) => (url.includes('/roster') ? { athletes: [athlete('5', 'Jayson Tatum')] } : {});
  await withApi(async (base) => {
    const body = await (await fetch(`${base}/api/team/2/roster?sport=nba`)).json();
    assert.strictEqual(body.groups[0].athletes[0].name, 'Jayson Tatum');
    assert.ok(calls.some((u) => u === 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster'));
  });
});

test('stat leaders parse with team from the leader or the athlete', () => {
  const cats = leaders.parseLeaders({
    leaders: {
      categories: [
        {
          name: 'passingYards',
          displayName: 'Passing Yards',
          leaders: [
            { displayValue: '2,801', athlete: { id: '1', displayName: 'QB One', position: { abbreviation: 'QB' } }, team: { id: '12', abbreviation: 'KC' } },
            { displayValue: '2,700', athlete: { id: '2', displayName: 'QB Two', team: { id: '13', abbreviation: 'LV' } } },
            { displayValue: '1', athlete: {} },
          ],
        },
        { name: 'empty', leaders: [] },
      ],
    },
  });
  assert.strictEqual(cats.length, 1);
  assert.strictEqual(cats[0].leaders.length, 2);
  assert.strictEqual(cats[0].leaders[0].team.abbreviation, 'KC');
  assert.strictEqual(cats[0].leaders[1].team.abbreviation, 'LV');
  assert.strictEqual(cats[0].leaders[1].rank, 2);
});

test('fantasy points follow standard, half and full PPR scoring', () => {
  const line = leaders.fantasyLine({
    'completions/passingAttempts': '22/31', passingYards: '300', passingTouchdowns: '2', interceptions: '1',
    rushingAttempts: '4', rushingYards: '20', rushingTouchdowns: '1',
    receptions: '0', receivingYards: '0', fumblesLost: '1',
  });
  // 300*.04 + 2*4 - 2 + 20*.1 + 6 - 2 = 24
  assert.strictEqual(leaders.fantasyPoints(line, 'standard'), 24);
  assert.strictEqual(leaders.role(line), 'QB');

  const wr = leaders.fantasyLine({ receptions: '8', receivingYards: '1,05', receivingTouchdowns: '1', receivingTargets: '11' });
  const wr2 = leaders.fantasyLine({ receptions: '8', receivingYards: '105', receivingTouchdowns: '1' });
  assert.strictEqual(leaders.fantasyPoints(wr2, 'ppr'), 24.5);
  assert.strictEqual(leaders.fantasyPoints(wr2, 'half'), 20.5);
  assert.strictEqual(leaders.fantasyPoints(wr2, 'standard'), 16.5);
  assert.strictEqual(leaders.role(wr), 'WR/TE');
  assert.strictEqual(leaders.role(leaders.fantasyLine({ rushingAttempts: '18', receptions: '3' })), 'RB');
});

const nflGame = (id, state) => ({
  id,
  date: '2026-11-01T18:00Z',
  status: { type: { state, completed: state === 'post' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', score: '24', team: { id: '12', displayName: 'Kansas City Chiefs', abbreviation: 'KC' } },
      { homeAway: 'away', score: '17', team: { id: '13', displayName: 'Las Vegas Raiders', abbreviation: 'LV' } },
    ],
  }],
});

const boxscore = {
  boxscore: {
    players: [{
      team: { id: '12', abbreviation: 'KC', displayName: 'Kansas City Chiefs' },
      statistics: [
        {
          name: 'passing',
          keys: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions'],
          athletes: [{ athlete: { id: '100', displayName: 'Star QB' }, stats: ['25/35', '310', '8.9', '3', '0'] }],
        },
        {
          name: 'rushing',
          labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
          athletes: [
            { athlete: { id: '100', displayName: 'Star QB' }, stats: ['3', '15', '5.0', '0', '9'] },
            { athlete: { id: '101', displayName: 'Lead Back' }, stats: ['20', '95', '4.8', '1', '22'] },
          ],
        },
        { name: 'defensive', keys: ['totalTackles'], athletes: [{ athlete: { id: '200', displayName: 'LB' }, stats: ['9'] }] },
      ],
    }],
  },
};

test('weekly fantasy adds up box scores for games that have started', async () => {
  responses = (url) => {
    if (url.includes('/football/nfl/scoreboard')) return { season: { year: 2026, type: 2 }, week: { number: 9 }, events: [nflGame('1', 'post'), nflGame('2', 'pre')] };
    if (url.includes('/football/nfl/summary?event=1')) return boxscore;
    throw new Error(`unexpected ${url}`);
  };
  await withApi(async (base) => {
    const body = await (await fetch(`${base}/api/fantasy?sport=nfl&week=9&format=ppr`)).json();
    assert.strictEqual(body.gamesStarted, 1);
    assert.strictEqual(body.gamesTotal, 2);
    assert.deepStrictEqual(body.players.map((p) => p.name), ['Star QB', 'Lead Back']);
    const qb = body.players[0];
    // 310*.04 + 3*4 + 15*.1 = 25.9
    assert.strictEqual(qb.points, 25.9);
    assert.strictEqual(qb.role, 'QB');
    assert.strictEqual(qb.opponent, 'LV');
    assert.ok(!calls.some((u) => u.includes('summary?event=2')), 'games that have not started are skipped');
    assert.ok(!body.players.some((p) => p.name === 'LB'));

    assert.strictEqual((await fetch(`${base}/api/fantasy?sport=nba`)).status, 404);
  });
});

test('fantasy is NFL only; leaders cover team sports but not UFC or NASCAR', () => {
  assert.strictEqual(resolveSport('nfl').fantasy, true);
  assert.strictEqual(resolveSport('cfb').fantasy, false);
  assert.strictEqual(resolveSport('cfb').leaders, true);
  assert.strictEqual(resolveSport('ufc').leaders, false);
  assert.strictEqual(resolveSport('nascar').leaders, false);
});

test('rankings report movement, new entries and teams that dropped out', async () => {
  responses = () => ({
    latestWeek: { number: 10 },
    rankings: [{
      id: '1',
      name: 'AP Top 25',
      ranks: [
        { current: 1, previous: 3, team: { id: '61', displayName: 'Georgia' } },
        { current: 2, previous: 1, team: { id: '333', displayName: 'Alabama' } },
        { current: 3, previous: 0, team: { id: '259', displayName: 'Virginia Tech' } },
      ],
      droppedOut: [{ previous: 2, team: { id: '52', displayName: 'Florida State' } }],
    }, {
      id: '2',
      name: 'Preseason',
      ranks: [{ current: 1, previous: 0, team: { id: '61' } }],
    }],
  });
  const result = await espn.getRankings({ sport: 'cfb', week: 10, year: 2026 });
  const [ap, pre] = result.polls;
  assert.deepStrictEqual(ap.ranks.map((r) => r.movement), [2, -1, null]);
  assert.deepStrictEqual(ap.ranks.map((r) => r.isNew), [false, false, true]);
  assert.strictEqual(ap.droppedOut[0].previousRank, 2);
  assert.strictEqual(pre.ranks[0].isNew, false, 'nobody is "new" in the first poll of the season');
});

test('standings carry home, away and points columns when ESPN sends them', () => {
  const [conf] = espn.parseStandings({
    children: [{
      name: 'ACC',
      standings: {
        entries: [{
          team: { id: '259', displayName: 'Virginia Tech' },
          stats: [
            { name: 'overall', type: 'total', summary: '6-2', displayValue: '6-2' },
            { name: 'Home', type: 'home', summary: '4-0', displayValue: '4-0' },
            { name: 'Road', type: 'road', summary: '2-2', displayValue: '2-2' },
            { name: 'pointsFor', displayValue: '240' },
            { name: 'pointsAgainst', displayValue: '150' },
            { name: 'differential', displayValue: '+90' },
          ],
        }],
      },
    }],
  });
  const e = conf.entries[0];
  assert.strictEqual(e.home, '4-0');
  assert.strictEqual(e.road, '2-2');
  assert.strictEqual(e.pointsFor, '240');
  assert.strictEqual(e.differential, '+90');
});

test('new pages escape what ESPN sends and link players safely', () => {
  const { loadShared } = require('./helpers');
  const CFB = loadShared();
  assert.strictEqual(CFB.playerLink({ id: '1"><x' }), '/player.html?id=1%22%3E%3Cx&sport=cfb');
  assert.strictEqual(CFB.playerLink(null), '#');
  for (const file of ['leaders.js', 'player.js', 'team.js', 'rankings.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
    // Every `.name` interpolated into a template literal goes through esc.
    const raw = src.match(/\$\{(?!CFB\.esc\()[a-z.]+\.name\}/gi) || [];
    assert.deepStrictEqual(raw, [], `${file} interpolates a name without CFB.esc`);
  }
});

test('college standings ignore split stats and sort by conference record', () => {
  const stat = (name, type, displayValue, summary) => ({ name, type, displayValue, summary });
  const team = (id, name, overall, conf, pf, splitPf) => ({
    team: { id, displayName: name },
    stats: [
      stat('pointsFor', 'pointsfor', pf),
      stat('pointsAgainst', 'pointsagainst', '200'),
      stat('streak', 'streak', 'W3'),
      stat('overall', 'total', overall, overall),
      stat('Home', 'homerecord', '5-0', '5-0'),
      stat('pointsFor', 'homerecord_pointsfor', '999'),
      stat('Away', 'awayrecord', '3-2', '3-2'),
      stat('vs. Conf.', 'vsconf', conf, conf),
      stat('pointsFor', 'vsaprankedteams_pointsfor', splitPf),
      stat('streak', 'vsaprankedteams_streak', '-'),
    ],
  });
  const [conf] = espn.parseStandings({ children: [{ name: 'American', standings: { entries: [
    team('1', 'Memphis', '8-2', '5-1', '390', '0'),
    team('2', 'North Texas', '7-2', '5-0', '300', '16'),
  ] } }] });
  const [first, second] = conf.entries;
  assert.strictEqual(first.team.name, 'North Texas', '5-0 sits above 5-1');
  assert.strictEqual(first.gamesBehind, '-');
  assert.strictEqual(second.gamesBehind, '0.5');
  assert.strictEqual(second.pointsFor, '390', 'season PF, not a split');
  assert.strictEqual(second.streak, 'W3');
  assert.strictEqual(second.home, '5-0');
  assert.strictEqual(second.road, '3-2');
});
