/* Stat Scraps service worker.
 *
 * Strategy, by request type:
 *   - Pages (navigations): network first, falling back to the last cached
 *     copy of that page, then to /offline.html. New deploys show up at once.
 *   - /css, /js, /img, manifest: stale-while-revalidate. Served instantly
 *     from cache, refreshed in the background for the next load.
 *   - /api (except admin and accounts): network first with a short timeout,
 *     falling back to the last good response so scores still show offline.
 *   - Everything else (admin, /auth sign-in, /calendar feeds, the /espn relay, other origins such as
 *     team logos on ESPN's CDN): left to the browser, never cached here.
 *
 * Bump VERSION to throw away every old cache on the next visit.
 */
const VERSION = 'v5';
const STATIC_CACHE = `cfb-static-${VERSION}`;
const PAGE_CACHE = `cfb-pages-${VERSION}`;
const API_CACHE = `cfb-api-${VERSION}`;
const KEEP = [STATIC_CACHE, PAGE_CACHE, API_CACHE];

const PRECACHE = [
  '/',
  '/offline.html',
  '/css/styles.css',
  '/js/shared.js',
  '/js/app.js',
  '/js/kids-core.js',
  '/js/kids.js',
  '/css/kids.css',
  '/js/pwa.js',
  '/js/theme-boot.js',
  '/css/themes.css',
  '/js/theme-picker.js',
  '/js/i18n.js',
  '/js/i18n-es.js',
  '/js/a11y.js',
  '/css/a11y.css',
  '/css/brand.css',
  '/img/scrappy-head.png',
  '/img/statscraps-icon-512.png',
  '/img/statscraps-icon-192.png',
  '/manifest.webmanifest',
];

const API_TIMEOUT_MS = 4000;
const API_MAX_ENTRIES = 80;
// API paths that are personal or privileged and must never be cached.
const API_NO_CACHE = /^\/api\/(admin|auth|account|accounts|me|login|logout|session|follows?|alerts?|push|scrappy)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // Fetch each one on its own so a single missing file cannot block install.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cfb-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (path === '/admin' || path.startsWith('/admin.') || path.startsWith('/espn/')) return;
  // Sign-in redirects and private calendar feeds must never be cached or replayed.
  if (path.startsWith('/auth/') || path.startsWith('/calendar')) return;

  if (req.mode === 'navigate') {
    event.respondWith(pageFetch(req));
    return;
  }
  if (path.startsWith('/api/')) {
    if (API_NO_CACHE.test(path)) return;
    event.respondWith(apiFetch(event, req));
    return;
  }
  if (/^\/(css|js|img|fonts)\//.test(path) || path === '/manifest.webmanifest') {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

async function pageFetch(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = (await cache.match(req, { ignoreSearch: false }))
      || (await cache.match(req, { ignoreSearch: true }))
      || (await caches.match('/offline.html'));
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

async function apiFetch(event, req) {
  const cache = await caches.open(API_CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) {
      cache.put(req, res.clone()).then(() => trim(cache, API_MAX_ENTRIES));
    }
    return res;
  });
  // Keep the cache update running even if the timeout wins below.
  event.waitUntil(network.catch(() => {}));

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, API_TIMEOUT_MS, null); });
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
    // Slow network: answer from cache if we can, otherwise keep waiting.
    const cached = await cache.match(req);
    return cached || (await network);
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// ---- Game alerts ----------------------------------------------------------
// Push notifications when a followed team's game starts or ends (see
// src/alerts.js). Tapping one opens that game's page.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Stat Scraps', {
    body: data.body || '',
    icon: '/img/statscraps-icon-180.png',
    badge: '/img/statscraps-icon-32.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => w.url === target.href);
    if (existing) return existing.focus();
    return self.clients.openWindow(target.href);
  })());
});
