// Award races: a Heisman watch and position awards for college football,
// and MVP / offensive / defensive player races for the NFL. Nobody
// publishes these lists as data, so they're built from ESPN's season stat
// leaders: each player's numbers are turned into points (a fantasy-style
// formula per award), with a bonus for playing on a ranked team (college)
// or a winning one (NFL), the way voters lean.
//
// A snapshot of each race is saved once a week, so the page can show who
// moved up or down since last week.

const { db } = require('./db');
const leaders = require('./leaders');
const espn = require('./espn');

db.exec(`
  CREATE TABLE IF NOT EXISTS award_snapshots (
    sport TEXT NOT NULL,
    award TEXT NOT NULL,
    week_key TEXT NOT NULL,
    ranking TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sport, award, week_key)
  );
`);

// ESPN category names vary a little between endpoints and seasons, so each
// stat lists the names it answers to.
const STATS = {
  passYds: ['passingYards'],
  passTd: ['passingTouchdowns', 'passTouchdowns'],
  rushYds: ['rushingYards'],
  rushTd: ['rushingTouchdowns'],
  recYds: ['receivingYards'],
  recTd: ['receivingTouchdowns'],
  sacks: ['sacks'],
  tackles: ['totalTackles', 'tackles'],
  ints: ['interceptions', 'defensiveInterceptions'],
  rating: ['QBRating', 'quarterbackRating', 'passerRating'],
};

const AWARDS = {
  cfb: [
    { key: 'heisman', name: 'Heisman Trophy', blurb: 'The most outstanding player in college football', positions: null,
      score: (s) => s.passYds / 25 + s.passTd * 4 + s.rushYds / 10 + s.rushTd * 6 + s.recYds / 12 + s.recTd * 5 },
    { key: 'obrien', name: "Davey O'Brien Award", blurb: 'The best quarterback', positions: ['QB'],
      score: (s) => s.passYds / 25 + s.passTd * 4 + s.rushYds / 10 + s.rushTd * 6 },
    { key: 'walker', name: 'Doak Walker Award', blurb: 'The best running back', positions: ['RB'],
      score: (s) => s.rushYds / 10 + s.rushTd * 6 + s.recYds / 15 },
    { key: 'biletnikoff', name: 'Biletnikoff Award', blurb: 'The best receiver', positions: ['WR', 'TE'],
      score: (s) => s.recYds / 10 + s.recTd * 6 },
    { key: 'nagurski', name: 'Bronko Nagurski Trophy', blurb: 'The best defensive player', positions: null, defense: true,
      score: (s) => s.tackles * 0.8 + s.sacks * 5 + s.ints * 7 },
  ],
  nfl: [
    { key: 'mvp', name: 'MVP', blurb: 'The most valuable player', positions: null,
      score: (s) => s.passYds / 25 + s.passTd * 4 + s.rushYds / 10 + s.rushTd * 6 + s.recYds / 12 + s.recTd * 5 },
    { key: 'opoy', name: 'Offensive Player of the Year', blurb: 'The best non-QB on offense', positions: ['RB', 'WR', 'TE', 'FB'],
      score: (s) => s.rushYds / 10 + s.rushTd * 6 + s.recYds / 10 + s.recTd * 6 },
    { key: 'dpoy', name: 'Defensive Player of the Year', blurb: 'The best defensive player', positions: null, defense: true,
      score: (s) => s.tackles * 0.6 + s.sacks * 6 + s.ints * 7 },
  ],
};

function num(v) {
  const n = Number(String(v === undefined || v === null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Every player in any leader list, with their stats from each list they
// appear in. { athleteId: { athlete, team, stats: { passYds, ... } } }
function playersFromLeaders(categories) {
  const players = new Map();
  (categories || []).forEach((cat) => {
    const stat = Object.keys(STATS).find((k) => STATS[k].includes(cat.name));
    if (!stat) return;
    (cat.leaders || []).forEach((l) => {
      if (!l.athlete || !l.athlete.id) return;
      const p = players.get(l.athlete.id) || { athlete: l.athlete, team: l.team || null, stats: {} };
      p.stats[stat] = num(l.value);
      if (!p.team && l.team) p.team = l.team;
      players.set(l.athlete.id, p);
    });
  });
  return players;
}

const DEFENSE = new Set(['DE', 'DT', 'DL', 'LB', 'OLB', 'ILB', 'MLB', 'CB', 'S', 'FS', 'SS', 'DB', 'EDGE', 'NT']);

// One race: the top `limit` players by points, with a team bonus.
// teamBonus(teamId) -> points.
function race(award, players, { teamBonus = () => 0, limit = 10 } = {}) {
  const zero = Object.fromEntries(Object.keys(STATS).map((k) => [k, 0]));
  const rows = [];
  players.forEach((p) => {
    const pos = (p.athlete.position || '').toUpperCase();
    if (award.positions && pos && !award.positions.includes(pos)) return;
    if (award.defense && pos && !DEFENSE.has(pos)) return;
    if (!award.defense && pos && DEFENSE.has(pos)) return;
    const stats = { ...zero, ...p.stats };
    const base = award.score(stats);
    if (!(base > 0)) return;
    const bonus = teamBonus(p.team && p.team.id);
    rows.push({ athlete: p.athlete, team: p.team, stats: p.stats, points: Math.round((base + bonus) * 10) / 10, bonus });
  });
  rows.sort((a, b) => b.points - a.points);
  return rows.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}

// "2026-W45": the ISO week, so one snapshot a week.
function weekKey(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function saveSnapshot(sport, award, key, rows) {
  db.prepare(`INSERT OR IGNORE INTO award_snapshots (sport, award, week_key, ranking) VALUES (?, ?, ?, ?)`)
    .run(sport, award, key, JSON.stringify(rows.map((r) => r.athlete.id)));
}

// Last week's order (the newest snapshot before this week), or null.
function previousRanking(sport, award, key) {
  const row = db.prepare('SELECT ranking FROM award_snapshots WHERE sport = ? AND award = ? AND week_key < ? ORDER BY week_key DESC LIMIT 1')
    .get(sport, award, key);
  if (!row) return null;
  try { return JSON.parse(row.ranking); } catch (err) { return null; }
}

// Ranked teams get a bonus in college (No. 1 the most); in the NFL, the
// team's win percentage does.
async function teamBonusFor(sport, deps) {
  if (sport === 'cfb') {
    const ranks = new Map();
    try {
      const data = await deps.getRankings({ sport: 'cfb' });
      const poll = (data.polls || []).find((p) => /cfp|playoff/i.test(`${p.name} ${p.shortName}`))
        || (data.polls || []).find((p) => /\bap\b/i.test(`${p.name} ${p.shortName}`)) || (data.polls || [])[0];
      ((poll && poll.ranks) || []).forEach((r) => { if (r.team && r.team.id) ranks.set(String(r.team.id), Number(r.rank)); });
    } catch (err) { /* no bonus without rankings */ }
    return (teamId) => {
      const r = ranks.get(String(teamId));
      return r ? (26 - r) * 1.2 : 0;
    };
  }
  const pct = new Map();
  try {
    const data = await deps.getStandings({ sport });
    (data.conferences || []).forEach((c) => (c.entries || []).forEach((e) => {
      if (e.team && e.team.id && e.winPercent !== null) pct.set(String(e.team.id), Number(e.winPercent));
    }));
  } catch (err) { /* no bonus without standings */ }
  return (teamId) => {
    const p = pct.get(String(teamId));
    return Number.isFinite(p) ? (p > 1 ? p / 100 : p) * 40 : 0;
  };
}

const realDeps = { getLeaders: leaders.getLeaders, getRankings: espn.getRankings, getStandings: espn.getStandings };

async function getAwards({ sport = 'cfb', now = new Date() } = {}, deps = realDeps) {
  const list = AWARDS[sport];
  if (!list) return null;
  const [data, teamBonus] = await Promise.all([deps.getLeaders({ sport }), teamBonusFor(sport, deps)]);
  const players = playersFromLeaders(data && data.categories);
  const key = weekKey(now);
  return {
    sport,
    week: key,
    awards: list.map((award) => {
      const rows = race(award, players, { teamBonus });
      if (rows.length) saveSnapshot(sport, award.key, key, rows);
      const before = previousRanking(sport, award.key, key);
      return {
        key: award.key,
        name: award.name,
        blurb: award.blurb,
        rows: rows.map((r) => {
          const was = before ? before.indexOf(r.athlete.id) : -1;
          return { ...r, lastWeek: was >= 0 ? was + 1 : null, isNew: !!before && was < 0 };
        }),
      };
    }),
  };
}

module.exports = { AWARDS, STATS, playersFromLeaders, race, weekKey, getAwards };
