const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-accounts-'));

// ESPN stand-in: one team schedule, team info.
const GAME_DATE = '2026-11-07T20:00:00Z';
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
  exports: async (url) => {
    const u = String(url);
    const team = (id, name) => ({ homeAway: id === '259' ? 'home' : 'away', team: { id, displayName: name, abbreviation: name.slice(0, 3).toUpperCase() } });
    let body = {};
    if (/\/teams\/\d+\/schedule/.test(u)) {
      body = {
        season: { year: 2026 },
        events: [
          { id: '401', date: GAME_DATE, name: 'Florida State at Virginia Tech', shortName: 'FSU @ VT',
            competitions: [{ venue: { fullName: 'Lane Stadium, Blacksburg' }, broadcasts: [{ names: ['ACC Network'] }], status: { type: { state: 'pre' } },
              competitors: [team('259', 'Virginia Tech Hokies'), team('52', 'Florida State Seminoles')] }] },
          { id: '402', date: '2026-11-14T17:00:00Z', timeValid: false, name: 'Virginia Tech at Miami', shortName: 'VT @ MIA',
            competitions: [{ status: { type: { state: 'pre' } }, competitors: [team('259', 'Virginia Tech Hokies'), team('2390', 'Miami Hurricanes')] }] },
        ],
      };
    } else if (/\/teams\/\d+$/.test(u.split('?')[0])) {
      body = { team: { id: '259', displayName: 'Virginia Tech Hokies', abbreviation: 'VT', color: '630031', record: { items: [{ summary: '6-3' }] } } };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const { startApp } = require('./helpers');
const db = require('../src/db');
const alerts = require('../src/alerts');
const { foldLine, buildIcs } = require('../src/calendar');
const { safeNext } = require('../src/routes/account');

const ENV = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'y'.repeat(40) };

// Minimal cookie jar around fetch.
function client(base) {
  const jar = new Map();
  return async (pathname, { method = 'GET', body, headers = {}, redirect = 'manual' } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      redirect,
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

test('sign up, follow teams, merge local follows, sign out and back in', async () => {
  const app = await startApp(ENV);
  const call = client(app.url);
  try {
    assert.deepStrictEqual((await (await call('/api/account/me')).json()).user, null);
    assert.strictEqual((await call('/api/account/follows')).status, 401);

    let res = await call('/api/account/signup', { method: 'POST', body: { email: 'kid@example.com', password: 'short' } });
    assert.strictEqual(res.status, 400);
    res = await call('/api/account/signup', { method: 'POST', body: { email: 'Kid@Example.com', password: 'go-hokies-1', displayName: 'Sam' } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await res.json()).user.displayName, 'Sam');
    assert.strictEqual((await call('/api/account/signup', { method: 'POST', body: { email: 'kid@example.com', password: 'go-hokies-1' } })).status, 409);

    res = await call('/api/account/follows/merge', {
      method: 'POST',
      body: { follows: [
        { sport: 'cfb', id: '259', name: 'Virginia Tech Hokies', logo: 'javascript:alert(1)' },
        { sport: 'nba', id: '2', name: 'Boston Celtics' },
        { sport: 'ufc', id: '1' }, // no teams in UFC
        { sport: 'cfb', id: '../x' },
      ] },
    });
    const merged = (await res.json()).follows;
    assert.deepStrictEqual(merged.map((t) => `${t.sport}:${t.id}`), ['cfb:259', 'nba:2']);
    assert.strictEqual(merged[0].logo, null, 'unsafe logo URLs are dropped');

    await call('/api/account/follows/nba/2', { method: 'DELETE' });
    const me = await (await call('/api/account/me')).json();
    assert.deepStrictEqual(me.follows.map((t) => t.id), ['259']);
    assert.match(me.feed.calendarUrl, /\/calendar\/[A-Za-z0-9_-]{20,}\.ics$/);
    assert.ok(me.feed.webcalUrl.startsWith('webcal:'));

    await call('/api/account/logout', { method: 'POST' });
    assert.strictEqual((await (await call('/api/account/me')).json()).user, null);

    assert.strictEqual((await call('/api/account/login', { method: 'POST', body: { email: 'kid@example.com', password: 'wrong-password' } })).status, 401);
    assert.strictEqual((await call('/api/account/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'go-hokies-1' } })).status, 401);
    res = await call('/api/account/login', { method: 'POST', body: { email: 'KID@example.com ', password: 'go-hokies-1' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await (await call('/api/account/follows')).json()).follows.map((t) => t.id), ['259']);
  } finally {
    await app.close();
  }
});

test('signup can be turned off', async () => {
  const app = await startApp({ ...ENV, ALLOW_SIGNUP: 'false' });
  try {
    const res = await client(app.url)('/api/account/signup', { method: 'POST', body: { email: 'new@example.com', password: 'long-enough-1' } });
    assert.strictEqual(res.status, 403);
  } finally {
    await app.close();
  }
});

test('calendar feed and teams API work with the private key, and the key can be reset', async () => {
  const user = db.createUser({ email: 'cal@example.com', displayName: 'Cal' });
  db.addFollow(user.id, { sport: 'cfb', id: '259', name: 'Virginia Tech Hokies' });
  const app = await startApp(ENV);
  try {
    let res = await fetch(`${app.url}/calendar/${user.feed_token}.ics`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/calendar/);
    const ics = await res.text();
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /UID:cfb-401@cfb-tracker/);
    assert.match(ics, /DTSTART:20261107T200000Z/);
    assert.match(ics, /DTEND:20261107T233000Z/);
    assert.match(ics, /SUMMARY:Florida State Seminoles at Virginia Tech Hokies/);
    assert.match(ics, /LOCATION:Lane Stadium\\, Blacksburg/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261114/, 'TBA kickoff is an all-day entry');
    assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));

    assert.strictEqual((await fetch(`${app.url}/calendar/not-a-real-key-at-all-xx.ics`)).status, 404);

    res = await fetch(`${app.url}/calendar.ics?teams=cfb:259,ufc:1,cfb:../x`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /UID:cfb-401@cfb-tracker/);

    assert.strictEqual((await fetch(`${app.url}/api/account/teams`)).status, 401);
    res = await fetch(`${app.url}/api/account/teams`, { headers: { Authorization: `Bearer ${user.feed_token}` } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.user.displayName, 'Cal');
    assert.strictEqual(data.teams.length, 1);
    const [team] = data.teams;
    assert.strictEqual(team.name, 'Virginia Tech Hokies');
    assert.strictEqual(team.record, '6-3');
    assert.strictEqual(team.color, '#630031');
    assert.ok(team.url.endsWith('/team.html?id=259&source=espn&sport=cfb'));
    assert.strictEqual(team.liveGame, null);
    assert.strictEqual(team.lastGame, null);

    const old = user.feed_token;
    db.resetFeedToken(user.id);
    assert.strictEqual((await fetch(`${app.url}/calendar/${old}.ics`)).status, 404);
    assert.strictEqual((await fetch(`${app.url}/api/account/teams`, { headers: { Authorization: `Bearer ${old}` } })).status, 401);
  } finally {
    await app.close();
  }
});

test('long calendar lines are folded at 75 bytes without splitting characters', () => {
  const folded = foldLine(`DESCRIPTION:${'é'.repeat(80)}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => Buffer.byteLength(l) <= 75));
  assert.strictEqual(lines.map((l, i) => (i ? l.slice(1) : l)).join(''), `DESCRIPTION:${'é'.repeat(80)}`);
  assert.doesNotThrow(() => buildIcs([], {}));
});

test('SSO signs in through an OpenID provider and links an existing email account', async () => {
  db.createUser({ email: 'parent@example.com', displayName: 'Parent', passwordHash: 'x' });
  const issuer = 'https://auth.example.com';
  const seen = {};
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u === `${issuer}/.well-known/openid-configuration`) {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/api/oidc/token`, userinfo_endpoint: `${issuer}/api/oidc/userinfo` });
    }
    if (u.endsWith('/token')) {
      seen.token = { auth: opts.headers.Authorization, body: new URLSearchParams(opts.body) };
      return json({ access_token: 'at-123', token_type: 'Bearer' });
    }
    if (u.endsWith('/userinfo')) {
      seen.userinfo = opts.headers.Authorization;
      return json({ sub: 'user-1', email: 'Parent@example.com', email_verified: true, name: 'Pat' });
    }
    return json({}, 404);
  };
  const { createApp } = require('../src/app');
  const app = createApp({ env: { ...ENV, SSO_ISSUER: `${issuer}/`, SSO_CLIENT_ID: 'tracker', SSO_CLIENT_SECRET: 's3cret', PUBLIC_URL: 'https://sports.example.com' }, logger: { warn() {} }, sso: { fetch: fakeFetch } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = client(`http://127.0.0.1:${server.address().port}`);
  try {
    const me = await (await call('/api/account/me')).json();
    assert.deepStrictEqual(me.options.sso, { label: 'Tinyauth' });

    let res = await call('/auth/sso/login?next=/team.html%3Fid%3D259');
    assert.strictEqual(res.status, 302);
    const authorize = new URL(res.headers.get('location'));
    assert.strictEqual(authorize.origin + authorize.pathname, `${issuer}/authorize`);
    assert.strictEqual(authorize.searchParams.get('client_id'), 'tracker');
    assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'https://sports.example.com/auth/sso/callback');
    assert.strictEqual(authorize.searchParams.get('code_challenge_method'), 'S256');
    const state = authorize.searchParams.get('state');

    // Wrong state is refused.
    res = await call(`/auth/sso/callback?code=abc&state=nope`);
    assert.strictEqual(res.headers.get('location'), '/account.html?error=sso');

    res = await call('/auth/sso/login?next=//evil.example');
    const state2 = new URL(res.headers.get('location')).searchParams.get('state');
    res = await call(`/auth/sso/callback?code=abc&state=${encodeURIComponent(state2)}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/account.html', 'off-site next is ignored');
    assert.strictEqual(seen.token.auth, `Basic ${Buffer.from('tracker:s3cret').toString('base64')}`);
    assert.strictEqual(seen.token.body.get('code'), 'abc');
    assert.ok(seen.token.body.get('code_verifier'));
    assert.strictEqual(seen.userinfo, 'Bearer at-123');
    assert.ok(state);

    const after = await (await call('/api/account/me')).json();
    assert.strictEqual(after.user.email, 'parent@example.com');
    assert.strictEqual(after.user.sso, true);
    assert.strictEqual(after.user.hasPassword, true, 'linked to the existing account');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('safeNext keeps same-site paths only', () => {
  assert.strictEqual(safeNext('/team.html?id=1'), '/team.html?id=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', undefined]) {
    assert.strictEqual(safeNext(bad), '/account.html');
  }
});

test('game alerts go out once on start and once on the final, only to followers', async () => {
  const fan = db.createUser({ email: 'fan@example.com' });
  const other = db.createUser({ email: 'other@example.com' });
  const quiet = db.createUser({ email: 'quiet@example.com' });
  db.addFollow(fan.id, { sport: 'nfl', id: '17' });
  db.addFollow(other.id, { sport: 'nfl', id: '99' });
  db.addFollow(quiet.id, { sport: 'nfl', id: '17' });
  db.updateUser(quiet.id, { alertStart: false });
  const sub = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: 'p', auth: 'a' } });
  db.savePushSubscription(fan.id, sub('fan'));
  db.savePushSubscription(other.id, sub('other'));
  db.savePushSubscription(quiet.id, sub('quiet'));

  const sent = [];
  const send = async (recipients, payload) => { sent.push({ to: recipients.map((r) => r.endpoint).sort(), payload }); };
  const now = Date.parse('2026-11-08T18:10:00Z');
  const game = (state, extra = {}) => ({
    id: '9001', date: '2026-11-08T18:00:00Z', broadcast: 'CBS',
    status: { state, completed: state === 'post', detail: state === 'post' ? 'Final' : '' },
    home: { id: '17', shortName: 'Patriots', score: state === 'pre' ? null : 24 },
    away: { id: '15', shortName: 'Dolphins', score: state === 'pre' ? null : 20 },
    ...extra,
  });
  const followed = new Set(['17', '99']);

  await alerts.checkGames('nfl', [game('pre')], followed, { now, send });
  assert.strictEqual(sent.length, 0);
  await alerts.checkGames('nfl', [game('in')], followed, { now, send });
  await alerts.checkGames('nfl', [game('in')], followed, { now, send });
  assert.strictEqual(sent.length, 1, 'start alert sent once');
  assert.deepStrictEqual(sent[0].to, ['https://push.example.com/fan']);
  assert.match(sent[0].payload.title, /Dolphins at Patriots has started/);
  assert.match(sent[0].payload.url, /^\/game\.html\?id=9001&source=espn&sport=nfl$/);

  await alerts.checkGames('nfl', [game('post')], followed, { now, send });
  await alerts.checkGames('nfl', [game('post')], followed, { now, send });
  assert.strictEqual(sent.length, 2, 'final alert sent once');
  assert.deepStrictEqual(sent[1].to, ['https://push.example.com/fan', 'https://push.example.com/quiet']);
  assert.match(sent[1].payload.title, /^Final: Dolphins 20, Patriots 24$/);

  // A game already long underway when first seen (e.g. after a restart)
  // doesn't send a stale start alert, nor a final.
  const late = game('in', { id: '9002', date: '2026-11-08T15:00:00Z' });
  await alerts.checkGames('nfl', [late], followed, { now, send });
  assert.strictEqual(sent.length, 2);
  await alerts.checkGames('nfl', [{ ...game('post'), id: '9003' }], followed, { now, send });
  assert.strictEqual(sent.length, 2, 'no final for a game never seen live');
});

test('dead push subscriptions are removed', async () => {
  const push = require('../src/push');
  const user = db.createUser({ email: 'gone@example.com' });
  db.savePushSubscription(user.id, { endpoint: 'https://push.example.com/gone', keys: { p256dh: 'p', auth: 'a' } });
  const delivered = await push.sendToSubscriptions(db.pushSubscriptionsForUser(user.id), { title: 't' }, {
    send: async () => { const err = new Error('gone'); err.statusCode = 410; throw err; },
  });
  assert.strictEqual(delivered, 0);
  assert.strictEqual(db.countPushSubscriptions(user.id), 0);
});
