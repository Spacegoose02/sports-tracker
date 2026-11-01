const test = require('node:test');
const assert = require('node:assert');
const { resolveSecurityConfig, rateLimit, isSafeId, safeHttpUrl } = require('../src/security');

test('admin is locked in production with a placeholder password', () => {
  const cfg = resolveSecurityConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'changeme', SESSION_SECRET: 'x'.repeat(32) });
  assert.strictEqual(cfg.adminEnabled, false);
  assert.ok(cfg.warnings.some((w) => w.includes('ADMIN_PASSWORD')));
});

test('admin is locked in production with no password at all', () => {
  const cfg = resolveSecurityConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) });
  assert.strictEqual(cfg.adminEnabled, false);
});

test('admin works in production with a real password and secret', () => {
  const cfg = resolveSecurityConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'hokies-2026!', SESSION_SECRET: 'x'.repeat(32) });
  assert.strictEqual(cfg.adminEnabled, true);
  assert.strictEqual(cfg.sessionSecret, 'x'.repeat(32));
  assert.deepStrictEqual(cfg.warnings, []);
});

test('admin still works in development with the placeholder, with a warning', () => {
  const cfg = resolveSecurityConfig({ ADMIN_PASSWORD: 'changeme', SESSION_SECRET: 'x'.repeat(32) });
  assert.strictEqual(cfg.adminEnabled, true);
  assert.strictEqual(cfg.warnings.length, 1);
});

test('placeholder or short session secrets are replaced with a random one', () => {
  for (const secret of [undefined, 'change-this-too', 'please-change-this-to-a-random-string', 'short']) {
    const cfg = resolveSecurityConfig({ ADMIN_PASSWORD: 'real-password', SESSION_SECRET: secret });
    assert.notStrictEqual(cfg.sessionSecret, secret);
    assert.ok(cfg.sessionSecret.length >= 32);
    assert.ok(cfg.warnings.some((w) => w.includes('SESSION_SECRET')));
  }
});

test('rate limiter blocks after the limit and resets after the window', () => {
  let now = 0;
  const limiter = rateLimit({ windowMs: 1000, max: 2, now: () => now });
  const run = () => {
    let status = 200;
    let nextCalled = false;
    const res = { setHeader() {}, status(code) { status = code; return { json() {} }; } };
    limiter({ ip: '1.2.3.4' }, res, () => { nextCalled = true; });
    return nextCalled ? 200 : status;
  };
  assert.strictEqual(run(), 200);
  assert.strictEqual(run(), 200);
  assert.strictEqual(run(), 429);
  now = 1001;
  assert.strictEqual(run(), 200);
});

test('isSafeId only allows plain ids', () => {
  assert.ok(isSafeId('259'));
  assert.ok(isSafeId('401628374'));
  assert.ok(!isSafeId('259/../../x'));
  assert.ok(!isSafeId('259?x=1'));
  assert.ok(!isSafeId(''));
});

test('safeHttpUrl rejects non-http schemes', () => {
  assert.strictEqual(safeHttpUrl('https://www.espn.com/a'), 'https://www.espn.com/a');
  assert.strictEqual(safeHttpUrl('  http://x.com/b  '), 'http://x.com/b');
  assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeHttpUrl('data:text/html,hi'), null);
  assert.strictEqual(safeHttpUrl('not a url'), null);
  assert.strictEqual(safeHttpUrl(undefined), null);
});
