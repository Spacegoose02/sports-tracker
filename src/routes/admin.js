const express = require('express');
const { checkPassword, requireAdmin } = require('../auth');
const db = require('../db');

const router = express.Router();

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (checkPassword(password)) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isAdmin) });
});

// Everything below requires an active admin session.
router.use(requireAdmin);

router.get('/notable', (req, res) => {
  const season = Number(req.query.season);
  const week = Number(req.query.week);
  if (!season || !week) return res.status(400).json({ error: 'season and week are required' });
  res.json(db.listNotableGames(season, week));
});

router.post('/notable', (req, res) => {
  const { season, week, eventId, source, label, gameName, sortOrder } = req.body || {};
  if (!season || !week || !eventId) {
    return res.status(400).json({ error: 'season, week, and eventId are required' });
  }
  const rows = db.addNotableGame({
    season: Number(season),
    week: Number(week),
    eventId: String(eventId),
    source,
    label,
    gameName,
    sortOrder,
  });
  res.json(rows);
});

router.delete('/notable/:id', (req, res) => {
  db.removeNotableGame(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/notable/reorder', (req, res) => {
  const { season, week, orderedIds } = req.body || {};
  if (!season || !week || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'season, week, and orderedIds[] are required' });
  }
  const rows = db.reorderNotableGames(Number(season), Number(week), orderedIds.map(Number));
  res.json(rows);
});

module.exports = router;
