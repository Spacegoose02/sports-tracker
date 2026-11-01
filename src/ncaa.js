// Fallback data source: a self-hosted instance of henrygd/ncaa-api
// (https://github.com/henrygd/ncaa-api), configured via NCAA_API_BASE.
// Used only when ESPN's API is unreachable or errors out. NCAA.com's data
// shape is quite different from ESPN's, so everything here is normalized
// into the same shape espn.js produces, so the rest of the app never has
// to know which source served a given response.

const fetch = require('node-fetch');
const cache = require('./cache');

function base() {
  return (process.env.NCAA_API_BASE || 'https://ncaawidget.sgiu.net').replace(/\/$/, '');
}

function division() {
  return process.env.NCAA_API_DIVISION || 'fbs';
}

async function fetchJson(path) {
  const url = `${base()}${path}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) {
    throw new Error(`ncaa-api request failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

function mapState(gameState) {
  // ncaa-api gameState is typically 'pre', 'live', or 'final'
  if (gameState === 'live') return 'in';
  if (gameState === 'final') return 'post';
  return 'pre';
}

function normalizeSide(side, homeAway) {
  if (!side) return null;
  const names = side.names || {};
  return {
    id: side.seoname || names.seo || null,
    name: names.full || names.short || names.char6,
    shortName: names.short || names.char6,
    abbreviation: names.char6,
    logo: null,
    color: null,
    score: side.score !== undefined && side.score !== '' ? Number(side.score) : null,
    homeAway,
    winner: side.winner === true,
    curatedRank: side.rank ? Number(side.rank) : null,
    records: side.description ? [{ name: 'overall', summary: side.description }] : [],
    linescores: (side.linescores || []).map((l) => l.score),
  };
}

function normalizeNcaaGame(entry) {
  const g = entry.game || entry;
  return {
    id: g.gameID || g.url,
    date: g.startTimeEpoch ? new Date(Number(g.startTimeEpoch) * 1000).toISOString() : g.startDate,
    name: `${(g.away && g.away.names && g.away.names.full) || 'Away'} at ${(g.home && g.home.names && g.home.names.full) || 'Home'}`,
    shortName: `${(g.away && g.away.names && g.away.names.char6) || 'AWY'} @ ${(g.home && g.home.names && g.home.names.char6) || 'HME'}`,
    week: null,
    venue: g.venue && g.venue.name,
    neutralSite: false,
    conferenceCompetition: false,
    broadcast: g.network,
    status: {
      state: mapState(g.gameState),
      detail: g.finalMessage || g.bracketRound || (g.gameState === 'live' ? `Period ${g.currentPeriod}` : g.startTime),
      shortDetail: g.finalMessage || g.startTime,
      completed: g.gameState === 'final',
      period: g.currentPeriod ? Number(g.currentPeriod) : null,
      clock: g.contestClock,
    },
    home: normalizeSide(g.home, 'home'),
    away: normalizeSide(g.away, 'away'),
    situation: null,
    source: 'ncaa-api',
  };
}

// week: NCAA's scoreboard is organized by year/week under a division
// (fbs/fcs/ii/iii), e.g. /scoreboard/football/fbs/2026/04/all-conf
async function getScoreboard({ year, week } = {}) {
  const y = year || new Date().getFullYear();
  const w = week || '01';
  const wPadded = String(w).padStart(2, '0');
  const key = `ncaa:scoreboard:${y}:${wPadded}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`/scoreboard/football/${division()}/${y}/${wPadded}/all-conf`);
    const games = (json.games || []).map(normalizeNcaaGame);
    return { season: y, week: Number(w), seasonType: 2, games, source: 'ncaa-api' };
  });
}

async function getGameDetail(gameId) {
  const key = `ncaa:game:${gameId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`/game/${encodeURIComponent(gameId)}/boxscore`);
    return { id: gameId, raw: json, source: 'ncaa-api' };
  }, 10 * 1000);
}

module.exports = { getScoreboard, getGameDetail };
