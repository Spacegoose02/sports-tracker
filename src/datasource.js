// Combines espn.js (primary) and ncaa.js (fallback). Every function here
// tries ESPN first; if that throws (network error, ESPN outage, etc.) it
// falls back to the self-hosted ncaa-api instance and tags the result so
// the UI can show a small "via ncaa-api" badge if it wants to.

const espn = require('./espn');
const ncaa = require('./ncaa');

async function getScoreboard(opts) {
  try {
    const result = await espn.getScoreboard(opts);
    return { ...result, source: 'espn' };
  } catch (err) {
    console.error('[datasource] ESPN scoreboard failed, falling back to ncaa-api:', err.message);
    return ncaa.getScoreboard(opts);
  }
}

async function getTeamSchedule(teamId, season) {
  // ncaa-api doesn't have a clean single-team-schedule endpoint, so the
  // fallback here is best-effort: derive it by scanning weekly scoreboards
  // is expensive, so we just surface the ESPN error if it fails. ESPN's
  // team schedule endpoint is stable enough that this is acceptable.
  return espn.getTeamSchedule(teamId, season);
}

async function getTeamInfo(teamId) {
  return espn.getTeamInfo(teamId);
}

async function getGameSummary(eventId, source) {
  if (source === 'ncaa-api') {
    return ncaa.getGameDetail(eventId);
  }
  try {
    return await espn.getGameSummary(eventId);
  } catch (err) {
    console.error('[datasource] ESPN summary failed:', err.message);
    throw err;
  }
}

// Rankings and standings are ESPN-only for now: ncaa-api's shape for these
// is different enough (and less complete for "others receiving votes")
// that a faithful fallback isn't worth the complexity yet. If ESPN is down,
// these simply surface an error to the UI rather than silently guessing.
async function getRankings(opts) {
  return espn.getRankings(opts);
}

async function getStandings(opts) {
  return espn.getStandings(opts);
}

async function getTeamStatistics(teamId, season) {
  return espn.getTeamStatistics(teamId, season);
}

module.exports = {
  getScoreboard,
  getTeamSchedule,
  getTeamInfo,
  getGameSummary,
  getRankings,
  getStandings,
  getTeamStatistics,
};
