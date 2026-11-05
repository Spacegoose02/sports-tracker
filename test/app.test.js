const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

const REAL = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'x'.repeat(40) };

test('security headers are set', async () => {
  const app = await startApp(REAL);
  try {
    const res = await fetch(`${app.url}/`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.strictEqual(res.headers.get('x-powered-by'), null);
  } finally {
    await app.close();
  }
});

test('admin login is refused in production with the placeholder password', async () => {
  const app = await startApp({ NODE_ENV: 'production', ADMIN_PASSWORD: 'changeme' });
  try {
    const res = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'changeme' }),
    });
    assert.strictEqual(res.status, 503);
  } finally {
    await app.close();
  }
});

test('admin login works with the real password, then is rate limited', async () => {
  const app = await startApp(REAL);
  const login = (password) => fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  try {
    assert.strictEqual((await login('a-real-password')).status, 200);
    for (let i = 0; i < 9; i++) await login('wrong');
    assert.strictEqual((await login('a-real-password')).status, 429);
  } finally {
    await app.close();
  }
});

test('team and game ids with path characters are rejected', async () => {
  const app = await startApp(REAL);
  try {
    for (const path of ['/api/team/259%2F..%2F..%2Fx', '/api/game/1%3Fevent%3D2']) {
      const res = await fetch(`${app.url}${path}`);
      assert.strictEqual(res.status, 400, path);
    }
  } finally {
    await app.close();
  }
});

test('/healthz reports ok for the Docker healthcheck', async () => {
  const app = await startApp(REAL);
  try {
    const res = await fetch(`${app.url}/healthz`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
  }
});

test('games to watch: a ranked team trailing late is an upset alert', () => {
  const { loadShared } = require('./helpers');
  const CFB = loadShared();
  const team = (id, score, rank) => ({ id, score, curatedRank: rank });
  const live = (period, away, home) => ({ status: { state: 'in', period }, away, home });
  const upset = CFB.gameDrama(live(4, team('a', 17, null), team('h', 10, 12)), 'cfb');
  assert.ok(upset.tags.some((t) => t.key === 'upset'));
  assert.ok(upset.tags.some((t) => t.key === 'close'));
  const blowout = CFB.gameDrama(live(2, team('a', 3, null), team('h', 42, 1)), 'cfb');
  assert.deepEqual(blowout.tags, []);
  assert.ok(upset.score > blowout.score);
  assert.equal(CFB.gameDrama({ status: { state: 'pre' } }, 'cfb').score, 0);
  const ot = CFB.gameDrama(live(5, team('a', 3, null), team('h', 3, null)), 'nhl');
  assert.ok(ot.tags.some((t) => t.key === 'ot'));
});
