const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub node-fetch before anything loads it, so these tests never hit ESPN.
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-scorecard-'));
let responses = () => ({});
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch',
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: async (url) => ({ ok: true, status: 200, statusText: 'OK', json: async () => responses(String(url)) }),
};

const express = require('express');
const { pickGame, footballField, yardsFromOwnGoal } = require('../src/scorecard');

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

const HOUR = 60 * 60 * 1000;
const g = (id, date, state) => ({ id, date: new Date(date).toISOString(), status: { state, completed: state === 'post' } });

test('pickGame prefers live, then a fresh final, then the next game', () => {
  const now = Date.parse('2026-11-01T20:00:00Z');
  const old = g('1', now - 7 * 24 * HOUR, 'post');
  const recent = g('2', now - 4 * HOUR, 'post');
  const live = g('3', now - HOUR, 'in');
  const next = g('4', now + 3 * 24 * HOUR, 'pre');
  assert.strictEqual(pickGame([old, recent, live, next], now).id, '3');
  assert.strictEqual(pickGame([old, recent, next], now).id, '2');
  assert.strictEqual(pickGame([old, next], now).id, '4');
  assert.strictEqual(pickGame([old], now).id, '1');
  assert.strictEqual(pickGame([], now), null);
});

test('football field: ball and first-down line from the followed team\'s goal', () => {
  const team = { id: '259', abbreviation: 'VT', homeAway: 'away' };
  const opp = { id: '2567', abbreviation: 'SMU', homeAway: 'home' };
  // VT has it on the SMU 35, 2nd & 7: 65 yards from VT's goal, line at 72.
  let f = footballField({ possession: '259', possessionText: 'SMU 35', distance: 7, down: '2nd & 7', awayTimeouts: 2, homeTimeouts: 3 }, team, opp);
  assert.strictEqual(f.possession, 'team');
  assert.strictEqual(f.ball, 65);
  assert.strictEqual(f.firstDown, 72);
  assert.strictEqual(f.teamTimeouts, 2);
  assert.strictEqual(f.opponentTimeouts, 3);
  // SMU has it on its own 20: drawn 80 yards from VT's goal, heading left.
  f = footballField({ possession: '2567', possessionText: 'SMU 20', distance: 10 }, team, opp);
  assert.strictEqual(f.possession, 'opponent');
  assert.strictEqual(f.ball, 80);
  assert.strictEqual(f.firstDown, 70);
  assert.strictEqual(yardsFromOwnGoal({ possessionText: '50' }, team), 50);
});

const schedule = {
  season: { year: 2026 },
  events: [{
    id: '401',
    date: '2026-11-01T18:00:00Z',
    name: 'Carolina Hurricanes at Winnipeg Jets',
    competitions: [{
      venue: { fullName: 'Lenovo Center' },
      broadcasts: [{ names: ['ESPN+'] }],
      competitors: [
        { homeAway: 'home', score: '1', team: { id: '7', displayName: 'Carolina Hurricanes', abbreviation: 'CAR', color: 'cc0000' }, records: [{ summary: '11-2-2' }] },
        { homeAway: 'away', score: '0', team: { id: '28', displayName: 'Winnipeg Jets', abbreviation: 'WPG' }, records: [{ summary: '4-7-3' }] },
      ],
    }],
    status: { period: 1, displayClock: '10:00', type: { state: 'in', shortDetail: '10:00 - 1st' } },
  }],
};
const summary = {
  header: {
    id: '401',
    competitions: [{
      date: '2026-11-01T18:00:00Z',
      status: { period: 3, displayClock: '1:19', type: { state: 'in', detail: '1:19 - 3rd', shortDetail: '1:19 - 3rd' } },
      competitors: [
        { homeAway: 'home', score: '7', team: { id: '7', displayName: 'Carolina Hurricanes', abbreviation: 'CAR' } },
        { homeAway: 'away', score: '0', team: { id: '28', displayName: 'Winnipeg Jets', abbreviation: 'WPG' } },
      ],
    }],
  },
  boxscore: {
    teams: [
      { team: { displayName: 'Carolina Hurricanes' }, statistics: [{ name: 'shotsTotal', label: 'Shots', displayValue: '31' }] },
      { team: { displayName: 'Winnipeg Jets' }, statistics: [{ name: 'shotsTotal', label: 'Shots', displayValue: '24' }] },
    ],
  },
};

test('GET /api/ha/scorecards merges the live summary into a team scorecard', async () => {
  responses = (url) => {
    if (url.includes('/hockey/nhl/teams/7/schedule')) return schedule;
    if (url.includes('/hockey/nhl/teams/7')) return { team: { id: '7', displayName: 'Carolina Hurricanes', logos: [{ href: 'https://a.espncdn.com/car.png' }] } };
    if (url.includes('/hockey/nhl/summary')) return summary;
    if (url.includes('/racing/nascar-premier/scoreboard')) {
      return {
        events: [{
          id: '9',
          name: 'Xfinity 500',
          date: '2026-11-01T19:00:00Z',
          circuit: { fullName: 'Martinsville Speedway' },
          competitions: [{
            type: { abbreviation: 'Race' },
            status: { period: 212, type: { state: 'in', shortDetail: 'Lap 212' } },
            competitors: [
              { order: 2, athlete: { displayName: 'Denny Hamlin' }, vehicle: { number: '11' } },
              { order: 1, athlete: { displayName: 'Ryan Blaney' }, vehicle: { number: '12' } },
            ],
          }],
        }],
      };
    }
    return {};
  };
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/ha/scorecards?items=nhl:7,nascar,curling,cfb:bad!id,__proto__`);
    const body = await res.json();
    const nhl = body.scorecards['nhl:7'];
    assert.strictEqual(nhl.state, 'IN');
    assert.strictEqual(nhl.team.name, 'Carolina Hurricanes');
    assert.strictEqual(nhl.team.score, 7);
    assert.strictEqual(nhl.team.record, '11-2-2');
    assert.strictEqual(nhl.team.logo, 'https://a.espncdn.com/car.png');
    assert.strictEqual(nhl.opponent.score, 0);
    assert.strictEqual(nhl.event.clock, '1:19');
    assert.strictEqual(nhl.event.periodLabel, 'P3');
    assert.deepStrictEqual(nhl.stat, { label: 'Shots on Goal', team: '31', opponent: '24' });
    const race = body.scorecards.nascar;
    assert.strictEqual(race.kind, 'race');
    assert.strictEqual(race.race.lap, 212);
    assert.strictEqual(race.race.leaders[0].name, 'Ryan Blaney');
    assert.strictEqual(race.event.venue, 'Martinsville Speedway');
    assert.ok(body.scorecards.curling.error);
    assert.ok(body.scorecards['cfb:bad!id'].error);
    assert.ok(body.scorecards.__proto__.error);

    const missing = await fetch(`${base}/api/ha/scorecard?sport=nhl`);
    assert.strictEqual(missing.status, 400);
  });
});
