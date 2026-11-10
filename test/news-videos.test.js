const test = require('node:test');
const assert = require('node:assert');
require('./helpers');

const news = require('../src/news');
const videos = require('../src/videos');

test('merged news drops the same story from two feeds and sorts newest first', () => {
  const items = news.mergeItems([
    { title: "Ohio State's defense, explained", link: 'https://a.com/1', pubDate: '2026-11-01T10:00:00Z' },
    { title: 'Ohio State’s Defense Explained', link: 'https://b.com/1', pubDate: '2026-11-01T09:00:00Z' },
    { title: 'Newer story', link: 'https://a.com/2', pubDate: '2026-11-01T12:00:00Z' },
    { title: 'Same link', link: 'https://a.com/2', pubDate: '2026-11-01T08:00:00Z' },
  ]);
  assert.deepStrictEqual(items.map((i) => i.link), ['https://a.com/2', 'https://a.com/1']);
});

test('college football news adds On3, 247Sports and The Athletic', () => {
  delete process.env.NEWS_FEEDS_JSON;
  const src = require('fs').readFileSync(require.resolve('../src/news'), 'utf8');
  for (const site of ['on3.com', '247sports.com', 'nytimes.com/athletic']) assert.ok(src.includes(`site:${site}`), site);
});

test('team and conference terms match headlines without matching inside words', () => {
  const vt = news.teamTerms({ name: 'Virginia Tech Hokies', shortName: 'Virginia Tech', location: 'Virginia Tech', nickname: 'Hokies' });
  assert.ok(news.mentionsAny({ title: 'Hokies hold on late' }, vt));
  assert.ok(!news.mentionsAny({ title: 'Texas Tech rolls' }, vt));
  const sec = news.conferenceTerms({ name: 'Southeastern Conference', abbreviation: 'SEC' });
  assert.ok(news.mentionsAny({ title: 'SEC title picture' }, sec));
  assert.ok(!news.mentionsAny({ title: 'A second-half surge' }, sec), 'abbreviations only match in capitals as a word');
  assert.ok(news.mentionsAny({ title: 'Big news from the Southeastern' }, sec));
  assert.deepStrictEqual(news.conferenceTerms({ name: 'FBS Independents', abbreviation: 'IND' }), ['IND']);
});

test('videos come from the selected sport, and sports without channels have none', () => {
  assert.ok(videos.getChannels('cfb', {}).some((c) => c.name === 'On3'));
  assert.deepStrictEqual(videos.getChannels('nba', {}).map((c) => c.name), ['NBA']);
  assert.deepStrictEqual(videos.getChannels('golf', {}), []);
  assert.strictEqual(videos.hasVideos('golf', {}), false);
  const env = { YOUTUBE_CHANNELS_GOLF_JSON: JSON.stringify([{ id: 'UCabcdefghijklmnop', name: 'Golf' }, { id: 'bad"id', name: 'x' }]) };
  assert.deepStrictEqual(videos.getChannels('golf', env).map((c) => c.name), ['Golf']);
});

test('the sports list tells the page which sports have a Videos tab', () => {
  const list = require('../src/sports').publicSportList();
  assert.strictEqual(list.find((s) => s.key === 'cfb').videos, true);
  assert.strictEqual(list.find((s) => s.key === 'nfl').videos, true);
  assert.strictEqual(list.find((s) => s.key === 'golf').videos, false);
});

// Fakes ESPN, Google News and YouTube, then calls the real routes.
async function withApi(fn) {
  const calls = [];
  const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title} - ${i.source}</title><link>${i.link}</link><pubDate>${i.date}</pubDate><source url="https://x">${i.source}</source></item>`).join('')}</channel></rss>`;
  require.cache[require.resolve('node-fetch')] = {
    id: 'node-fetch', filename: require.resolve('node-fetch'), loaded: true,
    exports: async (url) => {
      const u = String(url);
      calls.push(u);
      const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      const text = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
      if (u.includes('youtube.com/feeds')) {
        const id = new URL(u).searchParams.get('channel_id');
        return text(`<feed><entry><yt:videoId>vid${id.slice(2, 10)}</yt:videoId><title>Clip from ${id}</title><published>2026-11-01T10:00:00Z</published></entry></feed>`);
      }
      if (u.includes('news.google.com')) {
        const q = new URL(u).searchParams.get('q');
        if (q.includes('"Virginia Tech"')) return text(rss([{ title: 'Hokies land a transfer', source: 'On3', link: 'https://on3.com/vt', date: 'Sat, 01 Nov 2026 11:00:00 GMT' }, { title: 'Unrelated Tech story', source: 'On3', link: 'https://on3.com/x', date: 'Sat, 01 Nov 2026 11:00:00 GMT' }]));
        if (q.includes('"Atlantic Coast"')) return text(rss([{ title: 'ACC power rankings', source: '247Sports', link: 'https://247sports.com/acc', date: 'Sat, 01 Nov 2026 09:00:00 GMT' }]));
        if (q.startsWith('NBA')) return text(rss([{ title: 'Trade talk heats up', source: 'The Athletic', link: 'https://nytimes.com/athletic/nba', date: 'Sat, 01 Nov 2026 13:00:00 GMT' }]));
        return text(rss([]));
      }
      if (/\/teams\/259(\?|$)/.test(u)) return json({ team: { id: '259', displayName: 'Virginia Tech Hokies', shortDisplayName: 'Virginia Tech', location: 'Virginia Tech', name: 'Hokies', abbreviation: 'VT' } });
      if (u.includes('/standings')) {
        return json({ children: [{ name: 'Atlantic Coast Conference', abbreviation: 'ACC', standings: { entries: [
          { team: { id: '259', displayName: 'Virginia Tech Hokies', shortDisplayName: 'Virginia Tech', abbreviation: 'VT' }, stats: [] },
        ] } }] });
      }
      if (u.includes('/news?')) {
        const team = new URL(u).searchParams.get('team');
        const article = (n) => ({ headline: n, published: '2026-11-01T10:00:00Z', links: { web: { href: `https://www.espn.com/${encodeURIComponent(n)}` } } });
        return json({ articles: team ? [article('VT depth chart update')] : [article('League wide story')] });
      }
      return text('');
    },
  };
  for (const m of ['../src/espn', '../src/datasource', '../src/news', '../src/videos', '../src/sports', '../src/routes/api']) delete require.cache[require.resolve(m)];
  process.env.NEWS_FETCH_OG_IMAGES = '0';
  const express = require('express');
  const app = express();
  app.use('/api', require('../src/routes/api'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('news and videos routes follow the sport and the team/conference filter', async () => {
  await withApi(async (base, calls) => {
    const nbaNews = await (await fetch(`${base}/api/news?sport=nba`)).json();
    assert.ok(nbaNews.items.some((i) => i.title === 'Trade talk heats up'), 'NBA news includes news searches');
    assert.ok(nbaNews.items.some((i) => i.title === 'League wide story'), 'NBA news keeps ESPN headlines');

    const team = await (await fetch(`${base}/api/news?sport=cfb&team=259`)).json();
    assert.deepStrictEqual(team.filter, { type: 'team', id: '259', label: 'Virginia Tech' });
    const titles = team.items.map((i) => i.title);
    assert.ok(titles.includes('VT depth chart update'));
    assert.ok(titles.includes('Hokies land a transfer'));
    assert.ok(!titles.includes('Unrelated Tech story'), 'search results must name the team');

    const conf = await (await fetch(`${base}/api/news?sport=cfb&conference=ACC`)).json();
    assert.strictEqual(conf.filter.label, 'Atlantic Coast');
    assert.deepStrictEqual(conf.items.map((i) => i.title), ['ACC power rankings']);

    assert.strictEqual((await fetch(`${base}/api/news?sport=cfb&conference=NOPE`)).status, 404);

    const nbaVideos = await (await fetch(`${base}/api/videos?sport=nba`)).json();
    assert.deepStrictEqual(nbaVideos.items.map((v) => v.channel), ['NBA']);
    const golf = await (await fetch(`${base}/api/videos?sport=golf`)).json();
    assert.deepStrictEqual(golf.items, []);
    assert.ok(!calls.some((u) => u.includes('youtube.com') && u.includes('UCqos51yz')), 'NBA videos never load college football channels');
  });
});
