const test = require('node:test');
const assert = require('node:assert');
const { parseOdds } = require('../src/espn');
const { gradeGame, buildLines } = require('../src/lines');

// ESPN's newer odds shape: open/close blocks with string lines.
const NEW_SHAPE = [{
  provider: { name: 'ESPN BET' },
  details: 'UGA -7.5',
  overUnder: 51.5,
  spread: -7.5,
  homeTeamOdds: { favorite: true },
  awayTeamOdds: { favorite: false },
  moneyline: { home: { close: { odds: '-280' }, open: { odds: '-250' } }, away: { close: { odds: '+225' }, open: { odds: '+205' } } },
  pointSpread: { home: { close: { line: '-7.5', odds: '-110' }, open: { line: '-6.5' } }, away: { close: { line: '+7.5', odds: '-110' } } },
  total: { over: { close: { line: 'o51.5', odds: '-112' }, open: { line: 'o49.5' } }, under: { close: { line: 'u51.5', odds: '-108' } } },
}];

test('parseOdds reads the newer open/close shape', () => {
  const o = parseOdds(NEW_SHAPE);
  assert.strictEqual(o.provider, 'ESPN BET');
  assert.strictEqual(o.homeSpread, -7.5);
  assert.strictEqual(o.favorite, 'home');
  assert.strictEqual(o.overUnder, 51.5);
  assert.deepStrictEqual(o.moneyline, { home: '-280', away: '+225' });
  assert.deepStrictEqual(o.spreadOdds, { home: '-110', away: '-110' });
  assert.deepStrictEqual(o.totalOdds, { over: '-112', under: '-108' });
  assert.deepStrictEqual(o.open, { homeSpread: -6.5, overUnder: 49.5, moneylineHome: '-250', moneylineAway: '+205' });
});

test('parseOdds reads the older team-odds shape and trusts the favorite flag', () => {
  const o = parseOdds([{
    details: 'BAMA -3', overUnder: 48, spread: -3,
    homeTeamOdds: { favorite: false, moneyLine: 130, spreadOdds: -105 },
    awayTeamOdds: { favorite: true, moneyLine: -150, spreadOdds: -115 },
  }]);
  assert.strictEqual(o.favorite, 'away');
  assert.strictEqual(o.homeSpread, 3, 'home is the underdog, so +3');
  assert.deepStrictEqual(o.moneyline, { home: '+130', away: '-150' });
  assert.strictEqual(o.open, null);
});

test('parseOdds returns null without any line', () => {
  assert.strictEqual(parseOdds([]), null);
  assert.strictEqual(parseOdds([{ provider: { name: 'x' } }]), null);
  assert.strictEqual(parseOdds(undefined), null);
});

function final(home, away, odds) {
  return {
    id: '1', date: '2026-10-31T20:00Z',
    status: { state: 'post', completed: true },
    home: { id: 'h', score: home }, away: { id: 'a', score: away }, odds,
  };
}

test('gradeGame grades the spread and the total', () => {
  const odds = { homeSpread: -7.5, favorite: 'home', overUnder: 51.5 };
  const covered = gradeGame(final(31, 20, odds));
  assert.strictEqual(covered.ats.winner, 'home');
  assert.strictEqual(covered.ats.favoriteCovered, true);
  assert.strictEqual(covered.ats.margin, 3.5);
  assert.deepStrictEqual(covered.total, { points: 51, result: 'under' });

  const dog = gradeGame(final(24, 20, odds));
  assert.strictEqual(dog.ats.winner, 'away');
  assert.strictEqual(dog.ats.favoriteCovered, false);

  const push = gradeGame(final(27, 20, { homeSpread: -7, favorite: 'home', overUnder: 47 }));
  assert.strictEqual(push.ats.push, true);
  assert.strictEqual(push.ats.winner, null);
  assert.strictEqual(push.total.result, 'push');
});

test('gradeGame skips games that are not final', () => {
  const g = final(10, 7, { homeSpread: -3, overUnder: 40 });
  g.status = { state: 'in', completed: false };
  assert.strictEqual(gradeGame(g), null);
});

test('buildLines splits out games without a line and sums the week', () => {
  const odds = { homeSpread: -7.5, favorite: 'home', overUnder: 51.5 };
  const out = buildLines([final(31, 20, odds), final(24, 20, odds), { id: '3', odds: null }]);
  assert.strictEqual(out.games.length, 2);
  assert.strictEqual(out.withoutLines, 1);
  assert.deepStrictEqual(out.summary.favorites, { won: 1, lost: 1, push: 0 });
  assert.deepStrictEqual(out.summary.totals, { over: 0, under: 2, push: 0 });
});
