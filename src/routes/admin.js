const express = require('express');
const { checkPassword, requireAdmin } = require('../auth');
const db = require('../db');
const { rateLimit, isSafeId, safeHttpUrl } = require('../security');
const { getSport } = require('../sports');
const sso = require('../sso');
const seo = require('../seo');

// "ESPN, ESPN2" or ['ESPN', 'ESPN2'] -> ['ESPN', 'ESPN2'], trimmed and capped.
function nameList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  raw.forEach((v) => {
    const name = String(v || '').trim().slice(0, 60);
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  });
  return out.slice(0, 8);
}

function shortText(value, max) {
  const t = typeof value === 'string' ? value.trim() : '';
  return t ? t.slice(0, max) : null;
}

// Validates the Radio and TV form. Returns { error } or { override }.
function readOverride(body) {
  const b = body || {};
  const sport = getSport(String(b.sport || ''));
  if (!sport) return { error: 'Unknown sport' };
  if (!['team', 'game'].includes(b.scope)) return { error: 'scope must be team or game' };
  const targetId = String(b.targetId || '').trim();
  if (!isSafeId(targetId)) return { error: 'Invalid team or game id' };
  const urls = {};
  for (const key of ['listenUrl', 'watchUrl']) {
    const value = shortText(b[key], 500);
    if (value && !safeHttpUrl(value)) return { error: `${key === 'listenUrl' ? 'Listen' : 'Watch'} link must start with http:// or https://` };
    urls[key] = value ? safeHttpUrl(value) : null;
  }
  return {
    override: {
      sport: sport.key,
      scope: b.scope,
      targetId,
      label: shortText(b.label, 120),
      tv: nameList(b.tv),
      radio: nameList(b.radio),
      radioCity: shortText(b.radioCity, 80),
      listenUrl: urls.listenUrl,
      watchName: shortText(b.watchName, 60),
      watchUrl: urls.watchUrl,
      note: shortText(b.note, 200),
    },
  };
}

// Validates the sign-in provider form. Returns { error } or { provider }.
// The client secret is required for a new provider; when editing, a blank
// secret keeps the saved one.
function readSsoProvider(body, { isNew }) {
  const b = body || {};
  const name = shortText(b.name, 40);
  if (!name) return { error: 'Give the button a name, like Tinyauth or Google.' };
  const issuer = sso.cleanIssuer(b.issuer);
  if (!issuer) return { error: 'Issuer URL must be an address starting with https:// (or http:// on your home network).' };
  const clientId = shortText(b.clientId, 300);
  if (!clientId) return { error: 'Enter the client ID from your provider.' };
  const clientSecret = typeof b.clientSecret === 'string' ? b.clientSecret.trim().slice(0, 500) : '';
  if (isNew && !clientSecret) return { error: 'Enter the client secret from your provider.' };
  const scopes = sso.cleanScopes(b.scopes);
  if (scopes === null) return { error: 'Extra scopes can only hold scope names, separated by spaces or commas.' };
  return {
    provider: {
      name,
      issuer,
      clientId,
      clientSecret,
      scopes,
      autoCreate: b.autoCreate === true,
      showOnLogin: b.showOnLogin !== false,
    },
  };
}

// What Admin sees of a provider: everything but the secret.
function adminSsoProvider(p) {
  return {
    id: p.id,
    name: p.name,
    issuer: p.issuer,
    clientId: p.clientId,
    hasSecret: !!p.clientSecret,
    scopes: p.scopes,
    autoCreate: p.autoCreate,
    showOnLogin: p.showOnLogin,
    updatedAt: p.updatedAt,
  };
}

// Built per app instance so each app gets its own login rate limiter.
function createAdminRouter({ env = process.env, fetchImpl } = {}) {
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

  // Radio and TV overrides (src/overrides.js). Saving a form with every
  // field blank removes the override, so ESPN's data shows again.
  router.get('/broadcasts', (req, res) => {
    const sport = req.query.sport ? getSport(String(req.query.sport)) : null;
    if (req.query.sport && !sport) return res.status(400).json({ error: 'Unknown sport' });
    res.json(db.listBroadcastOverrides(sport ? sport.key : undefined));
  });

  router.post('/broadcasts', (req, res) => {
    const { error, override: o } = readOverride(req.body);
    if (error) return res.status(400).json({ error });
    const empty = !o.tv.length && !o.radio.length && !o.radioCity && !o.listenUrl && !o.watchUrl && !o.note;
    if (empty) {
      db.removeBroadcastOverride(o.sport, o.scope, o.targetId);
      return res.json({ removed: true });
    }
    return res.json(db.saveBroadcastOverride(o));
  });

  router.delete('/broadcasts/:sport/:scope/:targetId', (req, res) => {
    const sport = getSport(req.params.sport);
    if (!sport || !['team', 'game'].includes(req.params.scope) || !isSafeId(req.params.targetId)) {
      return res.status(400).json({ error: 'Invalid override' });
    }
    db.removeBroadcastOverride(sport.key, req.params.scope, req.params.targetId);
    return res.json({ ok: true });
  });

  // Sign-in providers (single sign-on). Every provider uses the same
  // callback URL, shown in Admin so it can be pasted into the provider.
  router.get('/sso', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      callbackUrl: `${seo.baseUrl(req, env)}/auth/sso/callback`,
      publicUrlSet: !!(env.PUBLIC_URL && String(env.PUBLIC_URL).trim()),
      providers: db.listSsoProviders().map(adminSsoProvider),
    });
  });

  // Checks that the issuer answers OpenID discovery. A failure is a
  // warning, not a refusal, so a provider can be saved while it's down.
  async function discoveryWarning(issuer) {
    try {
      await sso.discover(issuer, fetchImpl);
      return null;
    } catch (err) {
      return `Saved, but ${issuer}/.well-known/openid-configuration didn't answer (${err.message}). Check the issuer URL.`;
    }
  }

  router.post('/sso', async (req, res) => {
    const { error, provider } = readSsoProvider(req.body, { isNew: true });
    if (error) return res.status(400).json({ error });
    const saved = db.createSsoProvider(provider);
    return res.status(201).json({ provider: adminSsoProvider(saved), warning: await discoveryWarning(saved.issuer) });
  });

  router.put('/sso/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !db.getSsoProvider(id)) return res.status(404).json({ error: 'No such provider' });
    const { error, provider } = readSsoProvider(req.body, { isNew: false });
    if (error) return res.status(400).json({ error });
    const saved = db.updateSsoProvider(id, provider);
    sso.discoveryCache.delete(saved.issuer);
    return res.json({ provider: adminSsoProvider(saved), warning: await discoveryWarning(saved.issuer) });
  });

  router.delete('/sso/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    db.removeSsoProvider(id);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = createAdminRouter;
