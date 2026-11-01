const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadShared } = require('./helpers');
const live = require('../src/livegame');
const gd = require('../src/gamedetail');

const HOME = { id: '1', abbreviation: 'HOM', color: '#123456', homeAway: 'home' };
const AWAY = { id: '2', abbreviation: 'AWY', color: '#654321', homeAway: 'away' };

function play(id, team, ytgStart, ytgEnd, extra) {
  return {
    id, text: `Play ${id}`, type: { text: 'Rush' }, period: { number: 1 }, clock: { displayValue: '10:00' },
    start: { team: { id: team }, yardsToEndzone: ytgStart }, end: { yardsToEndzone: ytgEnd },
    awayScore: 0, homeScore: 0, ...(extra || {}),
  };
}

const footballSummary = {
  drives: {
    previous: [
      { id: 'd1', team: { id: '2', abbreviation: 'AWY' }, displayResult: 'Punt', offensivePlays: 3, yards: 4,
        timeElapsed: { displayValue: '1:30' }, start: { period: { number: 1 }, clock: { displayValue: '15:00' } },
        plays: [play('p1', '2', 75, 73), play('p2', '2', 73, 71)] },
      { id: 'd2', team: { id: '1', abbreviation: 'HOM' }, displayResult: 'Touchdown', isScore: true, yards: 60,
        plays: [play('p3', '1', 60, 35, { statYardage: 25 }), play('p4', '1', 35, 0, { scoringPlay: true, homeScore: 7 })] },
    ],
    current: { id: 'd3', team: { id: '2', abbreviation: 'AWY' }, plays: [play('p5', '2', 75, 60, { homeScore: 7 })] },
  },
  winprobability: [
    { playId: 'p1', homeWinPercentage: 0.5 }, { playId: 'p2', homeWinPercentage: 0.52 },
    { playId: 'p3', homeWinPercentage: 0.6 }, { playId: 'p4', homeWinPercentage: 0.75 }, { playId: 'p5', homeWinPercentage: 0.73 },
  ],
};

test('drive chart reads each drive, oldest first, with the live drive last', () => {
  const drives = live.parseDriveChart(footballSummary);
  assert.deepStrictEqual(drives.map((d) => d.kind), ['punt', 'td', 'live']);
  assert.strictEqual(drives[1].start, 40);
  assert.strictEqual(drives[1].end, 100);
  assert.strictEqual(drives[1].startText, 'Own 40');
  assert.strictEqual(drives[2].live, true);
  assert.strictEqual(drives[2].plays, 1);
  assert.deepStrictEqual(live.parseDriveChart({}), []);
});

test('drive results map to a kind', () => {
  assert.strictEqual(live.driveResultKind('Field Goal'), 'fg');
  assert.strictEqual(live.driveResultKind('Missed FG'), 'turnover');
  assert.strictEqual(live.driveResultKind('Interception'), 'turnover');
  assert.strictEqual(live.driveResultKind('Downs'), 'turnover');
  assert.strictEqual(live.driveResultKind('End of Half'), 'end');
  assert.strictEqual(live.fieldSpot(50), 'Midfield');
  assert.strictEqual(live.fieldSpot(30), 'Opp 30');
});

test('momentum uses win probability, falling back to points', () => {
  const m = live.parseMomentum(footballSummary, live.chronologicalPlays(footballSummary));
  assert.strictEqual(m.basis, 'winProbability');
  const total = m.bars.reduce((s, b) => s + b.value, 0);
  assert.ok(Math.abs(total - 0.23) < 0.001);

  const flat = { plays: [
    { id: '1', text: 'a', homeScore: 0, awayScore: 0 }, { id: '2', text: 'b', homeScore: 2, awayScore: 0 },
    { id: '3', text: 'c', homeScore: 2, awayScore: 3 }, { id: '4', text: 'd', homeScore: 4, awayScore: 3 },
  ] };
  const pts = live.parseMomentum(flat, live.chronologicalPlays(flat));
  assert.strictEqual(pts.basis, 'points');
  assert.strictEqual(pts.bars.reduce((s, b) => s + b.value, 0), 1);
  assert.strictEqual(live.parseMomentum({}, []), null);
});

test('biggest swings match win probability to play text', () => {
  const swings = live.parseSwings(footballSummary, live.chronologicalPlays(footballSummary));
  assert.deepStrictEqual(swings.map((s) => s.text), ['Play p4', 'Play p3']);
  assert.strictEqual(swings[0].delta, 0.15);
  assert.strictEqual(swings[0].teamId, '1');
});

test('live extras ride along with the other game extras', () => {
  const extras = gd.parseGameExtras(footballSummary, {});
  assert.strictEqual(extras.driveChart.length, 3);
  assert.ok(extras.momentum);
  const empty = gd.parseGameExtras({}, {});
  assert.deepStrictEqual(empty.driveChart, []);
  assert.strictEqual(empty.momentum, null);
  assert.deepStrictEqual(empty.wpSwings, []);
});

function loadBrowser(file, name) {
  const CFB = loadShared();
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
  const sandbox = { CFB, URL, URLSearchParams, console };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.${name} = ${name};`, sandbox);
  return sandbox[name];
}

test('live game sections filter plays and escape outside data', () => {
  const L = loadBrowser('game-live.js', 'CFBLive');
  const bad = '<img src=x onerror=alert(1)>';
  const plays = [
    { id: 'b', text: bad, type: bad, period: 2, clock: '1:00', teamId: '1', homeScore: 7, awayScore: 0, yards: 30, scoringPlay: true },
    { id: 'a', text: 'Short run', period: 1, clock: '9:00', teamId: '2', homeScore: 0, awayScore: 0, yards: 3, scoringPlay: false },
  ];
  assert.strictEqual(L.filterPlays(plays, 'scoring', AWAY, HOME).length, 1);
  assert.strictEqual(L.filterPlays(plays, 'away', AWAY, HOME)[0].id, 'a');
  assert.strictEqual(L.filterPlays(plays, 'big', AWAY, HOME)[0].id, 'b');

  const detail = {
    status: { state: 'in' },
    playByPlay: plays,
    momentum: { basis: 'winProbability', bars: [{ value: 0.1 }, { value: -0.2 }] },
    wpSwings: [{ delta: 0.2, text: bad, period: 1, clock: bad }],
    driveChart: [{ id: '1', teamId: '1', team: bad, kind: 'td', result: bad, start: 20, end: 100, startText: bad, endText: 'Opp 0', plays: 5, yards: 80, time: '2:00' }],
  };
  const html = [
    L.feedHtml(detail, { ...AWAY, abbreviation: bad }, HOME, { filter: 'scoring', newIds: new Set(['b']) }),
    L.momentumHtml(detail, AWAY, { ...HOME, color: 'red;}' }),
    L.swingsHtml(detail, AWAY, HOME),
    L.drivesHtml(detail, AWAY, HOME),
  ].join('');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('red;}'));
  assert.ok(html.includes('live-new'));
  assert.ok(html.includes('1 of 2 plays'));
  assert.strictEqual(L.feedHtml({ playByPlay: [] }, AWAY, HOME), '');
  assert.strictEqual(L.momentumHtml({}, AWAY, HOME), '');
});

test('compare tool numbers, edges and rows', () => {
  const C = loadBrowser('compare.js', 'CFBCompare');
  assert.strictEqual(C.toNumber('1,234'), 1234);
  assert.strictEqual(C.toNumber('45.6%'), 45.6);
  assert.strictEqual(C.toNumber('31:24'), 1884);
  assert.strictEqual(C.toNumber('20/30'), null);
  assert.strictEqual(C.lowerIsBetter('INT', 'Passing'), true);
  assert.strictEqual(C.lowerIsBetter('INT', 'Defensive'), false);
  assert.strictEqual(C.lowerIsBetter('Interceptions', 'Passing'), true);
  assert.strictEqual(C.lowerIsBetter('ERA', 'Pitching'), true);
  assert.strictEqual(C.lowerIsBetter('Turnovers', 'Miscellaneous'), true);
  assert.strictEqual(C.lowerIsBetter('YDS', 'Rushing'), false);

  const teams = C.teamRows(
    [{ name: 'Passing', stats: [{ name: 'Yards', value: '3,000', number: 3000, rank: '5th' }, { name: 'Only A', value: '1' }] }],
    [{ name: 'Passing', stats: [{ name: 'Yards', value: '2,500', number: 2500 }] }],
  );
  assert.strictEqual(teams.length, 1);
  assert.strictEqual(teams[0].edge, 'a');
  assert.strictEqual(teams[0].aRank, '5th');

  const career = (rows, totals) => [{ name: 'Passing', labels: ['YDS', 'INT'], rows, totals }];
  const a = career([{ season: '2023', stats: ['100', '9'] }, { season: '2024', stats: ['4,000', '5'] }], ['4,100', '14']);
  const b = career([{ season: '2024', stats: ['3,500', '12'] }], ['3,500', '12']);
  const season = C.playerRows(a, b, 'season');
  assert.strictEqual(season.map((r) => r.edge).join(), 'a,a');
  assert.strictEqual(season[0].a, '4,000');
  assert.strictEqual(C.playerRows(a, b, 'career')[0].a, '4,100');
  assert.strictEqual(C.seasonOf(a), '2024');
  assert.strictEqual(JSON.stringify(C.tally(season)), '{"a":2,"b":0}');

  const log = (vals) => ({ labels: ['CMP', 'YDS'], games: vals.map((v) => ({ stats: ['1', String(v)], opponent: { abbreviation: 'X' } })) });
  const la = log([300, 200, 100]);
  assert.strictEqual(C.trendLabels(la, log([1]))[0], 'YDS');
  assert.strictEqual(C.trendSeries(la, 'YDS', 10).map((p) => p.value).join(), '100,200,300');

  const bad = '<script>x</script>';
  const html = C.barsHtml([{ ...teams[0], group: bad, label: bad }], bad, bad)
    + C.trendHtml(C.trendSeries(la, 'YDS'), [], bad, bad, bad);
  assert.ok(!html.includes('<script>'));
});
