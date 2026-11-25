// College baseball and men's/women's college soccer, and the College / Pro /
// Racing / Fighting / Golf sections of the sport picker.
const test = require('node:test');
const assert = require('node:assert');
const { SPORTS, SPORT_GROUPS, getSport, publicSportList } = require('../src/sports');
const drama = require('../src/drama');
const KidsCore = require('../public/js/kids-core.js');
const GamedayCore = require('../public/js/gameday-core.js');

test('college baseball and soccer are configured like their pro cousins', () => {
  const cbase = getSport('cbase');
  assert.strictEqual(cbase.kind, 'baseball');
  assert.strictEqual(cbase.schedule, 'day');
  assert.strictEqual(cbase.standings, true);
  assert.strictEqual(cbase.rankings, false); // ESPN has no poll endpoint for it
  assert.strictEqual(cbase.leaders, false);
  for (const key of ['msoc', 'wsoc']) {
    const s = getSport(key);
    assert.strictEqual(s.kind, 'soccer');
    assert.strictEqual(s.format, 'game');
    assert.strictEqual(s.teams, true);
    assert.strictEqual(s.standings, false); // ESPN returns an empty table
    assert.strictEqual(s.leaders, false);
  }
  assert.notStrictEqual(getSport('msoc').label, getSport('wsoc').label);
});

test('every sport sits in a known picker section, college first', () => {
  const known = new Set(SPORT_GROUPS.map((g) => g.key));
  for (const s of Object.values(SPORTS)) assert.ok(known.has(s.group), `${s.key} has group ${s.group}`);
  const by = (g) => Object.values(SPORTS).filter((s) => s.group === g).map((s) => s.key);
  assert.deepStrictEqual(by('college'), ['cfb', 'mcbb', 'cbase', 'msoc', 'wsoc']);
  assert.deepStrictEqual(by('racing'), ['nascar', 'f1']);
  assert.deepStrictEqual(by('fighting'), ['ufc']);
  assert.ok(by('pro').includes('nfl') && by('pro').includes('epl'));
  // The browser gets the section with each sport, and never ESPN paths.
  const pub = publicSportList().find((s) => s.key === 'cbase');
  assert.strictEqual(pub.group, 'college');
  assert.strictEqual(pub.path, undefined);
});

test('college baseball drama counts innings, college soccer counts halves', () => {
  const game = (sport, period, h, a) => drama.liveFacts({
    status: { state: 'in', period }, home: { score: String(h) }, away: { score: String(a) },
  }, sport);
  const late = game('cbase', 8, 3, 2);
  assert.strictEqual(late.regulation, 9);
  assert.strictEqual(late.final, true);
  assert.ok(late.close);
  const soccer = game('wsoc', 2, 1, 1);
  assert.strictEqual(soccer.regulation, 2);
  assert.strictEqual(soccer.final, true);
});

test('kid mode and game day treat the college leagues as their sport', () => {
  assert.strictEqual(KidsCore.family('cbase'), 'baseball');
  assert.strictEqual(KidsCore.family('msoc'), 'soccer');
  assert.strictEqual(KidsCore.celebrationLabel('wsoc', 1), 'GOAL!');
  assert.strictEqual(GamedayCore.family('cbase'), 'baseball');
  assert.strictEqual(GamedayCore.family('wsoc'), 'soccer');
});
