// Opt-in alerts: every score by a followed team, close finishes and upsets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-smart-alerts-'));
const db = require('../src/db');
const alerts = require('../src/alerts');
const drama = require('../src/drama');

const sub = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: 'p', auth: 'a' } });

function setup() {
  const fan = db.createUser({ email: `fan${Math.random()}@example.com` });
  const watcher = db.createUser({ email: `watch${Math.random()}@example.com` });
  const hockey = db.createUser({ email: `hockey${Math.random()}@example.com` });
  db.addFollow(fan.id, { sport: 'cfb', id: '259' });
  db.addFollow(watcher.id, { sport: 'cfb', id: '1' });
  db.addFollow(hockey.id, { sport: 'nhl', id: '5' });
  db.updateUser(fan.id, { alertScore: true });
  db.updateUser(watcher.id, { alertClose: true, alertUpset: true });
  db.updateUser(hockey.id, { alertClose: true, alertUpset: true });
  db.savePushSubscription(fan.id, sub(`fan-${fan.id}`));
  db.savePushSubscription(watcher.id, sub(`watch-${watcher.id}`));
  db.savePushSubscription(hockey.id, sub(`hockey-${hockey.id}`));
  return { fan, watcher, hockey };
}

const game = (id, { period = 2, home = 0, away = 0, homeRank = null, awayRank = null } = {}) => ({
  id, date: '2026-11-07T20:00:00Z', broadcast: 'ACCN',
  status: { state: 'in', period, shortDetail: `Q${period}` },
  home: { id: '259', shortName: 'Hokies', score: home, curatedRank: homeRank },
  away: { id: '52', shortName: 'Seminoles', score: away, curatedRank: awayRank },
});

test('a score alert goes out for each new score a followed team makes, once', async () => {
  const { fan } = setup();
  const sent = [];
  const send = async (to, payload) => { sent.push({ to: to.map((r) => r.endpoint), payload }); };
  const now = Date.parse('2026-11-07T23:00:00Z');
  const followed = new Set(['259']);
  await alerts.checkGames('cfb', [game('s1', { home: 0 })], followed, { now, send });
  assert.strictEqual(sent.filter((s) => /TOUCHDOWN|FIELD/.test(s.payload.title)).length, 0, 'first sight is quiet');
  await alerts.checkGames('cfb', [game('s1', { home: 7 })], followed, { now, send });
  await alerts.checkGames('cfb', [game('s1', { home: 7 })], followed, { now, send });
  await alerts.checkGames('cfb', [game('s1', { home: 10 })], followed, { now, send });
  const scores = sent.filter((s) => s.payload.tag.endsWith('-score'));
  assert.deepStrictEqual(scores.map((s) => s.payload.title), ['TOUCHDOWN! Hokies', 'FIELD GOAL! Hokies']);
  assert.deepStrictEqual(scores[0].to, [`https://push.example.com/fan-${fan.id}`]);
});

test('close finishes and upsets alert people who follow the sport, once per game', async () => {
  const { watcher } = setup();
  const sent = [];
  const send = async (to, payload) => { sent.push({ to: to.map((r) => r.endpoint), payload }); };
  const followed = new Set();
  // Early in the game: neither.
  await alerts.checkGames('cfb', [game('c1', { period: 1, home: 3, away: 0, homeRank: 4 })], followed, { send });
  assert.strictEqual(sent.length, 0);
  // Third quarter, No. 4 losing to an unranked team: upset, not yet close.
  await alerts.checkGames('cfb', [game('c1', { period: 3, home: 10, away: 21, homeRank: 4 })], followed, { send });
  // Fourth quarter, one score: close. Upset stays sent once.
  await alerts.checkGames('cfb', [game('c1', { period: 4, home: 17, away: 21, homeRank: 4 })], followed, { send });
  await alerts.checkGames('cfb', [game('c1', { period: 4, home: 17, away: 21, homeRank: 4 })], followed, { send });
  assert.deepStrictEqual(sent.map((s) => s.payload.tag), ['cfb-c1-upset', 'cfb-c1-close']);
  assert.match(sent[0].payload.title, /^Upset alert: No\. 4 Hokies is losing$/);
  assert.ok(sent[1].to.includes(`https://push.example.com/watch-${watcher.id}`));
  assert.ok(!sent[1].to.some((e) => e.includes('hockey')), 'only people who follow this sport');
});

test('drama helpers', () => {
  assert.strictEqual(drama.isCloseFinish(game('x', { period: 4, home: 20, away: 14 }), 'cfb'), true);
  assert.strictEqual(drama.isCloseFinish(game('x', { period: 4, home: 30, away: 14 }), 'cfb'), false);
  assert.strictEqual(drama.isCloseFinish({ ...game('x', { period: 2, home: 1, away: 1 }) }, 'epl'), true);
  assert.strictEqual(drama.isUpsetBrewing(game('x', { period: 1, home: 0, away: 7, homeRank: 3 }), 'cfb'), null);
});
