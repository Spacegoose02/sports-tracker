const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const seo = require('../src/seo');

test('robots.txt and sitemap.xml are served with the site address', async () => {
  const app = await startApp({ PUBLIC_URL: 'https://example.test/' });
  try {
    const robots = await (await fetch(`${app.url}/robots.txt`)).text();
    assert.match(robots, /Disallow: \/api\//);
    assert.match(robots, /Sitemap: https:\/\/example\.test\/sitemap\.xml/);
    const res = await fetch(`${app.url}/sitemap.xml`);
    assert.match(res.headers.get('content-type'), /xml/);
    const xml = await res.text();
    assert.match(xml, /<loc>https:\/\/example\.test\/scores\?sport=cfb<\/loc>/);
    assert.match(xml, /<loc>https:\/\/example\.test\/news\.html\?sport=nfl<\/loc>/);
  } finally {
    await app.close();
  }
});

test('unknown pages are a real 404, not the scoreboard', async () => {
  const app = await startApp({});
  try {
    const page = await fetch(`${app.url}/no-such-page`, { headers: { Accept: 'text/html' } });
    assert.strictEqual(page.status, 404);
    assert.match(await page.text(), /Page not found/);
    const api = await fetch(`${app.url}/api/no-such-thing`);
    assert.strictEqual(api.status, 404);
    assert.deepStrictEqual(await api.json(), { error: 'Not found' });
  } finally {
    await app.close();
  }
});

test('pages carry share-preview tags with absolute URLs', async () => {
  const app = await startApp({ PUBLIC_URL: 'https://example.test' });
  try {
    const html = await (await fetch(`${app.url}/standings.html?sport=nfl&x=1`)).text();
    assert.match(html, /<meta property="og:title" content="Standings · Stat Scraps" \/>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/example\.test\/img\/statscraps-icon-512\.png" \/>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/standings\.html\?sport=nfl" \/>/);
    const home = await (await fetch(`${app.url}/`)).text();
    assert.match(home, /og:description" content="Scores, stats, schedules and news/);
    const news = await fetch(`${app.url}/news`);
    assert.strictEqual(news.status, 200);
  } finally {
    await app.close();
  }
});

test('preview tags escape titles and are not added twice', () => {
  const html = '<html><head><title>A "B" &amp; C</title></head><body></body></html>';
  const out = seo.withPreviewTags(html, { base: 'https://x.test', url: 'https://x.test/a' });
  assert.match(out, /og:title" content="A &quot;B&quot; &amp; C"/);
  assert.strictEqual(seo.withPreviewTags(out, { base: 'https://x.test', url: 'https://x.test/a' }), out);
});
