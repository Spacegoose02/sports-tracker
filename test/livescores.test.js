const test = require('node:test');
const assert = require('node:assert');
const { freshenGames, needsFreshening } = require('../src/livescores');

const NOW = Date.parse('2026-11-08T03:30:00Z');
const ND = { id: '87', shortName: 'Notre Dame' };
const MIA = { id: '2390', shortName: 'Miami' };

// The team schedule's copy of a live game: status, but no scores.
function scheduleLive(id = '501') {
  return { id, date: '2026-11-08T00:30:00Z', venue: 'Notre Dame Stadium', status: { state: 'in', shortDetail: '11:45 - 4th', period: 4 },
    home: { ...ND, score: null }, away: { ...MIA, score: null } };
}

function fakeDs({ board = [], summary = null, boardFails = false } = {}) {
  const calls = { scoreboard: 0, summary: 0 };
  return {
    calls,
    async getScoreboard() {
      calls.scoreboard += 1;
      if (boardFails) throw new Error('down');
      return { games: board };
    },
    async getGameSummary(id) {
      calls.summary += 1;
      if (!summary) throw new Error('no summary');
      return summary;
    },
  };
}

test('needsFreshening: live games and games past their start time', () => {
  assert.strictEqual(needsFreshening({ status: { state: 'in' } }, NOW), true);
  assert.strictEqual(needsFreshening({ status: { state: 'pre' }, date: '2026-11-08T02:00:00Z' }, NOW), true);
  assert.strictEqual(needsFreshening({ status: { state: 'pre' }, date: '2026-11-09T02:00:00Z' }, NOW), false);
  assert.strictEqual(needsFreshening({ status: { state: 'post' }, date: '2026-11-08T00:00:00Z' }, NOW), false);
});

test('no live games: the schedule is returned untouched without any lookups', async () => {
  const ds = fakeDs();
  const games = [{ id: '1', date: '2026-11-15T00:00:00Z', status: { state: 'pre' } }];
  const out = await freshenGames(games, 'cfb', { ds, now: NOW });
  assert.strictEqual(out, games);
  assert.strictEqual(ds.calls.scoreboard, 0);
});

test('a live game gets its score and clock from the scoreboard', async () => {
  const ds = fakeDs({ board: [{ id: '501', status: { state: 'in', shortDetail: '9:02 - 4th', period: 4 },
    home: { ...ND, score: 24, linescores: [7, 7, 3, 7] }, away: { ...MIA, score: 21 } }] });
  const [g] = await freshenGames([scheduleLive()], 'cfb', { ds, now: NOW });
  assert.strictEqual(g.home.score, 24);
  assert.strictEqual(g.away.score, 21);
  assert.strictEqual(g.status.shortDetail, '9:02 - 4th');
  assert.strictEqual(g.venue, 'Notre Dame Stadium');
  assert.strictEqual(ds.calls.summary, 0);
});

test('a live game missing from the scoreboard falls back to its summary (hockey)', async () => {
  const ds = fakeDs({ board: [], summary: { status: { state: 'in', shortDetail: '5:10 - 3rd', period: 3 },
    teams: [{ id: '1', homeAway: 'home', score: 2 }, { id: '2', homeAway: 'away', score: 3 }] } });
  const game = { id: '777', date: '2026-11-08T01:00:00Z', status: { state: 'in' },
    home: { id: '1', score: null }, away: { id: '2', score: null } };
  const [g] = await freshenGames([game], 'nhl', { ds, now: NOW });
  assert.deepStrictEqual([g.home.score, g.away.score], [2, 3]);
  assert.strictEqual(g.status.shortDetail, '5:10 - 3rd');
});

test('a game the schedule still calls "pre" after its start time picks up the live state', async () => {
  const ds = fakeDs({ board: [{ id: '9', status: { state: 'in', shortDetail: 'Top 2nd' }, home: { id: 'a', score: 1 }, away: { id: 'b', score: 0 } }] });
  const game = { id: '9', date: '2026-11-08T03:00:00Z', status: { state: 'pre' }, home: { id: 'a' }, away: { id: 'b' } };
  const [g] = await freshenGames([game], 'mlb', { ds, now: NOW });
  assert.strictEqual(g.status.state, 'in');
  assert.strictEqual(g.home.score, 1);
});

test('lookups failing keeps the schedule game as it was', async () => {
  const ds = fakeDs({ boardFails: true });
  const game = scheduleLive();
  const [g] = await freshenGames([game], 'cfb', { ds, now: NOW });
  assert.deepStrictEqual(g, game);
});
