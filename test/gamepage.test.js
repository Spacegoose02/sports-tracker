const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadShared } = require('./helpers');
const gd = require('../src/gamedetail');
const { servicesFor } = require('../src/streaming');
const matchup = require('../src/matchup');

test('broadcasts read both ESPN shapes, dedupe, and drop radio', () => {
  const list = gd.parseBroadcasts({
    broadcasts: [{ market: 'national', names: ['ESPN', 'ESPN'] }],
    geoBroadcasts: [
      { type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'ESPN' } },
      { type: { shortName: 'Streaming' }, market: { type: 'National' }, media: { shortName: 'ESPN+' } },
      { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'WBNS' } },
    ],
  });
  assert.deepStrictEqual(list.map((b) => b.network), ['ESPN', 'ESPN+']);
  assert.strictEqual(list[0].market, 'National');
});

test('streaming services follow the TV network', () => {
  const names = (n) => servicesFor(n).map((s) => s.name);
  assert.deepStrictEqual(names(['CBS']), ['Paramount+', 'Live TV streaming']);
  assert.deepStrictEqual(names(['NBC']), ['Peacock', 'Live TV streaming']);
  assert.deepStrictEqual(names(['Peacock']), ['Peacock']);
  assert.deepStrictEqual(names(['The CW']), ['The CW app']);
  assert.deepStrictEqual(names(['FOX', 'ABC']), ['Fox One', 'ESPN app', 'Live TV streaming']);
  assert.deepStrictEqual(names(['Some Local Station']), []);
});

test('win probability is thinned out and keeps the latest value', () => {
  const raw = Array.from({ length: 1000 }, (_, i) => ({ homeWinPercentage: i / 999 }));
  const wp = gd.parseWinProbability({ winprobability: raw });
  assert.strictEqual(wp.points.length, 240);
  assert.strictEqual(wp.home, 1);
  const pre = gd.parseWinProbability({ predictor: { homeTeam: { gameProjection: '62.5' }, awayTeam: { gameProjection: '37.5' } } });
  assert.strictEqual(pre.home, 0.625);
  assert.strictEqual(pre.points.length, 0);
  assert.strictEqual(gd.parseWinProbability({}), null);
});

test('player box score skips players who did not play', () => {
  const teams = gd.parsePlayerStats({
    players: [{
      team: { id: '194', displayName: 'Ohio State Buckeyes', shortDisplayName: 'Ohio State' },
      statistics: [{
        name: 'passing', text: 'Ohio State Passing', labels: ['C/ATT', 'YDS'],
        athletes: [
          { athlete: { displayName: 'A Passer', position: { abbreviation: 'QB' } }, stats: ['20/30', '250'] },
          { athlete: { displayName: 'Bench' }, didNotPlay: true, stats: [] },
        ],
        totals: ['20/30', '250'],
      }],
    }],
  });
  assert.strictEqual(teams[0].team, 'Ohio State');
  assert.strictEqual(teams[0].groups[0].players.length, 1);
  assert.strictEqual(teams[0].groups[0].players[0].position, 'QB');
});

test('injuries, game info, form and season series parse', () => {
  const inj = gd.parseInjuries({ injuries: [{ team: { id: '1', displayName: 'Team' }, injuries: [
    { athlete: { displayName: 'Hurt Guy', position: { abbreviation: 'WR' } }, status: 'Out', details: { type: 'Knee', side: 'Left' } },
  ] }] });
  assert.strictEqual(inj[0].players[0].injury, 'Left Knee');
  const info = gd.parseGameInfo({ gameInfo: { venue: { fullName: 'Ohio Stadium', address: { city: 'Columbus', state: 'OH' }, grass: false }, attendance: 105000, weather: { temperature: 55, displayValue: 'Cloudy', precipitation: 10 } } });
  assert.strictEqual(info.city, 'Columbus');
  assert.strictEqual(info.weather.temperatureF, 55);
  const form = gd.parseRecentForm({ lastFiveGames: [{ team: { id: '1', abbreviation: 'OSU' }, events: [{ id: '9', gameResult: 'W', score: '31-10', atVs: 'vs', opponent: { abbreviation: 'PSU' } }] }] });
  assert.strictEqual(form[0].games[0].opponent, 'PSU');
  const series = gd.parseSeasonSeries({ seasonseries: [{ type: 'season', title: 'Regular Season Series', summary: 'BOS leads 2-1', events: [] }] });
  assert.strictEqual(series.summary, 'BOS leads 2-1');
});

test('head-to-head summary, ties and streaks', () => {
  const g = (homeWin, awayWin) => ({ home: { id: '1', winner: homeWin }, away: { id: '2', winner: awayWin } });
  const s = matchup.summarizeSeries([g(true, false), g(true, false), g(false, true), g(false, false)], { id: '1', name: 'Home U' }, { id: '2', name: 'Away St' }, 2015);
  assert.strictEqual(s.summary, 'Home U leads 2-1-1 since 2015');
  assert.strictEqual(s.streak.text, 'Home U has won 2 straight');
  assert.strictEqual(matchup.summarizeSeries([], { id: '1', name: 'A' }, { id: '2', name: 'B' }, 2015).summary, 'No meetings since 2015');
});

test('head-to-head reads past seasons of the home team schedule', async () => {
  const espn = require('../src/espn');
  const orig = espn.getTeamSchedule;
  const calls = [];
  espn.getTeamSchedule = async (team, season) => {
    calls.push(season);
    if (season !== 2024) return { games: [] };
    return { games: [
      { id: '5', date: '2024-11-30T17:00Z', status: { completed: true }, home: { id: '10', abbreviation: 'H', score: 13, winner: false }, away: { id: '20', abbreviation: 'A', score: 10, winner: true } },
      { id: '6', date: '2024-10-01T17:00Z', status: { completed: true }, home: { id: '10', score: 40, winner: true }, away: { id: '99', score: 0 } },
    ] };
  };
  try {
    const h = await matchup.headToHead({ id: '77', date: '2026-11-28T17:00Z', teams: [
      { id: '10', homeAway: 'home', shortName: 'Home' }, { id: '20', homeAway: 'away', shortName: 'Away' },
    ] }, 'cfb');
    assert.strictEqual(calls.length, 12);
    assert.strictEqual(h.meetings.length, 1);
    assert.strictEqual(h.summary, 'Away leads 1-0 since 2015');
  } finally {
    espn.getTeamSchedule = orig;
  }
});

test('weather: roofs, season of a January bowl, and picking the kickoff hour', async () => {
  assert.strictEqual(matchup.roofFor('Caesars Superdome', null), 'fixed');
  assert.strictEqual(matchup.roofFor('AT&T Stadium', null), 'retractable');
  assert.strictEqual(matchup.roofFor('Ohio Stadium', null), null);
  assert.strictEqual(matchup.seasonOf('2026-01-01T20:00Z'), 2025);
  const hour = matchup.pickHour({
    time: ['2026-11-28T16:00', '2026-11-28T17:00'],
    temperature_2m: [40.4, 42.6], weather_code: [3, 61], precipitation_probability: [20, 60], wind_speed_10m: [8, 12.2],
  }, '2026-11-28T17:10:00Z');
  assert.deepStrictEqual([hour.temperatureF, hour.conditions, hour.precipitationChance, hour.windMph], [43, 'Rain', 60, 12]);
  assert.strictEqual(matchup.pickHour({ time: ['2026-11-20T00:00'] }, '2026-11-28T17:00Z'), null);
  const indoor = await matchup.kickoffWeather({ venue: 'Ford Field', gameInfo: { venue: 'Ford Field' } }, 'nfl');
  assert.strictEqual(indoor.indoor, true);
  assert.strictEqual(await matchup.kickoffWeather({ status: { state: 'pre' }, gameInfo: {} }, 'nba'), null);
});

function loadGameSections() {
  const CFB = loadShared();
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game-sections.js'), 'utf8');
  const sandbox = { CFB, URL, console };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.CFBGame = CFBGame;`, sandbox);
  return sandbox.CFBGame;
}

test('game page sections escape outside data', () => {
  const G = loadGameSections();
  const bad = '<img src=x onerror=alert(1)>';
  const html = [
    G.watchHtml({ broadcasts: [{ network: bad, type: 'TV', market: 'National' }], streaming: [{ name: bad, url: 'javascript:alert(1)', note: bad, networks: [bad] }] }),
    G.boxScoreHtml({ playerStats: [{ team: bad, groups: [{ title: bad, labels: [bad], players: [{ name: bad, stats: [bad] }], totals: null }] }] }),
    G.injuriesHtml({ injuries: [{ team: bad, players: [{ name: bad, status: bad, injury: bad }] }] }),
    G.recentFormHtml({ recentForm: [{ team: bad, games: [{ result: bad, opponent: bad, score: bad }] }] }),
    G.matchupHtml({ weather: { conditions: bad, temperatureF: bad, place: bad, source: bad }, headToHead: { summary: bad, meetings: [{ home: { abbreviation: bad }, away: { abbreviation: bad } }], complete: true } }),
    G.winProbHtml({ winProbability: { points: [0.5, 0.6], home: 0.6 }, status: { state: 'in' } }, { abbreviation: bad }, { abbreviation: bad, color: 'red;}' }),
  ].join('');
  assert.ok(!html.includes('<img'), 'raw tag leaked');
  assert.ok(!html.includes('javascript:'), 'unsafe link leaked');
  assert.ok(!html.includes('red;}'), 'unsafe color leaked');
});

test('where to watch falls back to the single broadcast and says when TV is unknown', () => {
  const G = loadGameSections();
  assert.match(G.watchHtml({ broadcast: 'ESPN', streaming: [] }), /ESPN/);
  assert.match(G.watchHtml({ status: { state: 'pre' } }), /hasn't been announced/);
  assert.strictEqual(G.watchHtml({ status: { state: 'post' } }), '');
});

test('where to watch puts the BingeBandit channel first and drops it after the game', () => {
  const G = loadGameSections();
  const detail = { status: { state: 'in' }, broadcasts: [{ network: 'ESPN2', type: 'TV', market: 'National' }], streaming: servicesFor(['ESPN2']) };
  const links = [{ network: 'ESPN2', channel: { number: 206, name: 'US: ESPN 2 HD' }, url: 'http://192.168.1.10:8484/live/42' }];
  const html = G.watchHtml(detail, links);
  assert.match(html, /href="http:\/\/192\.168\.1\.10:8484\/live\/42"[^>]*>.*Watch on BingeBandit/);
  assert.match(html, /Channel 206 &middot; US: ESPN 2 HD &middot; for ESPN2/);
  assert.ok(html.indexOf('Watch on BingeBandit') < html.indexOf('ESPN app'));
  assert.doesNotMatch(G.watchHtml(detail), /BingeBandit/);
  assert.doesNotMatch(G.watchHtml({ ...detail, status: { state: 'post' } }, links), /BingeBandit/);
  const bad = '<img src=x onerror=alert(1)>';
  const evil = G.watchHtml(detail, [{ network: bad, channel: { number: bad, name: bad }, url: 'javascript:alert(1)' }, { network: bad, channel: { name: bad }, url: 'http://x/live/1' }]);
  assert.doesNotMatch(evil, /<img|javascript:/);
});

test('matchup route rejects bad ids', async () => {
  const { startApp } = require('./helpers');
  const app = await startApp({});
  try {
    const res = await fetch(`${app.url}/api/game/1%3Fx%3D2/matchup`);
    assert.strictEqual(res.status, 400);
  } finally {
    await app.close();
  }
});
