const express = require('express');
const { checkPassword, requireAdmin } = require('../auth');
const db = require('../db');
const { rateLimit, isSafeId } = require('../security');

// Built per app instance so each app gets its own login rate limiter.
function createAdminRouter() {
  const router = express.Router();

  // Admin is locked when the server is running with a placeholder password
  // in production (see src/security.js).
  router.use((req, res, next) => {
    if (req.app.locals.adminEnabled === false) {
      return res.status(503).json({ error: 'Admin is disabled until a private ADMIN_PASSWORD is set on the server.' });
    }
    return next();
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

  router.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (checkPassword(password, req.app.locals.adminPassword)) {
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
    if (!isSafeId(String(eventId))) return res.status(400).json({ error: 'Invalid eventId' });
    if (source && !['espn', 'ncaa-api'].includes(source)) return res.status(400).json({ error: 'Invalid source' });
    const rows = db.addNotableGame({
      season: Number(season),
      week: Number(week),
      eventId: String(eventId),
      source,
      label: typeof label === 'string' ? label.slice(0, 120) : null,
      gameName: typeof gameName === 'string' ? gameName.slice(0, 120) : null,
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

  return router;
}

module.exports = createAdminRouter;
