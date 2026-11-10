// Recent uploads from a handful of YouTube channels for each sport, merged
// into one feed for the "Videos" tab. Uses YouTube's public
// per-channel Atom feed (https://www.youtube.com/feeds/videos.xml?channel_id=...)
// which needs no API key and no quota — it's the same feed a podcast/RSS
// reader would subscribe to, just the ~15 most recent uploads per channel.

const fetch = require('node-fetch');
const cache = require('./cache');
const { safeHttpUrl } = require('./security');

// College football defaults are the channels from your Dynacat config.
// Override them with YOUTUBE_CHANNELS_JSON (a JSON array of
// { "id": "UC...", "name": "..." }), and any other sport's list with
// YOUTUBE_CHANNELS_<SPORT>_JSON, e.g. YOUTUBE_CHANNELS_NBA_JSON. A sport
// with no channels has no Videos tab.
const DEFAULT_CHANNELS = {
  cfb: [
    { id: 'UCqos51yz-JaNorbbSDQrlGw', name: 'Hokie Sports' },
    { id: 'UCJn33SOv86632dLg_qVVlcg', name: 'Joel Klatt Show' },
    { id: 'UCLzocFrP98gfI5W2LD7Ux-w', name: '247Sports' },
    { id: 'UCg-q_MDeWQrjizr1VPLEpYg', name: "Josh Pate's College Football Show" },
    { id: 'UC0hy7TcR1gGD8nQBqrF2FaA', name: 'ACC Digital Network' },
    { id: 'UCzRWWsFjqHk1an4OnVPsl9g', name: 'ESPN College Football' },
    { id: 'UCn2g2Wy8uiE9BhDPV4knT7A', name: 'On3' },
  ],
  nfl: [{ id: 'UCDVYQ4Zhbm3S2dlz7P1GBDg', name: 'NFL' }],
  nba: [{ id: 'UCWJ2lWNubArHWmf3FIHbfcQ', name: 'NBA' }],
  mlb: [{ id: 'UCoLrcjPV5PbUrUyXq5mjc_A', name: 'MLB' }],
  nhl: [{ id: 'UCqFMzb-4AUf6WAIbl132QKA', name: 'NHL' }],
  epl: [{ id: 'UCG5qGWdu8nIRZqJ_GgDwQ-w', name: 'Premier League' }],
  f1: [{ id: 'UCB_qr75-ydFVKSF9Dmo6izg', name: 'FORMULA 1' }],
};

function envChannels(sport, env) {
  const name = sport === 'cfb' ? 'YOUTUBE_CHANNELS_JSON' : `YOUTUBE_CHANNELS_${String(sport).toUpperCase()}_JSON`;
  if (!env[name]) return null;
  try {
    const parsed = JSON.parse(env[name]);
    if (Array.isArray(parsed)) return parsed.filter((c) => c && typeof c.id === 'string' && /^UC[A-Za-z0-9_-]{10,40}$/.test(c.id));
  } catch (err) {
    console.error(`[videos] ${name} is not valid JSON, falling back to defaults:`, err.message);
  }
  return null;
}

function getChannels(sport = 'cfb', env = process.env) {
  const custom = envChannels(sport, env);
  if (custom && custom.length) return custom;
  return DEFAULT_CHANNELS[sport] || [];
}

function hasVideos(sport, env = process.env) {
  return getChannels(sport, env).length > 0;
}

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

// YouTube's channel feed is Atom, not RSS — entries, not items, and
// <yt:videoId>/<yt:channelId> extensions carry the IDs directly, so there's
// no link-parsing needed to build watch/embed/thumbnail URLs.
function parseAtom(xml, channelName) {
  const entries = [];
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i);
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    if (!videoIdMatch || !titleMatch) continue;
    const videoId = videoIdMatch[1].trim();
    // Video IDs go straight into embed URLs, so only accept YouTube's
    // actual ID alphabet.
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) continue;
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/i);
    const thumbMatch = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
    const viewsMatch = block.match(/<media:statistics[^>]*views=["'](\d+)["']/i);
    const publishedAt = publishedMatch ? new Date(publishedMatch[1]) : null;
    entries.push({
      id: videoId,
      title: decodeEntities(titleMatch[1]),
      channel: channelName,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`,
      thumbnail: (thumbMatch && safeHttpUrl(thumbMatch[1])) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: viewsMatch ? Number(viewsMatch[1]) : null,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
    });
  }
  return entries;
}

async function fetchChannel(channel) {
  const label = channel.name || channel.id;
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel.id)}`, { timeout: 10000 });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const xml = await res.text();
    return parseAtom(xml, label);
  } catch (err) {
    console.error(`[videos] Failed to load channel "${label}":`, err.message);
    return [];
  }
}

// Merged recent uploads across a sport's channels, newest first. Cached
// for 20 minutes — new uploads don't need to be as fresh as live scores,
// and this avoids re-pulling 7+ channel feeds on every tab click.
async function getVideos(sport = 'cfb') {
  const channels = getChannels(sport);
  if (!channels.length) return [];
  const key = `videos:merged:${sport}`;
  return cache.getOrFetch(key, async () => {
    const results = await Promise.all(channels.map(fetchChannel));
    const merged = results.flat();
    merged.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    return merged.slice(0, 30);
  }, 20 * 60 * 1000);
}

module.exports = { getVideos, getChannels, hasVideos, parseAtom };
