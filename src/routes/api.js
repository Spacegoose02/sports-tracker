const express = require('express');
const ds = require('../datasource');
const db = require('../db');
const news = require('../news');
const videos = require('../videos');
const radio = require('../radio');
const scorecard = require('../scorecard');
const { isSafeId } = require('../security');
const { getSport, DEFAULT_SPORT, publicSportList } = require('../sports');

const router = express.Router();

// Team and game IDs are placed into upstream API URLs, so reject anything
// that isn't a plain ID before it gets that far.
router.param('id', (req, res, next, id) => {
  if (!isSafeId(id)) return res.status(400).json({ error: 'Invalid id' });
  return next();
});

// Every data route takes an optional ?sport= (see src/sports.js). Missing
// means college football, so existing links and widgets keep working.
router.use((req, res, next) => {
  const key = req.query.sport || DEFAULT_SPORT;
  const sport = getSport(String(key));
  if (!sport) return res.status(400).json({ error: `Unknown sport: ${key}` });
  req.sport = sport;
  return next();
});

// The favorite team, Notable Games and the pinned "My Team" card are
// college-football features; FAVORITE_TEAM_ID is an ESPN CFB team id.
function isCfb(req) {
  return req.sport.key === DEFAULT_SPORT;
}

// YYYYMMDD or YYYYMMDD-YYYYMMDD, for day-based sports.
const DATES_RE = /^\d{8}(-\d{8})?$/;

router.get('/sports', (req, res) => {
  res.json({ defaultSport: DEFAULT_SPORT, sports: publicSportList() });
});

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
    const current = await ds.getScoreboard({ sport: req.sport.key });
    res.json({
      sport: req.sport.key,
      favoriteTeamId: isCfb(req) ? favoriteTeamId() : null,
      favoriteTeamName: isCfb(req) ? favoriteTeamName() : null,
      season: current.season,
      week: current.week,
      seasonType: current.seasonType,
      day: current.day || null,
      source: current.source,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not determine current week', detail: err.message });
  }
});

router.get('/scoreboard', async (req, res) => {
  try {
    const { week, year, seasontype, groups, dates } = req.query;
    if (dates && !DATES_RE.test(String(dates))) return res.status(400).json({ error: 'dates must be YYYYMMDD or YYYYMMDD-YYYYMMDD' });
    const result = await ds.getScoreboard({
      sport: req.sport.key,
      week: week ? Number(week) : undefined,
      year: year ? Number(year) : undefined,
      seasontype: seasontype ? Number(seasontype) : undefined,
      groups: groups ? Number(groups) : undefined, // CFB: 80 = FBS, 81 = FCS
      dates: dates ? String(dates) : undefined,
    });
    res.json({
      ...result,
      favoriteTeamId: isCfb(req) ? favoriteTeamId() : null,
      // Only pin the favorite team to the top when it's actually in this
      // division's games (no-op harmlessly otherwise, e.g. while viewing FCS).
      games: isCfb(req) ? pinFavorite(result.games) : result.games,
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
  if (!req.sport.teams) return res.status(404).json({ error: `${req.sport.label} has no team pages` });
  try {
    const teamId = req.params.id;
    const sport = req.sport.key;
    // ?lite=1 skips season stats: the home page's "My Teams" cards only
    // need the header and schedule.
    const lite = req.query.lite === '1';
    const [info, schedule, stats] = await Promise.all([
      ds.getTeamInfo(teamId, sport).catch(() => null),
      ds.getTeamSchedule(teamId, req.query.season, sport).catch(() => null),
      lite ? null : ds.getTeamStatistics(teamId, req.query.season, sport).catch(() => null),
    ]);
    res.json({
      sport,
      team: info,
      schedule: schedule ? schedule.games : [],
      stats: stats ? stats.categories : [],
      isFavorite: isCfb(req) && String(teamId) === String(favoriteTeamId()),
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
    if (!req.sport.rankings) return res.json({ polls: [] });
    const { week, year, seasontype } = req.query;
    const result = await ds.getRankings({
      sport: req.sport.key,
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
    if (!req.sport.standings) return res.json({ conferences: [] });
    const { year, group } = req.query;
    const result = await ds.getStandings({
      sport: req.sport.key,
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
    const source = req.query.source === 'ncaa-api' ? 'ncaa-api' : 'espn';
    const summary = await ds.getGameSummary(req.params.id, source, req.sport.key);
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: 'Could not load game detail', detail: err.message });
  }
});

// Where to listen: radio stations, SiriusXM, and free audio links for one
// game. Separate from /game/:id because it changes rarely and is cached
// longer. Uses the same ?sport= as every other route.
router.get('/game/:id/radio', async (req, res) => {
  try {
    res.json(await radio.getGameRadio(req.params.id, req.sport.key));
  } catch (err) {
    res.status(502).json({ error: 'Could not load radio info', detail: err.message });
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
    // College football keeps its configured RSS feeds; other sports use
    // ESPN's league headlines.
    const items = isCfb(req) ? await news.getNews() : await ds.getNews({ sport: req.sport.key });
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: 'Could not load news', detail: err.message });
  }
});

// Headlines for the teams a visitor follows, from ESPN's per-team news.
// ?teams=52,259,... (max 10). Each item is tagged with the team it came
// from; stories that mention two followed teams appear once.
const MAX_FOLLOWED_TEAMS = 10;
router.get('/news/teams', async (req, res) => {
  const ids = String(req.query.teams || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d{1,10}$/.test(id));
  const unique = [...new Set(ids)].slice(0, MAX_FOLLOWED_TEAMS);
  if (!unique.length) return res.json({ items: [] });
  try {
    const perTeam = await Promise.all(unique.map(async (teamId) => {
      const items = await ds.getNews({ sport: req.sport.key, team: teamId, limit: 10 }).catch(() => []);
      return items.map((item) => ({ ...item, teamId }));
    }));
    const seen = new Set();
    const items = perTeam.flat().filter((item) => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });
    items.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
    res.json({ items: items.slice(0, 40) });
  } catch (err) {
    res.status(502).json({ error: 'Could not load team news', detail: err.message });
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

// Every team in a league, for pickers such as the Home Assistant
// integration's "follow a team" step.
router.get('/teams', async (req, res) => {
  if (!req.sport.teams) return res.json({ sport: req.sport.key, teams: [] });
  try {
    res.json({ sport: req.sport.key, teams: await ds.getTeams({ sport: req.sport.key }) });
  } catch (err) {
    res.status(502).json({ error: 'Could not load teams', detail: err.message });
  }
});

// ---- Home Assistant scorecards (src/scorecard.js) ---------------------------

async function buildScorecard(sport, teamId) {
  if (sport.format === 'game') return scorecard.teamScorecard(sport, teamId);
  return scorecard.eventScorecard(sport);
}

// One scorecard: ?sport=cfb&team=259, or ?sport=nascar / ?sport=ufc.
router.get('/ha/scorecard', async (req, res) => {
  const teamId = req.query.team ? String(req.query.team) : null;
  if (req.sport.format === 'game' && !teamId) return res.status(400).json({ error: 'team is required for this sport' });
  if (teamId && !isSafeId(teamId)) return res.status(400).json({ error: 'Invalid team' });
  try {
    res.json(await buildScorecard(req.sport, teamId));
  } catch (err) {
    res.status(502).json({ error: 'Could not build scorecard', detail: err.message });
  }
});

// Many scorecards in one request, which is what Home Assistant polls:
// ?items=cfb:259,nhl:7,nascar,ufc (max 20). Results come back keyed by
// the item string; one failing item doesn't fail the rest.
const MAX_SCORECARDS = 20;
router.get('/ha/scorecards', async (req, res) => {
  const items = [...new Set(String(req.query.items || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_SCORECARDS);
  const results = await Promise.all(items.map(async (item) => {
    const [sportKey, teamId] = item.split(':');
    const sport = getSport(sportKey);
    if (!sport) return [item, { error: `Unknown sport: ${sportKey}` }];
    if (sport.format === 'game' && (!teamId || !isSafeId(teamId))) return [item, { error: 'Missing or invalid team id' }];
    try {
      return [item, await buildScorecard(sport, teamId)];
    } catch (err) {
      return [item, { error: 'Could not build scorecard', detail: err.message }];
    }
  }));
  res.json({ updated: new Date().toISOString(), scorecards: Object.fromEntries(results) });
});

module.exports = router;
