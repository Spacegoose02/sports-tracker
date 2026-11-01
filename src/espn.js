// Thin client around ESPN's public (unofficial, undocumented but widely
// used) sports APIs. No API key required. Every league uses the same
// endpoint shapes under a different path (see src/sports.js); college
// football is the default everywhere so existing callers keep working.
//
// Reference endpoints:
//   Scoreboard (a week's games):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard
//   Team schedule (full season for one team):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{id}/schedule
//   Game summary (box score / live drive-by-drive stats):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary

const fetch = require('node-fetch');
const cache = require('./cache');
const { resolveSport } = require('./sports');
const { parseGameExtras } = require('./gamedetail');

const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports';
const STANDINGS_ROOT = 'https://site.api.espn.com/apis/v2/sports';

function sportConfig(sportKey) {
  const sport = resolveSport(sportKey);
  if (!sport) throw new Error(`Unknown sport: ${sportKey}`);
  return sport;
}

function baseFor(sportKey) {
  return `${SITE_ROOT}/${sportConfig(sportKey).path}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) {
    throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// ESPN represents a competitor's score differently across endpoints: the
// scoreboard endpoint tends to give a plain string ("24"), but the
// per-team schedule endpoint has been observed giving an object
// ({ value: 24, displayValue: "24" }) or omitting it on some entries
// entirely. This normalizes all of those shapes, and falls back to
// summing quarter-by-quarter linescores if the top-level score is
// missing but linescores are present.
function parseScore(rawScore, linescores) {
  let value = null;
  if (rawScore !== undefined && rawScore !== null) {
    if (typeof rawScore === 'number') {
      value = rawScore;
    } else if (typeof rawScore === 'string' && rawScore !== '') {
      value = Number(rawScore);
    } else if (typeof rawScore === 'object') {
      if (rawScore.value !== undefined) value = Number(rawScore.value);
      else if (rawScore.displayValue !== undefined) value = Number(rawScore.displayValue);
    }
  }
  if ((value === null || Number.isNaN(value)) && Array.isArray(linescores) && linescores.length) {
    const sum = linescores.reduce((acc, l) => {
      const n = typeof l === 'object' ? Number(l.value !== undefined ? l.value : l.displayValue) : Number(l);
      return acc + (Number.isNaN(n) ? 0 : n);
    }, 0);
    if (sum > 0) value = sum;
  }
  return value === null || Number.isNaN(value) ? null : value;
}

// Betting odds, when ESPN includes them (mainly pregame/in-progress; often
// absent for older or lower-profile games). `oddsArr` is whatever raw array
// ESPN gave us (competition.odds on the scoreboard, or pickcenter on the
// summary endpoint) — both use roughly the same shape, so one parser covers
// both. Only the first (primary) provider is used.
//
// ESPN has shipped two shapes over the years: an older one with
// homeTeamOdds/awayTeamOdds carrying moneyLine and spreadOdds numbers, and
// a newer one with pointSpread/total/moneyline blocks holding open and
// close lines as strings ("-7.5", "o51.5", "+225"). Both are read here.
// `spread` (and homeSpread) is from the home team's side: -7.5 means the
// home team is a 7.5-point favorite.
function oddsNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim().replace(/^[ou]/i, '');
  if (/^pk$|^pick/i.test(str)) return 0;
  const n = Number(str);
  return str !== '' && Number.isFinite(n) ? n : null;
}

// American odds as a display string: "-110", "+225", "EVEN".
function americanOdds(value) {
  if (value === undefined || value === null || value === '') return null;
  if (/^even$/i.test(String(value).trim())) return 'EVEN';
  const n = oddsNumber(value);
  if (n === null || n === 0) return null;
  return n > 0 ? `+${n}` : String(n);
}

function pick(obj, ...path) {
  return path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function parseOdds(oddsArr) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return null;
  const o = oddsArr[0] || {};
  const rawOverUnder = o.overUnder !== undefined ? o.overUnder : (typeof o.total === 'object' ? undefined : o.total);
  let overUnder = oddsNumber(rawOverUnder);
  if (overUnder === null) overUnder = oddsNumber(pick(o, 'total', 'over', 'close', 'line'));
  let homeSpread = oddsNumber(pick(o, 'pointSpread', 'home', 'close', 'line'));
  if (homeSpread === null) homeSpread = oddsNumber(o.spread);
  if (homeSpread === null) homeSpread = oddsNumber(pick(o, 'homeTeamOdds', 'spread'));

  const homeFav = pick(o, 'homeTeamOdds', 'favorite');
  const awayFav = pick(o, 'awayTeamOdds', 'favorite');
  let favorite = null;
  if (homeFav === true || awayFav === false) favorite = 'home';
  else if (awayFav === true || homeFav === false) favorite = 'away';
  // The flags win if the spread's sign disagrees with them.
  if (homeSpread !== null && homeSpread !== 0 && favorite) {
    if ((favorite === 'home') !== (homeSpread < 0)) homeSpread = -homeSpread;
  }
  if (!favorite && homeSpread) favorite = homeSpread < 0 ? 'home' : 'away';

  const moneyline = {
    home: americanOdds(pick(o, 'moneyline', 'home', 'close', 'odds')) || americanOdds(pick(o, 'homeTeamOdds', 'moneyLine')),
    away: americanOdds(pick(o, 'moneyline', 'away', 'close', 'odds')) || americanOdds(pick(o, 'awayTeamOdds', 'moneyLine')),
  };
  const spreadOdds = {
    home: americanOdds(pick(o, 'pointSpread', 'home', 'close', 'odds')) || americanOdds(pick(o, 'homeTeamOdds', 'spreadOdds')),
    away: americanOdds(pick(o, 'pointSpread', 'away', 'close', 'odds')) || americanOdds(pick(o, 'awayTeamOdds', 'spreadOdds')),
  };
  const totalOdds = {
    over: americanOdds(pick(o, 'total', 'over', 'close', 'odds')) || americanOdds(o.overOdds),
    under: americanOdds(pick(o, 'total', 'under', 'close', 'odds')) || americanOdds(o.underOdds),
  };
  const open = {
    homeSpread: oddsNumber(pick(o, 'pointSpread', 'home', 'open', 'line')),
    overUnder: oddsNumber(pick(o, 'total', 'over', 'open', 'line')),
    moneylineHome: americanOdds(pick(o, 'moneyline', 'home', 'open', 'odds')),
    moneylineAway: americanOdds(pick(o, 'moneyline', 'away', 'open', 'odds')),
  };
  const hasOpen = Object.values(open).some((v) => v !== null);

  if (overUnder === null && homeSpread === null && !o.details && !moneyline.home && !moneyline.away) return null;
  return {
    provider: (o.provider && o.provider.name) || null,
    details: typeof o.details === 'string' ? o.details : null,
    spread: homeSpread,
    homeSpread,
    favorite,
    overUnder,
    moneyline,
    spreadOdds,
    totalOdds,
    open: hasOpen ? open : null,
  };
}

function parseCuratedRank(c) {
  const raw = c.curatedRank;
  if (!raw) return null;
  const current = typeof raw === 'object' ? raw.current : raw;
  const n = Number(current);
  return !Number.isNaN(n) && n > 0 && n < 99 ? n : null;
}

function normalizeCompetitor(c) {
  const team = c.team || {};
  const linescores = (c.linescores || []).map((l) => (typeof l === 'object' ? (l.value !== undefined ? l.value : l.displayValue) : l));
  return {
    id: team.id,
    uid: team.uid,
    name: team.displayName || team.name,
    shortName: team.shortDisplayName || team.abbreviation,
    abbreviation: team.abbreviation,
    logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || null,
    color: team.color ? `#${team.color}` : null,
    score: parseScore(c.score, c.linescores),
    homeAway: c.homeAway,
    winner: !!c.winner,
    curatedRank: parseCuratedRank(c),
    records: (c.records || []).map((r) => ({ name: r.name, summary: r.summary })),
    linescores,
  };
}

// ESPN's live "situation" object, normalized once and reused by both the
// scoreboard (normalizeGame, below) and the game-summary endpoint
// (getGameSummary). `yardLine` is a 0-100 number measured from the
// possessing team's OWN goal line (0 = pinned on their own goal, 100 =
// standing in the opponent's end zone) — this matches how ESPN computes
// `isRedZone` (true once yardLine crosses into the opponent's 20, i.e.
// yardLine >= 80) and is the convention this app's field-position diagram
// on the game page assumes. ESPN doesn't publish a formal schema for this
// endpoint, so if a live game ever shows the ball on the wrong side of the
// field, this is the first place to check.
function parseSituation(raw) {
  if (!raw) return null;
  const yardLine = raw.yardLine !== undefined && raw.yardLine !== null ? Number(raw.yardLine) : null;
  const distance = raw.distance !== undefined && raw.distance !== null ? Number(raw.distance) : null;
  return {
    down: raw.shortDownDistanceText || raw.downDistanceText || null,
    distance: Number.isNaN(distance) ? null : distance,
    yardLine: Number.isNaN(yardLine) ? null : yardLine,
    possessionText: raw.possessionText || null,
    isRedZone: !!raw.isRedZone,
    homeTimeouts: raw.homeTimeouts !== undefined ? raw.homeTimeouts : null,
    awayTimeouts: raw.awayTimeouts !== undefined ? raw.awayTimeouts : null,
    possession: raw.possession || null,
    lastPlay: raw.lastPlay && raw.lastPlay.text,
    // Baseball: count, outs and runners. Null for other sports.
    baseball: raw.outs !== undefined || raw.balls !== undefined
      ? {
        balls: raw.balls !== undefined ? Number(raw.balls) : null,
        strikes: raw.strikes !== undefined ? Number(raw.strikes) : null,
        outs: raw.outs !== undefined ? Number(raw.outs) : null,
        onFirst: !!raw.onFirst,
        onSecond: !!raw.onSecond,
        onThird: !!raw.onThird,
      }
      : null,
  };
}

function normalizeGame(event) {
  const comp = event.competitions && event.competitions[0];
  const status = event.status || (comp && comp.status) || {};
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  const broadcasts = (comp && comp.broadcasts) || [];

  return {
    id: event.id,
    date: event.date,
    // false when ESPN only knows the day (kickoff "TBA"), so calendars can
    // show an all-day entry instead of a made-up time.
    timeValid: !(event.timeValid === false || (comp && comp.timeValid === false)),
    name: event.name,
    shortName: event.shortName,
    week: event.week && event.week.number,
    venue: comp && comp.venue && comp.venue.fullName,
    neutralSite: !!(comp && comp.neutralSite),
    conferenceCompetition: !!(comp && comp.conferenceCompetition),
    broadcast: broadcasts[0] && broadcasts[0].names && broadcasts[0].names[0],
    status: {
      state: status.type && status.type.state, // 'pre' | 'in' | 'post'
      detail: status.type && status.type.detail,
      shortDetail: status.type && status.type.shortDetail,
      completed: !!(status.type && status.type.completed),
      period: status.period,
      clock: status.displayClock,
    },
    home: home ? normalizeCompetitor(home) : null,
    away: away ? normalizeCompetitor(away) : null,
    // Best-effort: ESPN only attaches odds to some games (mainly current/
    // upcoming FBS matchups with a real sportsbook line). Null just means
    // "no line available," not an error.
    odds: parseOdds(comp && comp.odds),
    situation: parseSituation(comp && comp.situation),
  };
}

// ESPN's `winner` flag on a competitor isn't always present (some feeds,
// notably the per-team schedule endpoint, omit it even for finished
// games). If the game is completed and both scores parsed successfully,
// infer the winner from the scores so the UI can always show a clear W/L.
function fillInWinner(game) {
  if (!game.status || !game.status.completed) return game;
  if (!game.home || !game.away) return game;
  if (game.home.score === null || game.away.score === null) return game;
  if (game.home.winner || game.away.winner) return game; // already known
  if (game.home.score === game.away.score) return game; // tie, leave as-is
  game.home.winner = game.home.score > game.away.score;
  game.away.winner = game.away.score > game.home.score;
  return game;
}

// Get the scoreboard. Week-based sports (football) take year/week/
// seasontype; day-based sports take `dates` (YYYYMMDD, or a
// YYYYMMDD-YYYYMMDD range). With nothing given, ESPN returns whatever
// week/day is "current" on their end.
async function getScoreboard({ sport, year, week, seasontype, groups, dates } = {}) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (cfg.schedule === 'week') {
    if (year) params.set('year', year);
    if (week) params.set('week', week);
    params.set('seasontype', seasontype || 2);
  } else if (dates) {
    params.set('dates', dates);
  }
  // College leagues default to their first division (FBS / Division I);
  // without a group ESPN only returns a handful of featured games.
  const group = groups || (cfg.groups ? cfg.groups[0].value : null);
  if (group) params.set('groups', group);
  params.set('limit', 400);

  if (cfg.format === 'card' || cfg.format === 'race') return getEvents(cfg, params);

  const key = `espn:${cfg.key}:scoreboard:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/scoreboard?${params.toString()}`);
    const events = json.events || [];
    return {
      sport: cfg.key,
      season: json.season && json.season.year,
      week: json.week && json.week.number,
      seasonType: json.season && json.season.type,
      day: (json.day && json.day.date) || null,
      games: events.map((e) => fillInWinner(normalizeGame(e))),
    };
  });
}

// ---- UFC and NASCAR -------------------------------------------------------
// These leagues don't have two-team games. ESPN models a UFC event as one
// event whose `competitions` are the individual fights, and a NASCAR race
// weekend as one event whose competitions are practice, qualifying and the
// race. Both are returned as `events` (with `games: []` so callers that only
// know team sports still work).

async function getEvents(cfg, params) {
  const key = `espn:${cfg.key}:events:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/scoreboard?${params.toString()}`);
    const events = (json.events || []).map((e) => (cfg.format === 'card' ? normalizeCard(e) : normalizeRace(e)));
    events.sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    return {
      sport: cfg.key,
      season: json.season && json.season.year,
      week: null,
      seasonType: json.season && json.season.type,
      day: null,
      games: [],
      events,
    };
  }, 60 * 1000);
}

function normalizeStatus(status) {
  const type = (status && status.type) || {};
  return {
    state: type.state, // 'pre' | 'in' | 'post'
    detail: type.detail,
    shortDetail: type.shortDetail,
    completed: !!type.completed,
    period: status && status.period,
    clock: status && status.displayClock,
  };
}

function eventShell(event, comp) {
  const broadcasts = (comp && comp.broadcasts) || [];
  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    date: (comp && comp.date) || event.date,
    venue: (comp && comp.venue && comp.venue.fullName) || (event.circuit && event.circuit.fullName) || (event.venues && event.venues[0] && event.venues[0].fullName) || null,
    broadcast: (broadcasts[0] && broadcasts[0].names && broadcasts[0].names[0]) || null,
    status: normalizeStatus((comp && comp.status) || event.status),
  };
}

function fighter(c) {
  const athlete = c.athlete || {};
  const records = c.records || c.record || [];
  return {
    id: athlete.id || c.id || null,
    name: athlete.displayName || athlete.fullName || null,
    shortName: athlete.shortName || athlete.displayName || null,
    flag: (athlete.flag && athlete.flag.href) || null,
    record: (records[0] && records[0].summary) || null,
    winner: !!c.winner,
  };
}

// A fight card: every competition is one bout. ESPN lists the prelims
// first, so reverse to put the main event on top.
function normalizeCard(event) {
  const comps = event.competitions || [];
  const main = comps[comps.length - 1];
  const bouts = comps.slice().reverse().map((comp) => {
    const [a, b] = comp.competitors || [];
    const status = normalizeStatus(comp.status || event.status);
    return {
      id: comp.id || null,
      weightClass: (comp.type && (comp.type.text || comp.type.abbreviation)) || null,
      status,
      result: status.completed ? (status.detail || null) : null,
      fighters: [a, b].filter(Boolean).map(fighter),
    };
  });
  const shell = eventShell(event, main);
  // The event is live if any fight is, and only final when all are.
  if (bouts.some((b) => b.status.state === 'in')) shell.status = { ...shell.status, state: 'in' };
  else if (bouts.length && bouts.every((b) => b.status.state === 'post')) shell.status = { ...shell.status, state: 'post', completed: true };
  return { ...shell, date: (comps[0] && comps[0].date) || event.date, bouts };
}

// A race weekend: keep the race itself (not practice or qualifying), with
// its running order (finishing order once it's over). Before the start the
// competitor list is just the entry list, so it's dropped.
function normalizeRace(event) {
  const comps = event.competitions || [];
  const race = comps.find((c) => c.type && /^race$/i.test(c.type.abbreviation || '')) || comps[comps.length - 1];
  const shell = eventShell(event, race);
  let order = ((race && race.competitors) || [])
    .filter((c) => c.athlete)
    .map((c) => ({
      place: Number(c.order) || null,
      name: c.athlete.displayName || null,
      shortName: c.athlete.shortName || c.athlete.displayName || null,
      number: (c.vehicle && c.vehicle.number) || null,
      winner: !!c.winner,
    }))
    .sort((a, b) => (a.place || 999) - (b.place || 999));
  if (shell.status.state === 'pre') order = [];
  // Lap counts, when ESPN has them (the period is the current lap while a
  // race is running).
  const totalLaps = Number((race && (race.laps || (race.format && race.format.regulation && race.format.regulation.periods))) || 0) || null;
  return { ...shell, race: order.slice(0, 10), fieldSize: order.length, totalLaps };
}

// Full-season schedule for one team (used for the pinned favorite team and
// for the "jump to my team's next game" convenience).
async function getTeamSchedule(teamId, season, sport) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  const key = `espn:${cfg.key}:teamschedule:${teamId}:${season || 'current'}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/teams/${teamId}/schedule?${params.toString()}`);
    const events = json.events || [];
    return {
      teamId,
      season: json.season && json.season.year,
      games: events.map((event) => {
        // Team schedule events have a slightly different shape than the
        // scoreboard endpoint (competitions live at the top level under
        // "competitions" too, but competitors reference team refs) - ESPN
        // is not perfectly consistent, so normalizeGame() defensively reads
        // through optional chaining-equivalent guards above, and
        // fillInWinner() covers the case where this feed omits the
        // `winner` flag on completed games even when scores are present.
        return fillInWinner(normalizeGame(event));
      }),
    };
  });
}

// Team header info: current record, rank, logo, colors.
async function getTeamInfo(teamId, sport) {
  const cfg = sportConfig(sport);
  const key = `espn:${cfg.key}:teaminfo:${teamId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/teams/${teamId}`);
    const team = json.team || {};
    return {
      id: team.id,
      name: team.displayName,
      shortName: team.shortDisplayName,
      abbreviation: team.abbreviation,
      logo: team.logos && team.logos[0] && team.logos[0].href,
      color: team.color ? `#${team.color}` : null,
      alternateColor: team.alternateColor ? `#${team.alternateColor}` : null,
      record: team.record && team.record.items && team.record.items[0] && team.record.items[0].summary,
      rank: team.rank || null,
      standingSummary: team.standingSummary,
    };
  }, 5 * 60 * 1000); // team info changes rarely, cache 5 min
}

// Live/finished game detail: score by quarter, leaders, box score stats.
// Cached for a very short time (or not at all) so "live" stays live.
async function getGameSummary(eventId, sport) {
  const cfg = sportConfig(sport);
  const key = `espn:${cfg.key}:summary:${eventId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/summary?event=${encodeURIComponent(eventId)}`);
    const header = json.header || {};
    const comp = header.competitions && header.competitions[0];
    const competitors = (comp && comp.competitors) || [];

    return {
      id: header.id,
      sport: cfg.key,
      date: (comp && comp.date) || header.date || null,
      venue: (comp && comp.venue && comp.venue.fullName) || null,
      broadcast: (comp && comp.broadcasts && comp.broadcasts[0] && comp.broadcasts[0].names && comp.broadcasts[0].names[0]) || null,
      status: comp && comp.status && {
        state: comp.status.type && comp.status.type.state,
        detail: comp.status.type && comp.status.type.detail,
        shortDetail: comp.status.type && comp.status.type.shortDetail,
        completed: !!(comp.status.type && comp.status.type.completed),
        period: comp.status.period,
        clock: comp.status.displayClock,
      },
      situation: parseSituation(json.situation),
      teams: competitors.map((c) => ({
        id: c.team && c.team.id,
        name: c.team && c.team.displayName,
        shortName: c.team && (c.team.shortDisplayName || c.team.abbreviation),
        abbreviation: c.team && c.team.abbreviation,
        logo: (c.team && (c.team.logo || (c.team.logos && c.team.logos[0] && c.team.logos[0].href))) || null,
        color: c.team && c.team.color ? `#${c.team.color}` : null,
        record: c.records && c.records[0] && c.records[0].summary,
        rank: c.curatedRank ? parseCuratedRank(c) : null,
        homeAway: c.homeAway,
        winner: !!c.winner,
        score: parseScore(c.score, c.linescores),
        linescores: (c.linescores || []).map((l) => (typeof l === 'object' ? (l.value !== undefined ? l.value : l.displayValue) : l)),
      })),
      leaders: (json.leaders || []).map((teamLeaders) => ({
        team: teamLeaders.team && teamLeaders.team.displayName,
        categories: (teamLeaders.leaders || []).map((cat) => ({
          name: cat.displayName,
          athlete: cat.leaders && cat.leaders[0] && cat.leaders[0].athlete && cat.leaders[0].athlete.displayName,
          value: cat.leaders && cat.leaders[0] && cat.leaders[0].displayValue,
        })),
      })),
      boxscore: json.boxscore
        ? {
          teams: (json.boxscore.teams || []).map((t) => ({
            team: t.team && t.team.displayName,
            stats: (t.statistics || []).map((s) => ({ name: s.label || s.name, value: s.displayValue })),
          })),
        }
        : null,
      drives: json.drives && json.drives.current
        ? {
          description: json.drives.current.description,
          plays: (json.drives.current.plays || []).slice(-5).map((p) => p.text),
        }
        : null,
      // Full play-by-play works out to at least ~50-150+ plays a game, so
      // this reads through every drive (previous, in chronological order
      // per ESPN, plus the current one) rather than just the last few
      // plays `drives` above uses for the compact "latest drive" summary.
      // Returned newest-first so the game page can show it as a live feed.
      odds: parseOdds(json.pickcenter) || parseOdds(comp && comp.odds),
      // Football groups plays into drives; every other sport returns a
      // flat `plays` list instead.
      playByPlay: json.drives ? buildPlayByPlay(json.drives) : buildFlatPlayByPlay(json.plays),
      // Every TV/streaming broadcast, player box scores, win probability,
      // injuries, venue/weather, recent form (see src/gamedetail.js).
      ...parseGameExtras(json, comp),
    };
  }, 10 * 1000); // 10s cache for in-game data
}

function buildPlayByPlay(drivesJson) {
  if (!drivesJson) return [];
  const drives = [...(drivesJson.previous || []), ...(drivesJson.current ? [drivesJson.current] : [])];
  const plays = [];
  for (const drive of drives) {
    const driveDesc = drive.description || (drive.team && drive.team.displayName) || null;
    for (const p of drive.plays || []) {
      if (!p.text) continue;
      plays.push({
        text: p.text,
        period: p.period && p.period.number,
        clock: p.clock && p.clock.displayValue,
        drive: driveDesc,
        scoringPlay: !!p.scoringPlay,
      });
    }
  }
  return plays.reverse(); // newest first
}

// Basketball/baseball/hockey summaries: a flat, chronological `plays`
// array (often 400+ entries for an NBA game), so keep the newest 250.
function buildFlatPlayByPlay(plays) {
  if (!Array.isArray(plays)) return [];
  return plays
    .filter((p) => p && p.text)
    .map((p) => ({
      text: p.text,
      period: p.period && p.period.number,
      clock: p.clock && p.clock.displayValue,
      drive: null,
      scoringPlay: !!p.scoringPlay,
    }))
    .reverse()
    .slice(0, 250);
}

// Top 25 rankings (AP, Coaches, etc.), including "others receiving votes".
// ESPN's rankings JSON shape has drifted a bit over the years, so this
// reads several possible field names defensively rather than assuming one.
// Preseason polls have no "previous" for anyone, so nobody is "new".
function isFirstPoll(poll) {
  return !(poll.ranks || []).some((r) => r.previous);
}

async function getRankings({ sport, year, week, seasontype = 2 } = {}) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (year) params.set('year', year);
  if (week) params.set('week', week);
  if (seasontype) params.set('seasontype', seasontype);
  // No group/division filter: ESPN's rankings endpoint returns every poll
  // it has for the week in one response (AP Top 25, AFCA Coaches, FCS
  // Coaches Poll, AFCA Division II/III Coaches, etc.) — the poll picker in
  // the UI is what narrows it down, so there's no need to ask ESPN to
  // pre-filter by division.

  const key = `espn:${cfg.key}:rankings:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/rankings?${params.toString()}`);
    const pollsRaw = json.rankings || (json.sports && json.sports[0] && json.sports[0].leagues && json.sports[0].leagues[0] && json.sports[0].leagues[0].rankings) || [];

    const polls = pollsRaw.map((poll) => {
      const ranks = (poll.ranks || []).map((r) => ({
        rank: r.current,
        previousRank: r.previous || null,
        // Positive = moved up. Null when the team wasn't ranked last week
        // (isNew) or this is the first poll of the season.
        movement: r.previous && r.current ? r.previous - r.current : null,
        isNew: !r.previous && !!r.current && !isFirstPoll(poll),
        trend: r.trend || null,
        points: r.points || null,
        firstPlaceVotes: r.firstPlaceVotes || 0,
        recordSummary: r.recordSummary || (r.team && r.team.record) || null,
        team: r.team
          ? {
            id: r.team.id,
            name: r.team.displayName || r.team.name,
            shortName: r.team.shortDisplayName || r.team.abbreviation,
            abbreviation: r.team.abbreviation,
            logo: r.team.logos && r.team.logos[0] && r.team.logos[0].href,
          }
          : null,
      }));

      // "Others receiving votes" shows up under a few different possible
      // keys depending on ESPN's API version; try each.
      const othersRaw = poll.others || poll.receivingVotes || poll.otherReceivingVotes || [];
      const others = othersRaw.map((o) => ({
        points: o.points || o.receivingVotesCount || null,
        recordSummary: o.recordSummary || null,
        team: o.team
          ? {
            id: o.team.id,
            name: o.team.displayName || o.team.name,
            shortName: o.team.shortDisplayName || o.team.abbreviation,
            abbreviation: o.team.abbreviation,
            logo: o.team.logos && o.team.logos[0] && o.team.logos[0].href,
          }
          : null,
      }));

      const droppedOut = (poll.droppedOut || []).map((d) => ({
        previousRank: d.previous || null,
        team: d.team ? { id: d.team.id, name: d.team.displayName || d.team.name, logo: d.team.logos && d.team.logos[0] && d.team.logos[0].href } : null,
      }));

      return {
        id: poll.id,
        name: poll.name,
        shortName: poll.shortName,
        type: poll.type || null,
        headline: poll.headline,
        occurrence: poll.occurrence && poll.occurrence.value,
        ranks,
        others,
        droppedOut,
      };
    });

    return {
      season: year || (json.latestSeason && json.latestSeason.year) || null,
      week: week || (json.latestWeek && json.latestWeek.number) || null,
      latestWeek: (json.latestWeek && json.latestWeek.number) || null,
      polls,
    };
  }, 60 * 1000); // rankings update ~weekly, but cache short so a same-day fix shows up fast
}

// Standings, grouped by conference (college) or conference/league (pros:
// AFC/NFC, East/West, AL/NL). For college football group=80 is FBS.
async function getStandings({ sport, year, group } = {}) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (cfg.key === 'cfb') {
    params.set('season', year || new Date().getFullYear());
    params.set('group', group || 80);
  } else {
    // Pro and basketball seasons span two calendar years (ESPN labels the
    // 2026-27 NBA season "2027"), so only pass a season when asked and
    // otherwise let ESPN return the current one.
    if (year) params.set('season', year);
    if (group) params.set('group', group);
  }

  const key = `espn:${cfg.key}:standings:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    // This endpoint lives at a slightly different path than the others.
    const url = `${STANDINGS_ROOT}/${cfg.path}/standings?${params.toString()}`;
    const json = await fetchJson(url);
    return { season: year, conferences: parseStandings(json) };
  }, 5 * 60 * 1000); // standings change slowly, cache 5 min
}

// Some leagues nest one level deeper (conference -> division). Flatten to
// the deepest groups that actually carry standings entries.
function standingsGroups(node) {
  if (node.standings && node.standings.entries && node.standings.entries.length) return [node];
  return (node.children || []).flatMap(standingsGroups);
}

function parseStandings(json) {
  const children = standingsGroups(json);
  const conferences = children.map((conf) => {
    const standings = (conf.standings && conf.standings.entries) || [];
    const entries = standings.map((entry) => {
      const team = entry.team || {};
      const statByName = {};
      (entry.stats || []).forEach((s) => {
        if (s.name) statByName[s.name] = s.displayValue;
        if (s.type) statByName[`type:${s.type}`] = s.summary || s.displayValue;
        if (s.shortDisplayName && statByName[s.shortDisplayName] === undefined) statByName[s.shortDisplayName] = s.displayValue;
      });
      // Pro standings don't always carry a ready-made "overall" record;
      // build one from wins/losses (and ties / OT losses) when needed.
      let overall = statByName.overall || statByName['overall record'] || statByName['type:total'] || null;
      if (!overall && statByName.wins !== undefined && statByName.losses !== undefined) {
        const extra = statByName.ties && statByName.ties !== '0' ? `-${statByName.ties}`
          : statByName.otLosses && statByName.otLosses !== '0' ? `-${statByName.otLosses}` : '';
        overall = `${statByName.wins}-${statByName.losses}${extra}`;
      }
      return {
        team: {
          id: team.id,
          name: team.displayName || team.name,
          shortName: team.shortDisplayName || team.abbreviation,
          abbreviation: team.abbreviation,
          logo: team.logos && team.logos[0] && team.logos[0].href,
        },
        overall,
        conference: statByName.vsConf || statByName.conferenceRecord || statByName['vs. Conf.'] || statByName['type:vsconf'] || null,
        winPercent: statByName.winPercent || null,
        gamesBehind: statByName.gamesBehind || null,
        points: statByName.points || null,
        streak: statByName.streak || null,
        rank: statByName.rank || null,
        home: statByName['type:home'] || statByName.home || statByName.Home || null,
        road: statByName['type:road'] || statByName['type:away'] || statByName.road || statByName.away || null,
        pointsFor: statByName.pointsFor || statByName.avgPointsFor || null,
        pointsAgainst: statByName.pointsAgainst || statByName.avgPointsAgainst || null,
        differential: statByName.differential || statByName.pointDifferential || null,
        seed: statByName.playoffSeed || null,
        clincher: statByName.clincher || null,
      };
    });
    return {
      name: conf.name || (conf.abbreviation),
      abbreviation: conf.abbreviation,
      entries,
    };
  });

  return conferences;
}

// Season-level team statistics (passing/rushing/defense totals, etc.)
async function getTeamStatistics(teamId, season, sport) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  const key = `espn:${cfg.key}:teamstats:${teamId}:${season || 'current'}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/teams/${teamId}/statistics?${params.toString()}`);
    const splits = (json.results && json.results.stats && json.results.stats.categories) || (json.splits && json.splits.categories) || [];
    return {
      teamId,
      categories: splits.map((cat) => ({
        name: cat.displayName || cat.name,
        stats: (cat.stats || []).map((s) => ({ name: s.displayName || s.name, value: s.displayValue })),
      })),
    };
  }, 5 * 60 * 1000);
}

// ESPN's own headlines for a league, optionally narrowed to one team.
// Same item shape as src/news.js (title/link/source/pubDate/summary/image)
// so the News tab can render either.
async function getNews({ sport, team, limit = 30 } = {}) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  params.set('limit', limit);
  if (team) params.set('team', team);
  const key = `espn:${cfg.key}:news:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/news?${params.toString()}`);
    return parseNews(json);
  }, 10 * 60 * 1000);
}

// Every team in a league, for pickers (the Home Assistant integration's
// "follow a team" step). College leagues have hundreds of teams.
async function getTeams({ sport } = {}) {
  const cfg = sportConfig(sport);
  if (cfg.teams === false) return [];
  const key = `espn:${cfg.key}:teams`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${baseFor(cfg.key)}/teams?limit=1000`);
    const league = json.sports && json.sports[0] && json.sports[0].leagues && json.sports[0].leagues[0];
    return ((league && league.teams) || [])
      .map((t) => t.team || t)
      .filter((t) => t && t.id)
      .map((t) => ({
        id: String(t.id),
        name: t.displayName || t.name,
        abbreviation: t.abbreviation || null,
        logo: (t.logos && t.logos[0] && t.logos[0].href) || null,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, 24 * 60 * 60 * 1000);
}

function parseNews(json) {
  return (json.articles || [])
    .map((a) => {
      const link = a.links && a.links.web && a.links.web.href;
      const image = (a.images || []).find((img) => img && img.url);
      const published = a.published ? new Date(a.published) : null;
      return {
        title: a.headline || a.title || null,
        link: link || null,
        source: 'ESPN',
        pubDate: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
        summary: (a.description || '').slice(0, 220),
        image: image ? image.url : null,
      };
    })
    .filter((item) => item.title && item.link);
}

module.exports = {
  getNews,
  getTeams,
  parseNews,
  getScoreboard,
  getTeamSchedule,
  getTeamInfo,
  getGameSummary,
  getRankings,
  getStandings,
  getTeamStatistics,
  // Exported for tests.
  parseOdds,
  normalizeGame,
  normalizeCard,
  normalizeRace,
  parseStandings,
  buildFlatPlayByPlay,
  parseSituation,
};
