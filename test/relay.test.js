const test = require('node:test');
const assert = require('node:assert');
require('./helpers'); // points the SQLite file at a temp folder
const { createApp } = require('../src/app');
const { ttlFor } = require('../src/relay');

const KEY = 'relay-test-key';
const SCOREBOARD = '/espn/site/v2/sports/football/college-football/scoreboard?dates=20261025&limit=1000';

// A fake ESPN: answers with whatever body/status the test sets, and records URLs.
function fakeEspn() {
  const f = {
    calls: [],
    status: 200,
    body: { events: [{ id: '401', date: '2026-10-25T23:30Z', status: { type: { state: 'post' } } }] },
    fetch: async (url) => {
      f.calls.push(url);
      const status = f.status;
      const text = JSON.stringify(f.body);
      return { ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Bad Gateway', text: async () => text };
    },
  };
  return f;
}

async function start(env, espn, clock) {
  const app = createApp({
    env: { NODE_ENV: 'test', ...env },
    logger: { warn() {} },
    relay: { fetch: espn.fetch, upstream: 'https://espn.test/apis', now: () => clock.t },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    get: (path, key = KEY) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: key ? { 'X-Api-Key': key } : {} }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('relay is off without RELAY_API_KEY', async () => {
  const espn = fakeEspn();
  const app = await start({}, espn, { t: Date.now() });
  try {
    assert.strictEqual((await app.get(SCOREBOARD)).status, 404);
    assert.strictEqual(espn.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('relay needs the key and only relays ESPN read endpoints', async () => {
  const espn = fakeEspn();
  const app = await start({ RELAY_API_KEY: KEY }, espn, { t: Date.now() });
  try {
    assert.strictEqual((await app.get(SCOREBOARD, null)).status, 401);
    assert.strictEqual((await app.get(SCOREBOARD, 'wrong')).status, 401);
    assert.strictEqual((await app.get('/espn/site/v2/sports/football/nfl/../../../x')).status, 404);
    assert.strictEqual((await app.get('/espn/site/v2/sports/football/nfl/athletes')).status, 404);
    assert.strictEqual(espn.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('relay passes the path and query through and caches', async () => {
  const espn = fakeEspn();
  const clock = { t: Date.parse('2026-10-26T12:00Z') };
  const app = await start({ RELAY_API_KEY: KEY }, espn, clock);
  try {
    let res = await app.get(SCOREBOARD);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-cache'), 'MISS');
    assert.deepStrictEqual(await res.json(), espn.body);
    assert.deepStrictEqual(espn.calls, ['https://espn.test/apis/site/v2/sports/football/college-football/scoreboard?dates=20261025&limit=1000']);

    res = await app.get(SCOREBOARD);
    assert.strictEqual(res.headers.get('x-cache'), 'HIT');
    assert.strictEqual(espn.calls.length, 1);

    // Finished games: kept five minutes.
    clock.t += 6 * 60 * 1000;
    await app.get(SCOREBOARD);
    assert.strictEqual(espn.calls.length, 2);

    // ESPN down: the last copy is served.
    espn.status = 502;
    clock.t += 6 * 60 * 1000;
    res = await app.get(SCOREBOARD);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-cache'), 'STALE');

    // Nothing cached and ESPN down: 502.
    res = await app.get('/espn/site/v2/sports/basketball/nba/scoreboard');
    assert.strictEqual(res.status, 502);
  } finally {
    await app.close();
  }
});

test('concurrent requests for one URL make one ESPN call', async () => {
  const espn = fakeEspn();
  const inner = espn.fetch;
  espn.fetch = async (url) => {
    await new Promise((r) => setTimeout(r, 30));
    return inner(url);
  };
  const app = await start({ RELAY_API_KEY: KEY }, espn, { t: Date.now() });
  try {
    const all = await Promise.all([app.get(SCOREBOARD), app.get(SCOREBOARD), app.get(SCOREBOARD)]);
    assert.ok(all.every((r) => r.status === 200));
    assert.strictEqual(espn.calls.length, 1);
  } finally {
    await app.close();
  }
});

test('cache time follows what is in the answer', () => {
  const now = Date.parse('2026-10-25T23:00Z');
  const sb = '/site/v2/sports/football/nfl/scoreboard';
  const live = { events: [{ date: '2026-10-25T22:00Z', status: { type: { state: 'in' } } }] };
  const soon = { events: [{ date: '2026-10-25T23:10Z', status: { type: { state: 'pre' } } }] };
  const later = { events: [{ date: '2026-10-26T23:10Z', status: { type: { state: 'pre' } } }] };
  const liveSummary = { header: { competitions: [{ date: '2026-10-25T22:00Z', status: { type: { state: 'in' } } }] } };
  assert.strictEqual(ttlFor(sb, live, now), 15000);
  assert.strictEqual(ttlFor(sb, soon, now), 15000);
  assert.strictEqual(ttlFor(sb, later, now), 5 * 60000);
  assert.strictEqual(ttlFor('/site/v2/sports/football/nfl/summary', liveSummary, now), 15000);
  assert.strictEqual(ttlFor('/site/v2/sports/football/nfl/summary', {}, now), 10 * 60000);
  assert.strictEqual(ttlFor('/site/v2/sports/football/nfl/teams', {}, now), 12 * 3600000);
  assert.strictEqual(ttlFor('/site/v2/sports/football/nfl/teams/259/schedule', {}, now), 10 * 60000);
});
