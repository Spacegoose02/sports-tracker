// Rosters and player pages, from ESPN's public APIs.
//
//   Team roster:
//     https://site.api.espn.com/apis/site/v2/sports/{path}/teams/{id}/roster
//   Player bio, career stats and game log (ESPN's "common v3" API, the one
//   espn.com's own player pages use):
//     https://site.web.api.espn.com/apis/common/v3/sports/{path}/athletes/{id}
//     .../athletes/{id}/stats
//     .../athletes/{id}/gamelog
//
// None of these are documented. Every parser below reads fields defensively
// and drops what it can't find instead of throwing, so a shape change shows
// up as a missing column rather than a broken page.

const fetch = require('node-fetch');
const cache = require('./cache');
const { resolveSport } = require('./sports');

const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB_ROOT = 'https://site.web.api.espn.com/apis/common/v3/sports';

function sportConfig(sportKey) {
  const sport = resolveSport(sportKey);
  if (!sport) throw new Error(`Unknown sport: ${sportKey}`);
  return sport;
}

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '') ?? null;

function headshot(a) {
  return (a.headshot && (a.headshot.href || a.headshot)) || null;
}

function teamRef(t) {
  if (!t || !t.id) return null;
  return {
    id: String(t.id),
    name: pick(t.displayName, t.name),
    abbreviation: t.abbreviation || null,
    logo: pick(t.logo, t.logos && t.logos[0] && t.logos[0].href),
    color: t.color ? `#${String(t.color).replace(/^#/, '')}` : null,
  };
}

// One roster row. College rosters carry a class year in `experience`;
// pro rosters carry years in the league.
function normalizeRosterAthlete(a) {
  const exp = a.experience || {};
  const injury = Array.isArray(a.injuries) && a.injuries[0];
  return {
    id: a.id ? String(a.id) : null,
    name: pick(a.displayName, a.fullName, [a.firstName, a.lastName].filter(Boolean).join(' ')),
    jersey: pick(a.jersey),
    position: pick(a.position && a.position.abbreviation, a.position && a.position.name),
    positionName: pick(a.position && a.position.displayName, a.position && a.position.name),
    height: pick(a.displayHeight),
    weight: pick(a.displayWeight),
    age: pick(a.age),
    experience: pick(exp.displayValue, exp.abbreviation, exp.years !== undefined ? (exp.years === 0 ? 'Rookie' : `${exp.years} yr`) : null),
    college: pick(a.college && (a.college.shortName || a.college.name)),
    hometown: a.birthPlace ? [a.birthPlace.city, a.birthPlace.state || a.birthPlace.country].filter(Boolean).join(', ') || null : null,
    headshot: headshot(a),
    injury: injury ? pick(injury.status, injury.type && injury.type.description) : null,
  };
}

// Football rosters come grouped ({ position: 'offense', items: [...] });
// basketball, baseball and hockey come as one flat list. Both become
// [{ name, athletes }].
function parseRoster(json) {
  const raw = Array.isArray(json.athletes) ? json.athletes : [];
  const grouped = raw.length && raw.every((g) => g && Array.isArray(g.items));
  const titleCase = (s) => String(s || '').replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const groups = grouped
    ? raw.map((g) => ({ name: titleCase(pick(g.position, g.name, 'Players')), athletes: g.items.map(normalizeRosterAthlete) }))
    : [{ name: 'Players', athletes: raw.map(normalizeRosterAthlete) }];
  const coach = Array.isArray(json.coach) && json.coach[0];
  return {
    groups: groups.filter((g) => g.athletes.length),
    coach: coach ? [coach.firstName, coach.lastName].filter(Boolean).join(' ') || null : null,
  };
}

async function getTeamRoster(teamId, sport) {
  const cfg = sportConfig(sport);
  const key = `espn:${cfg.key}:roster:${teamId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${SITE_ROOT}/${cfg.path}/teams/${encodeURIComponent(teamId)}/roster`);
    return { teamId: String(teamId), ...parseRoster(json) };
  }, 60 * 60 * 1000); // rosters change a few times a season
}

function parseAthlete(json) {
  const a = json.athlete || json;
  const pos = a.position || {};
  return {
    id: a.id ? String(a.id) : null,
    name: pick(a.displayName, a.fullName),
    jersey: pick(a.jersey),
    position: pick(pos.displayName, pos.name, pos.abbreviation),
    positionAbbr: pick(pos.abbreviation),
    team: teamRef(a.team),
    headshot: headshot(a),
    height: pick(a.displayHeight),
    weight: pick(a.displayWeight),
    age: pick(a.age),
    birthDate: pick(a.displayDOB),
    birthPlace: pick(a.displayBirthPlace),
    experience: pick(a.displayExperience, a.experience && a.experience.displayValue,
      a.experience && a.experience.years !== undefined ? `${a.experience.years} yr` : null),
    college: pick(a.college && (a.college.name || a.college.shortName)),
    draft: pick(a.displayDraft),
    status: pick(a.status && (a.status.name || a.status.type)),
  };
}

// Career stats: one table per category (Passing, Rushing, ...), one row per
// season, plus ESPN's career totals row when it sends one.
function parseCareerStats(json) {
  const categories = Array.isArray(json.categories) ? json.categories : [];
  return categories
    .map((cat) => {
      const labels = cat.labels || cat.displayNames || [];
      const rows = (cat.statistics || []).map((s) => {
        const team = json.teams && s.teamId ? json.teams[s.teamId] : null;
        return {
          season: pick(s.season && (s.season.displayName || s.season.year)),
          teamId: s.teamId ? String(s.teamId) : null,
          team: team ? pick(team.abbreviation, team.displayName) : pick(s.teamSlug),
          stats: (s.stats || []).map(String),
        };
      });
      return {
        name: pick(cat.displayName, cat.name, 'Stats'),
        labels: labels.map(String),
        rows,
        totals: Array.isArray(cat.totals) ? cat.totals.map(String) : null,
      };
    })
    .filter((c) => c.labels.length && c.rows.length);
}

// Game log: labels at the top, per-game stat lines nested under season
// types, game details (opponent, result) in an `events` map by id.
function parseGameLog(json) {
  const labels = (json.labels || json.displayNames || []).map(String);
  const events = json.events || {};
  const games = [];
  for (const st of json.seasonTypes || []) {
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const info = events[ev.eventId] || {};
        const opp = info.opponent || {};
        games.push({
          eventId: ev.eventId ? String(ev.eventId) : null,
          seasonType: pick(st.displayName),
          date: pick(info.gameDate),
          week: pick(info.week),
          atVs: pick(info.atVs),
          opponent: opp.id ? { id: String(opp.id), name: pick(opp.displayName, opp.abbreviation), abbreviation: opp.abbreviation || null, logo: pick(opp.logo) } : null,
          result: pick(info.gameResult),
          score: pick(info.score),
          stats: (ev.stats || []).map(String),
        });
      }
    }
  }
  games.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return { labels, games };
}

// Bio, career stats and this season's game log in one call. Only the bio
// is required; stats and game log come back empty when ESPN has none
// (e.g. a freshman who hasn't played, or an off-season request).
async function getPlayer(athleteId, sport) {
  const cfg = sportConfig(sport);
  const base = `${WEB_ROOT}/${cfg.path}/athletes/${encodeURIComponent(athleteId)}`;
  const key = `espn:${cfg.key}:player:${athleteId}`;
  return cache.getOrFetch(key, async () => {
    const [bio, stats, log] = await Promise.all([
      fetchJson(base),
      fetchJson(`${base}/stats`).catch(() => null),
      fetchJson(`${base}/gamelog`).catch(() => null),
    ]);
    return {
      sport: cfg.key,
      player: parseAthlete(bio),
      careerStats: stats ? parseCareerStats(stats) : [],
      gameLog: log ? parseGameLog(log) : { labels: [], games: [] },
    };
  }, 10 * 60 * 1000);
}

module.exports = { getTeamRoster, getPlayer, parseRoster, parseAthlete, parseCareerStats, parseGameLog };
