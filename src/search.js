// Site-wide search: teams in every team sport, plus players.
//
// Teams come from each league's team list (src/espn.js getTeams, cached for
// a day), so team search works offline from ESPN's search and is matched
// here. Players come from ESPN's public search API, the one espn.com's own
// search box uses:
//
//   https://site.web.api.espn.com/apis/search/v2?query=...&limit=...
//
// It isn't documented. The parser reads fields defensively and keeps only
// players in sports this app has a player page for; if the call fails the
// search still returns teams.

const fetch = require('node-fetch');
const cache = require('./cache');
const ds = require('./datasource');
const { SPORTS } = require('./sports');

const SEARCH_URL = 'https://site.web.api.espn.com/apis/search/v2';

// Sports with two-team games and a team list, in the order results show.
const TEAM_SPORTS = Object.values(SPORTS).filter((s) => s.teams !== false && (!s.format || s.format === 'game')).map((s) => s.key);

// ESPN league slugs (in links and defaultLeagueSlug) and league ids (in
// uids like s:20~l:28~a:3139477) for the sports with player pages.
const LEAGUE_SLUGS = {
  'college-football': 'cfb',
  nfl: 'nfl',
  nba: 'nba',
  'mens-college-basketball': 'mcbb',
  mlb: 'mlb',
  nhl: 'nhl',
  wnba: 'wnba',
  'eng.1': 'epl',
  'usa.1': 'mls',
  'uefa.champions': 'ucl',
};
const LEAGUE_IDS = { 23: 'cfb', 28: 'nfl', 46: 'nba', 41: 'mcbb', 10: 'mlb', 90: 'nhl', 59: 'wnba', 700: 'epl', 770: 'mls', 775: 'ucl' };

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// How well a team matches the query: 0 is no match.
function teamScore(team, q) {
  const name = normalize(team.name);
  const abbr = normalize(team.abbreviation);
  if (!name) return 0;
  if (abbr && abbr === q) return 100;
  if (name === q) return 95;
  if (name.startsWith(q)) return 80;
  const words = name.split(' ');
  const qWords = q.split(' ');
  // Every query word starts some word of the name ("va tech", "hokies").
  if (qWords.every((w) => words.some((nw) => nw.startsWith(w)))) return 60 - Math.min(words.length, 10);
  if (name.includes(q)) return 40;
  return 0;
}

// teamsBySport: { cfb: [team, ...], nfl: [...] }. Returns the best matches
// across sports, each with its sport key.
function matchTeams(query, teamsBySport, limit = 8) {
  const q = normalize(query);
  if (q.length < 2) return [];
  const hits = [];
  TEAM_SPORTS.forEach((sport, sportOrder) => {
    (teamsBySport[sport] || []).forEach((t) => {
      const score = teamScore(t, q);
      if (score > 0) hits.push({ ...t, sport, score, sportOrder });
    });
  });
  hits.sort((a, b) => b.score - a.score || a.sportOrder - b.sportOrder || String(a.name).localeCompare(String(b.name)));
  return hits.slice(0, limit).map(({ score, sportOrder, ...t }) => t);
}

function sportFromPlayer(item) {
  if (item.defaultLeagueSlug && LEAGUE_SLUGS[item.defaultLeagueSlug]) return LEAGUE_SLUGS[item.defaultLeagueSlug];
  const uidLeague = /~l:(\d+)/.exec(item.uid || '');
  if (uidLeague && LEAGUE_IDS[uidLeague[1]]) return LEAGUE_IDS[uidLeague[1]];
  const web = (item.link && (item.link.web || item.link)) || '';
  const slug = /espn\.com\/([a-z-]+)\/player\//.exec(String(web));
  if (slug && LEAGUE_SLUGS[slug[1]]) return LEAGUE_SLUGS[slug[1]];
  return null;
}

function playerId(item) {
  const uid = /~a:(\d+)/.exec(item.uid || '');
  if (uid) return uid[1];
  const web = (item.link && (item.link.web || item.link)) || '';
  const fromLink = /\/id\/(\d+)/.exec(String(web));
  if (fromLink) return fromLink[1];
  return item.id && /^\d+$/.test(String(item.id)) ? String(item.id) : null;
}

// ESPN's search response into [{ id, name, sport, team, headshot }].
function parsePlayers(json, limit = 8) {
  const groups = (json && Array.isArray(json.results)) ? json.results : [];
  const items = [];
  groups.forEach((g) => {
    const contents = Array.isArray(g && g.contents) ? g.contents : [];
    contents.forEach((c) => {
      const type = (c && c.type) || (g && g.type);
      if (type !== 'player') return;
      items.push(c);
    });
  });
  const seen = new Set();
  const players = [];
  items.forEach((c) => {
    const sport = sportFromPlayer(c);
    const id = playerId(c);
    const name = c.displayName || c.name;
    if (!sport || !id || !name) return;
    const key = `${sport}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const img = c.image && (c.image.default || c.image.href || (typeof c.image === 'string' ? c.image : null));
    players.push({ id, name, sport, team: c.subtitle || c.description || null, headshot: img || null });
  });
  return players.slice(0, limit);
}

async function searchPlayers(query, limit = 8) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  return cache.getOrFetch(`search:players:${q.toLowerCase()}`, async () => {
    const url = `${SEARCH_URL}?${new URLSearchParams({ query: q, limit: '20', region: 'us', lang: 'en', type: 'player' })}`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`ESPN search failed: ${res.status}`);
    return parsePlayers(await res.json(), limit);
  }, 10 * 60 * 1000);
}

async function allTeams() {
  const out = {};
  await Promise.all(TEAM_SPORTS.map(async (sport) => {
    try { out[sport] = await ds.getTeams({ sport }); } catch (err) { out[sport] = []; }
  }));
  return out;
}

async function search(query) {
  const q = String(query || '').slice(0, 60);
  const [teamsBySport, playersResult] = await Promise.all([
    allTeams(),
    searchPlayers(q).then((p) => ({ players: p }), () => ({ players: [], playersError: true })),
  ]);
  return { query: q, teams: matchTeams(q, teamsBySport), ...playersResult };
}

module.exports = { search, matchTeams, parsePlayers, normalize, TEAM_SPORTS };
