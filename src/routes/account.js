// User accounts: email + password, SSO (Tinyauth or any OpenID provider),
// followed teams stored on the account, game alerts, the calendar feed and
// the "my teams" API that Den Duty reads.
//
//   /api/account/...      JSON API used by the site (session cookie)
//   /auth/sso/...         SSO redirect flow
//   /calendar/<key>.ics   a user's private calendar feed
//   /calendar.ics?teams=  calendar for any list of teams, no account needed

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const sso = require('../sso');
const push = require('../push');
const { buildIcs, loadSchedules, myTeamsSummary } = require('../calendar');
const { rateLimit, isSafeId, safeHttpUrl } = require('../security');
const { getSport } = require('../sports');
const recapLib = require('../recap');

const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// Compared against when an email has no account, so a wrong email takes as
// long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function baseUrl(req, env) {
  const configured = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name || (user.email ? user.email.split('@')[0] : 'Fan'),
    hasPassword: !!user.password_hash,
    sso: !!user.oidc_sub,
    alertStart: !!user.alert_start,
    alertEnd: !!user.alert_end,
    recapEnabled: !!user.recap_enabled,
    recapTime: recapLib.cleanTime(user.recap_time) || '07:30',
    recapTimeZone: recapLib.isValidTimeZone(user.recap_tz) ? user.recap_tz : 'America/New_York',
  };
}

// Signed-in user from the session, or from "Authorization: Bearer <feed
// key>" so other apps (Den Duty, Home Assistant) can read without a cookie.
function userFromKeyOrSession(req) {
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return token ? db.getUserByFeedToken(token) : currentUser(req);
}

function signIn(req, user) {
  req.session.userId = user.id;
  req.sessionOptions.maxAge = SESSION_DAYS * 24 * 60 * 60 * 1000;
}

function currentUser(req) {
  const id = req.session && req.session.userId;
  return id ? db.getUser(id) : null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first' });
  req.user = user;
  return next();
}

function cleanText(value, max = 120) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

// A followed team from the browser: { sport, id, name, abbreviation, logo }.
function cleanFollow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sport = getSport(String(raw.sport || ''));
  const id = String(raw.id || '');
  if (!sport || sport.teams === false || !isSafeId(id)) return null;
  return {
    sport: sport.key,
    id,
    name: cleanText(raw.name),
    abbreviation: cleanText(raw.abbreviation, 12),
    logo: safeHttpUrl(raw.logo),
  };
}

// Safe same-site path to return to after SSO ("/team.html?id=1"), never
// another site ("//evil.example", "https://...").
function safeNext(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value.slice(0, 500) : '/account.html';
}

function feedLinks(req, env, user) {
  const base = baseUrl(req, env);
  const ics = `${base}/calendar/${user.feed_token}.ics`;
  return {
    calendarUrl: ics,
    webcalUrl: ics.replace(/^https?:/, 'webcal:'),
    teamsApiUrl: `${base}/api/account/teams`,
    recapApiUrl: `${base}/api/account/recap`,
    feedKey: user.feed_token,
  };
}

function createAccountRouter({ env = process.env, recapper = null } = {}) {
  const router = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  const allowSignup = String(env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';
  // Each "Send me one now" can cost a Claude call.
  const recapNowLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(env.RECAP_NOW_PER_HOUR) || 6 });

  router.get('/me', (req, res) => {
    const user = currentUser(req);
    const ssoCfg = sso.ssoConfig(env);
    const options = { signup: allowSignup, sso: ssoCfg.enabled ? { label: ssoCfg.label } : null };
    if (!user) return res.json({ user: null, options });
    return res.json({
      user: publicUser(user),
      follows: db.listFollows(user.id),
      pushDevices: db.countPushSubscriptions(user.id),
      feed: feedLinks(req, env, user),
      options,
    });
  });

  router.post('/signup', authLimiter, async (req, res) => {
    if (!allowSignup) return res.status(403).json({ error: 'New accounts are turned off on this site.' });
    const { email, password, displayName } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
      return res.status(400).json({ error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    }
    if (db.getUserByEmail(cleanEmail)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });
    const user = db.createUser({
      email: cleanEmail,
      passwordHash: await bcrypt.hash(password, 10),
      displayName: cleanText(displayName, 60),
    });
    signIn(req, user);
    return res.status(201).json({ user: publicUser(user) });
  });

  router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = typeof email === 'string' ? db.getUserByEmail(email.trim().toLowerCase()) : null;
    const ok = await bcrypt.compare(String(password || ''), (user && user.password_hash) || DUMMY_HASH);
    if (!user || !user.password_hash || !ok) return res.status(401).json({ error: 'Wrong email or password.' });
    signIn(req, user);
    return res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    if (req.session) delete req.session.userId;
    res.json({ ok: true });
  });

  // Everything below needs a signed-in user, except /teams, which also
  // takes the private feed key so another app (Den Duty) can read it.
  router.get('/teams', async (req, res) => {
    const user = userFromKeyOrSession(req);
    if (!user) return res.status(401).json({ error: 'Sign in or send Authorization: Bearer <feed key>' });
    try {
      const teams = await myTeamsSummary(db.listFollows(user.id), { baseUrl: baseUrl(req, env) });
      res.set('Cache-Control', 'private, max-age=30');
      return res.json({ user: { displayName: publicUser(user).displayName }, teams, recap: db.getRecap(user.id) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not load teams', detail: err.message });
    }
  });

  // Scrappy's latest daily recap and the recap settings. Home Assistant's
  // recap sensor and Den Duty read this with the feed key.
  router.get('/recap', (req, res) => {
    const user = userFromKeyOrSession(req);
    if (!user) return res.status(401).json({ error: 'Sign in or send Authorization: Bearer <feed key>' });
    res.set('Cache-Control', 'private, no-cache');
    return res.json({ user: { displayName: publicUser(user).displayName }, ...recapLib.recapState(user) });
  });

  router.use(requireUser);

  router.patch('/me', (req, res) => {
    const { displayName, alertStart, alertEnd, recapEnabled, recapTime, recapTimeZone } = req.body || {};
    if (recapTime !== undefined && !recapLib.cleanTime(recapTime)) return res.status(400).json({ error: 'Pick a recap time like 07:30.' });
    if (recapTimeZone !== undefined && !recapLib.isValidTimeZone(recapTimeZone)) return res.status(400).json({ error: 'Unknown time zone.' });
    const user = db.updateUser(req.user.id, {
      displayName: displayName !== undefined ? cleanText(displayName, 60) : undefined,
      alertStart: typeof alertStart === 'boolean' ? alertStart : undefined,
      alertEnd: typeof alertEnd === 'boolean' ? alertEnd : undefined,
      recapEnabled: typeof recapEnabled === 'boolean' ? recapEnabled : undefined,
      recapTime: recapTime !== undefined ? recapLib.cleanTime(recapTime) : undefined,
      recapTz: recapTimeZone !== undefined ? recapTimeZone : undefined,
    });
    res.json({ user: publicUser(user) });
  });

  router.get('/follows', (req, res) => {
    res.json({ follows: db.listFollows(req.user.id) });
  });

  router.post('/follows', (req, res) => {
    const team = cleanFollow(req.body);
    if (!team) return res.status(400).json({ error: 'Invalid team' });
    if (!db.addFollow(req.user.id, team)) return res.status(409).json({ error: `You can follow up to ${db.MAX_FOLLOWS} teams.` });
    return res.json({ follows: db.listFollows(req.user.id) });
  });

  router.delete('/follows/:sport/:id', (req, res) => {
    if (!isSafeId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    db.removeFollow(req.user.id, String(req.params.sport), req.params.id);
    res.json({ follows: db.listFollows(req.user.id) });
  });

  // Teams followed in this browser before signing in.
  router.post('/follows/merge', (req, res) => {
    const list = Array.isArray(req.body && req.body.follows) ? req.body.follows.slice(0, db.MAX_FOLLOWS) : [];
    const teams = list.map(cleanFollow).filter(Boolean);
    res.json({ follows: db.mergeFollows(req.user.id, teams) });
  });

  router.get('/push/key', (req, res) => {
    res.json({ publicKey: push.vapidKeys(env).publicKey });
  });

  router.post('/push/subscribe', (req, res) => {
    const sub = req.body && req.body.subscription;
    const endpoint = sub && safeHttpUrl(sub.endpoint);
    const keys = sub && sub.keys;
    if (!endpoint || !endpoint.startsWith('https://') || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
      || keys.p256dh.length > 200 || keys.auth.length > 100 || sub.endpoint.length > 1000) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    db.savePushSubscription(req.user.id, { endpoint: sub.endpoint, keys });
    res.json({ ok: true, pushDevices: db.countPushSubscriptions(req.user.id) });
  });

  router.post('/push/unsubscribe', (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (typeof endpoint === 'string') db.removePushSubscription(endpoint, req.user.id);
    res.json({ ok: true, pushDevices: db.countPushSubscriptions(req.user.id) });
  });

  router.post('/push/test', async (req, res) => {
    const subs = db.pushSubscriptionsForUser(req.user.id);
    if (!subs.length) return res.status(400).json({ error: 'Turn on alerts on this device first.' });
    const delivered = await push.sendToSubscriptions(subs, {
      title: 'Alerts are on',
      body: "You'll hear from us when your teams' games start and end.",
      url: '/account.html',
      tag: 'test',
    });
    res.json({ delivered });
  });

  // Writes today's recap right now and pushes it to this account's devices.
  router.post('/recap/now', recapNowLimiter, async (req, res) => {
    if (!recapper) return res.status(503).json({ error: 'Recaps are off on this site.' });
    if (!db.listFollows(req.user.id).length) return res.status(400).json({ error: 'Follow a team first.' });
    try {
      const out = await recapper.deliver(req.user, { force: true });
      return res.set('Cache-Control', 'no-store').json({ recap: out.recap, delivered: out.delivered });
    } catch (err) {
      return res.status(502).json({ error: "Scrappy couldn't put the recap together. Try again in a minute.", detail: err.message });
    }
  });

  // New private key: old calendar links and Den Duty keys stop working.
  router.post('/feed/reset', (req, res) => {
    const user = db.resetFeedToken(req.user.id);
    res.json({ feed: feedLinks(req, env, user) });
  });

  return router;
}

// SSO and calendar routes, mounted at the site root.
function createAccountPublicRouter({ env = process.env, fetchImpl } = {}) {
  const router = express.Router();
  const ssoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

  router.get('/auth/sso/login', ssoLimiter, async (req, res) => {
    const cfg = sso.ssoConfig(env);
    if (!cfg.enabled) return res.status(404).send('Single sign-on is not set up on this site.');
    try {
      const { url, pending } = await sso.startLogin(cfg, `${baseUrl(req, env)}/auth/sso/callback`, fetchImpl);
      req.session.sso = { ...pending, next: safeNext(req.query.next) };
      return res.redirect(url);
    } catch (err) {
      console.warn('[sso]', err.message);
      return res.redirect('/account.html?error=sso');
    }
  });

  router.get('/auth/sso/callback', ssoLimiter, async (req, res) => {
    const cfg = sso.ssoConfig(env);
    const pending = req.session && req.session.sso;
    if (req.session) delete req.session.sso;
    if (!cfg.enabled || !pending || !req.query.code || req.query.state !== pending.state) {
      return res.redirect('/account.html?error=sso');
    }
    try {
      const claims = await sso.finishLogin(cfg, pending, String(req.query.code), fetchImpl);
      const subject = `${cfg.issuer}|${claims.sub}`;
      const email = typeof claims.email === 'string' && EMAIL_RE.test(claims.email.trim()) ? claims.email.trim().toLowerCase() : null;
      const name = cleanText(claims.name, 60) || cleanText(claims.preferred_username, 60);
      let user = db.getUserByOidcSub(subject);
      if (!user && email && claims.email_verified !== false) {
        // Same email as an existing email/password account: sign-in links
        // the two, so a person has one account either way they sign in.
        const existing = db.getUserByEmail(email);
        if (existing && !existing.oidc_sub) user = db.linkOidc(existing.id, subject);
      }
      if (!user) {
        user = db.createUser({ email: email && !db.getUserByEmail(email) ? email : null, displayName: name, oidcSub: subject });
      }
      signIn(req, user);
      return res.redirect(pending.next || '/account.html');
    } catch (err) {
      console.warn('[sso]', err.message);
      return res.redirect('/account.html?error=sso');
    }
  });

  router.get('/calendar/:token.ics', async (req, res) => {
    const user = db.getUserByFeedToken(req.params.token);
    if (!user) return res.status(404).send('Calendar not found');
    const schedules = await loadSchedules(db.listFollows(user.id));
    const name = `${publicUser(user).displayName}'s teams`;
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=900');
    return res.send(buildIcs(schedules, { name, baseUrl: baseUrl(req, env) }));
  });

  // ?teams=cfb:259,nba:2 — lets visitors without an account add their
  // followed teams to a calendar too.
  router.get('/calendar.ics', async (req, res) => {
    const follows = String(req.query.teams || '').split(',').slice(0, db.MAX_FOLLOWS).map((pair) => {
      const [sport, id] = pair.split(':');
      return cleanFollow({ sport, id });
    }).filter(Boolean);
    if (!follows.length) return res.status(400).send('Add ?teams=sport:teamId,...');
    const schedules = await loadSchedules(follows);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=900');
    return res.send(buildIcs(schedules, { name: 'My teams', baseUrl: baseUrl(req, env) }));
  });

  return router;
}

module.exports = { createAccountRouter, createAccountPublicRouter, safeNext, cleanFollow };
