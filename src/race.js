// Conference title races (college football): who's still alive for each
// conference championship game, who controls their own destiny, and the
// conference games each contender has left.
//
// Built from two things the app already fetches: the conference standings
// (records) and the scoreboard for the rest of the regular season (which
// conference games remain, and who plays whom). Tiebreakers are not
// modeled, so a tie for a title-game spot is reported as "needs
// tiebreakers" rather than guessed.

const ds = require('./datasource');

const MAX_REGULAR_WEEK = 15;

function parseRecord(rec) {
  const m = /^(\d+)-(\d+)/.exec(String(rec || ''));
  return m ? { w: Number(m[1]), l: Number(m[2]) } : null;
}

// Conferences split into divisions send each division separately; their
// title game is the two division winners, so one spot per division.
function spotsFor(name) {
  return /\b(east|west|north|south)\b|division/i.test(String(name || '')) ? 1 : 2;
}

function isIndependent(name) {
  return /independent/i.test(String(name || ''));
}

// One conference (or division). `remaining` is every not-yet-final game,
// as { id, home, away, date } with team ids; only games between two teams
// of this group count.
function computeRace(group, remaining) {
  const spots = spotsFor(group.name);
  const teams = (group.entries || [])
    .map((e) => ({ entry: e, rec: parseRecord(e.conference) }))
    .filter((t) => t.rec && t.entry.team && t.entry.team.id)
    .map((t) => ({ id: String(t.entry.team.id), team: t.entry.team, overall: t.entry.overall, w: t.rec.w, l: t.rec.l }));
  const ids = new Set(teams.map((t) => t.id));
  const games = (remaining || []).filter((g) => ids.has(String(g.home)) && ids.has(String(g.away)));
  const left = new Map(teams.map((t) => [t.id, []]));
  games.forEach((g) => {
    left.get(String(g.home)).push({ id: g.id, opponent: String(g.away), home: true, date: g.date || null });
    left.get(String(g.away)).push({ id: g.id, opponent: String(g.home), home: false, date: g.date || null });
  });
  const byId = new Map(teams.map((t) => [t.id, t]));
  teams.forEach((t) => { t.left = left.get(t.id); t.max = t.w + t.left.length; });

  // With few enough games left, try every outcome; otherwise a quick
  // estimate from best and worst cases.
  const exact = games.length <= EXACT_LIMIT ? exactStatuses(teams, games, spots) : null;
  teams.forEach((t, i) => {
    if (exact) { t.status = exact[i]; return; }
    const others = teams.filter((o) => o !== t);
    // Out: enough teams have already won more than this team possibly can.
    const surelyAhead = others.filter((o) => o.w > t.max).length;
    // In: too few teams can still catch this team's current wins.
    const canCatch = others.filter((o) => o.max >= t.w).length;
    // Own destiny: this team wins out (so its opponents each lose that game).
    const beatenBy = (o) => t.left.filter((g) => g.opponent === o.id).length;
    const reach = others.map((o) => o.max - beatenBy(o));
    const above = reach.filter((r) => r > t.max).length;
    const tied = reach.filter((r) => r === t.max).length;
    let status;
    if (surelyAhead >= spots) status = 'out';
    else if (canCatch < spots) status = 'clinched';
    else if (above + tied < spots) status = 'control';
    else if (above < spots) status = 'tiebreak';
    else status = 'help';
    t.status = status;
  });

  teams.sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w || a.l - b.l);
  const cut = teams[spots - 1];
  return {
    name: group.name,
    abbreviation: group.abbreviation || null,
    spots,
    teams: teams.map((t) => ({
      team: t.team,
      overall: t.overall || null,
      conference: `${t.w}-${t.l}`,
      wins: t.w,
      losses: t.l,
      maxWins: t.max,
      // Games behind the last title-game spot.
      behind: cut && t !== cut ? Math.max(0, ((cut.w - cut.l) - (t.w - t.l)) / 2) : 0,
      status: t.status,
      left: t.left.map((g) => {
        const opp = byId.get(g.opponent);
        return { id: g.id, home: g.home, date: g.date, opponent: opp ? { id: opp.id, name: opp.team.name, abbreviation: opp.team.abbreviation || opp.team.shortName, logo: opp.team.logo || null } : null };
      }),
    })),
  };
}

// Every win/loss combination of the remaining games (2^n of them). For
// each team: clinched if no outcome puts `spots` others level or ahead;
// out if every outcome puts `spots` others strictly ahead; and, across the
// outcomes where it wins all its games, control (always clear), tiebreak
// (never behind, sometimes tied) or help.
const EXACT_LIMIT = 14;
function exactStatuses(teams, games, spots) {
  const index = new Map(teams.map((t, i) => [t.id, i]));
  const g = games.map((x) => [index.get(String(x.home)), index.get(String(x.away))]);
  const n = teams.length;
  const flags = teams.map(() => ({ everAtRisk: false, everSafe: false, outAlways: true, woSeen: false, woBehind: false, woTied: false }));
  const wins = new Array(n);
  for (let mask = 0; mask < (1 << g.length); mask++) {
    // Compared as wins minus losses, so teams with a different number of
    // games left still line up.
    for (let i = 0; i < n; i++) wins[i] = teams[i].w - teams[i].l;
    const wonAll = new Array(n).fill(true);
    for (let k = 0; k < g.length; k++) {
      const [h, a] = g[k];
      const homeWins = (mask >> k) & 1;
      wins[homeWins ? h : a] += 1;
      wins[homeWins ? a : h] -= 1;
      wonAll[homeWins ? a : h] = false;
    }
    for (let i = 0; i < n; i++) {
      let ahead = 0;
      let level = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (wins[j] > wins[i]) ahead++;
        else if (wins[j] === wins[i]) level++;
      }
      const f = flags[i];
      if (ahead + level >= spots) f.everAtRisk = true;
      if (ahead < spots) f.outAlways = false;
      if (wonAll[i]) {
        f.woSeen = true;
        if (ahead >= spots) f.woBehind = true;
        else if (ahead + level >= spots) f.woTied = true;
      }
    }
  }
  return flags.map((f) => {
    if (!f.everAtRisk) return 'clinched';
    if (f.outAlways) return 'out';
    if (f.woSeen && !f.woBehind && !f.woTied) return 'control';
    if (f.woSeen && !f.woBehind) return 'tiebreak';
    return 'help';
  });
}

function remainingFrom(games) {
  return (games || [])
    .filter((g) => g && g.home && g.away && !(g.status && (g.status.completed || g.status.state === 'post')))
    .map((g) => ({ id: g.id, home: String(g.home.id), away: String(g.away.id), date: g.date || null }));
}

async function getRaces({ year, group } = {}) {
  const current = await ds.getScoreboard({ sport: 'cfb', groups: group || 80 });
  const season = year || current.season;
  const postseason = Number(current.seasonType) === 3;
  const week = Number(current.week) || 1;
  const weeks = [];
  if (!postseason) for (let w = week + 1; w <= MAX_REGULAR_WEEK; w++) weeks.push(w);
  const [standings, ...later] = await Promise.all([
    ds.getStandings({ sport: 'cfb', year: season, group: group || 80 }),
    ...weeks.map((w) => ds.getScoreboard({ sport: 'cfb', week: w, year: season, seasontype: 2, groups: group || 80 }).catch(() => ({ games: [] }))),
  ]);
  const remaining = postseason ? [] : [
    ...remainingFrom(current.games),
    ...later.flatMap((sb) => remainingFrom(sb.games)),
  ];
  const races = (standings.conferences || [])
    .filter((c) => !isIndependent(c.name))
    .map((c) => computeRace(c, remaining))
    .filter((r) => r.teams.length);
  return { season, week, postseason, races };
}

module.exports = { getRaces, computeRace, parseRecord, spotsFor };
