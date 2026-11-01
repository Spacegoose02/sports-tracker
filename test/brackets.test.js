const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-brackets-'));

// ESPN stand-in: a CFB postseason scoreboard and an NCAA tournament window.
const requests = [];
const team = (id, name, homeAway, extra = {}) => ({ homeAway, team: { id, displayName: name, abbreviation: name.slice(0, 4).toUpperCase() }, ...extra });
const event = (id, headline, away, home, state = 'pre', date = '2026-12-20T17:00:00Z') => ({
  id, date, name: `${away.team.displayName} at ${home.team.displayName}`,
  competitions: [{ notes: headline ? [{ headline }] : [], status: { type: { state, completed: state === 'post' } }, competitors: [away, home] }],
});
const CFB_EVENTS = [
  event('b1', 'Famous Idaho Potato Bowl', team('1', 'Ohio Bobcats', 'away'), team('2', 'Fresno State', 'home'), 'post', '2025-12-22T20:00:00Z'),
  event('f1', 'College Football Playoff First Round Game', team('12', 'James Madison', 'away', { seed: '12' }), team('5', 'Oregon', 'home', { seed: '5', winner: true, score: '51' }), 'post', '2025-12-20T20:00:00Z'),
  event('f2', 'College Football Playoff First Round Game', team('9', 'Alabama', 'away', { seed: '9' }), team('8', 'Oklahoma', 'home', { seed: '8' }), 'pre', '2025-12-19T20:00:00Z'),
  event('q1', 'CFP Quarterfinal at the Rose Bowl Presented by Prudential', team('8', 'Oklahoma', 'away', { seed: '8' }), team('1', 'Indiana', 'home', { seed: '1' }), 'pre', '2026-01-01T21:00:00Z'),
  event('q2', 'Allstate Sugar Bowl - CFP Quarterfinal', team('5', 'Oregon', 'away', { seed: '5' }), team('4', 'Texas Tech', 'home', { seed: '4' }), 'pre', '2026-01-01T01:00:00Z'),
  event('x1', null, team('20', 'Army', 'away'), team('21', 'Navy', 'home'), 'post'),
];
const MM_EVENTS = [
  event('m1', "Men's Basketball Championship - South Region - 1st Round", team('31', 'Auburn', 'away', { seed: '1' }), team('32', 'Alabama State', 'home', { seed: '16' }), 'post', '2026-03-20T16:00:00Z'),
  event('m2', "Men's Basketball Championship - East Region - 2nd Round", team('41', 'Duke', 'away'), team('42', 'Baylor', 'home'), 'pre', '2026-03-22T16:00:00Z'),
  event('m3', "Men's Basketball Championship - First Four", team('51', 'Texas', 'away'), team('52', 'Xavier', 'home'), 'post', '2026-03-18T23:00:00Z'),
  event('m4', 'NIT - 1st Round', team('61', 'UC Irvine', 'away'), team('62', 'Northern Colorado', 'home'), 'post', '2026-03-18T23:00:00Z'),
];
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
  exports: async (url) => {
    const u = String(url);
    requests.push(u);
    let body = { events: [] };
    if (/college-football\/scoreboard/.test(u) && /seasontype=3/.test(u) && /year=2025/.test(u)) body = { season: { year: 2025, type: 3 }, events: CFB_EVENTS };
    if (/mens-college-basketball\/scoreboard/.test(u) && /dates=20260314-20260410/.test(u)) body = { events: MM_EVENTS };
    if (/college-football\/rankings/.test(u)) {
      body = {
        latestSeason: { year: 2026 },
        rankings: [
          { name: 'AP Top 25', shortName: 'AP Poll', ranks: Array.from({ length: 25 }, (_, i) => ({ current: i + 1, team: { id: `ap${i + 1}`, displayName: `AP Team ${i + 1}` } })) },
          { name: 'College Football Playoff Rankings', shortName: 'CFP Rankings', ranks: Array.from({ length: 25 }, (_, i) => ({ current: i + 1, team: { id: `t${i + 1}`, displayName: `Team ${i + 1}` } })) },
        ],
      };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const B = require('../public/js/brackets-core.js');
const { startApp } = require('./helpers');

test('classify names playoff rounds, bowls and tournament rounds', () => {
  const c = (headline, sport = 'cfb') => B.classify({ headline }, sport);
  assert.deepStrictEqual(c('College Football Playoff First Round Game'), { kind: 'cfp', round: 'first', region: null, name: null });
  assert.strictEqual(c('CFP Quarterfinal at the Rose Bowl Presented by Prudential').name, 'Rose Bowl');
  assert.strictEqual(c('Allstate Sugar Bowl - CFP Semifinal').round, 'sf');
  assert.strictEqual(c('Allstate Sugar Bowl - CFP Semifinal').name, 'Allstate Sugar Bowl');
  assert.strictEqual(c('CFP National Championship Presented by AT&T').round, 'final');
  assert.deepStrictEqual(c('Famous Idaho Potato Bowl'), { kind: 'bowl', round: null, region: null, name: 'Famous Idaho Potato Bowl' });
  assert.strictEqual(c(''), null);
  assert.strictEqual(c('ACC Championship'), null);
  assert.deepStrictEqual(c("Men's Basketball Championship - Midwest Region - Sweet 16", 'mcbb'), { kind: 'mm', round: 's16', region: 'Midwest', name: null });
  assert.strictEqual(c("Men's Basketball Championship - Final Four", 'mcbb').round, 'f4');
  assert.strictEqual(c("Men's Basketball Championship - National Championship", 'mcbb').round, 'final');
  assert.strictEqual(c('NIT - Quarterfinals', 'mcbb'), null);
});

test('rounds line up so each game sits beside the game it feeds', () => {
  const g = (id, a, h) => ({ id, away: { id: a }, home: { id: h } });
  const rounds = B.alignRounds([
    { games: [g('f1', '12', '5'), g('f2', '9', '8')] },
    { games: [g('q1', '8', '1'), g('q2', '5', '4')] },
  ]);
  assert.deepStrictEqual(rounds[0].games.map((x) => x.id), ['f2', 'f1']);
});

test('projected playoff field seeds the CFP rankings straight down', () => {
  const ranks = Array.from({ length: 14 }, (_, i) => ({ rank: i + 1, team: { id: `t${i + 1}`, name: `Team ${i + 1}` } }));
  const p = B.projectCfp([{ name: 'AP Top 25', ranks: [] }, { name: 'College Football Playoff Rankings', ranks }]);
  assert.strictEqual(p.poll, 'College Football Playoff Rankings');
  assert.strictEqual(p.seeds.length, 12);
  const first = p.rounds[0].games.map((x) => [x.away.seed, x.home.seed]);
  assert.deepStrictEqual(first, [[9, 8], [12, 5], [10, 7], [11, 6]]);
  assert.deepStrictEqual(p.rounds[1].games.map((x) => x.home.seed), [1, 4, 2, 3]);
  assert.strictEqual(B.projectCfp([{ name: 'AP', ranks: ranks.slice(0, 5) }]), null);
});

test('challenge scoring: later rounds are worth more, strict mode needs a pick before kickoff', () => {
  const game = (id, round, winner) => ({
    id, round, date: '2026-01-01T20:00:00Z',
    status: { state: winner ? 'post' : 'pre', completed: !!winner },
    away: { id: 'a', winner: winner === 'a' }, home: { id: 'h', winner: winner === 'h' },
  });
  const bracket = { cfp: { rounds: [{ points: 1, games: [game('1', 'first', 'h')] }, { points: 8, games: [game('2', 'final', 'a')] }, { points: 4, games: [game('3', 'sf')] }] }, bowls: [game('4', null, 'a')] };
  const index = B.gameIndex(bracket, 'cfb');
  const before = Date.parse('2026-01-01T19:00:00Z');
  const picks = {
    'cfb:1': { teamId: 'h', pickedAt: before },
    'cfb:2': { teamId: 'a', pickedAt: Date.parse('2026-01-01T21:00:00Z') }, // after kickoff
    'cfb:3': { teamId: 'a', pickedAt: before },
    'cfb:4': { teamId: 'h', pickedAt: before },
  };
  assert.deepStrictEqual(B.scorePicks(picks, index), { points: 9, right: 2, wrong: 1, pending: 1, possible: 13 });
  assert.deepStrictEqual(B.scorePicks(picks, index, { strict: true }), { points: 1, right: 1, wrong: 1, pending: 1, possible: 5 });
  const rows = B.standings([{ id: 'p1', name: 'Sam' }, { id: 'p2', name: 'Ava' }], { p1: picks }, index);
  assert.deepStrictEqual(rows.map((r) => r.player.name), ['Sam', 'Ava']);
});

test('default seasons follow when each postseason is played', () => {
  assert.strictEqual(B.defaultSeason('cfb', '2026-11-01T12:00:00Z'), 2026);
  assert.strictEqual(B.defaultSeason('cfb', '2027-01-05T12:00:00Z'), 2026);
  assert.strictEqual(B.defaultSeason('mcbb', '2026-11-01T12:00:00Z'), 2027);
  assert.strictEqual(B.defaultSeason('mcbb', '2027-03-20T12:00:00Z'), 2027);
});

test('/api/brackets serves the CFP, bowls and the March Madness bracket', async () => {
  const app = await startApp({ NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'z'.repeat(40) });
  try {
    let res = await fetch(`${app.url}/api/brackets?sport=cfb&season=2025`);
    assert.strictEqual(res.status, 200);
    let data = await res.json();
    assert.strictEqual(data.season, 2025);
    assert.strictEqual(data.cfpSet, true);
    assert.strictEqual(data.projected, null);
    assert.deepStrictEqual(data.bowls.map((g) => g.bowl), ['Famous Idaho Potato Bowl']);
    const [first, qf, sf, final] = data.cfp.rounds;
    assert.deepStrictEqual(first.games.map((g) => g.id), ['f2', 'f1', null, null]);
    assert.deepStrictEqual(qf.games.slice(0, 2).map((g) => g.bowl), ['Rose Bowl', 'Allstate Sugar Bowl']);
    assert.strictEqual(first.games[1].home.seed, 5);
    assert.strictEqual(sf.games.length, 2);
    assert.strictEqual(final.games[0].placeholder, true);

    res = await fetch(`${app.url}/api/brackets?sport=mcbb&season=2026`);
    data = await res.json();
    assert.deepStrictEqual(data.regions.map((r) => r.name), ['East', 'South']);
    assert.strictEqual(data.firstFour.length, 1);
    assert.strictEqual(data.regions[1].rounds[0].games[0].id, 'm1');
    assert.strictEqual(data.finals.length, 2);

    // A season with nothing yet: projection from the current rankings.
    res = await fetch(`${app.url}/api/brackets?sport=cfb&season=2026`);
    data = await res.json();
    assert.strictEqual(data.empty, true);
    assert.strictEqual(data.projected.poll, 'College Football Playoff Rankings');

    assert.strictEqual((await fetch(`${app.url}/api/brackets?sport=nba`)).status, 400);
  } finally {
    await app.close();
  }
});
