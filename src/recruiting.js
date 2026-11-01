// Recruiting and transfer portal: headlines from news feeds, and (with a
// free CollegeFootballData.com API key in CFBD_API_KEY) the transfer
// portal list, the top high school recruits and team class rankings.
// Without a key the news still works; the data tabs say how to add one.

const fetch = require('node-fetch');
const cache = require('./cache');
const news = require('./news');

const CFBD_BASE = 'https://api.collegefootballdata.com';

// Google News searches work without a key and pull from every outlet that
// covers recruiting (On3, 247Sports, Rivals, ESPN, local papers). Override
// with RECRUITING_FEEDS_JSON, a JSON array of { "name", "url" }.
const DEFAULT_FEEDS = [
  { name: 'Transfer portal', url: 'https://news.google.com/rss/search?q=%22transfer+portal%22+college+football+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Recruiting', url: 'https://news.google.com/rss/search?q=college+football+recruiting+commit+when:7d&hl=en-US&gl=US&ceid=US:en' },
];

// Stories in the regular college football feeds that are about
// recruiting or the portal also show up here.
const KEYWORDS = /\b(recruit\w*|(?:de)?commit(?:s|ted|ment|ments)?|transfer portal|portal|flip(?:s|ped)?|signing day|signees?|five-star|four-star|[45]-star|class of 20\d\d|official visits?)\b/i;

function getFeeds() {
  if (process.env.RECRUITING_FEEDS_JSON) {
    try {
      const parsed = JSON.parse(process.env.RECRUITING_FEEDS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error('[recruiting] RECRUITING_FEEDS_JSON is not valid JSON, falling back to defaults:', err.message);
    }
  }
  return DEFAULT_FEEDS;
}

function isRecruitingStory(item) {
  return KEYWORDS.test(`${item.title || ''} ${item.summary || ''}`);
}

// Tags a story as portal or recruiting news so the page can filter.
function topicOf(item) {
  return /portal|transfer/i.test(`${item.title || ''} ${item.summary || ''}`) ? 'portal' : 'recruiting';
}

// Normalizes a headline for duplicate detection across feeds.
function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CFBTrackerBot/1.0)' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return news.parseRss(await res.text(), feed.name);
  } catch (err) {
    console.error(`[recruiting] Failed to load feed "${feed.name}":`, err.message);
    return [];
  }
}

function mergeStories(lists) {
  const seen = new Set();
  const merged = [];
  lists.flat().forEach((item) => {
    const key = titleKey(item.title);
    if (!key || seen.has(key) || seen.has(item.link)) return;
    seen.add(key);
    seen.add(item.link);
    merged.push({ ...item, topic: topicOf(item) });
  });
  merged.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
  return merged.slice(0, 60);
}

async function getRecruitingNews() {
  return cache.getOrFetch('recruiting:news', async () => {
    const [fromFeeds, general] = await Promise.all([
      Promise.all(getFeeds().map(fetchFeed)),
      news.getNews().catch(() => []),
    ]);
    return mergeStories([...fromFeeds, general.filter(isRecruitingStory)]);
  }, 10 * 60 * 1000);
}

// ---- CollegeFootballData.com -------------------------------------------

function cfbdKey() {
  return process.env.CFBD_API_KEY || '';
}

function hasCfbd() {
  return !!cfbdKey();
}

async function cfbd(path) {
  if (!hasCfbd()) {
    const err = new Error('CFBD_API_KEY is not set');
    err.code = 'NO_KEY';
    throw err;
  }
  const res = await fetch(`${CFBD_BASE}${path}`, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${cfbdKey()}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CollegeFootballData ${res.status} ${res.statusText}`);
  return res.json();
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

function normalizePortalEntry(p) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return {
    name: name || null,
    position: str(p.position),
    origin: str(p.origin),
    destination: str(p.destination),
    transferDate: str(p.transferDate),
    stars: num(p.stars),
    rating: num(p.rating),
    eligibility: str(p.eligibility),
  };
}

function normalizeRecruit(r) {
  return {
    rank: num(r.ranking),
    name: str(r.name),
    position: str(r.position),
    school: str(r.school),
    city: str(r.city),
    state: str(r.stateProvince),
    stars: num(r.stars),
    rating: num(r.rating),
    height: num(r.height),
    weight: num(r.weight),
    committedTo: str(r.committedTo),
  };
}

function normalizeTeamRank(t) {
  return { rank: num(t.rank), team: str(t.team), points: num(t.points) };
}

// The portal season is named for the season players transfer into: the
// window that opens in December 2026 is the 2027 portal. The recruiting
// class is the same: high school seniors in fall 2026 are the 2027 class.
function defaultYear(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

function validYear(year) {
  const n = Number(year);
  return Number.isInteger(n) && n >= 2000 && n <= new Date().getFullYear() + 2 ? n : null;
}

const HOUR = 60 * 60 * 1000;

async function getPortal(year) {
  return cache.getOrFetch(`recruiting:portal:${year}`, async () => {
    const rows = await cfbd(`/player/portal?year=${year}`);
    return (Array.isArray(rows) ? rows : []).map(normalizePortalEntry).filter((p) => p.name)
      .sort((a, b) => (b.transferDate ? Date.parse(b.transferDate) : 0) - (a.transferDate ? Date.parse(a.transferDate) : 0));
  }, HOUR / 2);
}

async function getRecruits(year) {
  return cache.getOrFetch(`recruiting:players:${year}`, async () => {
    const rows = await cfbd(`/recruiting/players?year=${year}&classification=HighSchool`);
    return (Array.isArray(rows) ? rows : []).map(normalizeRecruit).filter((r) => r.name)
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
      .slice(0, 500);
  }, HOUR);
}

async function getClassRankings(year) {
  return cache.getOrFetch(`recruiting:teams:${year}`, async () => {
    const rows = await cfbd(`/recruiting/teams?year=${year}`);
    return (Array.isArray(rows) ? rows : []).map(normalizeTeamRank).filter((t) => t.team)
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  }, HOUR);
}

module.exports = {
  getRecruitingNews,
  getPortal,
  getRecruits,
  getClassRankings,
  hasCfbd,
  defaultYear,
  validYear,
  // Exported for tests.
  isRecruitingStory,
  mergeStories,
  normalizePortalEntry,
  normalizeRecruit,
};
