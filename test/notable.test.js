// Notable games on each account, and the keyed feeds that Glance/Dynacat
// dashboards read (/api/account/notable/feed, /api/account/dashboard).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-notable-'));

// ESPN stand-in: a week-10 scoreboard with two games, one of them live.
const competitor = (id, name, homeAway, score) => ({
  id, homeAway, score, team: { id, displayName: name, abbreviation: name.slice(0, 3).toUpperCase() },
});
const SCOREBOARD = {
  season: { year: 2026, type: 2 },
  week: { number: 10 },
  events: [
    { id: '501', date: '2026-11-07T20:00:00Z', name: 'Florida State at Virginia Tech', shortName: 'FSU @ VT',
      competitions: [{ status: { type: { state: 'in', shortDetail: 'Q2 4:12' } },
        competitors: [competitor('259', 'Virginia Tech Hokies', 'home', '14'), competitor('52', 'Florida State Seminoles', 'away', '10')] }] },
    { id: '502', date: '2026-11-07T23:30:00Z', name: 'Georgia at Alabama', shortName: 'UGA @ ALA',
      competitions: [{ status: { type: { state: 'pre', shortDetail: '7:30 PM' } },
        competitors: [competitor('333', 'Alabama Crimson Tide', 'home', '0'), competitor('61', 'Georgia Bulldogs', 'away', '0')] }] },
  ],
};
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
  exports: async (url) => {
    const u = String(url);
    const body = /college-football\/scoreboard/.test(u) ? SCOREBOARD : {};
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const { startApp } = require('./helpers');
const db = require('../src/db');

const ENV = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'z'.repeat(40) };

function client(base) {
  const jar = new Map();
  return async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
}

async function signUp(call, email) {
  const res = await call('/api/account/signup', { method: 'POST', body: { email, password: 'go-hokies-1' } });
  assert.strictEqual(res.status, 201);
}

test('each account keeps its own notable games', async () => {
  const app = await startApp(ENV);
  const alice = client(app.url);
  const bob = client(app.url);
  try {
    assert.strictEqual((await alice('/api/account/notable', { method: 'POST', body: { season: 2026, week: 10, eventId: '501' } })).status, 401);
    await signUp(alice, 'alice@example.com');
    await signUp(bob, 'bob@example.com');

    let res = await alice('/api/account/notable', { method: 'POST', body: { season: 2026, week: 10, eventId: '501', gameName: 'FSU @ VT', label: 'Rivalry' } });
    assert.strictEqual(res.status, 200);
    res = await alice('/api/account/notable', { method: 'POST', body: { season: 2026, week: 10, eventId: '502' } });
    const aliceRows = await res.json();
    assert.deepStrictEqual(aliceRows.map((r) => r.event_id), ['501', '502']);

    assert.strictEqual((await alice('/api/account/notable', { method: 'POST', body: { season: 2026, week: 10, eventId: '../x' } })).status, 400);
    assert.strictEqual((await alice('/api/account/notable', { method: 'POST', body: { season: 2026, week: 99, eventId: '1' } })).status, 400);

    // Bob sees none of Alice's picks and can't delete them.
    assert.deepStrictEqual(await (await bob('/api/account/notable?season=2026&week=10')).json(), []);
    await bob(`/api/account/notable/${aliceRows[0].id}`, { method: 'DELETE' });
    assert.strictEqual((await (await alice('/api/account/notable?season=2026&week=10')).json()).length, 2);

    // Reorder, then remove.
    res = await alice('/api/account/notable/reorder', { method: 'POST', body: { season: 2026, week: 10, orderedIds: [aliceRows[1].id, aliceRows[0].id] } });
    assert.deepStrictEqual((await res.json()).map((r) => r.event_id), ['502', '501']);
    await alice(`/api/account/notable/${aliceRows[1].id}`, { method: 'DELETE' });
    assert.deepStrictEqual((await (await alice('/api/account/notable?season=2026&week=10')).json()).map((r) => r.event_id), ['501']);

    // The admin's site picks stay separate and can be copied in.
    db.addNotableGame({ season: 2026, week: 10, eventId: '502', label: 'Top 5 clash' });
    db.addNotableGame({ season: 2026, week: 10, eventId: '501' });
    assert.strictEqual((await (await bob('/api/notable?season=2026&week=10')).json()).length, 2);
    res = await bob('/api/account/notable/import', { method: 'POST', body: { season: 2026, week: 10 } });
    assert.deepStrictEqual(await res.json(), { added: 2 });
    res = await bob('/api/account/notable/import', { method: 'POST', body: { season: 2026, week: 10 } });
    assert.deepStrictEqual(await res.json(), { added: 0 }, 'copying twice adds nothing');
    const bobRows = await (await bob('/api/account/notable?season=2026&week=10')).json();
    assert.strictEqual(bobRows.find((r) => r.event_id === '502').label, 'Top 5 clash');
  } finally {
    await app.close();
  }
});

test('notable feed and dashboard read with the feed key, live scores included', async () => {
  const user = db.createUser({ email: 'dash@example.com', displayName: 'Dash' });
  db.addUserNotableGame(user.id, { season: 2026, week: 10, eventId: '502', label: 'Game of the week' });
  db.addUserNotableGame(user.id, { season: 2026, week: 10, eventId: '501' });
  db.addUserNotableGame(user.id, { season: 2026, week: 10, eventId: '999' }); // not on the scoreboard
  const app = await startApp(ENV);
  try {
    assert.strictEqual((await fetch(`${app.url}/api/account/notable/feed`)).status, 401);
    assert.strictEqual((await fetch(`${app.url}/api/account/notable/feed`, { headers: { Authorization: 'Bearer not-a-real-key-at-all-xx' } })).status, 401);

    let res = await fetch(`${app.url}/api/account/notable/feed?weeks=2`, { headers: { Authorization: `Bearer ${user.feed_token}` } });
    assert.strictEqual(res.status, 200);
    let feed = await res.json();
    assert.strictEqual(feed.user.displayName, 'Dash');
    assert.strictEqual(feed.season, 2026);
    assert.deepStrictEqual(feed.weeks.map((w) => w.week), [10, 11]);
    const games = feed.weeks[0].games;
    assert.deepStrictEqual(games.map((g) => g.id), ['502', '501'], 'pick order kept, unknown games dropped');
    assert.strictEqual(games[0].label, 'Game of the week');
    assert.strictEqual(games[1].status.state, 'in');
    assert.deepStrictEqual(feed.counts, { games: 2, live: 1, final: 0, upcoming: 1 });

    // ?key= works too, for widgets that can't send headers.
    res = await fetch(`${app.url}/api/account/notable/feed?key=${user.feed_token}`);
    assert.strictEqual(res.status, 200);

    res = await fetch(`${app.url}/api/account/dashboard`, { headers: { Authorization: `Bearer ${user.feed_token}` } });
    assert.strictEqual(res.status, 200);
    const dash = await res.json();
    assert.strictEqual(dash.user.displayName, 'Dash');
    assert.deepStrictEqual(dash.teams, []);
    assert.strictEqual(dash.notable.weeks[0].games.length, 2);
    assert.strictEqual(dash.counts.notableLive, 1);
    assert.deepStrictEqual(dash.errors, []);

    // Writes never take the key.
    res = await fetch(`${app.url}/api/account/notable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.feed_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ season: 2026, week: 10, eventId: '777' }),
    });
    assert.strictEqual(res.status, 401);

    // The public feed still serves the site picks.
    db.addNotableGame({ season: 2026, week: 10, eventId: '501' });
    feed = await (await fetch(`${app.url}/api/notable/feed`)).json();
    assert.ok(feed.weeks[0].games.some((g) => g.id === '501'));
  } finally {
    await app.close();
  }
});
