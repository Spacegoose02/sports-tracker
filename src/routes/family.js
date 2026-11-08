// Family play API: Kids Zone data saved to the signed-in account, family
// leagues and their standings, and the public playoff hub data.
//
//   GET    /api/brackets?sport=cfb|mcbb&season=     playoff hub (public)
//   GET    /api/family/data                          players, picks, stickers, brackets
//   POST   /api/family/data/merge   { data }         add this browser's saved data
//   PUT    /api/family/data/:key    { value }        save one key
//   GET    /api/family/leagues                       my leagues
//   POST   /api/family/leagues      { name }         start a league
//   POST   /api/family/leagues/join { code }         join with an invite code
//   PATCH  /api/family/leagues/:id  { name }         rename (owner)
//   POST   /api/family/leagues/:id/code              new invite code (owner)
//   DELETE /api/family/leagues/:id/members/me        leave
//   DELETE /api/family/leagues/:id/members/:userId   remove someone (owner)
//   GET    /api/family/leagues/:id/leaderboard?sport=&week=
//   GET    /api/family/leagues/:id/bracket?sport=&season=

const express = require('express');
const db = require('../db');
const family = require('../family');
const brackets = require('../brackets');
const { rateLimit } = require('../security');

function requireUser(req, res, next) {
  const id = req.session && req.session.userId;
  const user = id ? db.getUser(id) : null;
  if (!user) return res.status(401).json({ error: 'Sign in first' });
  req.user = user;
  return next();
}

function leagueName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null;
}

function seasonParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : undefined;
}

function createBracketsRouter({ deps } = {}) {
  const router = express.Router();
  const getPostseason = (deps && deps.getPostseason) || brackets.getPostseason;
  router.get('/brackets', async (req, res) => {
    const sport = String(req.query.sport || 'cfb');
    if (!brackets.SPORTS.includes(sport)) return res.status(400).json({ error: 'sport must be cfb or mcbb' });
    try {
      res.json(await getPostseason({ sport, season: seasonParam(req.query.season) }));
    } catch (err) {
      res.status(502).json({ error: 'Could not load the postseason', detail: err.message });
    }
  });
  return router;
}

function createFamilyRouter({ deps } = {}) {
  const router = express.Router();
  const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
  router.use(requireUser);

  // ---- Saved Kids Zone data ----------------------------------------------
  router.get('/data', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json({ data: family.getKidsData(req.user.id) });
  });

  router.post('/data/merge', (req, res) => {
    const data = req.body && req.body.data;
    res.json({ data: family.mergeKidsData(req.user.id, data && typeof data === 'object' ? data : {}) });
  });

  router.put('/data/:key', (req, res) => {
    const { key } = req.params;
    if (!family.KEYS.includes(key)) return res.status(404).json({ error: 'Unknown key' });
    const value = family.saveKidsKey(req.user.id, key, req.body && req.body.value);
    res.json({ key, value });
  });

  // ---- Leagues ---------------------------------------------------------------
  const leagueId = (req) => Number(req.params.id);
  function memberOnly(req, res, next) {
    const id = leagueId(req);
    if (!Number.isInteger(id) || !family.isMember(id, req.user.id)) return res.status(404).json({ error: 'League not found' });
    return next();
  }

  router.get('/leagues', (req, res) => {
    res.json({ leagues: family.listLeagues(req.user.id) });
  });

  router.post('/leagues', (req, res) => {
    const name = leagueName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Give your league a name.' });
    const out = family.createLeague(req.user.id, name);
    if (out.error) return res.status(409).json(out);
    return res.status(201).json(out);
  });

  router.post('/leagues/join', joinLimiter, (req, res) => {
    const out = family.joinLeague(req.user.id, req.body && req.body.code);
    if (out.error) return res.status(out.error.startsWith('No league') ? 404 : 409).json(out);
    return res.json(out);
  });

  router.patch('/leagues/:id', memberOnly, (req, res) => {
    const name = leagueName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Give your league a name.' });
    const league = family.renameLeague(req.user.id, leagueId(req), name);
    if (!league) return res.status(403).json({ error: 'Only the league owner can rename it.' });
    return res.json({ league });
  });

  router.post('/leagues/:id/code', memberOnly, (req, res) => {
    const league = family.resetCode(req.user.id, leagueId(req));
    if (!league) return res.status(403).json({ error: 'Only the league owner can change the code.' });
    return res.json({ league });
  });

  router.delete('/leagues/:id/members/me', memberOnly, (req, res) => {
    family.leaveLeague(req.user.id, leagueId(req));
    res.json({ leagues: family.listLeagues(req.user.id) });
  });

  router.delete('/leagues/:id/members/:userId', memberOnly, (req, res) => {
    if (!family.removeMember(req.user.id, leagueId(req), Number(req.params.userId))) {
      return res.status(403).json({ error: 'Only the league owner can remove members.' });
    }
    return res.json({ league: family.publicLeague(family.getLeague(leagueId(req)), req.user.id) });
  });

  router.get('/leagues/:id/leaderboard', memberOnly, async (req, res) => {
    const sport = typeof req.query.sport === 'string' && /^[a-z]{2,10}$/.test(req.query.sport) ? req.query.sport : undefined;
    const weekKey = typeof req.query.week === 'string' && req.query.week.length <= 40 ? req.query.week : undefined;
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await family.weeklyLeaderboard(leagueId(req), { sport, weekKey }, deps));
    } catch (err) {
      res.status(502).json({ error: 'Could not load the leaderboard', detail: err.message });
    }
  });

  router.get('/leagues/:id/xp', memberOnly, (req, res) => {
    const since = Number(req.query.since);
    const game = family.chatGameKey(req.query.game);
    res.set('Cache-Control', 'private, no-store');
    res.json(family.xpStandings(leagueId(req), { since: Number.isFinite(since) ? since : undefined, game }));
  });

  // ---- Watch party chat ------------------------------------------------------
  const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyGenerator: (req) => `chat:${req.user.id}` });
  router.get('/leagues/:id/chat', memberOnly, (req, res) => {
    const game = family.chatGameKey(req.query.game);
    if (!game) return res.status(400).json({ error: 'game is required, like cfb:401628374' });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ messages: family.listChat(leagueId(req), game, { after: req.query.after, userId: req.user.id }), reactions: family.CHAT_REACTIONS });
  });

  router.post('/leagues/:id/chat', memberOnly, chatLimiter, (req, res) => {
    const body = req.body || {};
    const game = family.chatGameKey(body.game);
    if (!game) return res.status(400).json({ error: 'game is required' });
    const message = family.postChat(leagueId(req), game, req.user, { text: body.text, playerId: body.playerId });
    if (!message) return res.status(400).json({ error: 'Say something first.' });
    return res.json({ message });
  });

  router.get('/leagues/:id/bracket', memberOnly, async (req, res) => {
    const sport = String(req.query.sport || 'cfb');
    if (!brackets.SPORTS.includes(sport)) return res.status(400).json({ error: 'sport must be cfb or mcbb' });
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await family.bracketStandings(leagueId(req), { sport, season: seasonParam(req.query.season) }, deps));
    } catch (err) {
      res.status(502).json({ error: 'Could not load bracket standings', detail: err.message });
    }
  });

  return router;
}

module.exports = { createFamilyRouter, createBracketsRouter };
