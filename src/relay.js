// A caching relay for ESPN's site API, so other apps on the home network
// (BingeBandit's Sports section) read ESPN through this tracker instead of
// each calling ESPN themselves.
//
//   GET /espn/site/v2/sports/{sport}/{league}/{endpoint}?{query}
//
// answers exactly what
//
//   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/{endpoint}?{query}
//
// would, from a shared cache. It's off unless RELAY_API_KEY is set, and every
// request must send that key as X-Api-Key. Only the read endpoints apps need
// are relayed (scoreboard, teams, a team, its schedule, summary, rankings,
// news), and only to ESPN, so it can't be used as an open proxy.
//
// How long an answer is kept depends on what's in it: 15 seconds while a game
// in it is live or about to start, a few minutes for other scoreboards and
// summaries, and hours for team lists. When ESPN fails, the last copy (up to
// a day old) is served instead, marked X-Cache: STALE.

const crypto = require('crypto');
const express = require('express');
const nodeFetch = require('node-fetch');

const ESPN_SITE = 'https://site.api.espn.com/apis';

const ALLOWED = /^\/site\/v2\/sports\/[a-z-]+\/[a-z0-9.-]+\/(scoreboard|teams|teams\/[0-9]+|teams\/[0-9]+\/schedule|summary|rankings|news)$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const STALE_FOR = 24 * HOUR; // how long a copy may be served when ESPN is down
const MAX_ENTRIES = 1000;
const MAX_BODY = 32 * 1024 * 1024;

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Events in a scoreboard ({events: [...]}) or a summary ({header:
// {competitions: [...]}}), as {state, date} pairs.
function gameStates(body) {
  const out = [];
  const add = (status, date) => {
    const state = status && status.type && status.type.state;
    if (state) out.push({ state, date: date ? Date.parse(date) : NaN });
  };
  if (Array.isArray(body.events)) {
    for (const e of body.events) {
      const comp = Array.isArray(e.competitions) ? e.competitions[0] : null;
      add(e.status || (comp && comp.status), e.date);
    }
  }
  if (body.header && Array.isArray(body.header.competitions)) {
    for (const c of body.header.competitions) add(c.status, c.date);
  }
  return out;
}

// ttlFor says how long to keep an answer for path.
function ttlFor(path, body, now) {
  const endpoint = path.split('/').slice(6).join('/');
  if (endpoint === 'teams' || /^teams\/[0-9]+$/.test(endpoint)) return 12 * HOUR;
  if (endpoint === 'rankings' || endpoint === 'news' || endpoint.endsWith('/schedule')) return 10 * MINUTE;
  // scoreboard and summary
  const games = gameStates(body);
  const soon = games.some((g) => g.state === 'in' || (g.state === 'pre' && g.date - now < 20 * MINUTE && now - g.date < 6 * HOUR));
  if (soon) return 15 * SECOND;
  return endpoint === 'summary' ? 10 * MINUTE : 5 * MINUTE;
}

function createRelayRouter({ env = process.env, fetch = nodeFetch, upstream = ESPN_SITE, now = Date.now, logger = console } = {}) {
  const router = express.Router();
  const key = env.RELAY_API_KEY || '';
  const cache = new Map(); // url -> { body, fresh, keep }
  const inflight = new Map(); // url -> Promise

  router.use((req, res, next) => {
    if (!key) return res.status(404).json({ error: 'The ESPN relay is off. Set RELAY_API_KEY to turn it on.' });
    if (!sameKey(req.get('X-Api-Key') || '', key)) return res.status(401).json({ error: 'Wrong or missing X-Api-Key' });
    return next();
  });

  async function load(url, path) {
    const res = await fetch(url, { timeout: 10000, headers: { Accept: 'application/json' }, size: MAX_BODY });
    if (!res.ok) {
      const err = new Error(`ESPN ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    const body = JSON.parse(text);
    const t = now();
    const entry = { body: text, fresh: t + ttlFor(path, body, t), keep: t + STALE_FOR };
    cache.delete(url);
    cache.set(url, entry);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return entry;
  }

  router.get(/.*/, async (req, res) => {
    const path = req.path;
    if (!ALLOWED.test(path)) return res.status(404).json({ error: 'Not a relayed ESPN endpoint' });
    const raw = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    const query = new URLSearchParams(raw).toString();
    const url = upstream + path + (query ? `?${query}` : '');
    const send = (entry, state) => {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('X-Cache', state);
      res.send(entry.body);
    };

    const hit = cache.get(url);
    if (hit && now() < hit.fresh) return send(hit, 'HIT');

    // Requests for the same URL while one is in flight wait for it.
    let pending = inflight.get(url);
    if (!pending) {
      pending = load(url, path).finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }
    try {
      return send(await pending, 'MISS');
    } catch (err) {
      const old = cache.get(url);
      if (old && now() < old.keep) {
        logger.warn(`[relay] ${err.message}; serving the last copy of ${path}`);
        return send(old, 'STALE');
      }
      logger.warn(`[relay] ${err.message} for ${path}`);
      const status = err.status === 404 ? 404 : 502;
      return res.status(status).json({ error: `ESPN didn't answer: ${err.message}` });
    }
  });

  return router;
}

module.exports = { createRelayRouter, ttlFor, ALLOWED };
