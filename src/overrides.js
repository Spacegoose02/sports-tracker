// Admin-edited radio and TV info (the "Radio and TV" form on /admin). An
// override is saved for one game or one team and stored in SQLite in the
// data volume (src/db.js). It wins over what ESPN reports:
//
//   Game override
//     tv        replaces ESPN's TV list for that game; the "stream it"
//               services are worked out again from it
//     radio     replaces the national radio list for that game
//     watch     an extra "watch here" link shown first under Stream it
//     note      a line shown in the Where to Watch and Where to Listen boxes
//   Team override
//     radio     replaces the team's radio flagship (first station) and adds
//               the rest as extra stations; city and listen link go with it
//     tv        the team's usual channel, used only when ESPN and the game
//               override both have no TV for a game (TV changes game to
//               game, so a team-wide channel never beats a real listing)
//
// Summaries and scoreboards come out of a shared cache, so every function
// here returns a copy instead of changing what it was given.

const db = require('./db');
const { servicesFor } = require('./streaming');

// One lookup per request: the table is small, and a scoreboard has dozens
// of games to check.
function loadOverrides(sport) {
  const map = new Map();
  for (const o of db.listBroadcastOverrides(sport)) map.set(`${o.scope}:${o.targetId}`, o);
  return {
    game: (id) => (id ? map.get(`game:${id}`) || null : null),
    team: (id) => (id ? map.get(`team:${id}`) || null : null),
  };
}

function teamTv(lookup, ...teamIds) {
  for (const id of teamIds) {
    const o = lookup.team(id);
    if (o && o.tv.length) return o.tv;
  }
  return null;
}

// Scoreboard and schedule games: { id, broadcast, home: { id }, away: { id } }.
function applyToGames(games, sport, lookup = loadOverrides(sport)) {
  if (!Array.isArray(games)) return games;
  return games.map((g) => {
    if (!g) return g;
    const game = lookup.game(String(g.id));
    if (game && game.tv.length) return { ...g, broadcast: game.tv.join(' / ') };
    if (g.broadcast) return g;
    const fallback = teamTv(lookup, g.home && g.home.id, g.away && g.away.id);
    return fallback ? { ...g, broadcast: fallback.join(' / ') } : g;
  });
}

function sideIds(teams) {
  const home = (teams || []).find((t) => t && t.homeAway === 'home');
  const away = (teams || []).find((t) => t && t.homeAway === 'away');
  return [home && home.id, away && away.id].map((id) => (id ? String(id) : null));
}

// Game page summary: { id, teams, broadcast, broadcasts, streaming }.
function applyToSummary(summary, sport, lookup = loadOverrides(sport)) {
  if (!summary) return summary;
  const game = lookup.game(String(summary.id));
  let tv = game && game.tv.length ? game.tv : null;
  if (!tv && !(summary.broadcasts && summary.broadcasts.length) && !summary.broadcast) {
    tv = teamTv(lookup, ...sideIds(summary.teams));
  }
  if (!tv && !game) return summary;

  const out = { ...summary };
  if (tv) {
    out.broadcast = tv[0];
    out.broadcasts = tv.map((network) => ({ network, type: 'TV', market: 'National' }));
    out.streaming = servicesFor(tv);
  }
  if (game && game.watchUrl) {
    out.streaming = [
      { name: game.watchName || 'Watch here', url: game.watchUrl, note: 'Added by the site admin', networks: [] },
      ...(out.streaming || []),
    ];
  }
  if (game && game.note) out.broadcastNote = game.note;
  return out;
}

const radioStation = (name, market) => ({ kind: 'radio', name, market, lang: null, channel: null });

// Where to Listen info from src/radio.js.
function applyToRadio(info, sport, eventId, lookup = loadOverrides(sport)) {
  if (!info) return info;
  const out = { ...info };
  const game = lookup.game(String(eventId));
  if (game && game.radio.length) out.national = game.radio.map((name) => radioStation(name, 'national'));
  if (game && game.note) out.note = game.note;

  out.teams = (info.teams || []).map((t) => {
    const o = lookup.team(String(t.id));
    if (!o) return t;
    const team = { ...t };
    if (o.radio.length) {
      const [flagship, ...extra] = o.radio;
      team.flagship = { station: flagship, city: o.radioCity || null, checked: null };
      const taken = new Set(o.radio.map((s) => s.toLowerCase()));
      team.stations = [
        ...extra.map((name) => radioStation(name, t.homeAway)),
        ...(t.stations || []).filter((s) => !taken.has(String(s.name).toLowerCase())),
      ];
    }
    if (o.listenUrl) team.listen = o.listenUrl;
    return team;
  });
  return out;
}

module.exports = { loadOverrides, applyToGames, applyToSummary, applyToRadio };
