// Game-day games: bingo, play calls, score guesses, trading cards, XP, and
// the league XP board and watch party chat on the server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-gameday-'));
const GC = require('../public/js/gameday-core.js');

const ENV = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-real-password', SESSION_SECRET: 'g'.repeat(40) };

test('bingo cards are 4x4, the same for the same seed, and fill from plays', () => {
  const a = GC.bingoCard('cfb', 'kid1:401');
  const b = GC.bingoCard('cfb', 'kid1:401');
  const c = GC.bingoCard('cfb', 'kid2:401');
  assert.strictEqual(a.length, 16);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a.map((s) => s.key), c.map((s) => s.key));
  for (const sport of ['nba', 'nhl', 'mlb', 'epl']) assert.strictEqual(GC.bingoCard(sport, 'x').length, 16, sport);
  assert.strictEqual(GC.bingoCard('ufc', 'x'), null);

  const card = GC.SQUARES.football.slice(0, 16).map((s) => ({ key: s.key }));
  const marked = GC.markedSquares(card, 'cfb', [
    { text: 'Kyron Drones pass complete to Ali Jennings for 34 yds for a TOUCHDOWN' },
    { text: 'John Love 41 yd Field Goal' },
    { text: 'Jane Doe 38 yd field goal is NO GOOD' },
    { text: 'Pass intercepted by Smith' },
  ]);
  assert.ok(marked.has('td') && marked.has('fg') && marked.has('int') && marked.has('long'));
  assert.ok(!marked.has('fumble'));
});

test('bingo lines: rows, columns and diagonals', () => {
  const card = Array.from({ length: 16 }, (_, i) => ({ key: `k${i}` }));
  const marked = new Set(['k0', 'k1', 'k2', 'k3', 'k5', 'k10', 'k15']);
  assert.deepStrictEqual(GC.bingoLines(card, marked), [{ kind: 'row', index: 0 }, { kind: 'diag', index: 0 }]);
});

test('play calls resolve on the next snap and the next score', () => {
  assert.strictEqual(GC.playKind('Drones run for 4 yds'), 'run');
  assert.strictEqual(GC.playKind('Drones pass incomplete to Jennings'), 'pass');
  assert.strictEqual(GC.playKind('Smith punt for 44 yds'), 'kick');
  assert.strictEqual(GC.playKind('Timeout Virginia Tech'), null);
  const plays = [
    { id: '5', text: 'Love 30 yd field goal GOOD', awayScore: 3, homeScore: 7 },
    { id: '4', text: 'Timeout', awayScore: 0, homeScore: 7 },
    { id: '3', text: 'Drones pass complete for 8 yds', awayScore: 0, homeScore: 7 },
    { id: '2', text: 'Drones run for 2 yds', awayScore: 0, homeScore: 7 },
  ];
  const game = { away: { id: 'A', score: 3 }, home: { id: 'H', score: 7 } };
  assert.deepStrictEqual(GC.resolveCall({ kind: 'play', guess: 'pass', afterId: '2' }, plays, game).right, true);
  assert.strictEqual(GC.resolveCall({ kind: 'play', guess: 'run', afterId: '5' }, plays, game), null, 'waiting');
  const score = GC.resolveCall({ kind: 'score', guess: 'A', afterId: '2', away: 0, home: 7 }, plays, game);
  assert.deepStrictEqual([score.right, score.actual, score.points], [true, 'A', 25]);
  // Sports without scores on plays use the scoreboard.
  const noScores = GC.resolveCall({ kind: 'score', guess: 'H', afterId: null, away: 0, home: 0 }, [], { away: { id: 'A', score: 0 }, home: { id: 'H', score: 1 } });
  assert.strictEqual(noScores.right, true);
});

test('score guesses: error, points and closest', () => {
  assert.strictEqual(GC.guessError({ away: 21, home: 24 }, { away: 20, home: 27 }), 4);
  assert.strictEqual(GC.guessPoints({ away: 20, home: 27 }, { away: 20, home: 27 }), 60);
  assert.strictEqual(GC.guessPoints({ away: 21, home: 24 }, { away: 20, home: 27 }), 32);
  assert.strictEqual(GC.guessPoints({ away: 1, home: 1 }, { away: 2, home: 2 }), 36, 'a draw guessed as a draw');
  assert.deepStrictEqual(GC.closestGuesses([{ id: 'a', guess: { away: 1, home: 2 } }, { id: 'b', guess: { away: 0, home: 2 } }, { id: 'c', guess: { away: 1, home: 0 } }], { away: 1, home: 1 }).ids, ['a', 'c']);
});

test('levels, outfits, streaks and XP awards that only pay once', () => {
  assert.deepStrictEqual([GC.levelFor(0).level, GC.levelFor(99).level, GC.levelFor(100).level, GC.levelFor(300).level], [1, 1, 2, 3]);
  assert.deepStrictEqual(GC.unlockedOutfits(300).map((o) => o.key), ['cap', 'finger', 'scarf']);
  let s = GC.updateStreak(null, '2026-11-06');
  s = GC.updateStreak(s, '2026-11-07');
  s = GC.updateStreak(s, '2026-11-07');
  assert.deepStrictEqual(s, { last: '2026-11-07', days: 2, best: 2 });
  assert.strictEqual(GC.updateStreak(s, '2026-11-09').days, 1);
  assert.strictEqual(GC.streakBonus(7), 60);
  let r = GC.addXp(null, { key: 'bingo:1', points: 30, reason: 'BINGO', game: 'cfb:1' }, 1000);
  assert.ok(r.added);
  r = GC.addXp(r.record, { key: 'bingo:1', points: 30 }, 2000);
  assert.ok(!r.added);
  assert.strictEqual(r.record.total, 30);
  assert.strictEqual(GC.xpForGame(r.record, 'cfb:1'), 30);
  assert.strictEqual(GC.xpSince(r.record, 5000), 0);
});

test('trading cards from game leaders, with rarity from the stat line', () => {
  const detail = {
    id: '401', date: '2026-11-07T20:00Z',
    teams: [{ id: '259', name: 'Virginia Tech Hokies', color: '#630031', homeAway: 'home' }, { id: '52', name: 'Florida State Seminoles', homeAway: 'away' }],
    leaders: [{ team: 'Virginia Tech Hokies', categories: [
      { name: 'Passing Yards', athlete: 'Kyron Drones', athleteId: '4430', value: '24/31, 342 YDS, 4 TD, 1 INT' },
      { name: 'Rushing Yards', athlete: 'Bhayshul Tuten', athleteId: '4431', value: '12 CAR, 48 YDS' },
      { name: 'Receiving Yards', athlete: 'Kyron Drones', athleteId: '4430', value: '1 REC, 5 YDS' },
    ] }],
  };
  const cards = GC.cardsFromGame(detail, 'cfb');
  assert.strictEqual(cards.length, 2, 'one card per player per game');
  assert.strictEqual(cards[0].id, 'cfb:401:4430');
  assert.strictEqual(cards[0].rarity, 'legendary');
  assert.strictEqual(cards[1].rarity, 'common');
  assert.strictEqual(cards[0].color, '#630031');
  assert.strictEqual(GC.cardRarity('nba', '41 PTS, 12 REB, 9 AST'), 'legendary');
});

test('spoken scores', () => {
  const g = (state, a, h) => ({ status: { state }, away: { nickname: 'Seminoles', score: a }, home: { nickname: 'Hokies', score: h } });
  assert.strictEqual(GC.spokenScore(g('in', 7, 14)), 'The Hokies lead the Seminoles, 14 to 7.');
  assert.strictEqual(GC.spokenScore(g('post', 31, 24)), 'Final: the Seminoles beat the Hokies, 31 to 24.');
});

function client(base) {
  const jar = new Map();
  return async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
}

test('XP syncs to the account, merges devices, and shows on the league board; watch party chat', async () => {
  const { createApp } = require('../src/app');
  const app = createApp({ env: ENV, logger: { warn() {} } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mom = client(base);
    const pop = client(base);
    const stranger = client(base);
    await mom('/api/account/signup', { method: 'POST', body: { email: 'gd-mom@example.com', password: 'go-hokies-1', displayName: 'Mom' } });
    await pop('/api/account/signup', { method: 'POST', body: { email: 'gd-pop@example.com', password: 'go-hokies-1', displayName: 'Pop' } });
    await stranger('/api/account/signup', { method: 'POST', body: { email: 'gd-who@example.com', password: 'go-hokies-1' } });
    const { league } = await (await mom('/api/family/leagues', { method: 'POST', body: { name: 'Couch Crew' } })).json();
    await pop('/api/family/leagues/join', { method: 'POST', body: { code: league.code } });
    await mom('/api/family/data/players', { method: 'PUT', body: { value: [{ id: 'k1', name: 'Sam', emoji: '🦊' }] } });

    const entry = (key, points, game, at = Date.now()) => ({ key, points, reason: key, at, game });
    let res = await mom('/api/family/data/xp', { method: 'PUT', body: { value: { k1: { total: 40, log: [entry('a', 30, 'cfb:401'), entry('b', 10, null)], outfit: 'cap' } } } });
    assert.strictEqual((await res.json()).value.k1.total, 40);
    // A second device with an award the first didn't have, and one too big.
    res = await mom('/api/family/data/xp', { method: 'PUT', body: { value: { k1: { total: 9999, log: [entry('a', 30, 'cfb:401'), entry('c', 25, 'cfb:401'), entry('huge', 5000, null)] } } } });
    const merged = (await res.json()).value.k1;
    assert.strictEqual(merged.total, 65, 'only the new award counts, the oversized one is dropped');
    assert.deepStrictEqual(merged.log.map((l) => l.key).sort(), ['a', 'b', 'c']);

    const board = await (await mom(`/api/family/leagues/${league.id}/xp?game=cfb:401&since=0`)).json();
    assert.deepStrictEqual(board.rows.map((r) => [r.name, r.game, r.total, r.level]), [['Sam', 55, 65, 1]]);
    assert.strictEqual((await stranger(`/api/family/leagues/${league.id}/xp`)).status, 404);

    // Chat: members only, plain text, as a player or as the account.
    assert.strictEqual((await mom(`/api/family/leagues/${league.id}/chat`)).status, 400);
    res = await mom(`/api/family/leagues/${league.id}/chat`, { method: 'POST', body: { game: 'cfb:401', text: '  TOUCHDOWN!!\n<b>hi</b> ', playerId: 'k1' } });
    const sent = (await res.json()).message;
    assert.deepStrictEqual([sent.name, sent.emoji, sent.text], ['Sam', '🦊', 'TOUCHDOWN!! <b>hi</b>']);
    await pop(`/api/family/leagues/${league.id}/chat`, { method: 'POST', body: { game: 'cfb:401', text: '🎉' } });
    await pop(`/api/family/leagues/${league.id}/chat`, { method: 'POST', body: { game: 'nfl:9', text: 'other game' } });
    assert.strictEqual((await pop(`/api/family/leagues/${league.id}/chat`, { method: 'POST', body: { game: 'cfb:401', text: '   ' } })).status, 400);
    const log = await (await pop(`/api/family/leagues/${league.id}/chat?game=cfb:401`)).json();
    assert.deepStrictEqual(log.messages.map((m) => [m.name, m.text, m.mine]), [['Sam', 'TOUCHDOWN!! <b>hi</b>', false], ['Pop', '🎉', true]]);
    const after = await (await pop(`/api/family/leagues/${league.id}/chat?game=cfb:401&after=${log.messages[0].id}`)).json();
    assert.strictEqual(after.messages.length, 1);
    assert.strictEqual((await stranger(`/api/family/leagues/${league.id}/chat?game=cfb:401`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('score guesses ride along on picks', () => {
  process.env.DATA_DIR = process.env.DATA_DIR || '';
  const family = require('../src/family');
  const db = require('../src/db');
  const user = db.createUser({ email: 'guess@example.com' });
  family.saveKidsKey(user.id, 'players', [{ id: 'k9', name: 'Lou' }]);
  const saved = family.saveKidsKey(user.id, 'picks', { k9: { 'cfb:1': { sport: 'cfb', gameId: '1', teamId: 'h', away: { id: 'a' }, home: { id: 'h' }, guess: { away: 10, home: 24 } }, 'cfb:2': { sport: 'cfb', gameId: '2', teamId: 'h', away: { id: 'a' }, home: { id: 'h' }, guess: { away: -1, home: 3 } } } });
  assert.deepStrictEqual(saved.k9['cfb:1'].guess, { away: 10, home: 24 });
  assert.strictEqual(saved.k9['cfb:2'].guess, undefined);
});
