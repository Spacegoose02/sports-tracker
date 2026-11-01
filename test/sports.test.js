const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep SQLite out of the repo and stub node-fetch before anything loads it,
// so these tests never hit ESPN. Each test sets `responses` and reads `calls`.
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-sports-'));
const calls = [];
let responses = () => ({});
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch',
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, statusText: 'OK', json: async () => responses(String(url)) };
  },
};

const express = require('express');
const espn = require('../src/espn');
const { resolveSport, publicSportList } = require('../src/sports');

async function withApi(fn) {
  const app = express();
  app.use('/api', require('../src/routes/api'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const nbaEvent = {
  id: '401700001',
  date: '2026-11-01T23:30:00Z',
  name: 'Boston Celtics at New York Knicks',
  shortName: 'BOS @ NY',
  status: { period: 3, displayClock: '4:12', type: { state: 'in', shortDetail: '4:12 - 3rd', completed: false } },
  competitions: [{
    venue: { fullName: 'Madison Square Garden' },
    broadcasts: [{ names: ['TNT'] }],
    competitors: [
      { homeAway: 'home', score: '78', team: { id: '18', displayName: 'New York Knicks', abbreviation: 'NY', color: '006bb6' } },
      { homeAway: 'away', score: '81', team: { id: '2', displayName: 'Boston Celtics', abbreviation: 'BOS' } },
    ],
  }],
};

test('every sport resolves to an ESPN path, CFB is the default', () => {
  assert.strictEqual(resolveSport(undefined).key, 'cfb');
  for (const key of ['cfb', 'nfl', 'nba', 'mlb', 'nhl', 'mcbb']) {
    assert.ok(resolveSport(key).path.includes('/'), key);
  }
  assert.strictEqual(resolveSport('curling'), null);
  assert.ok(publicSportList().every((s) => s.path === undefined), 'ESPN paths stay server-side');
});

test('NBA scoreboard uses the NBA path and dates instead of weeks', async () => {
  calls.length = 0;
  responses = () => ({ events: [nbaEvent], day: { date: '2026-11-01' }, season: { year: 2027, type: 2 } });
  const result = await espn.getScoreboard({ sport: 'nba', dates: '20261101', week: 9 });
  assert.match(calls[0], /\/basketball\/nba\/scoreboard\?/);
  assert.match(calls[0], /dates=20261101/);
  assert.doesNotMatch(calls[0], /week=/);
  assert.doesNotMatch(calls[0], /groups=/);
  assert.strictEqual(result.day, '2026-11-01');
  assert.strictEqual(result.games[0].away.score, 81);
  assert.strictEqual(result.games[0].broadcast, 'TNT');
});

test('college football scoreboard still defaults to FBS and the regular season', async () => {
  calls.length = 0;
  responses = () => ({ events: [], season: { year: 2026 }, week: { number: 10 } });
  await espn.getScoreboard({ year: 2026, week: 10 });
  assert.match(calls[0], /\/football\/college-football\/scoreboard\?/);
  assert.match(calls[0], /groups=80/);
  assert.match(calls[0], /seasontype=2/);
});

test("men's college basketball asks for all of Division I", async () => {
  calls.length = 0;
  responses = () => ({ events: [] });
  await espn.getScoreboard({ sport: 'mcbb', dates: '20261110' });
  assert.match(calls[0], /mens-college-basketball\/scoreboard\?.*groups=50/);
});

test('pro standings flatten nested groups and build records from wins/losses', () => {
  const conferences = espn.parseStandings({
    children: [{
      name: 'Eastern Conference',
      children: [{
        name: 'Atlantic Division',
        standings: { entries: [{
          team: { id: '2', displayName: 'Boston Celtics' },
          stats: [
            { name: 'wins', displayValue: '5' },
            { name: 'losses', displayValue: '1' },
            { name: 'winPercent', displayValue: '.833' },
            { name: 'gamesBehind', displayValue: '-' },
            { name: 'streak', displayValue: 'W3' },
          ],
        }] },
      }],
    }],
  });
  assert.strictEqual(conferences.length, 1);
  assert.strictEqual(conferences[0].name, 'Atlantic Division');
  const row = conferences[0].entries[0];
  assert.strictEqual(row.overall, '5-1');
  assert.strictEqual(row.winPercent, '.833');
  assert.strictEqual(row.streak, 'W3');
});

test('NHL standings include OT losses in the record', () => {
  const [conf] = espn.parseStandings({ children: [{ name: 'West', standings: { entries: [{
    team: { id: '1' },
    stats: [{ name: 'wins', displayValue: '8' }, { name: 'losses', displayValue: '3' }, { name: 'otLosses', displayValue: '2' }, { name: 'points', displayValue: '18' }],
  }] } }] });
  assert.strictEqual(conf.entries[0].overall, '8-3-2');
  assert.strictEqual(conf.entries[0].points, '18');
});

test('flat play-by-play is newest first and capped', () => {
  const plays = Array.from({ length: 400 }, (_, i) => ({ text: `play ${i}`, period: { number: 1 }, clock: { displayValue: '1:00' } }));
  const pbp = espn.buildFlatPlayByPlay(plays);
  assert.strictEqual(pbp.length, 250);
  assert.strictEqual(pbp[0].text, 'play 399');
});

test('baseball situation carries count, outs and runners', () => {
  const s = espn.parseSituation({ balls: 1, strikes: 2, outs: 2, onFirst: true, onThird: true });
  assert.deepStrictEqual(s.baseball, { balls: 1, strikes: 2, outs: 2, onFirst: true, onSecond: false, onThird: true });
  assert.strictEqual(espn.parseSituation({ down: 1, yardLine: 40 }).baseball, null);
});

test('ESPN league news maps to the News tab item shape', () => {
  const items = espn.parseNews({ articles: [
    { headline: 'Knicks win', description: 'Recap', published: '2026-11-01T12:00:00Z', links: { web: { href: 'https://www.espn.com/nba/story/1' } }, images: [{ url: 'https://a.espncdn.com/x.jpg' }] },
    { headline: 'No link' },
  ] });
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0], { title: 'Knicks win', link: 'https://www.espn.com/nba/story/1', source: 'ESPN', pubDate: '2026-11-01T12:00:00.000Z', summary: 'Recap', image: 'https://a.espncdn.com/x.jpg' });
});

test('API lists sports and rejects unknown sports and bad dates', async () => {
  await withApi(async (url) => {
    const list = await (await fetch(`${url}/api/sports`)).json();
    assert.strictEqual(list.defaultSport, 'cfb');
    assert.deepStrictEqual(list.sports.map((s) => s.key), ['cfb', 'nfl', 'nba', 'mcbb', 'mlb', 'nhl']);
    assert.strictEqual((await fetch(`${url}/api/scoreboard?sport=curling`)).status, 400);
    assert.strictEqual((await fetch(`${url}/api/scoreboard?sport=nba&dates=tomorrow`)).status, 400);
  });
});

test('API scoreboard for a pro sport does not pin the CFB favorite', async () => {
  responses = () => ({ events: [nbaEvent] });
  await withApi(async (url) => {
    const data = await (await fetch(`${url}/api/scoreboard?sport=nba&dates=20261102`)).json();
    assert.strictEqual(data.sport, 'nba');
    assert.strictEqual(data.favoriteTeamId, null);
    assert.strictEqual(data.games.length, 1);
  });
});

test('API rankings are empty for leagues without polls', async () => {
  calls.length = 0;
  await withApi(async (url) => {
    const data = await (await fetch(`${url}/api/rankings?sport=nfl`)).json();
    assert.deepStrictEqual(data, { polls: [] });
    assert.strictEqual(calls.length, 0);
  });
});
