const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub node-fetch before anything loads it, so these tests never hit ESPN.
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-search-'));
let responses = () => ({});
require.cache[require.resolve('node-fetch')] = {
  id: 'node-fetch',
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: async (url) => {
    const body = responses(String(url));
    if (body === 500) return { ok: false, status: 500, statusText: 'Error', json: async () => ({}) };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  },
};

const express = require('express');
const search = require('../src/search');

const TEAMS = {
  cfb: [
    { id: '259', name: 'Virginia Tech Hokies', abbreviation: 'VT', logo: 'vt.png' },
    { id: '258', name: 'Virginia Cavaliers', abbreviation: 'UVA', logo: 'uva.png' },
    { id: '61', name: 'Georgia Bulldogs', abbreviation: 'UGA', logo: null },
  ],
  nfl: [
    { id: '12', name: 'Kansas City Chiefs', abbreviation: 'KC', logo: null },
    { id: '28', name: 'Washington Commanders', abbreviation: 'WSH', logo: null },
  ],
  mcbb: [{ id: '259', name: 'Virginia Tech Hokies', abbreviation: 'VT', logo: null }],
};

test('matchTeams ranks abbreviations, prefixes and nicknames', () => {
  assert.deepStrictEqual(search.matchTeams('kc', TEAMS).map((t) => t.name), ['Kansas City Chiefs']);
  const virginia = search.matchTeams('virginia', TEAMS);
  assert.deepStrictEqual(virginia.map((t) => `${t.sport}:${t.id}`), ['cfb:258', 'cfb:259', 'mcbb:259']);
  assert.deepStrictEqual(search.matchTeams('hokies', TEAMS).map((t) => t.sport), ['cfb', 'mcbb']);
  assert.deepStrictEqual(search.matchTeams('virg tech', TEAMS).map((t) => t.id), ['259', '259']);
  assert.deepStrictEqual(search.matchTeams('x', TEAMS), []);
  assert.deepStrictEqual(search.matchTeams('zzz', TEAMS), []);
});

test('parsePlayers keeps players in sports with player pages', () => {
  const json = {
    results: [
      { type: 'team', contents: [{ type: 'team', displayName: 'Kansas City Chiefs', uid: 's:20~l:28~t:12' }] },
      {
        type: 'player',
        contents: [
          { displayName: 'Patrick Mahomes', defaultLeagueSlug: 'nfl', uid: 's:20~l:28~a:3139477', subtitle: 'Kansas City Chiefs', image: { default: 'mahomes.png' } },
          { displayName: 'Kyron Drones', uid: 's:20~l:23~a:4685720', subtitle: 'Virginia Tech Hokies' },
          { displayName: 'Some Golfer', defaultLeagueSlug: 'pga', uid: 's:1100~l:1106~a:1' },
          { displayName: 'Link Only', link: { web: 'https://www.espn.com/mens-college-basketball/player/_/id/555/link-only' } },
          { displayName: 'Patrick Mahomes', defaultLeagueSlug: 'nfl', uid: 's:20~l:28~a:3139477' },
        ],
      },
    ],
  };
  assert.deepStrictEqual(search.parsePlayers(json), [
    { id: '3139477', name: 'Patrick Mahomes', sport: 'nfl', team: 'Kansas City Chiefs', headshot: 'mahomes.png' },
    { id: '4685720', name: 'Kyron Drones', sport: 'cfb', team: 'Virginia Tech Hokies', headshot: null },
    { id: '555', name: 'Link Only', sport: 'mcbb', team: null, headshot: null },
  ]);
  assert.deepStrictEqual(search.parsePlayers(null), []);
  assert.deepStrictEqual(search.parsePlayers({ results: 'nope' }), []);
});

async function withApi(fn) {
  const app = express();
  app.use('/api', require('../src/routes/api'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('/api/search returns teams and players, and teams when player search fails', async () => {
  const leagues = (teams) => ({ sports: [{ leagues: [{ teams: teams.map((t) => ({ team: { id: t.id, displayName: t.name, abbreviation: t.abbreviation } })) }] }] });
  let searchDown = false;
  responses = (url) => {
    if (url.includes('/search/v2')) {
      if (searchDown) return 500;
      return { results: [{ type: 'player', contents: [{ displayName: 'Hendon Hooker', defaultLeagueSlug: 'nfl', uid: 's:20~l:28~a:4239086' }] }] };
    }
    if (url.includes('football/college-football/teams')) return leagues(TEAMS.cfb);
    if (url.includes('football/nfl/teams')) return leagues(TEAMS.nfl);
    return leagues([]);
  };
  await withApi(async (base) => {
    let body = await (await fetch(`${base}/api/search?q=hoo`)).json();
    assert.deepStrictEqual(body.players.map((p) => p.name), ['Hendon Hooker']);
    assert.deepStrictEqual(body.teams, []);

    searchDown = true;
    body = await (await fetch(`${base}/api/search?q=chiefs`)).json();
    assert.deepStrictEqual(body.teams.map((t) => `${t.sport}:${t.id}`), ['nfl:12']);
    assert.deepStrictEqual(body.players, []);
    assert.strictEqual(body.playersError, true);

    body = await (await fetch(`${base}/api/search?q=a`)).json();
    assert.deepStrictEqual(body, { query: 'a', teams: [], players: [] });
  });
});
