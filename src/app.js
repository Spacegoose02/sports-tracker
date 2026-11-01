// Builds the Express app without starting a server, so tests can spin it
// up on a random port. server.js is the real entry point.

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');

const { resolveSecurityConfig, securityHeaders } = require('./security');
const { createRelayRouter } = require('./relay');

function createApp({ env = process.env, logger = console, relay = {} } = {}) {
  const security = resolveSecurityConfig(env);
  security.warnings.forEach((w) => logger.warn(`[security] ${w}`));

  const apiRoutes = require('./routes/api');
  const createAdminRouter = require('./routes/admin');

  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Nginx Proxy Manager, Traefik, Cloudflare
  // tunnel...) set TRUST_PROXY=1 so the login rate limit sees each
  // visitor's real IP instead of the proxy's.
  if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
  app.locals.adminEnabled = security.adminEnabled;
  app.locals.adminPassword = env.ADMIN_PASSWORD || 'changeme';
  app.use(securityHeaders);
  // Gzip responses (HTML, CSS, JS, JSON). Server-sent event streams are left
  // alone so live updates are not held in the compression buffer.
  app.use(compression({
    filter: (req, res) => {
      const type = String(res.getHeader('Content-Type') || '');
      if (type.startsWith('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));
  app.use(express.json({ limit: '20kb' }));
  app.use(
    cookieSession({
      name: 'cfb_session',
      secret: security.sessionSecret,
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
      httpOnly: true,
      sameSite: 'lax',
    })
  );

  app.use('/api/admin', createAdminRouter());
  app.use('/api', require('./routes/stats'));
  app.use('/api', apiRoutes);
  // ESPN's site API, cached, for other apps such as BingeBandit (src/relay.js).
  app.use('/espn', createRelayRouter({ env, logger, ...relay }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { setHeaders: staticCacheHeaders }));

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

// Cache rules for files in public/. File names are not fingerprinted, so
// pages, scripts and styles are revalidated on every load (cheap 304s via
// ETag); the service worker makes repeat loads instant on top of that.
// Images rarely change and are cached for a week. sw.js itself must never
// be cached, or browsers could keep running an old worker.
function staticCacheHeaders(res, filePath) {
  const base = path.basename(filePath);
  if (base === 'sw.js') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
  } else if (base === 'manifest.webmanifest') {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  } else if (/[\\/]img[\\/]/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

module.exports = { createApp };
