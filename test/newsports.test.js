// Soccer, WNBA, F1 and golf: the leagues added on top of the originals.
const test = require('node:test');
const assert = require('node:assert');
const { getSport } = require('../src/sports');
const espn = require('../src/espn');
const KidsCore = require('../public/js/kids-core.js');

test('new leagues are configured with the right shape', () => {
  assert.strictEqual(getSport('epl').kind, 'soccer');
  assert.strictEqual(getSport('mls').format, 'game');
  assert.strictEqual(getSport('ucl').standings, true);
  assert.strictEqual(getSport('wnba').kind, 'basketball');
  assert.strictEqual(getSport('f1').format, 'race');
  assert.strictEqual(getSport('golf').kind, 'golf');
  assert.strictEqual(getSport('golf').teams, false);
});

test('a golf leaderboard keeps to-par scores and tied positions', () => {
  const player = (order, name, score, pos) => ({ order, athlete: { displayName: name }, score, status: { position: { displayName: pos } } });
  const t = espn.normalizeRace({
    id: '401', name: 'The Open',
    competitions: [{ status: { type: { state: 'in' }, period: 3 }, competitors: [player(2, 'B', '-9', 'T2'), player(1, 'A', '-12', '1'), player(3, 'C', { displayValue: 'E' }, 'T2')] }],
  }, 'golf');
  assert.strictEqual(t.kind, 'golf');
  assert.deepStrictEqual(t.race.map((d) => [d.name, d.score, d.position]), [['A', '-12', '1'], ['B', '-9', 'T2'], ['C', 'E', 'T2']]);
});

test('soccer plays get kid explanations and goal celebrations', () => {
  assert.match(KidsCore.explainPlay('Goal! Arsenal 1, Chelsea 0. Bukayo Saka (Arsenal) left footed shot.', 'epl'), /GOAL!/);
  assert.match(KidsCore.explainPlay('Attempt saved. Cole Palmer right footed shot is saved in the centre of the goal.', 'epl'), /Save!/);
  assert.match(KidsCore.explainPlay('Declan Rice (Arsenal) is shown the yellow card.', 'epl'), /Yellow card/);
  assert.strictEqual(KidsCore.celebrationLabel('mls', 1), 'GOAL!');
  assert.strictEqual(KidsCore.family('ucl'), 'soccer');
});
