// Pulls a handful of college football RSS feeds and merges them into one
// sorted list for the "News" tab. Feeds are just plain RSS, so this uses a
// small dependency-free parser rather than pulling in a heavy XML library.

const fetch = require('node-fetch');
const cache = require('./cache');
const { safeHttpUrl } = require('./security');

// Defaults are public college football RSS feeds. Override entirely via the
// NEWS_FEEDS_JSON env var (a JSON array of { "name": "...", "url": "..." }),
// e.g. to point at a private RSS bridge. Keep private feed URLs/tokens in
// .env or your container config, never in this file.
//
// Outlets without a public RSS feed of their own (On3, 247Sports, The
// Athletic) come in through Google News searches limited to their site.
// Google News names the real outlet in <source>, so each story still shows
// "On3" or "247Sports", not "Google News".
function googleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

const DEFAULT_FEEDS = [
  { name: 'ESPN', url: 'https://www.espn.com/espn/rss/ncf/news' },
  { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' },
  { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss.xml' },
  { name: 'On3', url: googleNewsUrl('college football site:on3.com when:2d') },
  { name: '247Sports', url: googleNewsUrl('college football site:247sports.com when:2d') },
  { name: 'The Athletic', url: googleNewsUrl('college football site:nytimes.com/athletic when:3d') },
  { name: 'Sports Illustrated', url: googleNewsUrl('college football site:si.com when:2d') },
];

// Other sports start from ESPN's league headlines (src/espn.js getNews) and
// add these searches so the tab isn't one outlet. Keys match src/sports.js.
const SPORT_QUERIES = {
  nfl: 'NFL',
  nba: 'NBA',
  mcbb: '"college basketball"',
  mlb: 'MLB',
  nhl: 'NHL',
  wnba: 'WNBA',
  epl: '"Premier League"',
  mls: 'MLS soccer',
  ucl: '"Champions League"',
  ufc: 'UFC',
  nascar: 'NASCAR',
  f1: '"Formula 1"',
  golf: '"PGA Tour"',
};

function sportFeeds(sportKey) {
  const q = SPORT_QUERIES[sportKey];
  if (!q) return [];
  return [
    { name: 'The Athletic', url: googleNewsUrl(`${q} site:nytimes.com/athletic when:2d`) },
    { name: 'News', url: googleNewsUrl(`${q} when:1d`) },
  ];
}

function getFeeds() {
  if (process.env.NEWS_FEEDS_JSON) {
    try {
      const parsed = JSON.parse(process.env.NEWS_FEEDS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error('[news] NEWS_FEEDS_JSON is not valid JSON, falling back to defaults:', err.message);
    }
  }
  return DEFAULT_FEEDS;
}

// Pulls the text content of the first match of `tag` inside `xml`,
// stripping CDATA wrappers and basic HTML entities. Good enough for the
// handful of fields a standard RSS <item> uses — avoids pulling in a full
// XML parser dependency for what is otherwise a very regular format.
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(re);
  if (!match) return null;
  let value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1].trim();
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pulls a usable thumbnail image out of an <item>, trying the handful of
// ways feeds commonly carry one: a media:content/media:thumbnail tag, an
// <enclosure>, an <img> inside the raw (unstripped) description or
// content:encoded HTML, a plain <image><url>...</url></image> block, and
// finally — since RSS-bridge services often reshape a source feed and can
// drop namespaced tags (media:, itunes:, etc.) along the way — any bare
// image URL found anywhere in the item as a last resort. Any of these can
// be absent for a given feed/item, so this returns null rather than
// guessing when nothing matches. This is only ever a fallback now — getNews()
// below tries to replace whatever this finds with the article's real
// og:image, which is almost always higher-resolution than a feed thumbnail.
function extractImage(block) {
  // Some feeds list several <media:content> variants at different sizes;
  // when there's more than one, prefer the widest rather than whichever
  // happens to appear first (a small icon-sized one first is common and is
  // exactly what produces a blurry, stretched card).
  const allMediaContent = [...block.matchAll(/<media:content\b([^>]*)\/?>/gi)];
  if (allMediaContent.length) {
    let best = null;
    let bestWidth = -1;
    for (const m of allMediaContent) {
      const attrs = m[1];
      const urlMatch = attrs.match(/url=["']([^"']+)["']/i);
      if (!urlMatch) continue;
      const mediumMatch = attrs.match(/medium=["']([^"']+)["']/i);
      if (mediumMatch && mediumMatch[1].toLowerCase() !== 'image') continue;
      const widthMatch = attrs.match(/width=["']?(\d+)/i);
      const width = widthMatch ? Number(widthMatch[1]) : 0;
      if (width >= bestWidth) { bestWidth = width; best = urlMatch[1]; }
    }
    if (best) return best;
  }

  const mediaThumb = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
  if (mediaThumb) return mediaThumb[1];

  const enclosure = block.match(/<enclosure[^>]*type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i)
    || block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']*["']/i);
  if (enclosure) return enclosure[1];

  // Check description AND content:encoded independently — a feed can have
  // a plain-text description (so the first check below finds nothing) but
  // still carry an image in content:encoded, or vice versa. Using `||` on
  // extractTag() here would short-circuit on whichever field is merely
  // *present*, not on whichever one actually has an <img>, and skip the
  // other field entirely — this checks both.
  for (const tag of ['description', 'content:encoded', 'summary']) {
    const raw = extractTag(block, tag);
    if (!raw) continue;
    const imgMatch = raw.match(/<img[^>]*src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }

  const imageBlock = block.match(/<image>[\s\S]*?<url>([^<]+)<\/url>[\s\S]*?<\/image>/i);
  if (imageBlock) return imageBlock[1].trim();

  // Last resort: any bare image URL anywhere in the raw item XML, in case
  // the bridge dropped whichever tag normally carries it.
  const bareUrl = block.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>]*)?/i);
  if (bareUrl) return bareUrl[0];

  return null;
}

function parseRss(xml, sourceName) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    // Feeds are outside content: only keep http(s) links so a hostile or
    // broken feed can't hand the browser a javascript: URL.
    const link = safeHttpUrl(extractTag(block, 'link'));
    if (!title || !link) continue;
    const pubDateRaw = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published');
    const description = extractTag(block, 'description') || extractTag(block, 'summary');
    const parsedDate = pubDateRaw ? new Date(pubDateRaw) : null;
    // Aggregator feeds (Google News) name the real outlet in <source> and
    // append " - Outlet" to every title.
    const outlet = stripHtml(extractTag(block, 'source') || '');
    let cleanTitle = stripHtml(title);
    if (outlet && cleanTitle.endsWith(` - ${outlet}`)) cleanTitle = cleanTitle.slice(0, -(outlet.length + 3));
    items.push({
      title: cleanTitle,
      link,
      source: outlet || sourceName,
      pubDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      summary: stripHtml(description).slice(0, 220),
      image: safeHttpUrl(extractImage(block)),
    });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { timeout: 10000 });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const xml = await res.text();
    return parseRss(xml, feed.name);
  } catch (err) {
    console.error(`[news] Failed to load feed "${feed.name}":`, err.message);
    return [];
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once, instead of
// firing dozens of requests at the source sites simultaneously.
async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Reads an article page's HTML, stopping early once </head> shows up (the
// og:image tag always lives in <head>) or a size cap is hit, so this never
// downloads a whole page body just to read one meta tag.
function fetchPartialHtml(url, maxBytes = 300000) {
  return new Promise((resolve, reject) => {
    fetch(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CFBTrackerBot/1.0; +https://github.com/)' },
    }).then((res) => {
      if (!res.ok || !res.body) { resolve(''); return; }
      let data = '';
      let bytes = 0;
      res.body.on('data', (chunk) => {
        data += chunk.toString('utf8');
        bytes += chunk.length;
        if (data.includes('</head>') || bytes >= maxBytes) res.body.destroy();
      });
      res.body.on('close', () => resolve(data));
      res.body.on('end', () => resolve(data));
      res.body.on('error', () => resolve(data));
    }).catch(() => resolve(''));
  });
}

function extractOgImage(html) {
  if (!html) return null;
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  return match ? match[1] : null;
}

// The article's own og:image is almost always the real, full-resolution
// featured image — more reliable than whatever (if anything) the RSS feed
// embedded, and it's how we fix both "no image" (the feed just didn't
// carry one) and "blurry image" (the feed only carried a small icon-sized
// thumbnail that the card then stretched to fill). Cached for a full day
// per article link, since an article's featured image never changes, so
// this cost is only ever paid once per story.
async function fetchOgImageCached(link) {
  const key = `ogimage:${link}`;
  return cache.getOrFetch(key, async () => {
    try {
      const html = await fetchPartialHtml(link);
      return safeHttpUrl(extractOgImage(html));
    } catch (err) {
      return null;
    }
  }, 24 * 60 * 60 * 1000);
}

// Merged headlines across all configured feeds, newest first, capped to a
// reasonable length for a home-page widget. Cached for 10 minutes since
// news doesn't need to be as fresh as live scores. Set NEWS_FETCH_OG_IMAGES
// to "0" to skip the per-article og:image lookup below and use only
// whatever image (if any) the RSS feed itself provided — faster / fewer
// outbound requests, at the cost of ESPN-style feeds with no feed image
// and low-res feed thumbnails going back to showing nothing/blurry.
async function getNews() {
  const key = 'news:merged';
  return cache.getOrFetch(key, async () => {
    const feeds = getFeeds();
    const results = await Promise.all(feeds.map(fetchFeed));
    const trimmed = mergeItems(results.flat(), 40);
    await addOgImages(trimmed);
    return trimmed;
  }, 10 * 60 * 1000);
}

async function addOgImages(items) {
  if (process.env.NEWS_FETCH_OG_IMAGES === '0') return;
  // Google News links are redirects with no og:image of their own.
  await mapWithConcurrency(items.filter((i) => !i.image && !/news\.google\.com/i.test(i.link)), 6, async (item) => {
    const og = await fetchOgImageCached(item.link);
    if (og) item.image = og;
  });
}

// "Ohio State's defense, explained" and "Ohio State’s Defense Explained"
// are one story picked up by two feeds; keep the first (the newest).
function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Newest first, one copy of each story (by link and by title), capped.
function mergeItems(items, limit = 40) {
  const sorted = items.filter(Boolean).slice().sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
  const links = new Set();
  const titles = new Set();
  const out = [];
  for (const item of sorted) {
    const tk = titleKey(item.title);
    if (links.has(item.link) || (tk && titles.has(tk))) continue;
    links.add(item.link);
    if (tk) titles.add(tk);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// Headlines for any sport: college football's own feeds, or ESPN's league
// headlines (passed in, so this file doesn't depend on src/espn.js) plus
// the searches in SPORT_QUERIES.
async function getSportNews(sportKey, espnLoader) {
  if (sportKey === 'cfb') return getNews();
  return cache.getOrFetch(`news:sport:${sportKey}`, async () => {
    const [espnItems, ...feedItems] = await Promise.all([
      espnLoader ? espnLoader().catch(() => []) : [],
      ...sportFeeds(sportKey).map(fetchFeed),
    ]);
    return mergeItems([...espnItems, ...feedItems.flat()], 40);
  }, 10 * 60 * 1000);
}

// --- Team and conference filters -------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words that name a team in a headline: "Virginia Tech Hokies", "Virginia
// Tech", "Hokies". Short or generic pieces are left out so "Tech" alone
// doesn't match every Tech.
const GENERIC = new Set(['state', 'tech', 'university', 'college', 'city', 'united', 'team']);
function teamTerms(team) {
  if (!team) return [];
  const terms = [team.name, team.shortName, team.location, team.nickname]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter((s) => s.length >= 4 && !GENERIC.has(s.toLowerCase()));
  return [...new Set(terms)];
}

// "Southeastern Conference" / "SEC", "Big Ten Conference" / "Big Ten".
function conferenceTerms(conf) {
  if (!conf) return [];
  const terms = [conf.name, conf.abbreviation, conf.name && conf.name.replace(/\s+Conference$/i, '')]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter((s) => s.length >= 3 && !/independents?/i.test(s));
  return [...new Set(terms)];
}

function mentionsAny(item, terms) {
  if (!terms.length) return false;
  const text = `${item.title || ''} ${item.summary || ''}`;
  return terms.some((t) => {
    // Abbreviations (SEC, ACC) must match in capitals; names don't care.
    const flags = /^[A-Z0-9&-]{2,5}$/.test(t) ? '' : 'i';
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(t)}([^A-Za-z0-9]|$)`, flags).test(text);
  });
}

function filterByTerms(items, terms) {
  return (items || []).filter((item) => mentionsAny(item, terms));
}

// A Google News search for one team or conference, so a filter has more to
// show than whatever happened to be in the general feeds.
async function searchNews(query, days = 7) {
  const items = await fetchFeed({ name: 'News', url: googleNewsUrl(`${query} when:${days}d`) });
  return items;
}

module.exports = {
  getNews,
  getSportNews,
  parseRss,
  mergeItems,
  teamTerms,
  conferenceTerms,
  filterByTerms,
  mentionsAny,
  searchNews,
  googleNewsUrl,
  SPORT_QUERIES,
};
