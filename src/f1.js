// Formula 1 at a glance: the next race, the last race's finishing order,
// and both championships, all from ESPN (the same source as the rest of
// the site). Served at /api/f1 so a dashboard (Glance, Dynacat, Home
// Assistant) has one stable F1 feed instead of a third-party F1 API.
//
// ESPN pieces used:
//   Scoreboard: .../apis/site/v2/sports/racing/f1/scoreboard
//     leagues[0].calendar lists every race weekend of the season (label,
//     startDate, endDate); events[] holds the weekend's sessions as
//     competitions (FP1, FP2, FP3, Qual, Race). ?dates=YYYYMMDD returns the
//     weekend on that day.
//   Standings: .../apis/v2/sports/racing/f1/standings
//     children[] is "Driver Standings" and "Constructor Standings", each
//     with standings.entries[] of { athlete | team, stats[] }.
//
// Each section loads on its own, so one ESPN hiccup leaves the others up.

const fetch = require('node-fetch');
const cache = require('./cache');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/racing/f1/standings';

async function defaultFetchJson(url) {
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ESPN writes times like "2026-11-29T16:00Z" (no seconds), which some
// dashboards can't parse. Always hand out full ISO 8601.
function iso(value) {
  const t = Date.parse(value || '');
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function ymd(value) {
  const d = new Date(Date.parse(value));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function stateOf(status) {
  const type = (status && status.type) || {};
  return { state: type.state || null, completed: !!type.completed, detail: type.detail || type.shortDetail || null };
}

function isRace(comp) {
  const t = comp && comp.type;
  return !!t && (/^race$/i.test(t.abbreviation || '') || /^race$/i.test(t.text || '') || /^race$/i.test(t.name || ''));
}

function sessionLabel(comp) {
  const t = (comp && comp.type) || {};
  return t.abbreviation || t.text || t.name || null;
}

function statValue(stats, ...names) {
  for (const name of names) {
    const s = (stats || []).find((x) => x && (x.name === name || x.abbreviation === name || x.type === name));
    if (s) return s.displayValue !== undefined ? s.displayValue : (s.value !== undefined ? String(s.value) : null);
  }
  return null;
}

function driverOf(c) {
  const a = c.athlete || {};
  return {
    name: a.displayName || a.fullName || null,
    shortName: a.shortName || a.displayName || null,
    abbreviation: a.abbreviation || null,
    flag: (a.flag && a.flag.href) || null,
  };
}

// One race weekend: where it is, every session time, and (once the race is
// run) the finishing order.
function normalizeWeekend(event) {
  const comps = event.competitions || [];
  const race = comps.find(isRace) || comps[comps.length - 1] || null;
  const circuit = event.circuit || (race && race.circuit) || {};
  const address = circuit.address || {};
  const status = stateOf((race && race.status) || event.status);
  const results = status.state === 'pre' ? [] : ((race && race.competitors) || [])
    .filter((c) => c && c.athlete)
    .map((c) => ({
      position: Number(c.order) || null,
      ...driverOf(c),
      team: (c.team && (c.team.displayName || c.team.name)) || (c.vehicle && c.vehicle.manufacturer) || null,
      winner: !!c.winner,
      // Race time for the winner, the gap for the rest, when ESPN has it.
      time: statValue(c.statistics, 'totalTime', 'behindTime', 'time') || null,
      laps: statValue(c.statistics, 'lapsCompleted', 'laps') || null,
    }))
    .sort((a, b) => (a.position || 999) - (b.position || 999));
  return {
    id: event.id || null,
    name: event.name || event.shortName || null,
    shortName: event.shortName || null,
    date: iso((race && race.date) || event.date),
    endDate: iso(event.endDate),
    circuit: circuit.fullName || (race && race.venue && race.venue.fullName) || null,
    city: address.city || null,
    country: address.country || null,
    status,
    sessions: comps.map((c) => ({ name: sessionLabel(c), date: iso(c.date), state: stateOf(c.status).state }))
      .filter((s) => s.name && s.date),
    results,
  };
}

// The calendar can be plain strings or objects; keep the objects with a
// usable date window.
function calendarOf(json) {
  const league = (json.leagues && json.leagues[0]) || {};
  return (league.calendar || [])
    .filter((c) => c && typeof c === 'object' && (c.startDate || c.endDate))
    .map((c) => ({ label: c.label || c.value || null, startDate: iso(c.startDate || c.endDate), endDate: iso(c.endDate || c.startDate) }))
    .filter((c) => c.startDate && c.endDate)
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
}

// From the calendar: the weekend that hasn't finished yet (next) and the
// latest one that has (last). A race that ended a few hours ago still has
// its weekend's endDate in the past, so it counts as last.
function pickWeekends(calendar, now) {
  const t = now.getTime();
  const next = calendar.find((c) => Date.parse(c.endDate) >= t) || null;
  const done = calendar.filter((c) => Date.parse(c.endDate) < t);
  return { next, last: done[done.length - 1] || null, round: next ? calendar.indexOf(next) + 1 : null, rounds: calendar.length };
}

function weekendFor(events, entry) {
  if (!entry) return null;
  const start = Date.parse(entry.startDate) - 36 * 3600 * 1000;
  const end = Date.parse(entry.endDate) + 36 * 3600 * 1000;
  return events.find((e) => {
    const t = Date.parse(e.date || e.endDate || '');
    return t >= start && t <= end;
  }) || null;
}

function parseStandings(json) {
  const groups = [];
  (function walk(node) {
    if (!node) return;
    if (node.standings && Array.isArray(node.standings.entries)) groups.push(node);
    (node.children || []).forEach(walk);
  }(json));
  const find = (re) => groups.find((g) => re.test(`${g.name || ''} ${g.abbreviation || ''} ${g.id || ''}`));
  const driversGroup = find(/driver/i) || groups.find((g) => g.standings.entries.some((e) => e.athlete));
  const teamsGroup = find(/constructor|team/i) || groups.find((g) => g !== driversGroup && g.standings.entries.some((e) => e.team));
  const rows = (group, map) => ((group && group.standings.entries) || [])
    .map((e, i) => {
      const position = Number(statValue(e.stats, 'rank', 'position')) || i + 1;
      const points = statValue(e.stats, 'championshipPts', 'points', 'pts', 'PTS');
      return { position, points: points === null ? null : Number(points), ...map(e) };
    })
    .sort((a, b) => a.position - b.position);
  return {
    season: (json.season && (json.season.year || json.season)) || null,
    drivers: rows(driversGroup, (e) => ({
      ...driverOf(e),
      team: (e.team && (e.team.displayName || e.team.name)) || null,
      wins: Number(statValue(e.stats, 'wins')) || 0,
    })),
    constructors: rows(teamsGroup, (e) => {
      const team = e.team || {};
      return {
        name: team.displayName || team.name || null,
        abbreviation: team.abbreviation || null,
        logo: (team.logos && team.logos[0] && team.logos[0].href) || null,
        color: team.color ? `#${String(team.color).replace(/^#/, '')}` : null,
      };
    }),
  };
}

async function settle(promise) {
  try { return { value: await promise }; } catch (err) { return { error: err.message }; }
}

async function buildF1({ now = new Date(), fetchJson = defaultFetchJson } = {}) {
  const [board, standings] = await Promise.all([
    settle(fetchJson(`${SITE}/scoreboard`)),
    settle(fetchJson(STANDINGS)),
  ]);
  const errors = {};
  let nextRace = null;
  let lastRace = null;
  let season = null;
  let round = null;
  let rounds = null;

  if (board.error) {
    errors.schedule = board.error;
  } else {
    const json = board.value;
    season = (json.season && json.season.year) || null;
    const events = (json.events || []).map(normalizeWeekend);
    const picked = pickWeekends(calendarOf(json), now);
    round = picked.round;
    rounds = picked.rounds || null;
    // The default scoreboard holds this weekend only; fetch the other
    // weekend by its start date when it isn't already here.
    const load = async (entry) => {
      if (!entry) return null;
      const have = weekendFor(events, entry);
      if (have) return have;
      const res = await settle(fetchJson(`${SITE}/scoreboard?dates=${ymd(entry.startDate)}`));
      if (res.error) return null;
      return weekendFor((res.value.events || []).map(normalizeWeekend), entry);
    };
    const fallback = (entry) => entry && ({
      id: null, name: entry.label, shortName: null, date: entry.startDate, endDate: entry.endDate,
      circuit: null, city: null, country: null, status: { state: 'pre', completed: false, detail: null }, sessions: [], results: [],
    });
    const [next, last] = await Promise.all([load(picked.next), load(picked.last)]);
    nextRace = next || fallback(picked.next);
    lastRace = last || (picked.last ? fallback(picked.last) : null);
    // No calendar (ESPN left it out): use whatever weekend the scoreboard
    // has, as next if it's still to come, otherwise as last.
    if (!picked.next && !picked.last && events.length) {
      const e = events[events.length - 1];
      if (e.status.completed) lastRace = e; else nextRace = e;
    }
  }

  let drivers = [];
  let constructors = [];
  if (standings.error) {
    errors.standings = standings.error;
  } else {
    const parsed = parseStandings(standings.value);
    drivers = parsed.drivers;
    constructors = parsed.constructors;
    season = season || parsed.season;
  }

  // Off-season: every race is in the past, so nothing is "next".
  if (nextRace) nextRace.round = round;
  return {
    sport: 'f1',
    season,
    rounds,
    nextRace,
    lastRace,
    drivers,
    constructors,
    updatedAt: now.toISOString(),
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

async function getF1(opts = {}) {
  return cache.getOrFetch('f1:dashboard', () => buildF1(opts), (v) => (v.errors ? 60 * 1000 : 10 * 60 * 1000));
}

module.exports = { getF1, buildF1, parseStandings, normalizeWeekend, calendarOf, pickWeekends };
