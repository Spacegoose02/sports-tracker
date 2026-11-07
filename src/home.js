// The all-sports home page (public/home.html): one call that gathers what's
// happening across every league right now. For each sport it loads the
// current scoreboard (the same cached call each sport's Scores page makes),
// decides whether the league is in season, counts live / upcoming / final
// games and picks the few games most worth a look. It also merges the
// biggest live games from every league into one "Live now" list, and mixes
// headlines from the leagues that are in season.
//
// Followed teams are passed as ?teams=cfb:259,nba:25 (they live in the
// browser for signed-out visitors), and come back with their live, next and
// last game from src/calendar.js's myTeamsSummary.

const realDs = require('./datasource');
const realNews = require('./news');
const { myTeamsSummary } = require('./calendar');
const { SPORTS, DEFAULT_SPORT } = require('./sports');
const { isSafeId } = require('./security');

const DAY = 24 * 60 * 60 * 1000;
// A league counts as in season when it has a game from 4 days ago to 8 days
// ahead. Week-based sports (football) play Thursday to Monday, so a quiet
// Tuesday still counts.
const SEASON_BACK = 4 * DAY;
const SEASON_AHEAD = 8 * DAY;
const GAMES_PER_LEAGUE = 4;
const MAX_LIVE = 10;
const MAX_HEADLINES = 12;
const HEADLINES_PER_LEAGUE = 3;
const MAX_TEAMS = 12;

// Regulation periods and what counts as a close margin, by sport. Mirrors
// gameDrama in public/js/shared.js, which tags cards on the Scores page.
const REG_PERIODS = { cfb: 4, nfl: 4, nba: 4, mcbb: 2, nhl: 3, mlb: 9 };
const CLOSE_MARGIN = { cfb: 8, nfl: 8, nba: 6, mcbb: 6, nhl: 1, mlb: 2 };

function rankOf(team) {
  const r = team && Number(team.curatedRank);
  return r && r <= 25 ? r : null;
}

// How gripping a live game is right now, 0 to ~130 (see shared.js).
function liveDrama(game, sport) {
  if (!game.home || !game.away) return 0;
  const h = Number(game.home.score);
  const a = Number(game.away.score);
  if (Number.isNaN(h) || Number.isNaN(a)) return 0;
  const regulation = REG_PERIODS[sport] || 4;
  const close = CLOSE_MARGIN[sport] || 8;
  const period = Number(game.status && game.status.period) || 1;
  const overtime = period > regulation;
  const lateness = overtime ? 1.1 : Math.min(1, period / regulation);
  const closeness = Math.max(0, 1 - Math.abs(h - a) / (close * 2));
  const hr = rankOf(game.home);
  const ar = rankOf(game.away);
  const trailing = h < a ? { me: hr, them: ar } : a < h ? { me: ar, them: hr } : null;
  const upset = !!(trailing && trailing.me && (!trailing.them || trailing.them - trailing.me >= 5));
  return Math.round(closeness * 60 + lateness * 30 + (upset ? 25 : 0) + (hr && ar ? 10 : 0) + (overtime ? 10 : 0));
}

// Ranked teams make a game worth more, two ranked teams more still.
function rankBonus(game) {
  const ranks = [rankOf(game.home), rankOf(game.away)].filter(Boolean);
  return ranks.reduce((sum, r) => sum + (26 - r), 0) + (ranks.length === 2 ? 20 : 0);
}

// Higher is more worth showing: live games first (by drama), then games
// starting soon, then the latest finals.
function gameScore(game, sport, now) {
  const state = game.status && game.status.state;
  const t = Date.parse(game.date) || now;
  if (state === 'in') return 3000 + liveDrama(game, sport) + rankBonus(game);
  if (state === 'pre') {
    const hours = Math.max(0, (t - now) / 3600000);
    return 2000 + rankBonus(game) - Math.min(hours, 200) * 2;
  }
  const hoursAgo = Math.max(0, (now - t) / 3600000);
  return 1000 + rankBonus(game) - Math.min(hoursAgo, 200) * 2;
}

function slimTeam(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    abbreviation: t.abbreviation,
    logo: t.logo,
    color: t.color,
    score: t.score,
    winner: !!t.winner,
    curatedRank: t.curatedRank || null,
  };
}

function slimGame(game, sport) {
  return {
    sport,
    id: game.id,
    date: game.date,
    timeValid: game.timeValid !== false,
    shortName: game.shortName,
    headline: game.headline || null,
    broadcast: game.broadcast || null,
    source: game.source || 'espn',
    status: game.status,
    home: slimTeam(game.home),
    away: slimTeam(game.away),
  };
}

// UFC and NASCAR: the event itself, with a one-line summary (the main
// event, or the race leader / winner).
function slimEvent(event, sport) {
  let summary = null;
  if (event.bouts && event.bouts[0]) {
    const names = event.bouts[0].fighters.map((f) => f.name).filter(Boolean);
    if (names.length) summary = `Main event: ${names.join(' vs ')}`;
  } else if (event.race && event.race[0]) {
    const state = event.status && event.status.state;
    const lead = event.race[0];
    if (state === 'post') summary = `Winner: ${lead.name}`;
    else if (state === 'in') summary = `Leader: ${lead.name}`;
  }
  return {
    sport,
    id: event.id,
    date: event.date,
    name: event.name || event.shortName || 'Event',
    venue: event.venue || null,
    broadcast: event.broadcast || null,
    status: event.status,
    summary,
  };
}

function inWindow(item, now) {
  const t = Date.parse(item.date);
  if (Number.isNaN(t)) return false;
  return t >= now - SEASON_BACK && t <= now + SEASON_AHEAD;
}

function countStates(items) {
  const counts = { live: 0, upcoming: 0, final: 0, total: items.length };
  items.forEach((g) => {
    const state = g.status && g.status.state;
    if (state === 'in') counts.live += 1;
    else if (state === 'pre') counts.upcoming += 1;
    else if (state === 'post') counts.final += 1;
  });
  return counts;
}

// "Week 10", "Today", "Nov 7": what the league's scoreboard is showing.
function periodLabel(sportCfg, board) {
  if (sportCfg.schedule === 'week' && board.week) {
    return board.seasonType === 3 ? 'Postseason' : `Week ${board.week}`;
  }
  return null;
}

function scoresUrl(key) {
  return `/scores?sport=${encodeURIComponent(key)}`;
}

async function leagueSummary(sportCfg, { ds, now }) {
  const key = sportCfg.key;
  const base = {
    key,
    label: sportCfg.label,
    shortLabel: sportCfg.shortLabel,
    format: sportCfg.format,
    url: scoresUrl(key),
  };
  let board;
  try {
    board = await ds.getScoreboard({ sport: key });
  } catch (err) {
    return { ...base, inSeason: false, error: true, counts: countStates([]), games: [], events: [] };
  }
  const isEvents = sportCfg.format === 'card' || sportCfg.format === 'race';
  if (isEvents) {
    const events = (board.events || []).filter((e) => inWindow(e, now));
    const live = events.filter((e) => e.status && e.status.state === 'in');
    const next = events.filter((e) => e.status && e.status.state === 'pre').sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const past = events.filter((e) => e.status && e.status.state === 'post').sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const pick = [...live, ...next, ...past].slice(0, 2).map((e) => slimEvent(e, key));
    return {
      ...base,
      inSeason: events.length > 0,
      period: null,
      counts: countStates(events),
      games: [],
      events: pick,
      liveGames: [],
    };
  }
  const games = (board.games || []).filter((g) => g && g.date);
  const current = games.filter((g) => inWindow(g, now));
  const ranked = current
    .map((g) => ({ g, score: gameScore(g, key, now) }))
    .sort((a, b) => b.score - a.score);
  return {
    ...base,
    inSeason: current.length > 0,
    period: periodLabel(sportCfg, board),
    counts: countStates(current),
    games: ranked.slice(0, GAMES_PER_LEAGUE).map((x) => slimGame(x.g, key)),
    events: [],
    // Every live game with its drama score, for the cross-league list.
    liveGames: ranked
      .filter((x) => x.g.status && x.g.status.state === 'in')
      .map((x) => ({ score: x.score, game: slimGame(x.g, key) })),
  };
}

async function leagueHeadlines(key, { ds, news }) {
  try {
    const items = key === DEFAULT_SPORT ? await news.getNews() : await ds.getNews({ sport: key });
    return (items || []).slice(0, HEADLINES_PER_LEAGUE).map((i) => ({ ...i, sport: key }));
  } catch (err) {
    return [];
  }
}

// Takes headlines round-robin from each league (newest first within each),
// so one busy league can't push the rest off the page.
function mixHeadlines(lists) {
  const out = [];
  const seen = new Set();
  const queues = lists.map((l) => l.slice().sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)));
  while (out.length < MAX_HEADLINES && queues.some((q) => q.length)) {
    queues.forEach((q) => {
      const item = q.shift();
      if (!item || out.length >= MAX_HEADLINES) return;
      const k = item.link || item.title;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(item);
    });
  }
  return out;
}

// "cfb:259,nba:25" -> [{ sport, id }], dropping unknown sports, bad ids,
// sports without teams and duplicates.
function parseTeams(raw) {
  const out = [];
  const seen = new Set();
  String(raw || '').split(',').forEach((part) => {
    const [sport, id] = part.trim().split(':');
    const cfg = SPORTS[sport];
    if (!cfg || cfg.teams === false || !id || !isSafeId(id)) return;
    const k = `${sport}:${id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ sport, id });
  });
  return out.slice(0, MAX_TEAMS);
}

async function buildHome({ teams = [], now = Date.now(), ds = realDs, news = realNews, summarizeTeams = myTeamsSummary } = {}) {
  const sports = Object.values(SPORTS);
  const [leagues, myTeams] = await Promise.all([
    Promise.all(sports.map((s) => leagueSummary(s, { ds, now }))),
    teams.length ? summarizeTeams(teams, { now }).catch(() => []) : Promise.resolve([]),
  ]);

  const live = leagues
    .flatMap((l) => l.liveGames || [])
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LIVE)
    .map((x) => x.game);

  // Live leagues first, then by how much is going on, then the usual order.
  const order = new Map(sports.map((s, i) => [s.key, i]));
  const sorted = leagues
    .map(({ liveGames, ...l }) => l)
    .sort((a, b) => (b.inSeason - a.inSeason)
      || ((b.counts.live > 0) - (a.counts.live > 0))
      || (order.get(a.key) - order.get(b.key)));

  const inSeason = sorted.filter((l) => l.inSeason).map((l) => l.key);
  const headlineSports = inSeason.length ? inSeason : [DEFAULT_SPORT];
  const headlines = mixHeadlines(await Promise.all(headlineSports.map((k) => leagueHeadlines(k, { ds, news }))));

  return {
    generatedAt: new Date(now).toISOString(),
    counts: {
      live: sorted.reduce((n, l) => n + l.counts.live, 0),
      leaguesInSeason: inSeason.length,
    },
    myTeams,
    live,
    leagues: sorted,
    headlines,
  };
}

module.exports = { buildHome, parseTeams, gameScore, liveDrama, mixHeadlines };
