// Scorecards: one compact, ready-to-draw snapshot per followed team (or per
// UFC card / NASCAR race), built for the Home Assistant integration in
// custom_components/sports_tracker. Home Assistant polls these every few
// seconds while a game is live, so everything here leans on the same
// cached ESPN calls the website uses.
//
// The shape is deliberately flat and sport-agnostic:
//   state     'PRE' | 'IN' | 'POST' | 'NOT_FOUND'
//   team      the followed team (always drawn on the left)
//   opponent  the other team
//   event     date, venue, TV, clock, period
//   field     football only: ball and first-down line as 0-100 positions,
//             measured from the followed team's own goal line
//   bases     baseball only: count, outs and runners
//   stat      one head-to-head stat for a comparison bar (shots on goal,
//             total yards, field goal %, hits)

const ds = require('./datasource');
const { safeHttpUrl } = require('./security');

// A finished game stays on the scorecard this long after it started, like
// a scoreboard that's still lit up after the final whistle.
const SHOW_FINAL_FOR_MS = 20 * 60 * 60 * 1000;
// How close to kickoff we start asking ESPN for the live game summary.
const ENRICH_BEFORE_MS = 3 * 60 * 60 * 1000;

// The head-to-head stat shown as a bar, per sport. First match wins;
// matched against ESPN's boxscore stat labels/names, case-insensitively.
const COMPARE_STATS = {
  cfb: [['total yards', 'Total Yards']],
  nfl: [['total yards', 'Total Yards']],
  nba: [['field goal %', 'Field Goal %'], ['fg%', 'Field Goal %']],
  mcbb: [['field goal %', 'Field Goal %'], ['fg%', 'Field Goal %']],
  mlb: [['hits', 'Hits']],
  nhl: [['shots', 'Shots on Goal'], ['shotstotal', 'Shots on Goal'], ['sog', 'Shots on Goal']],
};

function upper(state) {
  if (state === 'in') return 'IN';
  if (state === 'post') return 'POST';
  if (state === 'pre') return 'PRE';
  return 'NOT_FOUND';
}

function time(game) {
  const t = Date.parse(game && game.date);
  return Number.isNaN(t) ? null : t;
}

// Picks the one game a scorecard should show: a live game first, then a
// game that just ended, then the next game, then the last one played.
function pickGame(games, now = Date.now()) {
  const list = (games || []).filter((g) => g && g.status).slice().sort((a, b) => (time(a) || 0) - (time(b) || 0));
  if (!list.length) return null;
  const live = list.find((g) => g.status.state === 'in');
  if (live) return live;
  const finished = list.filter((g) => g.status.state === 'post' || g.status.completed);
  const lastFinal = finished[finished.length - 1];
  if (lastFinal && time(lastFinal) !== null && now - time(lastFinal) < SHOW_FINAL_FOR_MS) return lastFinal;
  const next = list.find((g) => g.status.state === 'pre' && !g.status.completed);
  if (next) return next;
  return lastFinal || list[list.length - 1];
}

function side(c, sportKey) {
  if (!c) return null;
  const rank = c.curatedRank || c.rank || null;
  return {
    id: c.id != null ? String(c.id) : null,
    name: c.name || null,
    shortName: c.shortName || c.abbreviation || null,
    abbreviation: c.abbreviation || null,
    logo: safeHttpUrl(c.logo) || null,
    color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : null,
    record: c.record || (c.records && c.records[0] && c.records[0].summary) || null,
    rank: sportKey === 'cfb' || sportKey === 'mcbb' ? rank : null,
    score: c.score === undefined ? null : c.score,
    homeAway: c.homeAway || null,
    winner: !!c.winner,
    linescores: Array.isArray(c.linescores) ? c.linescores : [],
  };
}

// "SMU 35" -> where the ball is, in yards from the possessing team's own
// goal line. ESPN's possessionText names the side of the field, which is
// unambiguous; the raw yardLine is only the fallback.
function yardsFromOwnGoal(situation, possessor) {
  const text = situation.possessionText || '';
  const m = /^([A-Za-z&.'\- ]+?)\s+(\d{1,2})$/.exec(text.trim());
  if (m && possessor) {
    const n = Number(m[2]);
    const sideAbbr = m[1].trim().toUpperCase();
    const own = [possessor.abbreviation, possessor.shortName].filter(Boolean).map((s) => String(s).toUpperCase());
    return own.includes(sideAbbr) ? n : 100 - n;
  }
  if (/^50$/.test(text.trim())) return 50;
  return situation.yardLine;
}

function footballField(situation, team, opponent) {
  if (!situation) return null;
  const poss = situation.possession ? String(situation.possession) : null;
  let possession = null;
  if (poss && team && poss === team.id) possession = 'team';
  else if (poss && opponent && poss === opponent.id) possession = 'opponent';
  const result = {
    possession,
    downDistance: situation.down || null,
    possessionText: situation.possessionText || null,
    isRedZone: !!situation.isRedZone,
    ball: null,
    firstDown: null,
    teamTimeouts: null,
    opponentTimeouts: null,
  };
  if (team && team.homeAway) {
    const teamHome = team.homeAway === 'home';
    result.teamTimeouts = teamHome ? situation.homeTimeouts : situation.awayTimeouts;
    result.opponentTimeouts = teamHome ? situation.awayTimeouts : situation.homeTimeouts;
  }
  if (possession) {
    const possessor = possession === 'team' ? team : opponent;
    const y = yardsFromOwnGoal(situation, possessor);
    if (typeof y === 'number' && !Number.isNaN(y)) {
      // The followed team defends the left goal and attacks to the right.
      result.ball = possession === 'team' ? y : 100 - y;
      if (typeof situation.distance === 'number') {
        const target = Math.min(100, y + situation.distance);
        result.firstDown = possession === 'team' ? target : 100 - target;
      }
    }
  }
  return result;
}

function compareStat(sportKey, boxscore, team, opponent) {
  const wanted = COMPARE_STATS[sportKey];
  if (!wanted || !boxscore || !Array.isArray(boxscore.teams) || !team || !opponent) return null;
  const find = (t) => boxscore.teams.find((b) => b.team && (b.team === t.name || b.team === t.shortName));
  const a = find(team);
  const b = find(opponent);
  if (!a || !b) return null;
  for (const [needle, label] of wanted) {
    const pick = (stats) => (stats || []).find((s) => String(s.name || '').toLowerCase() === needle);
    const sa = pick(a.stats);
    const sb = pick(b.stats);
    if (sa && sb) return { label, team: sa.value, opponent: sb.value };
  }
  return null;
}

function periodLabel(sport, status) {
  if (!status || !status.period || status.state !== 'in') return null;
  const n = status.period;
  if (sport.key === 'mlb') return null; // shortDetail already says "Top 5th"
  return `${sport.periodPrefix || ''}${n}`;
}

function eventInfo(sport, game) {
  const status = game.status || {};
  return {
    id: game.id != null ? String(game.id) : null,
    name: game.name || null,
    shortName: game.shortName || null,
    date: game.date || null,
    venue: game.venue || null,
    broadcast: game.broadcast || null,
    detail: status.detail || null,
    shortDetail: status.shortDetail || null,
    clock: status.clock || null,
    period: status.period || null,
    periodLabel: periodLabel(sport, status),
  };
}

// A team's scorecard. `now` is injectable for tests.
async function teamScorecard(sport, teamId, { now = Date.now() } = {}) {
  const base = {
    kind: 'game',
    sport: sport.key,
    sportLabel: sport.label,
    league: sport.shortLabel,
    updated: new Date(now).toISOString(),
  };
  const [info, schedule] = await Promise.all([
    ds.getTeamInfo(teamId, sport.key).catch(() => null),
    ds.getTeamSchedule(teamId, undefined, sport.key).catch(() => null),
  ]);
  const games = (schedule && schedule.games) || [];
  const game = pickGame(games, now);
  const infoSide = info ? side({ ...info, rank: info.rank }, sport.key) : null;
  if (!game) {
    return { ...base, state: 'NOT_FOUND', team: infoSide || { id: String(teamId) }, opponent: null, event: null };
  }

  const isTeam = (c) => c && String(c.id) === String(teamId);
  let teamRaw = [game.home, game.away].find(isTeam) || game.home;
  let oppRaw = teamRaw === game.home ? game.away : game.home;
  let status = game.status;
  let situation = game.situation;
  let boxscore = null;
  let event = { ...game };

  // Close to game time, the summary has the live clock, score and field
  // position. The team schedule endpoint lags behind during games.
  const start = time(game);
  const near = start !== null && now >= start - ENRICH_BEFORE_MS && now - start < SHOW_FINAL_FOR_MS;
  if (status.state === 'in' || near) {
    const summary = await ds.getGameSummary(game.id, 'espn', sport.key).catch(() => null);
    if (summary && Array.isArray(summary.teams) && summary.teams.length) {
      const sTeam = summary.teams.find(isTeam);
      const sOpp = summary.teams.find((t) => !isTeam(t));
      if (sTeam) teamRaw = { ...teamRaw, ...sTeam, records: teamRaw.records };
      if (sOpp) oppRaw = { ...oppRaw, ...sOpp, records: oppRaw && oppRaw.records };
      if (summary.status) status = summary.status;
      situation = summary.situation || situation;
      boxscore = summary.boxscore;
      event = {
        ...event,
        venue: summary.venue || event.venue,
        broadcast: summary.broadcast || event.broadcast,
        status,
      };
      const plays = summary.playByPlay || [];
      if (plays[0] && situation && !situation.lastPlay) situation = { ...situation, lastPlay: plays[0].text };
    }
  }

  const team = side(teamRaw, sport.key);
  if (team && infoSide) {
    team.logo = team.logo || infoSide.logo;
    team.color = team.color || infoSide.color;
    team.record = team.record || infoSide.record;
  }
  const opponent = side(oppRaw, sport.key);
  const state = upper(status && status.state);
  const live = state === 'IN';

  const card = {
    ...base,
    state,
    team,
    opponent,
    event: eventInfo(sport, event),
    odds: game.odds || null,
    lastPlay: live && situation ? situation.lastPlay || null : null,
    field: live && sport.field ? footballField(situation, team, opponent) : null,
    bases: live && situation && situation.baseball ? situation.baseball : null,
    stat: state !== 'PRE' ? compareStat(sport.key, boxscore, team, opponent) : null,
    nextGame: null,
  };

  // After a final, say when the next one is.
  if (state === 'POST') {
    const next = games
      .filter((g) => g.status && g.status.state === 'pre' && time(g) !== null && time(g) > (start || 0))
      .sort((a, b) => time(a) - time(b))[0];
    if (next) {
      const nextOpp = [next.home, next.away].find((c) => c && !isTeam(c));
      card.nextGame = { date: next.date, opponent: nextOpp ? nextOpp.name : null, homeAway: [next.home, next.away].find(isTeam) ? ([next.home, next.away].find(isTeam).homeAway || null) : null };
    }
  }
  return card;
}

// Picks the UFC card or NASCAR race to show: live, else the next one, else
// the most recent.
function pickEvent(events, now = Date.now()) {
  const list = (events || []).slice().sort((a, b) => (time(a) || 0) - (time(b) || 0));
  if (!list.length) return null;
  const live = list.find((e) => e.status && e.status.state === 'in');
  if (live) return live;
  const finished = list.filter((e) => e.status && e.status.state === 'post');
  const last = finished[finished.length - 1];
  if (last && time(last) !== null && now - time(last) < SHOW_FINAL_FOR_MS) return last;
  return list.find((e) => e.status && e.status.state === 'pre') || last || list[list.length - 1];
}

async function eventScorecard(sport, { now = Date.now() } = {}) {
  const board = await ds.getScoreboard({ sport: sport.key });
  const ev = pickEvent(board.events, now);
  const base = {
    kind: sport.format,
    sport: sport.key,
    sportLabel: sport.label,
    league: sport.shortLabel,
    updated: new Date(now).toISOString(),
  };
  if (!ev) return { ...base, state: 'NOT_FOUND', event: null };
  const state = upper(ev.status && ev.status.state);
  const card = {
    ...base,
    state,
    event: {
      id: ev.id != null ? String(ev.id) : null,
      name: ev.name || null,
      shortName: ev.shortName || null,
      date: ev.date || null,
      venue: ev.venue || null,
      broadcast: ev.broadcast || null,
      detail: (ev.status && ev.status.detail) || null,
      shortDetail: (ev.status && ev.status.shortDetail) || null,
      clock: (ev.status && ev.status.clock) || null,
      period: (ev.status && ev.status.period) || null,
      periodLabel: null,
    },
  };
  if (sport.format === 'race') {
    card.race = {
      lap: state === 'IN' ? (ev.status.period || null) : null,
      totalLaps: ev.totalLaps || null,
      fieldSize: ev.fieldSize || 0,
      leaders: (ev.race || []).slice(0, 10).map((r) => ({
        place: r.place, name: r.name, shortName: r.shortName, number: r.number, winner: !!r.winner,
      })),
    };
  } else {
    const bouts = (ev.bouts || []).map((b) => ({
      weightClass: b.weightClass || null,
      state: upper(b.status && b.status.state),
      round: (b.status && b.status.period) || null,
      clock: (b.status && b.status.clock) || null,
      result: b.result || null,
      fighters: (b.fighters || []).map((f) => ({
        name: f.name, shortName: f.shortName, record: f.record, flag: safeHttpUrl(f.flag) || null, winner: !!f.winner,
      })),
    }));
    // The fight happening now (or next up), shown big on the card.
    const current = bouts.find((b) => b.state === 'IN')
      || bouts.slice().reverse().find((b) => b.state === 'PRE')
      || bouts[0]
      || null;
    card.card = { current, bouts: bouts.slice(0, 12) };
    if (current && current.state === 'IN') {
      card.event.period = current.round;
      card.event.clock = current.clock;
      card.event.periodLabel = current.round ? `R${current.round}` : null;
    }
  }
  return card;
}

module.exports = { teamScorecard, eventScorecard, pickGame, pickEvent, footballField, yardsFromOwnGoal };
