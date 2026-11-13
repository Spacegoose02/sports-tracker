const test = require('node:test');
const assert = require('node:assert');
const ts = require('../src/teamstats');

const byTeamJson = {
  requestedSeason: { year: 2026, type: { week: { number: 11 } } },
  categories: [
    { name: 'general', names: ['gamesPlayed', 'fumblesRecovered'] },
    { name: 'passing', names: ['passingYardsPerGame', 'totalPointsPerGame', 'interceptions', 'sacks', 'yardsPerGame', 'passingYardsPerGame'] },
  ],
  teams: [
    { team: { id: '1', displayName: 'Alpha' }, categories: [
      { name: 'general', splitId: '0', values: [9, 6] },
      { name: 'general', splitId: '900', values: [9, 4] },
      { name: 'passing', splitId: '0', values: [300, 40, 5, 10, 450, 999] },
      { name: 'passing', splitId: '900', values: [200, 14, 12, 30, 300, 999] },
    ] },
    { team: { id: '2', displayName: 'Bravo' }, categories: [
      { name: 'general', splitId: '0', values: [9, 3] },
      { name: 'general', splitId: '900', values: [9, 8] },
      { name: 'passing', splitId: '0', values: [250, 30, 9, 20, 400, 1] },
      { name: 'passing', splitId: '900', values: [260, 10, 4, 18, 380, 1] },
    ] },
  ],
};

test('team stats split offense from defense and rank allowed stats lowest first', () => {
  const ranked = ts.rankTeams(ts.parseByTeam(byTeamJson));
  assert.strictEqual(ranked.season, 2026);
  const table = (k) => ranked.stats.find((s) => s.key === k);
  assert.deepStrictEqual(table('scoring').rows.map((r) => [r.team.name, r.value, r.rank]), [['Alpha', 40, 1], ['Bravo', 30, 2]]);
  assert.deepStrictEqual(table('scoringD').rows.map((r) => r.team.name), ['Bravo', 'Alpha'], '10 allowed beats 14');
  assert.strictEqual(table('passing').rows[0].value, 300, 'first passingYardsPerGame wins over the repeat');
  // Turnover margin: takeaways (opp INT + own fumbles recovered) - giveaways.
  const to = table('turnovers').rows;
  assert.deepStrictEqual(to.map((r) => [r.team.name, r.value]), [['Alpha', 9], ['Bravo', -10]]);
  assert.deepStrictEqual(table('margin').rows.map((r) => r.value), [26, 20]);
});

function game(id, away, home, awayScore, homeScore, state = 'post') {
  return {
    id,
    status: { state, completed: state === 'post' },
    away: { id: away, name: away, score: awayScore, winner: state === 'post' && awayScore > homeScore },
    home: { id: home, name: home, score: homeScore, winner: state === 'post' && homeScore > awayScore },
  };
}

test('records, strength of schedule and bowl watch come from the season games', () => {
  const games = [
    game('1', 'A', 'B', 30, 20),
    game('2', 'C', 'A', 10, 24),
    game('3', 'B', 'C', 17, 14),
    game('4', 'A', 'C', null, null, 'pre'),
  ];
  const records = ts.buildRecords(games);
  assert.strictEqual(records.get('A').wins, 2);
  assert.deepStrictEqual(records.get('A').remaining, ['C']);
  const sos = ts.strengthOfSchedule(records, null);
  // A played B (1-1, minus the loss to A = 1-0) and C (0-2, minus the loss to A = 0-1): 1-1.
  const a = sos.find((r) => r.team.id === 'A');
  assert.strictEqual(a.sos, 0.5);
  const watch = ts.bowlWatch(records, null, new Map([['A', 'Big Test']]));
  const rowA = watch.rows.find((r) => r.team.id === 'A');
  assert.strictEqual(rowA.need, 4);
  assert.strictEqual(rowA.status, 'out', 'two wins and one game left cannot reach six');
  assert.strictEqual(rowA.conference, 'Big Test');
});

test('six wins is bowl eligible; needing every remaining game is must-win', () => {
  const games = [];
  for (let i = 0; i < 6; i += 1) games.push(game(`w${i}`, 'X', `o${i}`, 30, 10));
  for (let i = 0; i < 5; i += 1) games.push(game(`y${i}`, 'Y', `p${i}`, 30, 10));
  games.push(game('y5', 'Y', 'q', null, null, 'pre'));
  const watch = ts.bowlWatch(ts.buildRecords(games), null, null);
  assert.strictEqual(watch.rows.find((r) => r.team.id === 'X').status, 'eligible');
  assert.strictEqual(watch.rows.find((r) => r.team.id === 'Y').status, 'mustWinOut');
});
