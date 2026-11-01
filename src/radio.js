// "Listen" info for a game: radio stations, satellite channels, and free
// audio links. Kept in its own module (instead of inside espn.js) so the
// game summary stays lean and this can grow on its own.
//
// Where the data comes from, best first:
//   1. ESPN's broadcast list for the game. ESPN tags every broadcast with a
//      type ("TV", "Radio", "Streaming", ...) and a market ("National",
//      "Home", "Away"). For NFL/NBA/MLB/NHL it usually lists the radio
//      stations; for college football it is mostly TV only, but radio does
//      show up for some games. Two endpoints carry this list:
//        site API summary:  .../summary?event={id}          (json.broadcasts)
//        core API:          .../events/{id}/competitions/{id}/broadcasts
//   2. A small hand-checked list of team radio flagships
//      (src/radio-flagships.json), for the college football gap.
//   3. Links that always work: the SiriusXM college football schedule
//      (it posts the channel for every game it carries, which changes week
//      to week, so we link rather than guess a channel) and a TuneIn search
//      for each team's radio broadcast.

const fetch = require('node-fetch');
const cache = require('./cache');
const networks = require('./radio-flagships.json');

const { DEFAULT_SPORT, getSport } = require('./sports');

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports';

// SiriusXM schedule pages we have confirmed exist, by sport key.
const SIRIUSXM = {
  cfb: 'https://www.siriusxm.com/sports/college-football',
};

// ESPN's core API puts "leagues/" between the sport and the league:
// football/college-football -> football/leagues/college-football.
function corePath(sitePath) {
  const [sport, league] = sitePath.split('/');
  return `${sport}/leagues/${league}`;
}

// Radio info changes rarely during a game, so cache it longer than scores.
const CACHE_MS = 10 * 60 * 1000;

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`ESPN request failed: ${res.status} for ${url}`);
  return res.json();
}

function text(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Sort one ESPN broadcast entry into a kind we show, or null for TV.
function kindOf(b) {
  const type = (b.type && (text(b.type.shortName) || text(b.type.longName) || text(b.type.slug))) || '';
  const t = type.toLowerCase();
  const name = (mediaName(b) || '').toLowerCase();
  if (/sirius|xm\b|satellite/.test(name) || /satellite/.test(t)) return 'satellite';
  if (t === 'radio') return 'radio';
  // ESPN marks some audio streams as "Streaming" or "Web"; only count
  // them when the name makes clear it is audio and not a video stream.
  if (/stream|web/.test(t) && /radio|audio|tunein|varsity network/.test(name)) return 'stream';
  return null;
}

function mediaName(b) {
  const m = b.media || {};
  const station = b.station && typeof b.station === 'object' ? b.station : null;
  return text(m.shortName) || text(m.name) || text(m.callLetters)
    || (station && (text(station.name) || text(station.shortName)))
    || text(b.station) || (Array.isArray(b.names) && text(b.names[0])) || null;
}

function marketOf(b) {
  const raw = b.market && typeof b.market === 'object' ? b.market.type : b.market;
  const m = (text(raw) || '').toLowerCase();
  if (m === 'home' || m === 'away' || m === 'national') return m;
  return null;
}

// Turn one or more raw ESPN broadcast arrays into a de-duplicated list of
// { kind, name, market, lang, channel }.
function parseEspnBroadcasts(...lists) {
  const out = [];
  const seen = new Set();
  lists.flat(Infinity).forEach((b) => {
    if (!b || typeof b !== 'object') return;
    const kind = kindOf(b);
    const name = mediaName(b);
    if (!kind || !name) return;
    const market = marketOf(b);
    const key = `${kind}|${name.toLowerCase()}|${market || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const channel = b.station && typeof b.station === 'object' && b.station.channel !== undefined && kind === 'satellite'
      ? String(b.station.channel) : null;
    out.push({ kind, name, market, lang: text(b.lang), channel });
  });
  return out;
}

function tuneInSearch(teamName) {
  return `https://tunein.com/search/?query=${encodeURIComponent(`${teamName} radio`)}`;
}

// Build the full listen info from already-fetched pieces. Pure, so it is
// easy to test without the network.
function buildRadioInfo({ sport = DEFAULT_SPORT, teams = [], broadcasts = [] }) {
  const stations = parseEspnBroadcasts(broadcasts);

  const teamInfo = teams.filter((t) => t && t.id).map((t) => {
    const name = t.name || t.shortName || 'Team';
    const net = sport === DEFAULT_SPORT ? networks[String(t.id)] : null;
    // Skip an ESPN station that is just the flagship we already show.
    const espnStations = stations.filter((s) => s.market === t.homeAway
      && !(net && net.flagship.toLowerCase().includes(s.name.toLowerCase())));
    return {
      id: String(t.id),
      name,
      homeAway: t.homeAway || null,
      flagship: net ? { station: net.flagship, city: net.city || null, checked: net.checked || null } : null,
      listen: net && net.listen ? net.listen : null,
      stations: espnStations,
      tuneIn: tuneInSearch(name),
    };
  });

  return {
    sport,
    national: stations.filter((s) => s.market !== 'home' && s.market !== 'away'),
    teams: teamInfo,
    siriusxm: SIRIUSXM[sport] || null,
  };
}

async function getGameRadio(eventId, sport = DEFAULT_SPORT) {
  const cfg = getSport(sport);
  if (!cfg) throw new Error(`Unknown sport: ${sport}`);
  return cache.getOrFetch(`radio:${sport}:${eventId}`, async () => {
    const id = encodeURIComponent(eventId);
    const summary = await fetchJson(`${SITE_BASE}/${cfg.path}/summary?event=${id}`);
    const header = summary.header || {};
    const comp = (header.competitions && header.competitions[0]) || {};
    const teams = (comp.competitors || []).map((c) => ({
      id: c.team && c.team.id,
      name: c.team && c.team.displayName,
      shortName: c.team && c.team.shortDisplayName,
      homeAway: c.homeAway,
    }));

    // The core API sometimes has radio entries the summary leaves out.
    // It is optional: if it fails we still return what we have.
    let core = [];
    try {
      const json = await fetchJson(`${CORE_BASE}/${corePath(cfg.path)}/events/${id}/competitions/${id}/broadcasts`);
      core = Array.isArray(json.items) ? json.items : [];
    } catch (err) {
      core = [];
    }

    return buildRadioInfo({
      sport,
      teams,
      broadcasts: [summary.broadcasts || [], comp.geoBroadcasts || [], core],
    });
  }, CACHE_MS);
}

module.exports = { getGameRadio, buildRadioInfo, parseEspnBroadcasts, corePath };
