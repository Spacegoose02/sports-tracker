const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-recap-'));

const ds = require('../src/datasource');
const db = require('../src/db');
const { createApp } = require('../src/app');
const recap = require('../src/recap');

const ENV = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'z'.repeat(40) };
const NOW = Date.parse('2026-11-02T15:45:00Z'); // 7:45 AM in Los Angeles, 10:45 AM in New York

// Virginia Tech beat Florida State on Sunday night and plays Miami on
// Saturday (time TBD); a second followed team has nothing going on.
const VT = { id: '259', name: 'Virginia Tech Hokies', shortName: 'Virginia Tech', abbreviation: 'VT' };
function stubEspn() {
  const saved = { getTeamSchedule: ds.getTeamSchedule, getTeamInfo: ds.getTeamInfo, getNews: ds.getNews };
  ds.getTeamSchedule = async (id) => ({
    games: id !== '259' ? [] : [
      { id: '401', date: '2026-11-01T23:00:00Z', name: 'Florida State at Virginia Tech',
        status: { state: 'post', detail: 'Final' },
        home: { ...VT, score: 31 }, away: { id: '52', shortName: 'Florida State', score: 24 } },
      { id: '402', date: '2026-11-07T17:00:00Z', timeValid: false, broadcast: 'ACC Network', name: 'Virginia Tech at Miami',
        status: { state: 'pre' }, home: { id: '2390', shortName: 'Miami', rank: 9 }, away: { ...VT } },
    ],
  });
  ds.getTeamInfo = async (id) => (id === '259' ? { ...VT, record: '7-2', rank: 22 } : { id, name: 'Idle U' });
  ds.getNews = async ({ team }) => (team === '259' ? [{ title: 'Hokies climb into the AP poll' }] : []);
  return () => Object.assign(ds, saved);
}

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); return reply(req); } } },
  };
}

const scrappyReply = () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ headline: 'Hokies hold off FSU 31-24', recap: 'Big night in Blacksburg! Virginia Tech beat Florida State 31-24. Next up: at #9 Miami Saturday on ACC Network.' }) }],
});

test('a recap is due once a day at the user\'s local time', () => {
  const user = { recap_enabled: 1, recap_time: '07:30', recap_tz: 'America/Los_Angeles' };
  assert.strictEqual(recap.isDue(user, null, NOW), true);
  assert.strictEqual(recap.isDue(user, { date: '2026-11-01' }, NOW), true);
  assert.strictEqual(recap.isDue(user, { date: '2026-11-02' }, NOW), false, 'already sent today');
  assert.strictEqual(recap.isDue(user, null, Date.parse('2026-11-02T15:00:00Z')), false, 'too early (7:00)');
  assert.strictEqual(recap.isDue(user, null, Date.parse('2026-11-02T18:31:00Z')), false, 'too late after downtime (10:31)');
  assert.strictEqual(recap.isDue({ ...user, recap_enabled: 0 }, null, NOW), false, 'opted out');
  assert.strictEqual(recap.isDue({ ...user, recap_tz: 'America/New_York', recap_time: '09:00' }, null, NOW), true);
  assert.deepStrictEqual(recap.localParts(NOW, 'Asia/Tokyo'), { date: '2026-11-03', minutes: 45 });
  assert.strictEqual(recap.cleanTime('7:30'), null);
  assert.strictEqual(recap.cleanTime('23:59'), '23:59');
  assert.strictEqual(recap.isValidTimeZone('Mars/Base'), false);
});

test('facts and the plain recap cover results, next games and quiet teams', () => {
  const summaries = [
    {
      sport: 'cfb', sportLabel: 'College Football', id: '259', name: 'Virginia Tech Hokies', record: '7-2', rank: 22,
      lastGame: { date: '2026-11-01T23:00:00Z', status: { detail: 'Final' }, home: { id: '259', score: 31 }, away: { id: '52', shortName: 'Florida State', score: 24 } },
      nextGame: { date: '2026-11-07T17:00:00Z', timeValid: false, broadcast: 'ACC Network', home: { id: '2390', shortName: 'Miami', rank: 9 }, away: { id: '259' } },
    },
    // A result from last week is too old for a morning recap.
    { sport: 'nfl', id: '17', name: 'New England Patriots', lastGame: { date: '2026-10-26T17:00:00Z', home: { id: '17', score: 10 }, away: { id: '1', score: 3 } } },
  ];
  const facts = recap.factsFromSummaries(summaries, { now: NOW, timeZone: 'America/New_York' });
  assert.deepStrictEqual(facts[0].result, { opponent: 'Florida State', home: true, teamScore: 31, opponentScore: 24, outcome: 'W', status: 'Final' });
  assert.strictEqual(facts[0].next.when, 'Sat, Nov 7, time TBD');
  assert.strictEqual(facts[0].next.home, false);
  assert.strictEqual(facts[1].result, null);
  assert.strictEqual(recap.hasNews(facts), true);
  assert.strictEqual(recap.hasNews([facts[1]]), false);

  const plain = recap.basicRecap(facts, { displayName: 'Sam' });
  assert.strictEqual(plain.headline, 'Virginia Tech Hokies won!');
  assert.match(plain.text, /^Morning, Sam!/);
  assert.match(plain.text, /#22 Virginia Tech Hokies \(7-2\): beat Florida State 31-24; next: at #9 Miami, Sat, Nov 7, time TBD on ACC Network\./);
  assert.doesNotMatch(plain.text, /Patriots/);
  assert.strictEqual(recap.basicRecap([facts[1]]).headline, 'Quiet day for your teams');

  const note = recap.notification({ headline: 'H', text: 'word '.repeat(100) });
  assert.ok(note.body.length <= 300);
  assert.strictEqual(note.tag, 'daily-recap');
});

test('settings, send-now, and the feed-key endpoints for Home Assistant and Den Duty', async () => {
  const restore = stubEspn();
  const client = fakeClient(scrappyReply);
  const pushes = [];
  const send = async (subs, payload) => { pushes.push({ subs, payload }); return subs.length; };
  const app = createApp({ env: ENV, logger: { warn() {} }, scrappy: { client }, recap: { send } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  try {
    assert.strictEqual((await call('/api/account/signup', { method: 'POST', body: { email: 'recap@example.com', password: 'password123', displayName: 'Sam' } })).status, 201);

    let res = await call('/api/account/recap/now', { method: 'POST' });
    assert.strictEqual(res.status, 400, 'needs a followed team');

    await call('/api/account/follows', { method: 'POST', body: { sport: 'cfb', id: '259', name: 'Virginia Tech Hokies' } });
    await call('/api/account/follows', { method: 'POST', body: { sport: 'nfl', id: '17', name: 'New England Patriots' } });

    // Off by default.
    let me = await (await call('/api/account/me')).json();
    assert.strictEqual(me.user.recapEnabled, false);
    assert.strictEqual(me.user.recapTime, '07:30');
    assert.match(me.feed.recapApiUrl, /\/api\/account\/recap$/);

    assert.strictEqual((await call('/api/account/me', { method: 'PATCH', body: { recapTime: '7:30am' } })).status, 400);
    assert.strictEqual((await call('/api/account/me', { method: 'PATCH', body: { recapTimeZone: 'Nowhere/Land' } })).status, 400);
    res = await call('/api/account/me', { method: 'PATCH', body: { recapEnabled: true, recapTime: '06:45', recapTimeZone: 'America/Chicago' } });
    me = await res.json();
    assert.deepStrictEqual([me.user.recapEnabled, me.user.recapTime, me.user.recapTimeZone], [true, '06:45', 'America/Chicago']);

    // A device with alerts on gets the recap.
    const userId = me.user.id;
    db.savePushSubscription(userId, { endpoint: 'https://push.example.com/recap', keys: { p256dh: 'p', auth: 'a' } });

    res = await call('/api/account/recap/now', { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const sent = await res.json();
    assert.strictEqual(sent.delivered, 1);
    assert.strictEqual(sent.recap.headline, 'Hokies hold off FSU 31-24');
    assert.strictEqual(sent.recap.source, 'scrappy');
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].payload.title, 'Hokies hold off FSU 31-24');
    assert.strictEqual(pushes[0].payload.url, '/account.html#recap');

    // Scrappy got the facts and was asked for structured JSON.
    const req = client.calls[0];
    assert.strictEqual(req.model, 'claude-opus-5-5');
    assert.strictEqual(req.output_config.format.type, 'json_schema');
    assert.deepStrictEqual(req.output_config.format.schema.required, ['headline', 'recap']);
    assert.match(req.messages[0].content, /Fan's name: Sam/);
    assert.match(req.messages[0].content, /Florida State/);
    assert.match(req.messages[0].content, /Hokies climb into the AP poll/);
    assert.doesNotMatch(req.messages[0].content, /Patriots/, 'quiet teams are left out of the prompt');

    // Home Assistant / Den Duty read it with the feed key, no cookie.
    const key = db.getUser(userId).feed_token;
    const saved = cookie;
    cookie = '';
    assert.strictEqual((await call('/api/account/recap')).status, 401);
    const viaKey = await (await call('/api/account/recap', { headers: { Authorization: `Bearer ${key}` } })).json();
    assert.strictEqual(viaKey.enabled, true);
    assert.strictEqual(viaKey.time, '06:45');
    assert.strictEqual(viaKey.recap.text.startsWith('Big night in Blacksburg'), true);
    assert.strictEqual(viaKey.recap.teams.find((t) => t.id === '259').result.outcome, 'W');
    const teams = await (await call('/api/account/teams', { headers: { Authorization: `Bearer ${key}` } })).json();
    assert.strictEqual(teams.recap.headline, 'Hokies hold off FSU 31-24');
    cookie = saved;
  } finally {
    restore();
    await new Promise((r) => server.close(r));
  }
});

test('the scheduler sends each opted-in user one recap a day, falling back without Scrappy', async () => {
  const restore = stubEspn();
  try {
    const fan = db.createUser({ email: 'morning@example.com', displayName: 'Pat' });
    db.addFollow(fan.id, { sport: 'cfb', id: '259', name: 'Virginia Tech Hokies' });
    db.updateUser(fan.id, { recapEnabled: true, recapTime: '07:30', recapTz: 'America/Los_Angeles' });
    db.savePushSubscription(fan.id, { endpoint: 'https://push.example.com/morning', keys: { p256dh: 'p', auth: 'a' } });
    // Opted out: never gets one.
    const off = db.createUser({ email: 'nope@example.com' });
    db.addFollow(off.id, { sport: 'cfb', id: '259' });

    const pushes = [];
    const send = async (subs, payload) => { pushes.push({ to: subs.map((s) => s.endpoint), payload }); return subs.length; };
    // No API key: the plain recap.
    const recapper = recap.createRecapper({ env: {}, logger: { warn() {} }, send });
    assert.strictEqual(recapper.scrappy, false);

    await recapper.runDue({ now: Date.parse('2026-11-02T15:00:00Z') }); // 7:00 local
    assert.strictEqual(pushes.filter((p) => p.to.includes('https://push.example.com/morning')).length, 0);

    await recapper.runDue({ now: NOW }); // 7:45 local
    await recapper.runDue({ now: NOW + 60 * 1000 });
    const mine = pushes.filter((p) => p.to.includes('https://push.example.com/morning'));
    assert.strictEqual(mine.length, 1, 'once a day');
    assert.strictEqual(mine[0].payload.title, 'Virginia Tech Hokies won!');
    assert.strictEqual(db.getRecap(fan.id).source, 'basic');
    assert.strictEqual(db.getRecap(fan.id).date, '2026-11-02');
    assert.strictEqual(db.getRecap(off.id), null);

    // Scrappy failing (bad JSON) also falls back to the plain recap.
    const broken = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }));
    const writer = recap.createRecapWriter({ client: broken, logger: { warn() {} } });
    const out = await writer.write([], { displayName: 'Pat' });
    assert.strictEqual(out.source, 'basic');
    assert.strictEqual(broken.calls.length, 1);
  } finally {
    restore();
  }
});
