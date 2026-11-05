const test = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { computeRace, spotsFor } = require('../src/race');

const entry = (id, conf) => ({ team: { id, name: `Team ${id}`, abbreviation: id.toUpperCase() }, conference: conf, overall: null });
const game = (id, away, home) => ({ id, away, home });

test('conference race: clinched, controls destiny, needs tiebreakers, needs help and out', () => {
  const group = {
    name: 'Test Conference',
    entries: [entry('a', '7-0'), entry('b', '5-1'), entry('c', '5-1'), entry('d', '4-2'), entry('e', '1-6')],
  };
  // a is done. b and c play each other; d plays b; c plays e.
  const remaining = [game('g1', 'b', 'c'), game('g2', 'd', 'b'), game('g3', 'c', 'e')];
  const race = computeRace(group, remaining);
  const status = Object.fromEntries(race.teams.map((t) => [t.team.id, t.status]));
  assert.strictEqual(status.a, 'clinched');
  assert.strictEqual(status.b, 'control', 'b wins out: 7-1, c falls to at most 6-2');
  assert.strictEqual(status.c, 'control', 'c wins out: 7-1, b falls to at most 6-2');
  assert.strictEqual(status.d, 'out', 'd can reach 5-2 at best, and a plus the b/c winner finish ahead');
  assert.strictEqual(status.e, 'out');
  assert.strictEqual(race.spots, 2);
  assert.deepStrictEqual(race.teams.map((t) => t.team.id), ['a', 'b', 'c', 'd', 'e']);
  const b = race.teams.find((t) => t.team.id === 'b');
  assert.deepStrictEqual(b.left.map((g) => [g.home, g.opponent.id]), [[false, 'c'], [true, 'd']]);
  // Games against teams outside the conference are ignored.
  assert.strictEqual(computeRace(group, [game('x', 'a', 'zz')]).teams[0].left.length, 0);
});

test('conference race: a tie for the last spot needs tiebreakers', () => {
  // If b and c both win out, a, b and c all finish 6-1 for two spots.
  const group = { name: 'Tie Conference', entries: [entry('a', '6-0'), entry('b', '5-1'), entry('c', '5-1'), entry('e', '0-6')] };
  const race = computeRace(group, [game('g1', 'a', 'b'), game('g2', 'e', 'c')]);
  const status = Object.fromEntries(race.teams.map((t) => [t.team.id, t.status]));
  assert.strictEqual(status.b, 'tiebreak');
  assert.strictEqual(status.c, 'tiebreak');
});

test('conference race: winning out is not enough when a rival also has to lose', () => {
  const group = { name: 'Help Conference', entries: [entry('a', '5-1'), entry('b', '4-1'), entry('d', '4-2'), entry('e', '0-5'), entry('f', '0-6')] };
  const race = computeRace(group, [game('g1', 'b', 'e'), game('g2', 'd', 'f')]);
  const status = Object.fromEntries(race.teams.map((t) => [t.team.id, t.status]));
  assert.strictEqual(status.d, 'help');
  assert.strictEqual(status.b, 'control');
});

test('divisions send one team to the title game', () => {
  assert.strictEqual(spotsFor('Sun Belt - East'), 1);
  assert.strictEqual(spotsFor('Southeastern Conference'), 2);
});
