// Rosters, player pages, stat leaders and fantasy football. Kept apart from
// routes/api.js so these features can grow without touching the scores and
// game routes. Takes the same ?sport= as every other /api route.

const express = require('express');
const players = require('../players');
const leaders = require('../leaders');
const { isSafeId } = require('../security');
const { getSport, DEFAULT_SPORT } = require('../sports');

const router = express.Router();

router.param('id', (req, res, next, id) => {
  if (!isSafeId(id)) return res.status(400).json({ error: 'Invalid id' });
  return next();
});

function withSport(req, res, next) {
  const key = String(req.query.sport || DEFAULT_SPORT);
  const sport = getSport(key);
  if (!sport) return res.status(400).json({ error: `Unknown sport: ${key}` });
  req.sport = sport;
  return next();
}

const optionalNumber = (v) => (v !== undefined && /^\d{1,4}$/.test(String(v)) ? Number(v) : undefined);

router.get('/team/:id/roster', withSport, async (req, res) => {
  if (!req.sport.teams) return res.status(404).json({ error: `${req.sport.label} has no team rosters` });
  try {
    res.json(await players.getTeamRoster(req.params.id, req.sport.key));
  } catch (err) {
    res.status(502).json({ error: 'Could not load roster', detail: err.message });
  }
});

router.get('/player/:id', withSport, async (req, res) => {
  try {
    res.json(await players.getPlayer(req.params.id, req.sport.key));
  } catch (err) {
    res.status(502).json({ error: 'Could not load player', detail: err.message });
  }
});

router.get('/leaders', withSport, async (req, res) => {
  if (!req.sport.leaders) return res.json({ categories: [] });
  try {
    res.json(await leaders.getLeaders({
      sport: req.sport.key,
      season: optionalNumber(req.query.season),
      seasontype: optionalNumber(req.query.seasontype),
    }));
  } catch (err) {
    res.status(502).json({ error: 'Could not load stat leaders', detail: err.message });
  }
});

router.get('/fantasy', withSport, async (req, res) => {
  if (!req.sport.fantasy) return res.status(404).json({ error: `Fantasy scoring isn't available for ${req.sport.label}` });
  const format = ['ppr', 'half', 'standard'].includes(req.query.format) ? req.query.format : 'ppr';
  try {
    res.json(await leaders.getWeeklyFantasy({
      sport: req.sport.key,
      season: optionalNumber(req.query.season),
      week: optionalNumber(req.query.week),
      seasontype: optionalNumber(req.query.seasontype),
      format,
    }));
  } catch (err) {
    res.status(502).json({ error: 'Could not load fantasy scores', detail: err.message });
  }
});

module.exports = router;
