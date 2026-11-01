// Highlight clips for one game. Two sources, merged:
//   1. ESPN's game summary carries a `videos` list for most big-conference
//      and pro games: short clips with an MP4 that plays right in the page.
//   2. The YouTube channels behind the Videos tab (src/videos.js). Their
//      recent uploads are matched to the game by team names in the title,
//      which picks up full-game highlight packages ESPN doesn't carry.
// ESPN publishes no schema for `videos`, so the reader is defensive and
// skips anything without a title and somewhere to watch it.

const { safeHttpUrl } = require('./security');

const MAX_ESPN_CLIPS = 12;
const MAX_YOUTUBE_CLIPS = 4;

function pickHref(...candidates) {
  for (const c of candidates) {
    const url = safeHttpUrl(c && typeof c === 'object' ? c.href : c);
    if (url) return url;
  }
  return null;
}

// summary.videos -> [{ id, title, description, duration, thumbnail, url,
// videoUrl, source }]. `videoUrl` is only set for a plain MP4, since that's
// what a <video> tag can play everywhere (HLS needs Safari or a library).
function parseEspnHighlights(json) {
  const list = (json && Array.isArray(json.videos)) ? json.videos : [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (!v || out.length >= MAX_ESPN_CLIPS) break;
    const title = String(v.headline || v.title || '').trim();
    if (!title) continue;
    const links = v.links || {};
    const source = links.source || {};
    const mobile = links.mobile || {};
    const mp4 = pickHref(source.HD, source, mobile.source, mobile);
    const videoUrl = mp4 && /\.mp4(\?|$)/i.test(mp4) ? mp4 : null;
    const url = pickHref(links.web, v.link);
    if (!videoUrl && !url) continue;
    const id = v.id != null ? String(v.id) : title;
    if (seen.has(id)) continue;
    seen.add(id);
    const duration = Number(v.duration);
    out.push({
      id,
      title,
      description: String(v.description || '').trim().slice(0, 240) || null,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      thumbnail: pickHref(v.thumbnail, v.images && v.images[0] && v.images[0].url, v.posterImages && v.posterImages.default),
      url,
      videoUrl,
      embedUrl: null,
      source: 'ESPN',
    });
  }
  return out;
}

// Words that identify a team in a video title: "Virginia Tech", "Hokies",
// "VT". Short abbreviations only count as whole words.
function teamTerms(team) {
  if (!team) return [];
  const names = [team.name, team.shortName, team.location, team.nickname]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().trim())
    .filter((s) => s.length >= 4);
  const abbr = team.abbreviation && String(team.abbreviation).length >= 2 ? [String(team.abbreviation).toLowerCase()] : [];
  return [...new Set([...names, ...abbr])];
}

function mentions(title, terms) {
  return terms.some((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(title);
  });
}

// YouTube uploads that name both teams and were posted no earlier than six
// hours before kickoff, so last year's meeting doesn't show up. The title has
// to mention both teams, which keeps "Alabama vs. Georgia" out of an
// Alabama vs. Auburn page.
function matchYouTube(videos, teams, gameDate) {
  const [a, b] = teams || [];
  const ta = teamTerms(a);
  const tb = teamTerms(b);
  if (!ta.length || !tb.length) return [];
  const start = Date.parse(gameDate);
  return (videos || [])
    .filter((v) => v && v.title && mentions(v.title, ta) && mentions(v.title, tb))
    .filter((v) => {
      if (Number.isNaN(start) || !v.publishedAt) return true;
      return Date.parse(v.publishedAt) >= start - 6 * 60 * 60 * 1000;
    })
    .sort((x, y) => (/highlight/i.test(y.title) ? 1 : 0) - (/highlight/i.test(x.title) ? 1 : 0))
    .slice(0, MAX_YOUTUBE_CLIPS)
    .map((v) => ({
      id: `yt:${v.id}`,
      title: v.title,
      description: null,
      duration: null,
      thumbnail: v.thumbnail || null,
      url: v.url,
      videoUrl: null,
      embedUrl: v.embedUrl,
      source: v.channel || 'YouTube',
    }));
}

module.exports = { parseEspnHighlights, matchYouTube, teamTerms };
