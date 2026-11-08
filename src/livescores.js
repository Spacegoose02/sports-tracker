// ESPN's per-team schedule endpoint isn't a live feed: while a game is in
// progress it carries the game's status but no score (and the status can
// lag behind). Anything that shows a followed team's live game from its
// schedule (the home page's My Teams cards, the Scores page's My Teams,
// the team page) runs the schedule through freshenGames() first, which
// swaps in the live version of any game that is, or should be, under way.
//
// The live copy comes from the league's scoreboard (cached for seconds and
// already loaded by the home page), and for a game the scoreboard doesn't
// list (a late game that ran past midnight, an ncaa-api fallback board),
// from that game's summary.

const realDs = require('./datasource');

// A scheduled game whose start time passed less than this long ago might be
// under way even though the schedule still says "pre".
const STARTED_WINDOW = 8 * 60 * 60 * 1000;

function needsFreshening(game, now) {
  if (!game || !game.status) return false;
  if (game.status.state === 'in') return true;
  if (game.status.state !== 'pre') return false;
  const t = Date.parse(game.date);
  return !Number.isNaN(t) && t <= now && t >= now - STARTED_WINDOW;
}

function hasScore(team) {
  return !!team && team.score !== null && team.score !== undefined && team.score !== '';
}

// Copies the live status and scores onto the schedule's game, keeping the
// schedule's own fields (venue, broadcast, overrides) otherwise.
function mergeTeam(mine, fresh) {
  if (!mine) return fresh || mine;
  if (!fresh) return mine;
  return {
    ...mine,
    score: hasScore(fresh) ? fresh.score : mine.score,
    winner: fresh.winner !== undefined ? !!fresh.winner : mine.winner,
    linescores: fresh.linescores && fresh.linescores.length ? fresh.linescores : mine.linescores,
  };
}

function mergeGame(game, fresh) {
  return {
    ...game,
    status: fresh.status || game.status,
    situation: fresh.situation || game.situation,
    home: mergeTeam(game.home, fresh.home),
    away: mergeTeam(game.away, fresh.away),
  };
}

// A game summary lists the two teams in `teams`, tagged home / away.
function gameFromSummary(summary) {
  if (!summary || !Array.isArray(summary.teams)) return null;
  const pick = (side) => summary.teams.find((t) => t.homeAway === side) || null;
  return { status: summary.status, situation: summary.situation, home: pick('home'), away: pick('away') };
}

async function freshenGames(games, sport, { ds = realDs, now = Date.now() } = {}) {
  if (!Array.isArray(games) || !games.some((g) => needsFreshening(g, now))) return games;
  let board = null;
  try {
    board = await ds.getScoreboard({ sport });
  } catch (err) {
    board = null;
  }
  const byId = new Map(((board && board.games) || []).map((g) => [String(g.id), g]));
  return Promise.all(games.map(async (game) => {
    if (!needsFreshening(game, now)) return game;
    let merged = game;
    const live = byId.get(String(game.id));
    if (live) merged = mergeGame(game, live);
    const stillMissing = merged.status && merged.status.state === 'in'
      && (!hasScore(merged.home) || !hasScore(merged.away));
    if (!live || stillMissing) {
      try {
        const fresh = gameFromSummary(await ds.getGameSummary(String(game.id), 'espn', sport));
        if (fresh && fresh.status && fresh.status.state) merged = mergeGame(merged, fresh);
      } catch (err) {
        // Keep what the schedule (and scoreboard) gave us.
      }
    }
    return merged;
  }));
}

module.exports = { freshenGames, needsFreshening };
