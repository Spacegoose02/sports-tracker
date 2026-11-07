// Notable games, enriched with live scoreboard data (scores, status,
// broadcast, venue, logos: the same game shape /api/scoreboard returns) and
// grouped by week. Shared by the public site-picks feed (/api/notable/feed)
// and each account's own feed (/api/account/notable/feed), which dashboard
// widgets such as Glance/Dynacat "custom-api" read.

const ds = require('./datasource');
const overrides = require('./overrides');
const { DEFAULT_SPORT } = require('./sports');

const MAX_WEEKS = 8;

// The current CFB season and week, from the live scoreboard.
async function currentWeek(seasontype = 2) {
  const current = await ds.getScoreboard({ seasontype });
  return { season: current.season, week: current.week };
}

// listPicks(season, week) returns the stored rows for that week.
// query: { season, startWeek, weeks, seasontype } (strings from req.query).
async function buildNotableFeed(listPicks, query = {}) {
  const seasontype = Number(query.seasontype) || 2;
  let season = Number(query.season) || undefined;
  let startWeek = Number(query.startWeek) || undefined;
  if (!season || !startWeek) {
    const current = await currentWeek(seasontype);
    season = season || current.season;
    startWeek = startWeek || current.week;
  }
  const weekCount = Math.min(Math.max(Number(query.weeks) || 1, 1), MAX_WEEKS);

  const weeks = await Promise.all(
    Array.from({ length: weekCount }, (_, i) => startWeek + i).map(async (week) => {
      const picks = listPicks(season, week);
      if (!picks.length) return { week, games: [] };
      let scoreboard;
      try {
        scoreboard = await ds.getScoreboard({ year: season, week, seasontype });
      } catch (err) {
        return { week, games: [], error: 'Could not load scores for this week' };
      }
      const games = picks
        .map((pick) => {
          const game = (scoreboard.games || []).find((g) => String(g.id) === String(pick.event_id));
          return game ? { ...game, label: pick.label || null } : null;
        })
        .filter(Boolean);
      return { week, games: overrides.applyToGames(games, DEFAULT_SPORT) };
    })
  );

  const flat = weeks.flatMap((w) => w.games);
  return {
    season,
    startWeek,
    weeks,
    // Handy totals for a dashboard header ("2 live").
    counts: {
      games: flat.length,
      live: flat.filter((g) => g.status && g.status.state === 'in').length,
      final: flat.filter((g) => g.status && g.status.state === 'post').length,
      upcoming: flat.filter((g) => !g.status || g.status.state === 'pre').length,
    },
  };
}

module.exports = { buildNotableFeed, currentWeek, MAX_WEEKS };
