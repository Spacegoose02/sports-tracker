const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');
const { parseRss } = require('../src/news');
const { parseAtom } = require('../src/videos');

const CFB = loadShared();
const EVIL = '<img src=x onerror=alert(1)>';

test('esc escapes HTML special characters', () => {
  assert.strictEqual(CFB.esc(`"a" & 'b' <c>`), '&quot;a&quot; &amp; &#39;b&#39; &lt;c&gt;');
  assert.strictEqual(CFB.esc(null), '');
  assert.strictEqual(CFB.esc(0), '0');
});

test('safeUrl allows http(s) and same-site paths only', () => {
  assert.strictEqual(CFB.safeUrl('https://a.com/x?y=1&z=2'), 'https://a.com/x?y=1&amp;z=2');
  assert.strictEqual(CFB.safeUrl('/team.html?id=1'), '/team.html?id=1');
  assert.strictEqual(CFB.safeUrl('//evil.com/x'), '');
  assert.strictEqual(CFB.safeUrl('javascript:alert(1)'), '');
  assert.strictEqual(CFB.safeUrl('JaVaScRiPt:alert(1)'), '');
  assert.strictEqual(CFB.safeUrl(''), '');
});

test('game cards escape team names, venue and broadcast', () => {
  const team = (name) => ({ id: '1', name, logo: 'javascript:alert(1)', score: 7, winner: false });
  const html = CFB.gameCardHtml({
    id: '1"><script>',
    status: { state: 'pre' },
    date: '2026-11-01T20:00:00Z',
    broadcast: EVIL,
    venue: EVIL,
    away: team(EVIL),
    home: team('Virginia Tech'),
  });
  assert.ok(!html.includes('<img src=x'), 'raw markup leaked into card');
  assert.ok(!html.includes('<script>'), 'raw script tag leaked into card');
  assert.ok(!html.includes('javascript:'), 'javascript: URL leaked into card');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('game detail sections escape play-by-play and leaders', () => {
  const html = CFB.gameDetailSectionsHtml({
    status: { state: 'in' },
    leaders: [{ team: EVIL, categories: [{ name: EVIL, athlete: EVIL, value: EVIL }] }],
    boxscore: { teams: [{ team: EVIL, stats: [{ name: EVIL, value: EVIL }] }] },
    drives: { description: EVIL, plays: [EVIL] },
    playByPlay: [{ text: EVIL, drive: EVIL, period: 1, clock: '1:00' }],
    odds: { details: EVIL, overUnder: 50, provider: EVIL },
  });
  assert.ok(!html.includes('<img src=x'));
});

test('RSS parser drops javascript: links and bad image URLs', () => {
  const xml = `<rss><channel>
    <item><title>Good</title><link>https://www.espn.com/story</link><enclosure url="javascript:alert(1)" type="image/png"/></item>
    <item><title>Bad</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const items = parseRss(xml, 'Test');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].link, 'https://www.espn.com/story');
  assert.strictEqual(items[0].image, null);
});

test('YouTube parser rejects malformed video ids', () => {
  const xml = `<feed>
    <entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>Ok</title></entry>
    <entry><yt:videoId>"><script>alert(1)</script></yt:videoId><title>Bad</title></entry>
  </feed>`;
  const items = parseAtom(xml, 'Chan');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'dQw4w9WgXcQ');
});
