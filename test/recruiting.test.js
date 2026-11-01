const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const recruiting = require('../src/recruiting');
const { parseRss } = require('../src/news');

test('recruiting stories are picked out of general news', () => {
  assert.ok(recruiting.isRecruitingStory({ title: 'Five-star QB commits to Virginia Tech' }));
  assert.ok(recruiting.isRecruitingStory({ title: 'Starting RB enters the transfer portal' }));
  assert.ok(!recruiting.isRecruitingStory({ title: 'CFP committee releases first rankings' }));
  assert.ok(!recruiting.isRecruitingStory({ title: 'Georgia beats Florida 34-20' }));
});

test('mergeStories drops duplicates and tags the topic', () => {
  const merged = recruiting.mergeStories([
    [{ title: 'WR enters portal', link: 'https://a.example/1', pubDate: '2026-11-01T10:00:00Z' }],
    [{ title: 'WR Enters Portal!', link: 'https://b.example/2', pubDate: '2026-11-01T11:00:00Z' },
      { title: 'Top recruit commits', link: 'https://b.example/3', pubDate: '2026-11-01T12:00:00Z' }],
  ]);
  assert.deepStrictEqual(merged.map((m) => m.topic), ['recruiting', 'portal']);
});

test('Google News items use the outlet name and drop it from the title', () => {
  const xml = `<rss><channel><item><title>QB flips to Tech - On3</title><link>https://news.google.com/x</link>
    <source url="https://www.on3.com">On3</source><pubDate>Sat, 01 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  const [item] = parseRss(xml, 'Recruiting');
  assert.strictEqual(item.title, 'QB flips to Tech');
  assert.strictEqual(item.source, 'On3');
});

test('CFBD rows are normalized', () => {
  assert.deepStrictEqual(recruiting.normalizePortalEntry({
    firstName: 'Jane', lastName: 'Doe', position: 'QB', origin: 'Texas', destination: null,
    transferDate: '2026-12-09T00:00:00Z', rating: 0.89, stars: 4, eligibility: 'Immediate',
  }), {
    name: 'Jane Doe', position: 'QB', origin: 'Texas', destination: null,
    transferDate: '2026-12-09T00:00:00Z', stars: 4, rating: 0.89, eligibility: 'Immediate',
  });
  const r = recruiting.normalizeRecruit({ ranking: 1, name: 'A B', stateProvince: 'GA', committedTo: '', stars: 5 });
  assert.strictEqual(r.state, 'GA');
  assert.strictEqual(r.committedTo, null);
});

test('default recruiting year rolls over in August', () => {
  assert.strictEqual(recruiting.defaultYear(new Date(2026, 10, 1)), 2027);
  assert.strictEqual(recruiting.defaultYear(new Date(2026, 2, 1)), 2026);
});

test('portal routes explain the missing key instead of failing', async () => {
  const app = await startApp({ CFBD_API_KEY: '' });
  const saved = process.env.CFBD_API_KEY;
  delete process.env.CFBD_API_KEY;
  try {
    const status = await (await fetch(`${app.url}/api/recruiting/status`)).json();
    assert.strictEqual(status.cfbd, false);
    for (const path of ['portal', 'players', 'teams']) {
      const res = await fetch(`${app.url}/api/recruiting/${path}`);
      assert.strictEqual(res.status, 503);
      assert.strictEqual((await res.json()).needsKey, true);
    }
  } finally {
    if (saved !== undefined) process.env.CFBD_API_KEY = saved;
    await app.close();
  }
});

test('recruiting routes reject a bad year', async () => {
  process.env.CFBD_API_KEY = 'test-key';
  const app = await startApp({});
  try {
    const res = await fetch(`${app.url}/api/recruiting/portal?year=abc`);
    assert.strictEqual(res.status, 400);
  } finally {
    delete process.env.CFBD_API_KEY;
    await app.close();
  }
});
