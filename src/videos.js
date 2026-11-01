// Recent uploads from a handful of college-football YouTube channels,
// merged into one feed for the "Videos" tab. Uses YouTube's public
// per-channel Atom feed (https://www.youtube.com/feeds/videos.xml?channel_id=...)
// which needs no API key and no quota — it's the same feed a podcast/RSS
// reader would subscribe to, just the ~15 most recent uploads per channel.

const fetch = require('node-fetch');
const cache = require('./cache');

// Defaults are the channels from your Dynacat config. Override entirely via
// YOUTUBE_CHANNELS_JSON (a JSON array of { "id": "UC...", "name": "..." })
// if you ever want to add/remove/rename channels without editing code.
const DEFAULT_CHANNELS = [
  { id: 'UCqos51yz-JaNorbbSDQrlGw', name: 'Hokie Sports' },
  { id: 'UCJn33SOv86632dLg_qVVlcg', name: 'Joel Klatt Show' },
  { id: 'UCLzocFrP98gfI5W2LD7Ux-w', name: '247Sports' },
  { id: 'UCg-q_MDeWQrjizr1VPLEpYg', name: "Josh Pate's College Football Show" },
  { id: 'UC0hy7TcR1gGD8nQBqrF2FaA', name: 'ACC Digital Network' },
  { id: 'UCzRWWsFjqHk1an4OnVPsl9g', name: 'ESPN College Football' },
  { id: 'UCn2g2Wy8uiE9BhDPV4knT7A', name: 'On3' },
];

function getChannels() {
  if (process.env.YOUTUBE_CHANNELS_JSON) {
    try {
      const parsed = JSON.parse(process.env.YOUTUBE_CHANNELS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error('[videos] YOUTUBE_CHANNELS_JSON is not valid JSON, falling back to defaults:', err.message);
    }
  }
  return DEFAULT_CHANNELS;
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
      thumbnail: thumbMatch ? thumbMatch[1] : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
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

// Merged recent uploads across all configured channels, newest first.
// Cached for 20 minutes — new uploads don't need to be as fresh as live
// scores, and this avoids re-pulling 7+ channel feeds on every tab click.
async function getVideos() {
  const key = 'videos:merged';
  return cache.getOrFetch(key, async () => {
    const channels = getChannels();
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

module.exports = { getVideos };
