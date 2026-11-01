// Combines espn.js (primary) and ncaa.js (fallback). Every function takes an
// optional `sport` key (see src/sports.js; default college football). The
// self-hosted ncaa-api fallback only covers college football, so other
// sports surface ESPN errors directly.

const espn = require('./espn');
const ncaa = require('./ncaa');
const { DEFAULT_SPORT } = require('./sports');

function isCfb(sport) {
  return !sport || sport === DEFAULT_SPORT;
}

async function getScoreboard(opts = {}) {
  try {
    const result = await espn.getScoreboard(opts);
    return { ...result, source: 'espn' };
  } catch (err) {
    if (!isCfb(opts.sport)) throw err;
    console.error('[datasource] ESPN scoreboard failed, falling back to ncaa-api:', err.message);
    return ncaa.getScoreboard(opts);
  }
}

// ncaa-api doesn't have a clean single-team-schedule endpoint, so there's
// no fallback here; ESPN's team schedule endpoint is stable enough.
async function getTeamSchedule(teamId, season, sport) {
  return espn.getTeamSchedule(teamId, season, sport);
}

async function getTeamInfo(teamId, sport) {
  return espn.getTeamInfo(teamId, sport);
}

async function getGameSummary(eventId, source, sport) {
  if (source === 'ncaa-api' && isCfb(sport)) {
    return ncaa.getGameDetail(eventId);
  }
  try {
    return await espn.getGameSummary(eventId, sport);
  } catch (err) {
    console.error('[datasource] ESPN summary failed:', err.message);
    throw err;
  }
}

// Rankings and standings are ESPN-only: ncaa-api's shape for these is
// different enough that a faithful fallback isn't worth the complexity.
async function getRankings(opts) {
  return espn.getRankings(opts);
}

async function getStandings(opts) {
  return espn.getStandings(opts);
}

async function getTeamStatistics(teamId, season, sport) {
  return espn.getTeamStatistics(teamId, season, sport);
}

async function getNews(opts) {
  return espn.getNews(opts);
}

async function getTeams(opts) {
  return espn.getTeams(opts);
}

module.exports = {
  getNews,
  getTeams,
  getScoreboard,
  getTeamSchedule,
  getTeamInfo,
  getGameSummary,
  getRankings,
  getStandings,
  getTeamStatistics,
};
