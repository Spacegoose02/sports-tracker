const test = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { buildHome, parseTeams, mixHeadlines } = require('../src/home');
const { startApp } = require('./helpers');

const NOW = Date.parse('2026-11-07T20:00:00Z');
const hours = (h) => new Date(NOW + h * 3600000).toISOString();

function team(id, score, extra) {
  return { id, name: `Team ${id}`, shortName: `T${id}`, abbreviation: `T${id}`, score, winner: false, curatedRank: null, ...extra };
}
function game(id, state, date, home, away, period) {
  return { id, date, status: { state, period: period || 1, shortDetail: state, completed: state === 'post' }, home, away };
}

function fakeDs(boards) {
  return {
    async getScoreboard({ sport }) {
      if (boards[sport] === 'error') throw new Error('down');
      return boards[sport] || { games: [] };
    },
    async getNews({ sport }) {
      return [{ title: `${sport} story`, link: `https://example.com/${sport}`, pubDate: hours(-1) }];
    },
  };
}
const fakeNews = { async getNews() { return [{ title: 'cfb story', link: 'https://example.com/cfb', pubDate: hours(-2) }]; } };

test('buildHome summarizes in-season leagues and ranks live games first', async () => {
  const boards = {
    cfb: {
      week: 11,
      seasonType: 2,
      games: [
        game('1', 'post', hours(-30), team('a', 10, { winner: true }), team('b', 3)),
        game('2', 'in', hours(-1), team('c', 21), team('d', 20), 4),
        game('3', 'pre', hours(3), team('e', null, { curatedRank: 3 }), team('f', null, { curatedRank: 5 })),
        game('4', 'in', hours(-1), team('g', 42), team('h', 0), 2),
        game('5', 'pre', hours(5), team('i', null), team('j', null)),
      ],
    },
    nba: { games: [game('9', 'in', hours(-1), team('k', 100), team('l', 99), 4)] },
    // Last season's games: off-season.
    mlb: { games: [game('20', 'post', hours(-24 * 40), team('m', 1), team('n', 2))] },
    nhl: 'error',
  };
  const data = await buildHome({ now: NOW, ds: fakeDs(boards), news: fakeNews });

  const cfb = data.leagues.find((l) => l.key === 'cfb');
  assert.strictEqual(cfb.inSeason, true);
  assert.strictEqual(cfb.period, 'Week 11');
  assert.deepStrictEqual(cfb.counts, { live: 2, upcoming: 2, final: 1, total: 5 });
  assert.strictEqual(cfb.games.length, 4);
  // The close late game beats the blowout; the ranked matchup leads upcoming.
  assert.deepStrictEqual(cfb.games.map((g) => g.id), ['2', '4', '3', '5']);
  assert.strictEqual(cfb.games[0].sport, 'cfb');
  assert.strictEqual(cfb.url, '/scores?sport=cfb');

  assert.strictEqual(data.leagues.find((l) => l.key === 'mlb').inSeason, false);
  assert.strictEqual(data.leagues.find((l) => l.key === 'nhl').inSeason, false);
  // In-season leagues are listed before off-season ones.
  const firstOff = data.leagues.findIndex((l) => !l.inSeason);
  assert.ok(data.leagues.slice(firstOff).every((l) => !l.inSeason));

  // Live games from every league, most dramatic first.
  assert.deepStrictEqual(data.live.map((g) => `${g.sport}:${g.id}`), ['cfb:2', 'nba:9', 'cfb:4']);
  assert.strictEqual(data.counts.live, 3);
  assert.strictEqual(data.counts.leaguesInSeason, 2);

  // Headlines only from in-season leagues, CFB from its own feeds.
  assert.deepStrictEqual(data.headlines.map((h) => h.sport).sort(), ['cfb', 'nba']);
  assert.strictEqual(data.headlines.find((h) => h.sport === 'cfb').title, 'cfb story');
  assert.deepStrictEqual(data.myTeams, []);
});

test('buildHome passes followed teams to the team summary', async () => {
  let got = null;
  const data = await buildHome({
    now: NOW,
    teams: [{ sport: 'nfl', id: '12' }],
    ds: fakeDs({}),
    news: fakeNews,
    summarizeTeams: async (teams) => { got = teams; return [{ sport: 'nfl', id: '12', name: 'Chiefs' }]; },
  });
  assert.deepStrictEqual(got, [{ sport: 'nfl', id: '12' }]);
  assert.strictEqual(data.myTeams[0].name, 'Chiefs');
});

test('parseTeams keeps valid sport:id pairs only', () => {
  assert.deepStrictEqual(parseTeams('cfb:259,nba:25,cfb:259,bogus:1,ufc:5,nfl:../x,nhl:'), [
    { sport: 'cfb', id: '259' },
    { sport: 'nba', id: '25' },
  ]);
  assert.deepStrictEqual(parseTeams(undefined), []);
});

test('mixHeadlines takes from each league in turn and drops repeats', () => {
  const a = [{ link: 'x', pubDate: hours(-1) }, { link: 'y', pubDate: hours(-2) }];
  const b = [{ link: 'x', pubDate: hours(-3) }, { link: 'z', pubDate: hours(-4) }];
  assert.deepStrictEqual(mixHeadlines([a, b]).map((i) => i.link), ['x', 'y', 'z']);
});

test('/ serves the home page and /scores the scoreboard', async () => {
  const app = await startApp({});
  try {
    const home = await (await fetch(`${app.url}/`)).text();
    assert.match(home, /\/js\/home\.js/);
    const scores = await (await fetch(`${app.url}/scores?sport=nba`)).text();
    assert.match(scores, /\/js\/app\.js/);
    const index = await (await fetch(`${app.url}/index.html`)).text();
    assert.match(index, /\/js\/app\.js/);
  } finally {
    await app.close();
  }
});
