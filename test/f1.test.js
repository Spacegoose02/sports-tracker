const test = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { buildF1, parseStandings, pickWeekends, calendarOf } = require('../src/f1');

const calendar = [
  { label: 'Brazilian Grand Prix', startDate: '2026-11-06T04:00Z', endDate: '2026-11-08T04:59Z' },
  { label: 'Las Vegas Grand Prix', startDate: '2026-11-19T05:00Z', endDate: '2026-11-22T07:59Z' },
  { label: 'Qatar Grand Prix', startDate: '2026-11-27T05:00Z', endDate: '2026-11-29T18:59Z' },
];

const vegas = {
  id: '600',
  name: 'Las Vegas Grand Prix',
  date: '2026-11-20T00:30Z',
  endDate: '2026-11-22T07:59Z',
  circuit: { fullName: 'Las Vegas Strip Circuit', address: { city: 'Las Vegas', country: 'United States' } },
  competitions: [
    { type: { abbreviation: 'FP1' }, date: '2026-11-20T00:30Z', status: { type: { state: 'pre' } } },
    { type: { abbreviation: 'Qual' }, date: '2026-11-21T04:00Z', status: { type: { state: 'pre' } } },
    {
      type: { abbreviation: 'Race' },
      date: '2026-11-22T04:00Z',
      status: { type: { state: 'pre', completed: false } },
      competitors: [{ order: 1, athlete: { displayName: 'Entry List' } }],
    },
  ],
};

const brazil = {
  id: '599',
  name: 'Brazilian Grand Prix',
  date: '2026-11-06T14:30Z',
  circuit: { fullName: 'Autódromo José Carlos Pace', address: { city: 'São Paulo', country: 'Brazil' } },
  competitions: [{
    type: { abbreviation: 'Race' },
    date: '2026-11-08T17:00Z',
    status: { type: { state: 'post', completed: true } },
    competitors: [
      { order: 2, athlete: { displayName: 'Driver Two', shortName: 'D. Two' }, statistics: [{ name: 'behindTime', displayValue: '+1.234' }] },
      { order: 1, winner: true, athlete: { displayName: 'Driver One', shortName: 'D. One' }, team: { displayName: 'Team A' }, statistics: [{ name: 'totalTime', displayValue: '1:32:10.111' }] },
    ],
  }],
};

const standings = {
  season: { year: 2026 },
  children: [
    {
      name: 'Driver Standings',
      standings: { entries: [
        { athlete: { displayName: 'Driver Two', shortName: 'D. Two' }, stats: [{ name: 'rank', value: 2 }, { name: 'championshipPts', value: 300, displayValue: '300' }] },
        { athlete: { displayName: 'Driver One', shortName: 'D. One' }, stats: [{ name: 'rank', value: 1 }, { name: 'championshipPts', value: 350, displayValue: '350' }, { name: 'wins', value: 7, displayValue: '7' }] },
      ] },
    },
    {
      name: 'Constructor Standings',
      standings: { entries: [
        { team: { displayName: 'Team A', color: 'ff8000' }, stats: [{ name: 'rank', value: 1 }, { name: 'points', displayValue: '650' }] },
      ] },
    },
  ],
};

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [match, body] of routes) {
      if (url.endsWith(match)) {
        if (body instanceof Error) throw body;
        return body;
      }
    }
    throw new Error(`unexpected ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('f1: next race from the calendar, last race results fetched by date, standings parsed', async () => {
  const fetchJson = fakeFetch([
    ['/f1/scoreboard', { season: { year: 2026 }, leagues: [{ calendar }], events: [vegas] }],
    ['/f1/scoreboard?dates=20261106', { events: [brazil] }],
    ['/f1/standings', standings],
  ]);
  const data = await buildF1({ now: new Date('2026-11-16T04:00:00Z'), fetchJson });

  assert.strictEqual(data.season, 2026);
  assert.strictEqual(data.nextRace.name, 'Las Vegas Grand Prix');
  assert.strictEqual(data.nextRace.round, 2);
  assert.strictEqual(data.rounds, 3);
  assert.strictEqual(data.nextRace.date, '2026-11-22T04:00:00.000Z', 'race start, as full ISO');
  assert.strictEqual(data.nextRace.city, 'Las Vegas');
  assert.deepStrictEqual(data.nextRace.results, [], 'entry list is not a result');
  assert.deepStrictEqual(data.nextRace.sessions.map((s) => s.name), ['FP1', 'Qual', 'Race']);

  assert.strictEqual(data.lastRace.name, 'Brazilian Grand Prix');
  assert.deepStrictEqual(data.lastRace.results.map((r) => [r.position, r.shortName, r.time]), [[1, 'D. One', '1:32:10.111'], [2, 'D. Two', '+1.234']]);
  assert.strictEqual(data.lastRace.results[0].team, 'Team A');

  assert.deepStrictEqual(data.drivers.map((d) => [d.position, d.name, d.points]), [[1, 'Driver One', 350], [2, 'Driver Two', 300]]);
  assert.strictEqual(data.drivers[0].wins, 7);
  assert.deepStrictEqual(data.constructors.map((c) => [c.position, c.name, c.points, c.color]), [[1, 'Team A', 650, '#ff8000']]);
  assert.strictEqual(data.errors, undefined);
});

test('f1: standings still load when the schedule fails, and the error is reported', async () => {
  const fetchJson = fakeFetch([
    ['/f1/scoreboard', new Error('ESPN request failed: 503')],
    ['/f1/standings', standings],
  ]);
  const data = await buildF1({ now: new Date('2026-11-16T04:00:00Z'), fetchJson });
  assert.strictEqual(data.nextRace, null);
  assert.strictEqual(data.drivers.length, 2);
  assert.match(data.errors.schedule, /503/);
});

test('f1: off-season has a last race but no next race', () => {
  const picked = pickWeekends(calendarOf({ leagues: [{ calendar }] }), new Date('2026-12-15T00:00:00Z'));
  assert.strictEqual(picked.next, null);
  assert.strictEqual(picked.last.label, 'Qatar Grand Prix');
});

test('f1: standings fall back to list order when ESPN has no rank stat', () => {
  const parsed = parseStandings({ children: [{ name: 'Driver Standings', standings: { entries: [
    { athlete: { displayName: 'A' }, stats: [{ name: 'points', displayValue: '10' }] },
    { athlete: { displayName: 'B' }, stats: [] },
  ] } }] });
  assert.deepStrictEqual(parsed.drivers.map((d) => [d.position, d.name, d.points]), [[1, 'A', 10], [2, 'B', null]]);
  assert.deepStrictEqual(parsed.constructors, []);
});
