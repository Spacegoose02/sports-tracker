const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-overrides-'));

// ESPN stand-in: a game summary (with no radio) and a team schedule.
const competitors = [
  { homeAway: 'home', team: { id: '259', displayName: 'Virginia Tech Hokies', abbreviation: 'VT' } },
  { homeAway: 'away', team: { id: '52', displayName: 'Florida State Seminoles', abbreviation: 'FSU' } },
];
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
  exports: async (url) => {
    const u = String(url);
    let body = {};
    if (/summary\?event=/.test(u)) {
      body = {
        header: { id: '401', competitions: [{ broadcasts: [{ market: 'national', names: ['ESPN'] }], status: { type: { state: 'pre' } }, competitors }] },
        broadcasts: [{ type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'ESPN' } }],
      };
    } else if (/\/teams\/\d+\/schedule/.test(u)) {
      body = {
        season: { year: 2026 },
        events: [
          { id: '401', date: '2026-11-07T20:00:00Z', name: 'FSU at VT', competitions: [{ broadcasts: [{ names: ['ESPN'] }], status: { type: { state: 'pre' } }, competitors }] },
          { id: '402', date: '2026-11-14T20:00:00Z', name: 'FSU at VT', competitions: [{ status: { type: { state: 'pre' } }, competitors }] },
        ],
      };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const { startApp } = require('./helpers');
const db = require('../src/db');
const overrides = require('../src/overrides');

const ENV = { ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'x'.repeat(40) };

function clear() {
  db.db.prepare('DELETE FROM broadcast_overrides').run();
}

test('game TV override replaces ESPN and reworks the streaming list', () => {
  clear();
  db.saveBroadcastOverride({ sport: 'cfb', scope: 'game', targetId: '401', tv: ['CBS'], watchName: 'Team stream', watchUrl: 'https://example.com/live', note: 'Moved to CBS' });
  const summary = { id: '401', broadcast: 'ESPN', broadcasts: [{ network: 'ESPN', type: 'TV', market: 'National' }], streaming: [], teams: [] };
  const out = overrides.applyToSummary(summary, 'cfb');
  assert.strictEqual(out.broadcast, 'CBS');
  assert.deepStrictEqual(out.broadcasts.map((b) => b.network), ['CBS']);
  assert.strictEqual(out.streaming[0].name, 'Team stream');
  assert.ok(out.streaming.some((s) => s.name === 'Paramount+'));
  assert.strictEqual(out.broadcastNote, 'Moved to CBS');
  // The cached original is left alone.
  assert.strictEqual(summary.broadcast, 'ESPN');
});

test('team TV is only a fallback; game TV wins over ESPN', () => {
  clear();
  db.saveBroadcastOverride({ sport: 'cfb', scope: 'team', targetId: '259', tv: ['ACC Network'] });
  db.saveBroadcastOverride({ sport: 'cfb', scope: 'game', targetId: '3', tv: ['ABC'] });
  const games = overrides.applyToGames([
    { id: '1', broadcast: 'ESPN', home: { id: '259' } },
    { id: '2', broadcast: null, home: { id: '259' } },
    { id: '3', broadcast: 'ESPN', home: { id: '259' } },
    { id: '4', broadcast: null, home: { id: '1' } },
  ], 'cfb');
  assert.deepStrictEqual(games.map((g) => g.broadcast), ['ESPN', 'ACC Network', 'ABC', null]);
  // Another sport's override never applies.
  assert.strictEqual(overrides.applyToGames([{ id: '3', broadcast: 'ESPN' }], 'nfl')[0].broadcast, 'ESPN');
});

test('radio overrides set the team flagship and the national list', () => {
  clear();
  db.saveBroadcastOverride({ sport: 'cfb', scope: 'team', targetId: '259', radio: ['WFNR 710', 'WBRW 105.3'], radioCity: 'Roanoke, VA', listenUrl: 'https://hokiesports.com/listen' });
  db.saveBroadcastOverride({ sport: 'cfb', scope: 'game', targetId: '401', radio: ['Westwood One'] });
  const info = {
    national: [{ kind: 'radio', name: 'Sports USA', market: 'national' }],
    teams: [
      { id: '259', homeAway: 'home', flagship: { station: 'Old Station' }, stations: [{ kind: 'radio', name: 'WBRW 105.3', market: 'home' }, { kind: 'radio', name: 'WXYZ', market: 'home' }] },
      { id: '52', homeAway: 'away', flagship: null, stations: [] },
    ],
  };
  const out = overrides.applyToRadio(info, 'cfb', '401');
  assert.deepStrictEqual(out.national.map((s) => s.name), ['Westwood One']);
  const vt = out.teams[0];
  assert.strictEqual(vt.flagship.station, 'WFNR 710');
  assert.strictEqual(vt.flagship.city, 'Roanoke, VA');
  assert.strictEqual(vt.listen, 'https://hokiesports.com/listen');
  assert.deepStrictEqual(vt.stations.map((s) => s.name), ['WBRW 105.3', 'WXYZ']);
  assert.strictEqual(out.teams[1], info.teams[1]);
});

test('admin can save, list and clear overrides, and the public API uses them', async () => {
  clear();
  const app = await startApp(ENV);
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(`${app.url}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.strictEqual((await call('GET', '/api/admin/broadcasts')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/login', { password: 'a-real-password' })).status, 200);

    const bad = await call('POST', '/api/admin/broadcasts', { sport: 'cfb', scope: 'game', targetId: '401', watchUrl: 'javascript:alert(1)' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await call('POST', '/api/admin/broadcasts', { sport: 'nope', scope: 'game', targetId: '401', tv: 'ESPN' })).status, 400);
    assert.strictEqual((await call('POST', '/api/admin/broadcasts', { sport: 'cfb', scope: 'game', targetId: '../x', tv: 'ESPN' })).status, 400);

    const saved = await call('POST', '/api/admin/broadcasts', { sport: 'cfb', scope: 'game', targetId: '401', tv: 'FOX, fox, FS1', radio: 'Westwood One', note: 'Flexed to FOX' });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.tv, ['FOX', 'FS1']);
    await call('POST', '/api/admin/broadcasts', { sport: 'cfb', scope: 'team', targetId: '259', tv: 'ACC Network', radio: 'WFNR 710' });
    assert.strictEqual((await call('GET', '/api/admin/broadcasts')).body.length, 2);

    const game = (await call('GET', '/api/game/401')).body;
    assert.strictEqual(game.broadcast, 'FOX');
    assert.strictEqual(game.broadcastNote, 'Flexed to FOX');
    const radio = (await call('GET', '/api/game/401/radio')).body;
    assert.deepStrictEqual(radio.national.map((s) => s.name), ['Westwood One']);
    assert.strictEqual(radio.teams.find((t) => t.id === '259').flagship.station, 'WFNR 710');
    const team = (await call('GET', '/api/team/259')).body;
    assert.deepStrictEqual(team.schedule.map((g) => g.broadcast), ['FOX / FS1', 'ACC Network']);

    // A blank form removes the override; so does DELETE.
    assert.deepStrictEqual((await call('POST', '/api/admin/broadcasts', { sport: 'cfb', scope: 'game', targetId: '401' })).body, { removed: true });
    assert.strictEqual((await call('DELETE', '/api/admin/broadcasts/cfb/team/259')).status, 200);
    assert.strictEqual((await call('GET', '/api/admin/broadcasts')).body.length, 0);
    assert.strictEqual((await call('GET', '/api/game/401')).body.broadcast, 'ESPN');
  } finally {
    await app.close();
  }
});
