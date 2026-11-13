// College football team stat rankings, strength of schedule and the bowl
// eligibility tracker.
//
// Team stats come from the endpoint behind espn.com's college football
// "Team Stats" pages (undocumented, read defensively):
//
//   https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam
//
// Every FBS team comes back with each stat category twice: splitId "0" is
// the team's own numbers (offense) and "900" is its opponents' (defense).
// Rankings are worked out here, per stat, so "allowed" stats rank lowest
// first.
//
// Strength of schedule and bowl eligibility are built from the season's
// weekly FBS scoreboards (one call per week, cached): each team's games
// played and still to play, and its opponents' records.

const fetch = require('node-fetch');
const cache = require('./cache');
const espn = require('./espn');

const BYTEAM_URL = 'https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam';
const HOUR = 60 * 60 * 1000;
const REGULAR_SEASON_WEEKS = 15;
const BOWL_WINS = 6;

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// The stat tables the Team Stats page offers. `side` is own (offense) or
// opp (what opponents did, i.e. defense); `lower` ranks the smallest first.
// `derive` builds a stat ESPN doesn't send directly.
const STATS = [
  { key: 'scoring', label: 'Scoring offense', unit: 'Points per game', side: 'own', cat: 'passing', name: 'totalPointsPerGame' },
  { key: 'total', label: 'Total offense', unit: 'Yards per game', side: 'own', cat: 'passing', name: 'yardsPerGame' },
  { key: 'passing', label: 'Passing offense', unit: 'Pass yards per game', side: 'own', cat: 'passing', name: 'passingYardsPerGame' },
  { key: 'rushing', label: 'Rushing offense', unit: 'Rush yards per game', side: 'own', cat: 'rushing', name: 'rushingYardsPerGame' },
  { key: 'scoringD', label: 'Scoring defense', unit: 'Points allowed per game', side: 'opp', cat: 'passing', name: 'totalPointsPerGame', lower: true },
  { key: 'totalD', label: 'Total defense', unit: 'Yards allowed per game', side: 'opp', cat: 'passing', name: 'yardsPerGame', lower: true },
  { key: 'passingD', label: 'Pass defense', unit: 'Pass yards allowed per game', side: 'opp', cat: 'passing', name: 'passingYardsPerGame', lower: true },
  { key: 'rushingD', label: 'Run defense', unit: 'Rush yards allowed per game', side: 'opp', cat: 'rushing', name: 'rushingYardsPerGame', lower: true },
  {
    key: 'margin', label: 'Scoring margin', unit: 'Points per game, scored minus allowed', fixed: 1,
    derive: (t) => diff(t.own.passing && t.own.passing.totalPointsPerGame, t.opp.passing && t.opp.passing.totalPointsPerGame),
  },
  { key: 'third', label: 'Third down %', unit: 'Third-down conversion %', side: 'own', cat: 'miscellaneous', name: 'thirdDownConvPct' },
  { key: 'thirdD', label: 'Third down defense', unit: 'Opponent third-down conversion %', side: 'opp', cat: 'miscellaneous', name: 'thirdDownConvPct', lower: true },
  { key: 'sacks', label: 'Sacks', unit: 'Sacks made', side: 'opp', cat: 'passing', name: 'sacks' },
  { key: 'sacksAllowed', label: 'Sacks allowed', unit: 'Sacks allowed', side: 'own', cat: 'passing', name: 'sacks', lower: true },
  {
    key: 'turnovers', label: 'Turnover margin', unit: 'Takeaways minus giveaways',
    derive: (t) => {
      const take = sum(t.opp.passing && t.opp.passing.interceptions, t.own.general && t.own.general.fumblesRecovered);
      const give = sum(t.own.passing && t.own.passing.interceptions, t.opp.general && t.opp.general.fumblesRecovered);
      return take === null || give === null ? null : take - give;
    },
  },
  { key: 'penalties', label: 'Fewest penalty yards', unit: 'Penalty yards', side: 'own', cat: 'miscellaneous', name: 'totalPenaltyYards', lower: true },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function diff(a, b) {
  return num(a) === null || num(b) === null ? null : num(a) - num(b);
}
function sum(a, b) {
  return num(a) === null || num(b) === null ? null : num(a) + num(b);
}

// One team's categories -> { own: { passing: { name: value } }, opp: {...} }.
// A stat name can repeat inside a category (passingYards twice); the first
// one wins.
function splitStats(categories, names) {
  const out = { own: {}, opp: {} };
  (categories || []).forEach((c) => {
    const side = String(c.splitId) === '900' ? 'opp' : 'own';
    const list = names[c.name] || [];
    const values = c.values || c.totals || [];
    const bucket = out[side][c.name] || (out[side][c.name] = {});
    list.forEach((n, i) => {
      if (bucket[n] === undefined && values[i] !== undefined) bucket[n] = num(values[i]);
    });
  });
  return out;
}

function parseByTeam(json) {
  const names = {};
  (json.categories || []).forEach((c) => { names[c.name] = c.names || []; });
  const teams = (json.teams || []).map((t) => {
    const team = t.team || {};
    return {
      team: {
        id: String(team.id),
        name: team.displayName || team.name,
        shortName: team.shortDisplayName || team.abbreviation,
        abbreviation: team.abbreviation,
        logo: (team.logos && team.logos[0] && team.logos[0].href) || team.logo || null,
      },
      games: null,
      ...splitStats(t.categories, names),
    };
  }).filter((t) => t.team.id && t.team.id !== 'undefined');
  teams.forEach((t) => { t.games = (t.own.general && t.own.general.gamesPlayed) || null; });
  const season = json.requestedSeason || json.currentSeason || {};
  return { season: season.year || null, week: (season.type && season.type.week && season.type.week.number) || null, teams };
}

function valueOf(stat, t) {
  if (stat.derive) return stat.derive(t);
  const bucket = t[stat.side] && t[stat.side][stat.cat];
  return bucket ? num(bucket[stat.name]) : null;
}

// Every team's value for every stat, plus its rank (ties share a rank).
function rankTeams(parsed) {
  const tables = STATS.map((stat) => {
    const rows = parsed.teams
      .map((t) => ({ team: t.team, games: t.games, value: valueOf(stat, t) }))
      .filter((r) => r.value !== null)
      .sort((a, b) => (stat.lower ? a.value - b.value : b.value - a.value) || String(a.team.name).localeCompare(String(b.team.name)));
    let lastValue = null;
    let lastRank = 0;
    rows.forEach((r, i) => {
      r.rank = r.value === lastValue ? lastRank : i + 1;
      lastValue = r.value;
      lastRank = r.rank;
    });
    return { key: stat.key, label: stat.label, unit: stat.unit, lower: !!stat.lower, rows };
  });
  return { season: parsed.season, week: parsed.week, stats: tables };
}

async function getTeamStatRankings({ season } = {}) {
  const params = new URLSearchParams({ region: 'us', lang: 'en', contentorigin: 'espn', limit: '500', group: '80', seasontype: '2' });
  if (season) params.set('season', season);
  return cache.getOrFetch(`teamstats:cfb:${params.toString()}`, async () => {
    const json = await fetchJson(`${BYTEAM_URL}?${params.toString()}`);
    return rankTeams(parseByTeam(json));
  }, HOUR);
}

// ---- Season games: strength of schedule and bowl eligibility --------------

// Every FBS regular-season game, week by week. Past weeks barely change, so
// the whole set is cached for an hour.
async function getSeasonGames({ season, scoreboard = espn.getScoreboard } = {}) {
  return cache.getOrFetch(`teamstats:cfb:seasongames:${season || 'current'}`, async () => {
    const weeks = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
    const boards = await Promise.all(weeks.map((week) => scoreboard({ sport: 'cfb', year: season, week, seasontype: 2 }).catch(() => null)));
    const seen = new Set();
    const games = [];
    boards.forEach((b, i) => (b && b.games || []).forEach((g) => {
      if (!g || seen.has(g.id) || !g.home || !g.away) return;
      seen.add(g.id);
      games.push({ ...g, week: weeks[i] });
    }));
    return games;
  }, HOUR);
}

function blankRecord(team) {
  return { team, wins: 0, losses: 0, played: [], remaining: [] };
}

// Pure: records, opponents played and opponents left for every team that
// appears in the games. Only finished games count toward records.
function buildRecords(games) {
  const byId = new Map();
  const get = (t) => {
    const id = String(t.id);
    if (!byId.has(id)) byId.set(id, blankRecord({ id, name: t.name, shortName: t.shortName, abbreviation: t.abbreviation, logo: t.logo, curatedRank: t.curatedRank || null }));
    const rec = byId.get(id);
    if (t.curatedRank && !rec.team.curatedRank) rec.team.curatedRank = t.curatedRank;
    return rec;
  };
  games.forEach((g) => {
    const home = get(g.home);
    const away = get(g.away);
    const final = g.status && g.status.state === 'post' && g.status.completed !== false;
    if (final) {
      const homeWon = g.home.winner || (!g.away.winner && Number(g.home.score) > Number(g.away.score));
      (homeWon ? home : away).wins += 1;
      (homeWon ? away : home).losses += 1;
      home.played.push({ id: away.team.id, won: !!homeWon });
      away.played.push({ id: home.team.id, won: !homeWon });
    } else if (!(g.status && g.status.state === 'in')) {
      home.remaining.push(away.team.id);
      away.remaining.push(home.team.id);
    }
  });
  return byId;
}

const pct = (r) => (r && r.wins + r.losses ? r.wins / (r.wins + r.losses) : null);

// Strength of schedule: opponents' combined win % (games against the team
// itself left out), and the same for opponents still to play. FBS teams
// only (FCS opponents count as games, not as opponents with records).
function strengthOfSchedule(records, fbsIds) {
  // Opponents' win % with their games against this team taken out.
  const oppPct = (team, games) => {
    let w = 0; let l = 0;
    games.forEach((g) => {
      const o = records.get(g.id);
      if (!o || (fbsIds && !fbsIds.has(g.id))) return;
      const vsUs = o.played.filter((x) => x.id === team.team.id);
      w += o.wins - vsUs.filter((x) => x.won).length;
      l += o.losses - vsUs.filter((x) => !x.won).length;
    });
    return w + l ? w / (w + l) : null;
  };
  const rows = [...records.values()]
    .filter((r) => !fbsIds || fbsIds.has(r.team.id))
    .map((r) => ({
      team: r.team,
      record: `${r.wins}-${r.losses}`,
      sos: oppPct(r, r.played),
      remainingSos: r.remaining.length ? oppPct(r, r.remaining.map((id) => ({ id }))) : null,
      opponents: r.played.length,
      remaining: r.remaining.length,
    }))
    .filter((r) => r.sos !== null)
    .sort((a, b) => b.sos - a.sos);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Bowl eligibility: six wins. "One away" and "still alive" depend on the
// games left; a team that can't get to six even by winning out is out.
function bowlWatch(records, fbsIds, confById) {
  const rows = [...records.values()]
    .filter((r) => !fbsIds || fbsIds.has(r.team.id))
    .map((r) => {
      const left = r.remaining.length;
      const need = Math.max(0, BOWL_WINS - r.wins);
      let status = 'alive';
      if (need === 0) status = 'eligible';
      else if (need > left) status = 'out';
      else if (need === left) status = 'mustWinOut';
      return {
        team: r.team,
        conference: (confById && confById.get(r.team.id)) || null,
        wins: r.wins,
        losses: r.losses,
        left,
        need,
        status,
      };
    });
  const order = { eligible: 0, mustWinOut: 2, alive: 1, out: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || (b.wins - a.wins) || (a.losses - b.losses) || String(a.team.name).localeCompare(String(b.team.name)));
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    counts: { eligible: count('eligible'), alive: count('alive') + count('mustWinOut'), out: count('out') },
  };
}

async function fbsTeams({ season }) {
  const standings = await espn.getStandings({ sport: 'cfb', year: season }).catch(() => null);
  const ids = new Set();
  const conf = new Map();
  ((standings && standings.conferences) || []).forEach((c) => (c.entries || []).forEach((e) => {
    if (e.team && e.team.id) {
      ids.add(String(e.team.id));
      conf.set(String(e.team.id), String(c.name || '').replace(/\s+Conference$/i, ''));
    }
  }));
  return { ids: ids.size ? ids : null, conf };
}

async function getSeasonOutlook({ season } = {}) {
  return cache.getOrFetch(`teamstats:cfb:outlook:${season || 'current'}`, async () => {
    const [games, fbs] = await Promise.all([getSeasonGames({ season }), fbsTeams({ season })]);
    const records = buildRecords(games);
    return {
      season: season || (games[0] && games[0].season) || null,
      sos: strengthOfSchedule(records, fbs.ids),
      bowls: bowlWatch(records, fbs.ids, fbs.conf),
    };
  }, 30 * 60 * 1000);
}

// Bowl games on ESPN's postseason scoreboard (once they're announced).
async function getBowlSchedule({ season } = {}) {
  const board = await espn.getScoreboard({ sport: 'cfb', year: season, seasontype: 3, week: 1 }).catch(() => null);
  return ((board && board.games) || []).map((g) => ({
    id: g.id,
    date: g.date,
    timeValid: g.timeValid,
    name: g.headline || g.name || null,
    venue: g.venue || null,
    broadcast: g.broadcast || null,
    status: g.status,
    home: g.home,
    away: g.away,
  }));
}

module.exports = {
  STATS,
  parseByTeam,
  rankTeams,
  getTeamStatRankings,
  getSeasonGames,
  buildRecords,
  strengthOfSchedule,
  bowlWatch,
  getSeasonOutlook,
  getBowlSchedule,
};
