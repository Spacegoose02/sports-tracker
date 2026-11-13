// Search engines and link previews: robots.txt, sitemap.xml, the
// share-preview tags (Open Graph / Twitter card) on every page, and a real
// "not found" page.
//
// Pages are plain files in public/, so the preview tags are added as each
// page is sent: the page's own <title> and description, plus the site's
// absolute address, which crawlers need for og:image and og:url. The
// address comes from PUBLIC_URL when set (recommended behind a proxy),
// otherwise from the request.

const fs = require('fs');
const path = require('path');
const { SPORTS } = require('./sports');

const DEFAULT_DESCRIPTION = 'Live scores, stats, schedules, rankings and news for college football and every major sport.';

// Pages listed in the sitemap: the home page once, then each sport's main
// pages (only the ones that sport has).
const SPORT_PAGES = [
  { path: '/scores', always: true },
  { path: '/news.html', always: true },
  { path: '/rankings.html', when: (s) => s.rankings },
  { path: '/standings.html', when: (s) => s.standings !== false && s.teams !== false },
  { path: '/leaders.html', when: (s) => s.leaders },
  { path: '/stats.html', when: (s) => s.key === 'cfb' },
  { path: '/bowls.html', when: (s) => s.key === 'cfb' },
];
const SITE_PAGES = ['/', '/brackets.html', '/race.html', '/recruiting.html', '/awards.html', '/player.html'];

function baseUrl(req, env) {
  const configured = env && env.PUBLIC_URL ? String(env.PUBLIC_URL).replace(/\/+$/, '') : '';
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function robotsTxt(base) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /account.html',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sitemapUrls(base, sports) {
  const urls = SITE_PAGES.map((p) => `${base}${p}`);
  for (const s of Object.values(sports || SPORTS)) {
    for (const page of SPORT_PAGES) {
      if (page.always || (page.when && page.when(s))) urls.push(`${base}${page.path}?sport=${encodeURIComponent(s.key)}`);
    }
  }
  return [...new Set(urls)];
}

function sitemapXml(base, sports) {
  const items = sitemapUrls(base, sports).map((u) => `  <url><loc>${xmlEsc(u)}</loc><changefreq>hourly</changefreq></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

function htmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Adds share-preview tags to a page's <head>, leaving any it already has.
function withPreviewTags(html, { base, url }) {
  if (/property="og:title"/.test(html)) return html;
  const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/&middot;/g, '·').replace(/&amp;/g, '&').trim() : 'Stat Scraps';
  const descMatch = /<meta name="description" content="([^"]*)"/i.exec(html);
  const description = descMatch ? descMatch[1] : DEFAULT_DESCRIPTION;
  const image = `${base}/img/statscraps-icon-512.png`;
  const tags = [
    descMatch ? '' : `<meta name="description" content="${htmlAttr(description)}" />`,
    '<meta property="og:site_name" content="Stat Scraps" />',
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${htmlAttr(title)}" />`,
    `<meta property="og:description" content="${htmlAttr(description)}" />`,
    `<meta property="og:url" content="${htmlAttr(url)}" />`,
    `<meta property="og:image" content="${htmlAttr(image)}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<link rel="canonical" href="${htmlAttr(url)}" />`,
  ].filter(Boolean).join('\n');
  return html.replace(/<\/head>/i, `${tags}\n</head>`);
}

// Express middleware: serves public/*.html (and the / and /scores
// aliases) with preview tags added. Everything else falls through to
// express.static.
function createPageServer({ publicDir, env, aliases }) {
  const cache = new Map();
  const read = (file) => {
    // Re-read in development so edits show without a restart.
    if (cache.has(file) && process.env.NODE_ENV === 'production') return cache.get(file);
    const text = fs.readFileSync(file, 'utf8');
    cache.set(file, text);
    return text;
  };
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = aliases[req.path] || (req.path.endsWith('.html') ? req.path.slice(1) : null);
    if (!name || name.includes('..') || name.includes('/')) return next();
    const file = path.join(publicDir, name);
    if (!fs.existsSync(file)) return next();
    const base = baseUrl(req, env);
    // Canonical URL keeps ?sport= (it changes the page) and drops the rest.
    const sport = typeof req.query.sport === 'string' && /^[a-z0-9]+$/.test(req.query.sport) ? `?sport=${req.query.sport}` : '';
    const html = withPreviewTags(read(file), { base, url: `${base}${req.path}${sport}` });
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  };
}

module.exports = { robotsTxt, sitemapXml, sitemapUrls, withPreviewTags, createPageServer, baseUrl, DEFAULT_DESCRIPTION };
