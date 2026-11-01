// "Watch on BingeBandit" links for the game page's Where to watch section.
//
// BingeBandit (a home media server with Live TV) knows which of its channels
// shows each TV network: an admin ties networks to channels under Live TV →
// Networks, and otherwise a channel named for the network counts ("US: ESPN 2
// HD" for ESPN2). This asks it, so a game on ESPN2 can link straight to the
// BingeBandit channel that plays ESPN2.
//
//   GET /api/bingebandit/watch?network=ESPN2&network=ABC
//   -> { links: [{ network, channel: { number, name }, url }] }
//
// Off (always { links: [] }) unless BINGEBANDIT_URL is set. The key is
// BINGEBANDIT_API_KEY, or RELAY_API_KEY when that's unset: BingeBandit already
// stores the relay key under Server → Settings → Sports data, so pairing the
// two apps once covers both directions. Links point at BINGEBANDIT_LINK_URL
// when the address browsers use differs from the one this server reaches.
// Answers are cached for a few minutes, and a BingeBandit that's down just
// means no links.

const express = require('express');
const nodeFetch = require('node-fetch');

const MINUTE = 60 * 1000;
const FRESH_FOR = 5 * MINUTE;
const FAILED_FOR = MINUTE;
const MAX_NETWORKS = 12;
const MAX_ENTRIES = 500;

function trimUrl(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}

function bingeBanditConfig(env = process.env) {
  const base = trimUrl(env.BINGEBANDIT_URL);
  if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/i.test(base)) return null;
  const link = trimUrl(env.BINGEBANDIT_LINK_URL);
  return {
    base,
    linkBase: /^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/i.test(link) ? link : base,
    key: env.BINGEBANDIT_API_KEY || env.RELAY_API_KEY || '',
  };
}

// The networks asked for, trimmed, de-duplicated and capped.
function networkList(query) {
  const raw = query.network;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const n = String(v).trim();
    if (!n || n.length > 80 || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length === MAX_NETWORKS) break;
  }
  return out;
}

// Keeps only well-formed links that open a /live/{id} page on BingeBandit.
function cleanLinks(body, linkBase, asked) {
  const wanted = new Set(asked.map((n) => n.toLowerCase()));
  const out = [];
  for (const l of (body && Array.isArray(body.links) ? body.links : [])) {
    if (!l || typeof l.network !== 'string' || !wanted.has(l.network.toLowerCase())) continue;
    if (typeof l.path !== 'string' || !/^\/live\/\d+$/.test(l.path)) continue;
    const c = l.channel || {};
    out.push({
      network: l.network,
      channel: { number: Number.isFinite(c.number) ? c.number : null, name: typeof c.name === 'string' ? c.name.slice(0, 80) : '' },
      url: linkBase + l.path,
    });
  }
  return out;
}

function createBingeBanditRouter({ env = process.env, fetch = nodeFetch, now = Date.now, logger = console } = {}) {
  const router = express.Router();
  const cfg = bingeBanditConfig(env);
  const cache = new Map(); // sorted lower-case networks -> { links, until }
  const inflight = new Map();
  let warned = false;

  async function ask(networks) {
    const qs = networks.map((n) => `network=${encodeURIComponent(n)}`).join('&');
    const res = await fetch(`${cfg.base}/api/sports/watch-links?${qs}`, {
      timeout: 5000,
      headers: { Accept: 'application/json', 'X-Api-Key': cfg.key },
      size: 256 * 1024,
    });
    if (!res.ok) throw new Error(`BingeBandit answered ${res.status}`);
    return cleanLinks(await res.json(), cfg.linkBase, networks);
  }

  router.get('/watch', async (req, res) => {
    res.set('Cache-Control', 'private, max-age=60');
    const networks = networkList(req.query);
    if (!cfg || !cfg.key || !networks.length) return res.json({ links: [] });
    const id = networks.map((n) => n.toLowerCase()).sort().join('|');
    const hit = cache.get(id);
    if (hit && now() < hit.until) return res.json({ links: hit.links });

    let pending = inflight.get(id);
    if (!pending) {
      pending = ask(networks)
        .then((links) => ({ links, until: now() + FRESH_FOR }))
        .catch((err) => {
          if (!warned) logger.warn(`[bingebandit] ${err.message}; no Watch on BingeBandit links for now`);
          warned = true;
          return { links: [], until: now() + FAILED_FOR };
        })
        .then((entry) => {
          if (entry.links.length) warned = false;
          cache.delete(id);
          cache.set(id, entry);
          while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
          return entry;
        })
        .finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    const entry = await pending;
    return res.json({ links: entry.links });
  });

  return router;
}

module.exports = { createBingeBanditRouter, bingeBanditConfig, cleanLinks, networkList };
