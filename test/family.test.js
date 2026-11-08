const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-family-'));

const ENV = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'f'.repeat(40) };
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const past = new Date(now - DAY).toISOString(); // already played
const future = new Date(now + DAY).toISOString(); // not started

// Stand-ins for ESPN: week 10 of CFB has one finished game and one still to
// play; the CFB postseason has one finished bowl.
const team = (id, name, extra = {}) => ({ id, name, ...extra });
const WEEK = {
  games: [
    { id: 'g1', date: past, status: { state: 'post', completed: true }, away: team('a1', 'Away One'), home: team('h1', 'Home One', { winner: true }) },
    { id: 'g2', date: future, status: { state: 'pre' }, away: team('a2', 'Away Two'), home: team('h2', 'Home Two') },
  ],
};
// Week 11: home is a 6.5-point favorite and wins by only 4.
const WEEK11 = {
  games: [
    { id: 'g3', date: past, status: { state: 'post', completed: true }, odds: { homeSpread: -6.5 }, away: team('a3', 'Away Three', { score: 20 }), home: team('h3', 'Home Three', { score: 24, winner: true }) },
  ],
};
const POSTSEASON = {
  sport: 'cfb', season: 2026, empty: false, cfp: null, cfpSet: false, projected: null,
  bowls: [{ id: 'b1', date: past, bowl: 'Rose Bowl', status: { state: 'post', completed: true }, away: team('x', 'X', { winner: true }), home: team('y', 'Y') }],
};
const calls = [];
const deps = {
  getScoreboard: async (opts) => { calls.push(opts); return opts.week === 10 ? WEEK : opts.week === 11 ? WEEK11 : { games: [] }; },
  getGameSummary: async () => null,
  getPostseason: async () => POSTSEASON,
};

function client(base) {
  const jar = new Map();
  return async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
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

async function start() {
  const { createApp } = require('../src/app');
  const app = createApp({ env: ENV, logger: { warn() {} }, family: { deps } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const pick = (gameId, teamId, date, extra = {}) => ({
  sport: 'cfb', gameId, teamId, week: 'cfb-2026-2-10', date,
  away: { id: gameId === 'g1' ? 'a1' : 'a2', name: 'Away' }, home: { id: gameId === 'g1' ? 'h1' : 'h2', name: 'Home' }, result: null, ...extra,
});

test('kids data: merge on sign-in, server pick times, removals, cleaning', async () => {
  const app = await start();
  const call = client(app.url);
  try {
    assert.strictEqual((await call('/api/family/data')).status, 401);
    assert.strictEqual((await call('/api/family/leagues')).status, 401);
    await call('/api/account/signup', { method: 'POST', body: { email: 'mom@example.com', password: 'go-hokies-1', displayName: 'Mom' } });

    let data = (await (await call('/api/family/data')).json()).data;
    assert.deepStrictEqual(data, { players: [], picks: {}, stickers: {}, brackets: {}, xp: {}, cards: {} });

    // What this browser saved while signed out.
    const local = {
      players: [{ id: 'p1', name: 'Sam', emoji: '🦊' }, { id: 'bad id!', name: 'Nope' }],
      picks: { p1: { 'cfb:g2': pick('g2', 'h2', future), 'cfb:zz': { sport: 'cfb', gameId: '<script>', teamId: '1' } } },
      stickers: { p1: [{ sport: 'cfb', gameId: 'g1', teamId: 'h1', reason: 'watched', name: 'Home One', logo: 'javascript:alert(1)', at: 5 }] },
      brackets: { p1: { 'cfb:b1': { sport: 'cfb', season: 2026, gameId: 'b1', teamId: 'x', round: 'bowl' } } },
    };
    data = (await (await call('/api/family/data/merge', { method: 'POST', body: { data: local } })).json()).data;
    assert.deepStrictEqual(data.players, [{ id: 'p1', name: 'Sam', emoji: '🦊' }]);
    assert.deepStrictEqual(Object.keys(data.picks.p1), ['cfb:g2']);
    assert.ok(data.picks.p1['cfb:g2'].pickedAt > 0);
    assert.strictEqual(data.stickers.p1[0].logo, null);
    // Merging the same thing again changes nothing.
    const again = (await (await call('/api/family/data/merge', { method: 'POST', body: { data: local } })).json()).data;
    assert.strictEqual(again.picks.p1['cfb:g2'].pickedAt, data.picks.p1['cfb:g2'].pickedAt);
    assert.strictEqual(again.stickers.p1.length, 1);

    // A second player and a pick; a client-sent pickedAt is ignored.
    await call('/api/family/data/players', { method: 'PUT', body: { value: [...data.players, { id: 'p2', name: 'Ava', emoji: '🐼' }] } });
    let res = await (await call('/api/family/data/picks', { method: 'PUT', body: { value: { p1: data.picks.p1, p2: { 'cfb:g2': pick('g2', 'a2', future, { pickedAt: 1 }) } } } })).json();
    assert.ok(res.value.p2['cfb:g2'].pickedAt > 1);
    assert.strictEqual(res.value.p1['cfb:g2'].pickedAt, data.picks.p1['cfb:g2'].pickedAt);

    // Removing a player: the browser sends picks without them.
    res = await (await call('/api/family/data/picks', { method: 'PUT', body: { value: { p1: data.picks.p1 } } })).json();
    assert.deepStrictEqual(Object.keys(res.value), ['p1']);
    assert.strictEqual((await call('/api/family/data/nope', { method: 'PUT', body: { value: 1 } })).status, 404);

    // Bodies bigger than the site-wide 20kb limit are fine here.
    const many = Array.from({ length: 300 }, (_, i) => ({ sport: 'cfb', gameId: `g${i}`, teamId: 't1', reason: 'watched', name: 'A team with a long name', label: 'vs Somebody Else Entirely', at: i + 1 }));
    res = await call('/api/family/data/stickers', { method: 'PUT', body: { value: { p1: many } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).value.p1.length, 301);
  } finally {
    await app.close();
  }
});

test('leagues: create, join by code, weekly leaderboard, bracket standings, leave', async () => {
  const app = await start();
  const mom = client(app.url);
  const grandpa = client(app.url);
  const stranger = client(app.url);
  try {
    await mom('/api/account/signup', { method: 'POST', body: { email: 'mom2@example.com', password: 'go-hokies-1', displayName: 'Mom' } });
    await grandpa('/api/account/signup', { method: 'POST', body: { email: 'pop@example.com', password: 'go-hokies-1', displayName: 'Grandpa' } });
    await stranger('/api/account/signup', { method: 'POST', body: { email: 'who@example.com', password: 'go-hokies-1' } });

    assert.strictEqual((await mom('/api/family/leagues', { method: 'POST', body: { name: '  ' } })).status, 400);
    let res = await mom('/api/family/leagues', { method: 'POST', body: { name: 'Underwood Family' } });
    assert.strictEqual(res.status, 201);
    const { league } = await res.json();
    assert.match(league.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.strictEqual(league.isOwner, true);

    assert.strictEqual((await grandpa('/api/family/leagues/join', { method: 'POST', body: { code: 'NOPE00' } })).status, 404);
    res = await grandpa('/api/family/leagues/join', { method: 'POST', body: { code: league.code.toLowerCase() } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).league.members.map((m) => m.name), ['Mom', 'Grandpa']);
    // Not a member: the league doesn't exist as far as they can tell.
    assert.strictEqual((await stranger(`/api/family/leagues/${league.id}/leaderboard`)).status, 404);

    // Mom's kid picked the finished game right, but that pick has to have
    // been saved before kickoff: it was saved just now, so it's late.
    await mom('/api/family/data/players', { method: 'PUT', body: { value: [{ id: 'k1', name: 'Sam', emoji: '🦊' }] } });
    await mom('/api/family/data/picks', { method: 'PUT', body: { value: { k1: { 'cfb:g1': pick('g1', 'h1', past), 'cfb:g2': pick('g2', 'h2', future) } } } });
    await grandpa('/api/family/data/players', { method: 'PUT', body: { value: [{ id: 'gp', name: 'Pop', emoji: '🐻' }] } });
    await grandpa('/api/family/data/picks', { method: 'PUT', body: { value: { gp: { 'cfb:g2': pick('g2', 'a2', future) } } } });

    // Pretend Sam's pick on g1 was saved two days ago (before kickoff).
    const { db } = require('../src/db');
    const row = db.prepare("SELECT user_id, value FROM kids_data WHERE key = 'picks' AND value LIKE '%k1%'").get();
    const picks = JSON.parse(row.value);
    picks.k1['cfb:g1'].pickedAt = now - 2 * DAY;
    db.prepare("UPDATE kids_data SET value = ? WHERE user_id = ? AND key = 'picks'").run(JSON.stringify(picks), row.user_id);

    res = await mom(`/api/family/leagues/${league.id}/leaderboard?sport=cfb`);
    let board = await res.json();
    assert.strictEqual(board.week.key, 'cfb-2026-2-10');
    assert.strictEqual(board.week.label, 'Week 10, 2026');
    assert.deepStrictEqual(board.rows.map((r) => [r.name, r.member, r.right, r.pending]), [['Sam', 'Mom', 1, 1], ['Pop', 'Grandpa', 0, 1]]);
    assert.deepStrictEqual(calls.at(-1), { sport: 'cfb', year: 2026, week: 10, seasontype: 2 });

    // A browser claiming a result doesn't change the score.
    await grandpa('/api/family/data/picks', { method: 'PUT', body: { value: { gp: { 'cfb:g2': pick('g2', 'a2', future, { result: { winnerId: 'a2' } }) } } } });
    board = await (await grandpa(`/api/family/leagues/${league.id}/leaderboard?sport=cfb&week=cfb-2026-2-10`)).json();
    assert.strictEqual(board.rows.find((r) => r.name === 'Pop').right, 0);

    // Bracket standings: a pick saved after the bowl started doesn't count.
    await mom('/api/family/data/brackets', { method: 'PUT', body: { value: { k1: { 'cfb:b1': { sport: 'cfb', season: 2026, gameId: 'b1', teamId: 'x', round: 'bowl' } } } } });
    const bracket = await (await mom(`/api/family/leagues/${league.id}/bracket?sport=cfb&season=2026`)).json();
    assert.deepStrictEqual(bracket.rows.map((r) => [r.name, r.points]), [['Pop', 0], ['Sam', 0]]);

    // Owner tools.
    assert.strictEqual((await grandpa(`/api/family/leagues/${league.id}/code`, { method: 'POST' })).status, 403);
    const fresh = (await (await mom(`/api/family/leagues/${league.id}/code`, { method: 'POST' })).json()).league;
    assert.notStrictEqual(fresh.code, league.code);

    // The owner leaves: Grandpa takes over. The last one out deletes it.
    await mom(`/api/family/leagues/${league.id}/members/me`, { method: 'DELETE' });
    const [gpLeague] = (await (await grandpa('/api/family/leagues')).json()).leagues;
    assert.strictEqual(gpLeague.isOwner, true);
    await grandpa(`/api/family/leagues/${league.id}/members/me`, { method: 'DELETE' });
    assert.deepStrictEqual((await (await grandpa('/api/family/leagues')).json()).leagues, []);
  } finally {
    await app.close();
  }
});

test('league pick\'em against the spread is scored on ESPN\'s line', async () => {
  const app = await start();
  const dad = client(app.url);
  try {
    await dad('/api/account/signup', { method: 'POST', body: { email: 'dad-ats@example.com', password: 'go-hokies-1', displayName: 'Dad' } });
    const { league } = await (await dad('/api/family/leagues', { method: 'POST', body: { name: 'Spread Family' } })).json();
    await dad('/api/family/data/players', { method: 'PUT', body: { value: [{ id: 'p1', name: 'Fav', emoji: '🦊' }, { id: 'p2', name: 'Dog', emoji: '🐻' }, { id: 'p3', name: 'Straight', emoji: '🐸' }] } });
    const g3 = (teamId, extra) => ({ sport: 'cfb', gameId: 'g3', teamId, week: 'cfb-2026-2-11', date: past, away: { id: 'a3', name: 'Away' }, home: { id: 'h3', name: 'Home' }, result: null, ...extra });
    await dad('/api/family/data/picks', { method: 'PUT', body: { value: {
      // Saved a made-up pick'em line: ESPN's -6.5 wins out, so the favorite didn't cover.
      p1: { 'cfb:g3': g3('h3', { spread: -1 }) },
      p2: { 'cfb:g3': g3('a3', { spread: -6.5 }) },
      p3: { 'cfb:g3': g3('h3') },
    } } });
    const { db } = require('../src/db');
    const row = db.prepare("SELECT user_id, value FROM kids_data WHERE key = 'picks' AND value LIKE '%cfb:g3%'").get();
    const picks = JSON.parse(row.value);
    assert.strictEqual(picks.p1['cfb:g3'].spread, -1, 'the line is kept on the pick');
    Object.values(picks).forEach((list) => { list['cfb:g3'].pickedAt = now - 2 * DAY; });
    db.prepare("UPDATE kids_data SET value = ? WHERE user_id = ? AND key = 'picks'").run(JSON.stringify(picks), row.user_id);
    const board = await (await dad(`/api/family/leagues/${league.id}/leaderboard?sport=cfb&week=cfb-2026-2-11`)).json();
    const by = Object.fromEntries(board.rows.map((r) => [r.name, [r.right, r.wrong]]));
    assert.deepStrictEqual(by, { Fav: [0, 1], Dog: [1, 0], Straight: [1, 0] });
  } finally {
    await app.close();
  }
});

test('league weeks roll day sports up into Monday-to-Sunday weeks', () => {
  const K = require('../public/js/kids-core.js');
  assert.strictEqual(K.weekGroup('nba-2026-11-04').key, 'nba-wk-20261102');
  assert.strictEqual(K.weekGroup('nba-20261108').key, 'nba-wk-20261102');
  assert.strictEqual(K.weekGroup('nba-wk-20261102').label, 'Week of Nov 2, 2026');
  assert.strictEqual(K.weekGroup('cfb-2026-3-1').label, 'Postseason, 2026');
  assert.strictEqual(K.weekGroup('garbage'), null);
});
