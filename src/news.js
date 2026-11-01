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
const DEFAULT_FEEDS = [
  { name: 'ESPN', url: 'https://www.espn.com/espn/rss/ncf/news' },
  { name: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' },
  { name: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss.xml' },
];

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
    items.push({
      title: stripHtml(title),
      link,
      source: sourceName,
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
    const merged = results.flat();
    merged.sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
    const trimmed = merged.slice(0, 40);

    if (process.env.NEWS_FETCH_OG_IMAGES !== '0') {
      await mapWithConcurrency(trimmed, 6, async (item) => {
        const og = await fetchOgImageCached(item.link);
        if (og) item.image = og;
      });
    }

    return trimmed;
  }, 10 * 60 * 1000);
}

module.exports = { getNews, parseRss };
