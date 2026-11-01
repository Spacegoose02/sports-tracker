// Startup safety checks and small security helpers shared by the server.
//
// The app ships with placeholder secrets in docker-compose.yml and
// .env.example. Running a public site with those is dangerous: anyone who
// has read this repo knows the admin password, and a known SESSION_SECRET
// lets anyone forge an admin session cookie. Rather than refuse to start
// (which would take the whole public site down for a config mistake), the
// app keeps serving scores but locks the admin area until real values are
// set, and logs exactly what to change.

const crypto = require('crypto');

const PLACEHOLDER_PASSWORDS = new Set(['', 'changeme', 'change-me', 'password', 'admin']);
const PLACEHOLDER_SECRETS = new Set([
  '',
  'please-change-this-to-a-random-string',
  'change-this-too',
  'a-long-random-string',
]);
const MIN_SECRET_LENGTH = 16;

function resolveSecurityConfig(env = process.env) {
  const warnings = [];
  const password = env.ADMIN_PASSWORD || '';
  const isProduction = env.NODE_ENV === 'production';

  let adminEnabled = true;
  if (PLACEHOLDER_PASSWORDS.has(password.trim().toLowerCase())) {
    if (isProduction) {
      adminEnabled = false;
      warnings.push('ADMIN_PASSWORD is missing or a placeholder, so /admin is locked. Set a private ADMIN_PASSWORD to use it.');
    } else {
      warnings.push('ADMIN_PASSWORD is missing or a placeholder. That is allowed for local development only; /admin will be locked when NODE_ENV=production.');
    }
  }

  let sessionSecret = env.SESSION_SECRET || '';
  if (PLACEHOLDER_SECRETS.has(sessionSecret) || sessionSecret.length < MIN_SECRET_LENGTH) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    warnings.push(`SESSION_SECRET is missing, a placeholder, or shorter than ${MIN_SECRET_LENGTH} characters. Using a random one for this run, so admin logins reset on every restart. Set a long random SESSION_SECRET to keep them.`);
  }

  return { adminEnabled, sessionSecret, warnings };
}

// Basic hardening headers. No Content-Security-Policy yet: the pages still
// use inline event handlers (image onerror fallbacks) and YouTube embeds,
// which a strict CSP would break.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

// Fixed-window, in-memory rate limiter keyed by client IP. Good enough for a
// single self-hosted container; it slows password guessing on /admin to a
// crawl without pulling in a dependency.
function rateLimit({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = now();
    let entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
    }
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - t) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return next();
  };
}

// IDs from the browser end up inside upstream API URLs (ESPN paths), so
// only allow plain alphanumeric IDs through.
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

// Only http(s) URLs are allowed to reach the browser as links or images.
// Blocks javascript:, data: and other schemes a hostile feed could use.
function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (err) {
    return null;
  }
}

module.exports = { resolveSecurityConfig, securityHeaders, rateLimit, isSafeId, safeHttpUrl };
