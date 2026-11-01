const express = require('express');
const ds = require('../datasource');
const db = require('../db');
const news = require('../news');
const videos = require('../videos');

const router = express.Router();

function favoriteTeamId() {
  return process.env.FAVORITE_TEAM_ID || '259';
}
function favoriteTeamName() {
  return process.env.FAVORITE_TEAM_NAME || 'Virginia Tech Hokies';
}

// Pin the favorite team's games to the top of a games array, in place of
// relying on whatever order the upstream API returned.
function pinFavorite(games) {
  const favId = String(favoriteTeamId());
  const isFav = (g) => (g.home && String(g.home.id) === favId) || (g.away && String(g.away.id) === favId);
  const favGames = games.filter(isFav);
  const rest = games.filter((g) => !isFav(g));
  return [...favGames, ...rest];
}

router.get('/meta', async (req, res) => {
  try {
    const current = await ds.getScoreboard({});
    res.json({
      favoriteTeamId: favoriteTeamId(),
      favoriteTeamName: favoriteTeamName(),
      season: current.season,
      week: current.week,
      seasonType: current.seasonType,
      source: current.source,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not determine current week', detail: err.message });
  }
});

router.get('/scoreboard', async (req, res) => {
  try {
    const { week, year, seasontype, groups } = req.query;
    const result = await ds.getScoreboard({
      week: week ? Number(week) : undefined,
      year: year ? Number(year) : undefined,
      seasontype: seasontype ? Number(seasontype) : undefined,
      groups: groups ? Number(groups) : undefined, // 80 = FBS, 81 = FCS
    });
    res.json({
      ...result,
      favoriteTeamId: favoriteTeamId(),
      // Only pin the favorite team to the top when it's actually in this
      // division's games (no-op harmlessly otherwise, e.g. while viewing FCS).
      games: pinFavorite(result.games),
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not load scoreboard', detail: err.message });
  }
});

router.get('/team/favorite', async (req, res) => {
  try {
    const teamId = favoriteTeamId();
    const [info, schedule] = await Promise.all([
      ds.getTeamInfo(teamId).catch(() => null),
      ds.getTeamSchedule(teamId, req.query.season).catch(() => null),
    ]);
    res.json({ team: info, schedule: schedule ? schedule.games : [] });
  } catch (err) {
    res.status(502).json({ error: 'Could not load favorite team', detail: err.message });
  }
});

// Any team's page: header info, full season schedule, and season stats.
// Used by the click-through team.html page for every team, not just the
// pinned favorite.
router.get('/team/:id', async (req, res) => {
  try {
    const teamId = req.params.id;
    const [info, schedule, stats] = await Promise.all([
      ds.getTeamInfo(teamId).catch(() => null),
      ds.getTeamSchedule(teamId, req.query.season).catch(() => null),
      ds.getTeamStatistics(teamId, req.query.season).catch(() => null),
    ]);
    res.json({
      team: info,
      schedule: schedule ? schedule.games : [],
      stats: stats ? stats.categories : [],
      isFavorite: String(teamId) === String(favoriteTeamId()),
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not load team', detail: err.message });
  }
});

// No division/group filter here on purpose — ESPN returns every poll it
// has (FBS AP/Coaches, FCS Coaches, Division II/III Coaches, etc.) in one
// response, and the front-end's poll picker is what narrows it down.
router.get('/rankings', async (req, res) => {
  try {
    const { week, year, seasontype } = req.query;
    const result = await ds.getRankings({
      week: week ? Number(week) : undefined,
      year: year ? Number(year) : undefined,
      seasontype: seasontype ? Number(seasontype) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Could not load rankings', detail: err.message });
  }
});

router.get('/standings', async (req, res) => {
  try {
    const { year, group } = req.query;
    const result = await ds.getStandings({
      year: year ? Number(year) : undefined,
      group: group ? Number(group) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Could not load standings', detail: err.message });
  }
});

router.get('/game/:id', async (req, res) => {
  try {
    const source = req.query.source || 'espn';
    const summary = await ds.getGameSummary(req.params.id, source);
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: 'Could not load game detail', detail: err.message });
  }
});

// Public read of notable games for a given season/week.
router.get('/notable', (req, res) => {
  const season = Number(req.query.season);
  const week = Number(req.query.week);
  if (!season || !week) return res.status(400).json({ error: 'season and week are required' });
  res.json(db.listNotableGames(season, week));
});

// Notable games, fully enriched with live scoreboard data (scores, status,
// broadcast, venue, logos — the same shape /api/scoreboard's games use) and
// grouped by week, in one response. Built for external dashboard widgets
// (e.g. a Glance/Dynacat "custom-api" widget) so they don't have to
// hand-maintain a list of matchups per week or make N follow-up requests —
// picking notable games stays in this app's /admin UI, and this endpoint
// is the single URL a dashboard widget points at.
//
// Query params: season (required), startWeek (defaults to the current
// week from /api/meta), weeks (how many consecutive weeks to include,
// default 1, max 8), seasontype (default 2).
router.get('/notable/feed', async (req, res) => {
  try {
    const seasontype = req.query.seasontype ? Number(req.query.seasontype) : 2;
    let season = req.query.season ? Number(req.query.season) : undefined;
    let startWeek = req.query.startWeek ? Number(req.query.startWeek) : undefined;

    if (!season || !startWeek) {
      const current = await ds.getScoreboard({ seasontype });
      season = season || current.season;
      startWeek = startWeek || current.week;
    }

    const weekCount = Math.min(Math.max(Number(req.query.weeks) || 1, 1), 8);

    const weeks = await Promise.all(
      Array.from({ length: weekCount }, (_, i) => startWeek + i).map(async (week) => {
        const picks = db.listNotableGames(season, week);
        if (!picks.length) return { week, games: [] };
        let scoreboard;
        try {
          scoreboard = await ds.getScoreboard({ year: season, week, seasontype });
        } catch (err) {
          return { week, games: [], error: 'Could not load scores for this week' };
        }
        const games = picks
          .map((pick) => {
            const game = scoreboard.games.find((g) => String(g.id) === String(pick.event_id));
            if (!game) return null;
            return { ...game, label: pick.label || null };
          })
          .filter(Boolean);
        return { week, games };
      })
    );

    res.json({
      season,
      favoriteTeamId: favoriteTeamId(),
      favoriteTeamName: favoriteTeamName(),
      weeks,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not load notable games feed', detail: err.message });
  }
});

// Merged, sorted headlines from the configured college football RSS feeds
// (see src/news.js). Meant for a "News" tab/section on the home page.
router.get('/news', async (req, res) => {
  try {
    const items = await news.getNews();
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: 'Could not load news', detail: err.message });
  }
});

// Recent uploads from the configured college football YouTube channels
// (see src/videos.js), merged and sorted newest-first. Meant for a
// "Videos" tab alongside News.
router.get('/videos', async (req, res) => {
  try {
    const items = await videos.getVideos();
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: 'Could not load videos', detail: err.message });
  }
});

module.exports = router;
