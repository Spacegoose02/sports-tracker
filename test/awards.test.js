const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-awards-'));
const awards = require('../src/awards');

const athlete = (id, name, position) => ({ id, name, position });
const team = (id, name) => ({ id, name });
const LEADERS = {
  categories: [
    { name: 'passingYards', leaders: [
      { value: '3,400', athlete: athlete('1', 'Star QB', 'QB'), team: team('259', 'Virginia Tech') },
      { value: '3,500', athlete: athlete('2', 'Stat QB', 'QB'), team: team('99', 'Nobody U') },
    ] },
    { name: 'passingTouchdowns', leaders: [{ value: '30', athlete: athlete('1', 'Star QB', 'QB') }, { value: '28', athlete: athlete('2', 'Stat QB', 'QB') }] },
    { name: 'rushingYards', leaders: [{ value: '1,600', athlete: athlete('3', 'Big RB', 'RB'), team: team('52', 'FSU') }] },
    { name: 'rushingTouchdowns', leaders: [{ value: '18', athlete: athlete('3', 'Big RB', 'RB') }] },
    { name: 'receivingYards', leaders: [{ value: '1,300', athlete: athlete('4', 'Fast WR', 'WR'), team: team('52', 'FSU') }] },
    { name: 'sacks', leaders: [{ value: '14', athlete: athlete('5', 'Edge', 'DE'), team: team('52', 'FSU') }] },
    { name: 'totalTackles', leaders: [{ value: '120', athlete: athlete('6', 'Mike', 'LB'), team: team('99', 'Nobody U') }] },
  ],
};

test('award races rank players by their award formula, with a ranked-team bonus', async () => {
  const deps = {
    getLeaders: async () => LEADERS,
    getRankings: async () => ({ polls: [{ name: 'AP Top 25', ranks: [{ rank: 2, team: { id: '259' } }] }] }),
    getStandings: async () => ({ conferences: [] }),
  };
  const data = await awards.getAwards({ sport: 'cfb', now: new Date('2026-11-08T12:00:00Z') }, deps);
  const by = Object.fromEntries(data.awards.map((a) => [a.key, a.rows.map((r) => r.athlete.name)]));
  assert.strictEqual(by.heisman[0], 'Star QB', 'the ranked team bonus beats slightly better stats');
  assert.deepStrictEqual(by.obrien, ['Star QB', 'Stat QB']);
  assert.deepStrictEqual(by.walker, ['Big RB']);
  assert.deepStrictEqual(by.biletnikoff, ['Fast WR']);
  assert.deepStrictEqual(by.nagurski, ['Mike', 'Edge']);
  assert.ok(!by.heisman.includes('Edge'), 'defenders stay out of offensive races');
  assert.strictEqual(data.week, '2026-W45');
  assert.strictEqual(data.awards[0].rows[0].lastWeek, null);

  // Next week: the order flips and the arrows say so.
  const flipped = { categories: LEADERS.categories.map((c) => (c.name === 'passingTouchdowns'
    ? { ...c, leaders: [{ value: '30', athlete: athlete('1', 'Star QB', 'QB') }, { value: '45', athlete: athlete('2', 'Stat QB', 'QB') }] } : c)) };
  const next = await awards.getAwards({ sport: 'cfb', now: new Date('2026-11-15T12:00:00Z') }, { ...deps, getLeaders: async () => flipped });
  const obrien = next.awards.find((a) => a.key === 'obrien').rows;
  assert.deepStrictEqual(obrien.map((r) => [r.athlete.name, r.rank, r.lastWeek]), [['Stat QB', 1, 2], ['Star QB', 2, 1]]);
});

test('NFL races use win percentage, and other sports have none', async () => {
  const deps = {
    getLeaders: async () => LEADERS,
    getRankings: async () => ({ polls: [] }),
    getStandings: async () => ({ conferences: [{ entries: [{ team: { id: '99' }, winPercent: '.900' }] }] }),
  };
  const data = await awards.getAwards({ sport: 'nfl' }, deps);
  assert.deepStrictEqual(data.awards.map((a) => a.key), ['mvp', 'opoy', 'dpoy']);
  assert.strictEqual(data.awards[0].rows[0].athlete.name, 'Stat QB');
  assert.strictEqual(await awards.getAwards({ sport: 'nba' }, deps), null);
});
