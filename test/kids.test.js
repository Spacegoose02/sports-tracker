const test = require('node:test');
const assert = require('node:assert');
const K = require('../public/js/kids-core.js');

const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('explainPlay turns plays into kid-sized sentences', () => {
  assert.match(K.explainPlay('Kyron Drones 12 Yd Run for a TD, (John Love KICK)', 'cfb'), /touchdown, worth 6 points/);
  assert.match(K.explainPlay('John Love 42 Yd Field Goal GOOD', 'cfb'), /3 points/);
  assert.match(K.explainPlay('John Love 51 Yd Field Goal MISSED', 'nfl'), /didn't go in/);
  assert.match(K.explainPlay('Jayson Tatum makes 26-foot three point jumper', 'nba'), /3 points/);
  assert.match(K.explainPlay('Jayson Tatum misses 26-foot three point jumper', 'nba'), /missed/);
  assert.match(K.explainPlay('Auston Matthews Goal (12) Wrist Shot', 'nhl'), /GOAL/);
  assert.match(K.explainPlay('Shot on goal by Matthews saved by Price', 'nhl'), /goalie stopped/);
  assert.match(K.explainPlay('Judge homered to left (410 feet).', 'mlb'), /Home run/);
  assert.strictEqual(K.explainPlay('Timeout Hokies', 'ufc'), null);
  assert.strictEqual(K.explainPlay('', 'cfb'), null);
});

test('scoreChanges celebrates followed teams only, and not on first sight', () => {
  const game = (away, home, state = 'in', winner) => ({
    id: '1', status: { state },
    away: { id: 'a', score: away, winner: winner === 'a' }, home: { id: 'h', score: home, winner: winner === 'h' },
  });
  const followed = new Set(['h']);
  let r = K.scoreChanges({}, [game(0, 7)], followed, 'cfb');
  assert.deepStrictEqual(r.events, []);
  r = K.scoreChanges(r.next, [game(7, 10)], followed, 'cfb');
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].label, 'FIELD GOAL!');
  assert.strictEqual(r.events[0].points, 3);
  r = K.scoreChanges(r.next, [game(7, 17, 'post', 'h')], followed, 'cfb');
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['score', 'win']);
  assert.strictEqual(r.events[0].label, 'TOUCHDOWN!');
  // Basketball: no confetti for every bucket, only the win.
  const b1 = K.scoreChanges({}, [game(10, 10)], followed, 'nba');
  const b2 = K.scoreChanges(b1.next, [game(10, 12)], followed, 'nba');
  assert.deepStrictEqual(b2.events, []);
});

test('countdownParts and nextGame', () => {
  assert.deepStrictEqual(K.countdownParts(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000), { days: 2, hours: 3, minutes: 4, seconds: 5, done: false });
  assert.strictEqual(K.countdownParts(-5000).done, true);
  const now = Date.parse('2026-11-01T12:00:00Z');
  const sched = [
    { id: 'old', date: '2026-10-25T12:00:00Z', status: { state: 'post' } },
    { id: 'later', date: '2026-11-15T12:00:00Z', status: { state: 'pre' } },
    { id: 'next', date: '2026-11-08T12:00:00Z', status: { state: 'pre' } },
  ];
  assert.strictEqual(K.nextGame(sched, now).id, 'next');
  assert.strictEqual(K.nextGame([...sched, { id: 'live', status: { state: 'in' } }], now).id, 'live');
  assert.strictEqual(K.nextGame([sched[0]], now), null);
});

const pick = (n, teamId, winnerId, extra) => Object.assign({
  sport: 'cfb', gameId: String(n), teamId, week: 'w1', date: `2026-09-0${n}T00:00:00Z`,
  away: { id: 'a' }, home: { id: 'h' }, result: winnerId === undefined ? null : { winnerId },
}, extra);

test('pick results, stats and badges', () => {
  assert.strictEqual(K.pickOutcome(pick(1, 'a')), 'pending');
  assert.strictEqual(K.pickOutcome(pick(1, 'a', 'a')), 'right');
  assert.strictEqual(K.pickOutcome(pick(1, 'a', 'h')), 'wrong');
  assert.strictEqual(K.pickOutcome(pick(1, 'a', null)), 'tie');

  const picks = { 1: pick(1, 'a', 'a'), 2: pick(2, 'a', 'a'), 3: pick(3, 'h', 'h') };
  assert.deepStrictEqual(K.playerStats(picks), { right: 3, wrong: 0, pending: 0, total: 3 });
  const keys = K.badgesFor(picks).map((b) => b.key);
  assert.ok(keys.includes('first') && keys.includes('streak3') && keys.includes('perfect'));
  assert.ok(!keys.includes('upset'));

  const upset = { 1: pick(1, 'a', 'a', { ranks: { a: null, h: 5 } }) };
  assert.ok(K.badgesFor(upset).some((b) => b.key === 'upset'));
  const notUpset = { 1: pick(1, 'a', 'a', { ranks: { a: 3, h: 5 } }) };
  assert.ok(!K.badgesFor(notUpset).some((b) => b.key === 'upset'));
});

test('leaderboard orders by right picks', () => {
  const players = [{ id: 'x', name: 'Mia' }, { id: 'y', name: 'Jack' }];
  const rows = K.leaderboard(players, { x: { 1: pick(1, 'a', 'h') }, y: { 1: pick(1, 'h', 'h') } });
  assert.deepStrictEqual(rows.map((r) => r.player.name), ['Jack', 'Mia']);
});

test('gameResult reads scoreboard games and summaries', () => {
  assert.strictEqual(K.gameResult({ status: { state: 'in' }, away: { id: 'a' }, home: { id: 'h' } }), null);
  assert.deepStrictEqual(K.gameResult({ status: { state: 'post', completed: true }, teams: [{ id: 'a', winner: true }, { id: 'h' }] }), { winnerId: 'a' });
  assert.deepStrictEqual(K.gameResult({ status: { state: 'post' }, away: { id: 'a', score: 3 }, home: { id: 'h', score: 7 } }), { winnerId: 'h', scores: { a: 3, h: 7 } });
  assert.deepStrictEqual(K.gameResult({ status: { state: 'post' }, away: { id: 'a', score: 7 }, home: { id: 'h', score: 7 } }), { winnerId: null, scores: { a: 7, h: 7 } });
});

test('buildQuiz makes valid questions from team info', () => {
  const team = (id, name, nickname, location, color, venue) => ({ id, sport: 'cfb', name, nickname, location, color, venue, logo: `https://x/${id}.png` });
  const teams = [team('259', 'Virginia Tech Hokies', 'Hokies', 'Virginia Tech', '#630031', 'Lane Stadium')];
  const pool = [
    team('1', 'Miami Hurricanes', 'Hurricanes', 'Miami', '#005030', 'Hard Rock Stadium'),
    team('2', 'Clemson Tigers', 'Tigers', 'Clemson', '#f56600', 'Memorial Stadium'),
    team('3', 'Duke Blue Devils', 'Blue Devils', 'Duke', '#003087', 'Wallace Wade Stadium'),
    team('4', 'NC State Wolfpack', 'Wolfpack', 'NC State', '#cc0000', 'Carter-Finley Stadium'),
  ];
  const quiz = K.buildQuiz({ teams, pool, sports: ['cfb'], count: 10, rng: seeded(42) });
  assert.strictEqual(quiz.length, 10);
  quiz.forEach((q) => {
    assert.ok(q.choices.includes(q.answer), q.q);
    assert.strictEqual(new Set(q.choices).size, q.choices.length, `duplicate choices in ${q.q}`);
    assert.ok(q.choices.length >= 3);
  });
  const kinds = new Set(quiz.map((q) => q.kind));
  ['nickname', 'logo', 'venue', 'color', 'fact'].forEach((k) => assert.ok(kinds.has(k), `missing ${k}`));
  // No followed teams: still a full quiz of rules questions.
  assert.strictEqual(K.buildQuiz({ teams: [], pool: [], sports: ['nhl'], count: 5 }).length, 5);
});

test('albumByTeam groups stickers per team', () => {
  const album = K.albumByTeam([
    { sport: 'cfb', teamId: '259', gameId: '1', name: 'VT', at: 1 },
    { sport: 'cfb', teamId: '259', gameId: '2', name: 'VT', at: 3 },
    { sport: 'nfl', teamId: '28', gameId: '9', name: 'WAS', at: 2 },
  ]);
  assert.deepStrictEqual(album.map((s) => [s.teamId, s.stickers.length]), [['259', 2], ['28', 1]]);
  assert.notStrictEqual(K.stickerKey({ sport: 'cfb', gameId: '1', teamId: '2', reason: 'watched' }), K.stickerKey({ sport: 'cfb', gameId: '1', teamId: '2', reason: 'picked' }));
});

test('against the spread: the line decides right, wrong and push', () => {
  const ats = (teamId, spread, away, home) => ({
    teamId, spread, away: { id: 'a' }, home: { id: 'h' },
    result: K.gameResult({ status: { state: 'post', completed: true }, away: { id: 'a', score: away }, home: { id: 'h', score: home } }),
  });
  // Home favored by 6.5 and wins by 7: home covers.
  assert.strictEqual(K.pickOutcome(ats('h', -6.5, 14, 21)), 'right');
  assert.strictEqual(K.pickOutcome(ats('a', -6.5, 14, 21)), 'wrong');
  // Home wins by 3 as a 6.5-point favorite: the away team covers while losing.
  assert.strictEqual(K.pickOutcome(ats('a', -6.5, 18, 21)), 'right');
  // Exactly on the number is a push.
  assert.strictEqual(K.pickOutcome(ats('h', -7, 14, 21)), 'tie');
  // No scores saved (older picks): straight up.
  assert.strictEqual(K.pickOutcome({ teamId: 'h', spread: -6.5, away: { id: 'a' }, home: { id: 'h' }, result: { winnerId: 'h' } }), 'right');
  assert.strictEqual(K.lineFor({}, true, -6.5), '-6.5');
  assert.strictEqual(K.lineFor({}, false, -6.5), '+6.5');
  assert.strictEqual(K.lineFor({}, false, 0), 'PK');
});
