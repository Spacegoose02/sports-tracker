// Extra pieces of ESPN's game summary for the game page: every TV and
// streaming broadcast, player box scores, win probability, injuries, venue
// and weather, recent form and the season series. Kept apart from espn.js
// so getGameSummary only has to spread `parseGameExtras(json)` into its
// result. ESPN doesn't publish a schema for the summary endpoint, so every
// reader here is defensive and returns null or [] when a field is missing.

const { servicesFor } = require('./streaming');
const { parseEspnHighlights } = require('./highlights');

const MAX_WIN_PROB_POINTS = 240;

// One broadcast entry. The scoreboard uses { market, names: [...] }, the
// summary uses { type: { shortName }, market: { type }, media: { shortName } }.
function parseBroadcasts(comp) {
  const out = [];
  const seen = new Set();
  const add = (network, type, market) => {
    if (!network) return;
    type = type || 'TV';
    const key = `${network}|${type}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ network: String(network), type, market: market || null });
  };
  const list = [...((comp && comp.broadcasts) || []), ...((comp && comp.geoBroadcasts) || [])];
  for (const b of list) {
    if (!b) continue;
    const type = (b.type && (b.type.shortName || b.type.longName)) || null;
    const marketRaw = typeof b.market === 'string' ? b.market : b.market && (b.market.type || b.market.longName);
    const market = marketRaw ? String(marketRaw).replace(/^\w/, (c) => c.toUpperCase()) : null;
    if (Array.isArray(b.names)) b.names.forEach((n) => add(n, type, market));
    if (b.media) add(b.media.shortName || b.media.name, type, market);
  }
  // Radio has its own section (src/radio.js); keep TV and streaming here.
  return out.filter((b) => !/radio/i.test(b.type));
}

function athleteName(a) {
  return (a && (a.shortName || a.displayName)) || null;
}

// Player box score: one table per team per stat group (passing, rushing...
// for football; a single table for basketball and hockey).
function parsePlayerStats(boxscore) {
  if (!boxscore || !Array.isArray(boxscore.players)) return [];
  return boxscore.players.map((teamBlock) => ({
    teamId: teamBlock.team && teamBlock.team.id ? String(teamBlock.team.id) : null,
    team: teamBlock.team && (teamBlock.team.shortDisplayName || teamBlock.team.displayName),
    abbreviation: teamBlock.team && teamBlock.team.abbreviation,
    groups: (teamBlock.statistics || []).map((g) => ({
      title: g.text || (g.name ? g.name.charAt(0).toUpperCase() + g.name.slice(1) : 'Players'),
      labels: (g.labels || []).map(String),
      players: (g.athletes || [])
        .filter((p) => p && p.athlete && !p.didNotPlay)
        .map((p) => ({
          name: athleteName(p.athlete),
          jersey: p.athlete.jersey || null,
          position: (p.athlete.position && p.athlete.position.abbreviation) || null,
          starter: !!p.starter,
          stats: (p.stats || []).map(String),
        })),
      totals: Array.isArray(g.totals) ? g.totals.map(String) : null,
    })).filter((g) => g.players.length),
  })).filter((t) => t.groups.length);
}

function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ESPN's live win probability is one entry per play: homeWinPercentage in
// 0..1. Thin it out evenly so a long game doesn't send thousands of points,
// always keeping the latest. Before kickoff, ESPN's matchup predictor
// (projections in 0..100) stands in.
function parseWinProbability(json) {
  const raw = Array.isArray(json.winprobability) ? json.winprobability : [];
  let points = raw.map((p) => pct(p && p.homeWinPercentage)).filter((p) => p !== null);
  if (points.length > MAX_WIN_PROB_POINTS) {
    const step = (points.length - 1) / (MAX_WIN_PROB_POINTS - 1);
    points = Array.from({ length: MAX_WIN_PROB_POINTS }, (_, i) => points[Math.round(i * step)]);
  }
  points = points.map((p) => Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000);
  let pregame = null;
  const pred = json.predictor;
  if (pred && pred.homeTeam) {
    const home = pct(pred.homeTeam.gameProjection);
    const away = pct(pred.awayTeam && pred.awayTeam.gameProjection);
    if (home !== null) pregame = { home: home / 100, away: away !== null ? away / 100 : 1 - home / 100, source: 'ESPN Matchup Predictor' };
  }
  if (!points.length && !pregame) return null;
  return {
    points,
    home: points.length ? points[points.length - 1] : pregame.home,
    pregame,
  };
}

function parseInjuries(json) {
  if (!Array.isArray(json.injuries)) return [];
  return json.injuries.map((t) => ({
    teamId: t.team && t.team.id ? String(t.team.id) : null,
    team: t.team && (t.team.displayName || t.team.abbreviation),
    players: (t.injuries || []).map((i) => {
      const details = i.details || {};
      const injury = [details.side && details.side !== 'Not Specified' ? details.side : null, details.type, details.detail]
        .filter(Boolean).join(' ') || (i.type && i.type.description) || null;
      return {
        name: i.athlete && i.athlete.displayName,
        position: i.athlete && i.athlete.position && i.athlete.position.abbreviation,
        status: i.status || (i.type && i.type.description) || null,
        injury,
        returnDate: details.returnDate || null,
      };
    }).filter((p) => p.name),
  })).filter((t) => t.players.length);
}

function parseWeather(w) {
  if (!w) return null;
  const temp = pct(w.temperature !== undefined ? w.temperature : w.highTemperature);
  const conditions = w.displayValue || w.conditions || null;
  if (temp === null && !conditions) return null;
  return {
    temperatureF: temp,
    conditions,
    precipitationChance: pct(w.precipitation),
    windMph: pct(w.gust !== undefined ? w.gust : w.windSpeed),
    source: 'ESPN',
  };
}

function parseGameInfo(json) {
  const gi = json.gameInfo || {};
  const v = gi.venue || {};
  const addr = v.address || {};
  return {
    venue: v.fullName || null,
    city: addr.city || null,
    state: addr.state || null,
    country: addr.country || null,
    indoor: v.indoor === true ? true : v.indoor === false ? false : null,
    grass: v.grass === true ? true : v.grass === false ? false : null,
    attendance: pct(gi.attendance) || null,
    weather: parseWeather(gi.weather),
  };
}

// "Last five" for each team: { teamId, games: [{ result, opponent, score, atVs }] }.
function parseRecentForm(json) {
  if (!Array.isArray(json.lastFiveGames)) return [];
  return json.lastFiveGames.map((t) => ({
    teamId: t.team && t.team.id ? String(t.team.id) : null,
    team: t.team && (t.team.abbreviation || t.team.displayName),
    games: (t.events || []).map((e) => ({
      id: e.id ? String(e.id) : null,
      date: e.gameDate || null,
      result: e.gameResult || null,
      score: e.score || null,
      atVs: e.atVs || null,
      opponent: e.opponent && (e.opponent.abbreviation || e.opponent.displayName),
    })),
  })).filter((t) => t.games.length);
}

// NBA/NHL/MLB summaries carry this season's series between the two teams.
function parseSeasonSeries(json) {
  const list = Array.isArray(json.seasonseries) ? json.seasonseries : [];
  const s = list.find((x) => x && x.type === 'season') || list[0];
  if (!s) return null;
  return {
    title: s.title || 'Season series',
    summary: s.summary || s.description || null,
    games: (s.events || []).map((e) => {
      const comps = e.competitors || [];
      const home = comps.find((c) => c.homeAway === 'home') || comps[0] || {};
      const away = comps.find((c) => c.homeAway === 'away') || comps[1] || {};
      const side = (c) => ({
        id: c.team && c.team.id ? String(c.team.id) : null,
        abbreviation: c.team && c.team.abbreviation,
        score: c.score !== undefined ? String(c.score) : null,
        winner: !!c.winner,
      });
      return { id: e.id ? String(e.id) : null, date: e.date || null, status: e.statusType && e.statusType.state, home: side(home), away: side(away) };
    }),
  };
}

function parseGameExtras(json, comp) {
  json = json || {};
  const broadcasts = parseBroadcasts(comp);
  return {
    broadcasts,
    streaming: servicesFor(broadcasts.map((b) => b.network)),
    winProbability: parseWinProbability(json),
    playerStats: parsePlayerStats(json.boxscore),
    injuries: parseInjuries(json),
    gameInfo: parseGameInfo(json),
    recentForm: parseRecentForm(json),
    seasonSeries: parseSeasonSeries(json),
    highlights: parseEspnHighlights(json),
  };
}

module.exports = {
  parseGameExtras,
  parseBroadcasts,
  parsePlayerStats,
  parseWinProbability,
  parseInjuries,
  parseGameInfo,
  parseRecentForm,
  parseSeasonSeries,
};
