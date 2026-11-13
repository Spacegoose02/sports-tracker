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

const { rankOf, liveDrama } = require('./drama');

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

// College football game day (most Saturdays, plus rivalry Fridays and
// bowl days): when at least GAMEDAY_MIN games kick off in the window
// around now, the home page leads with the day's Top 25 games and any
// upsets. Pure, so it's easy to test.
const GAMEDAY_MIN = 8;
const GAMEDAY_BACK = 12 * 60 * 60 * 1000;
const GAMEDAY_AHEAD = 14 * 60 * 60 * 1000;
const SPOTLIGHT_GAMES = 8;

// An upset: a ranked team losing (live or final) to an unranked team or
// one ranked at least 5 spots lower.
function upsetOf(game) {
  const state = game.status && game.status.state;
  if (state !== 'in' && state !== 'post') return null;
  const h = Number(game.home && game.home.score);
  const a = Number(game.away && game.away.score);
  if (!Number.isFinite(h) || !Number.isFinite(a) || h === a) return null;
  const leader = h > a ? game.home : game.away;
  const trailer = h > a ? game.away : game.home;
  const lr = rankOf(leader); const tr = rankOf(trailer);
  if (!tr) return null;
  if (lr && lr <= tr + 4) return null;
  return { winnerId: leader.id, loserId: trailer.id, final: state === 'post' };
}

function gameDaySpotlight(games, now) {
  const today = games.filter((g) => {
    const t = Date.parse(g.date);
    return Number.isFinite(t) && t >= now - GAMEDAY_BACK && t <= now + GAMEDAY_AHEAD;
  });
  if (today.length < GAMEDAY_MIN) return null;
  const stateRank = { in: 0, pre: 1, post: 2 };
  const bestRank = (g) => Math.min(rankOf(g.home) || 99, rankOf(g.away) || 99);
  const top25 = today
    .filter((g) => rankOf(g.home) || rankOf(g.away))
    .sort((x, y) => (stateRank[(x.status && x.status.state) || 'pre'] - stateRank[(y.status && y.status.state) || 'pre'])
      || (bestRank(x) - bestRank(y)) || (Date.parse(x.date) - Date.parse(y.date)));
  const upsets = today.map((g) => ({ g, u: upsetOf(g) })).filter((x) => x.u);
  return {
    gamesToday: today.length,
    live: today.filter((g) => g.status && g.status.state === 'in').length,
    top25: top25.slice(0, SPOTLIGHT_GAMES).map((g) => slimGame(g, DEFAULT_SPORT)),
    top25Count: top25.length,
    upsets: upsets.map(({ g, u }) => ({ ...slimGame(g, DEFAULT_SPORT), upset: u })),
  };
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
    spotlight: key === DEFAULT_SPORT ? gameDaySpotlight(games, now) : null,
    games: ranked.slice(0, GAMES_PER_LEAGUE).map((x) => slimGame(x.g, key)),
    events: [],
    // Every live game with its drama score, for the cross-league list.
    liveGames: ranked
      .filter((x) => x.g.status && x.g.status.state === 'in')
      .map((x) => ({ score: x.score, game: slimGame(x.g, key) })),
  };
}

async function leagueHeadlines(key, { ds, news, perLeague = HEADLINES_PER_LEAGUE }) {
  try {
    const items = key === DEFAULT_SPORT ? await news.getNews() : await ds.getNews({ sport: key });
    return (items || []).slice(0, perLeague).map((i) => ({ ...i, sport: key }));
  } catch (err) {
    return [];
  }
}

// Takes headlines round-robin from each league (newest first within each),
// so one busy league can't push the rest off the page.
function mixHeadlines(lists, max = MAX_HEADLINES) {
  const out = [];
  const seen = new Set();
  const queues = lists.map((l) => l.slice().sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)));
  while (out.length < max && queues.some((q) => q.length)) {
    queues.forEach((q) => {
      const item = q.shift();
      if (!item || out.length >= max) return;
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
    .map(({ liveGames, spotlight, ...l }) => l)
    .sort((a, b) => (b.inSeason - a.inSeason)
      || ((b.counts.live > 0) - (a.counts.live > 0))
      || (order.get(a.key) - order.get(b.key)));

  const inSeason = sorted.filter((l) => l.inSeason).map((l) => l.key);
  const headlineSports = inSeason.length ? inSeason : [DEFAULT_SPORT];
  const headlines = mixHeadlines(await Promise.all(headlineSports.map((k) => leagueHeadlines(k, { ds, news }))));

  const cfb = leagues.find((l) => l.key === DEFAULT_SPORT);
  return {
    generatedAt: new Date(now).toISOString(),
    spotlight: (cfb && cfb.spotlight) || null,
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

// The News page's "All sports" view: more headlines from every league
// (college football first), mixed round-robin so no one sport crowds the
// rest out, skipping anything older than a week.
const ALL_NEWS_PER_LEAGUE = 10;
const ALL_NEWS_MAX = 80;
const WEEK = 7 * 24 * 60 * 60 * 1000;
async function allHeadlines({ now = Date.now(), ds = realDs, news = realNews } = {}) {
  const keys = Object.values(SPORTS).map((s) => s.key);
  const lists = await Promise.all(keys.map((k) => leagueHeadlines(k, { ds, news, perLeague: ALL_NEWS_PER_LEAGUE })));
  const fresh = lists.map((l) => l.filter((i) => !i.pubDate || !Date.parse(i.pubDate) || now - Date.parse(i.pubDate) < WEEK));
  return mixHeadlines(fresh, ALL_NEWS_MAX);
}

module.exports = { allHeadlines, gameDaySpotlight, upsetOf, buildHome, parseTeams, gameScore, liveDrama, mixHeadlines };
