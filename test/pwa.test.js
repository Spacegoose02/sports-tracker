const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startApp } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');

test('web app manifest is served and its icons exist', async () => {
  const app = await startApp({});
  try {
    const res = await fetch(`${app.url}/manifest.webmanifest`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await res.json();
    assert.strictEqual(manifest.display, 'standalone');
    assert.ok(manifest.start_url);
    const sizes = manifest.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const icon of manifest.icons) {
      assert.ok(fs.existsSync(path.join(PUBLIC, icon.src)), `${icon.src} is missing`);
    }
  } finally {
    await app.close();
  }
});

test('service worker is served uncached from the site root', async () => {
  const app = await startApp({});
  try {
    const res = await fetch(`${app.url}/sw.js`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
  } finally {
    await app.close();
  }
});

test('service worker precaches only files that exist', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const list = sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const url of list) {
    const file = url === '/' ? 'index.html' : url.slice(1);
    assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${url} is precached but missing`);
  }
});

test('every page links the manifest and registers the service worker', () => {
  for (const file of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html') && f !== 'offline.html')) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.match(html, /rel="manifest"/, `${file} has no manifest link`);
    assert.match(html, /\/js\/pwa\.js/, `${file} does not load pwa.js`);
  }
});

test('text responses are gzip compressed and images are cached', async () => {
  const app = await startApp({});
  try {
    const css = await fetch(`${app.url}/css/styles.css`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(css.headers.get('content-encoding'), 'gzip');
    assert.strictEqual(css.headers.get('cache-control'), 'no-cache');
    const img = await fetch(`${app.url}/img/cfbtracker-icon-192.png`);
    assert.match(img.headers.get('cache-control'), /max-age=604800/);
  } finally {
    await app.close();
  }
});
