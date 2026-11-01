// Stat leaders and fantasy football numbers.
//
//   Season leaders (the list behind espn.com's "Stat Leaders" pages):
//     https://site.web.api.espn.com/apis/site/v3/sports/{path}/leaders
//   Weekly fantasy scores are computed here from each game's box score
//   (the same /summary endpoint the game page uses), because ESPN doesn't
//   publish fantasy points in its public API.

const fetch = require('node-fetch');
const cache = require('./cache');
const espn = require('./espn');
const { resolveSport } = require('./sports');

const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports';
const LEADERS_ROOT = 'https://site.web.api.espn.com/apis/site/v3/sports';

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

function teamRef(t) {
  if (!t || !t.id) return null;
  return {
    id: String(t.id),
    name: t.displayName || t.name || null,
    abbreviation: t.abbreviation || null,
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || null,
  };
}

// ---- Season stat leaders ---------------------------------------------------

function parseLeaders(json) {
  const raw = (json.leaders && (json.leaders.categories || (Array.isArray(json.leaders) ? json.leaders : null)))
    || json.categories || [];
  return raw
    .map((cat) => ({
      name: cat.name || null,
      label: cat.displayName || cat.shortDisplayName || cat.name || 'Leaders',
      abbreviation: cat.abbreviation || null,
      leaders: (cat.leaders || []).slice(0, 10).map((l, i) => {
        const a = l.athlete || {};
        return {
          rank: i + 1,
          value: l.displayValue || (l.value !== undefined ? String(l.value) : null),
          athlete: a.id ? {
            id: String(a.id),
            name: a.displayName || a.fullName || a.shortName || null,
            position: (a.position && a.position.abbreviation) || null,
            headshot: (a.headshot && (a.headshot.href || a.headshot)) || null,
          } : null,
          team: teamRef(l.team || a.team),
        };
      }).filter((l) => l.athlete),
    }))
    .filter((c) => c.leaders.length);
}

async function getLeaders({ sport, season, seasontype } = {}) {
  const cfg = sportConfig(sport);
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  if (seasontype) params.set('seasontype', seasontype);
  // College leagues need the top division, or ESPN mixes in every level.
  if (cfg.groups) params.set('group', cfg.groups[0].value);
  const key = `espn:${cfg.key}:leaders:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${LEADERS_ROOT}/${cfg.path}/leaders?${params.toString()}`);
    return { categories: parseLeaders(json) };
  }, 30 * 60 * 1000);
}

// ---- Weekly fantasy points ---------------------------------------------------

// Standard scoring used by most leagues. `reception` is what changes
// between PPR (1), half-PPR (0.5) and standard (0).
const SCORING = {
  passYd: 0.04,
  passTd: 4,
  int: -2,
  rushYd: 0.1,
  rushTd: 6,
  recYd: 0.1,
  recTd: 6,
  fumbleLost: -2,
};
const FORMATS = { ppr: 1, half: 0.5, standard: 0 };

function num(v) {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Box score stat lines are positional; `keys` names each column. Older
// responses only have `labels`, so map those too.
const LABEL_KEYS = {
  passing: { 'C/ATT': 'completions/passingAttempts', YDS: 'passingYards', TD: 'passingTouchdowns', INT: 'interceptions' },
  rushing: { CAR: 'rushingAttempts', YDS: 'rushingYards', TD: 'rushingTouchdowns' },
  receiving: { REC: 'receptions', YDS: 'receivingYards', TD: 'receivingTouchdowns', TGTS: 'receivingTargets' },
  fumbles: { FUM: 'fumbles', LOST: 'fumblesLost' },
};

function statMap(group, line) {
  const keys = group.keys || (group.labels || []).map((l) => (LABEL_KEYS[group.name] || {})[l] || l);
  const out = {};
  keys.forEach((k, i) => { out[k] = line[i]; });
  return out;
}

// Reads one game's box score into per-player totals.
function playersFromBoxscore(summary, game) {
  const players = new Map();
  const teams = (summary.boxscore && summary.boxscore.players) || [];
  for (const side of teams) {
    const team = teamRef(side.team);
    for (const group of side.statistics || []) {
      if (!LABEL_KEYS[group.name]) continue;
      for (const row of group.athletes || []) {
        const a = row.athlete || {};
        if (!a.id) continue;
        const id = String(a.id);
        if (!players.has(id)) {
          players.set(id, {
            id,
            name: a.displayName || a.shortName || null,
            position: (a.position && a.position.abbreviation) || null,
            headshot: (a.headshot && (a.headshot.href || a.headshot)) || null,
            team,
            gameId: game.id,
            opponent: null,
            gameState: game.status && game.status.state,
            stats: {},
          });
        }
        Object.assign(players.get(id).stats, statMap(group, row.stats || []));
      }
    }
  }
  for (const p of players.values()) {
    const opp = p.team && [game.home, game.away].find((t) => t && String(t.id) !== p.team.id);
    p.opponent = opp ? (opp.abbreviation || opp.name) : null;
  }
  return [...players.values()];
}

function fantasyLine(stats) {
  const [, att] = String(stats['completions/passingAttempts'] || '0/0').split('/');
  return {
    passAtt: num(att),
    passYds: num(stats.passingYards),
    passTd: num(stats.passingTouchdowns),
    int: num(stats.interceptions),
    rushAtt: num(stats.rushingAttempts),
    rushYds: num(stats.rushingYards),
    rushTd: num(stats.rushingTouchdowns),
    rec: num(stats.receptions),
    targets: num(stats.receivingTargets),
    recYds: num(stats.receivingYards),
    recTd: num(stats.receivingTouchdowns),
    fumblesLost: num(stats.fumblesLost),
  };
}

function fantasyPoints(line, format = 'ppr') {
  const perRec = FORMATS[format] !== undefined ? FORMATS[format] : FORMATS.ppr;
  const pts = line.passYds * SCORING.passYd + line.passTd * SCORING.passTd + line.int * SCORING.int
    + line.rushYds * SCORING.rushYd + line.rushTd * SCORING.rushTd
    + line.rec * perRec + line.recYds * SCORING.recYd + line.recTd * SCORING.recTd
    + line.fumblesLost * SCORING.fumbleLost;
  return Math.round(pts * 10) / 10;
}

// The box score has no positions, so group players by what they mostly
// did: QBs threw, rushers ran more than they caught, receivers caught.
function role(line, position) {
  if (position) {
    if (position === 'QB') return 'QB';
    if (['RB', 'FB'].includes(position)) return 'RB';
    if (['WR', 'TE'].includes(position)) return 'WR/TE';
  }
  if (line.passAtt >= 5) return 'QB';
  if (line.rushAtt > line.rec) return 'RB';
  if (line.rec > 0 || line.targets > 0) return 'WR/TE';
  return 'RB';
}

async function getGameBoxscore(cfg, game) {
  const final = game.status && game.status.completed;
  const key = `espn:${cfg.key}:fantasybox:${game.id}`;
  return cache.getOrFetch(key, async () => fetchJson(`${SITE_ROOT}/${cfg.path}/summary?event=${encodeURIComponent(game.id)}`),
    final ? 6 * 60 * 60 * 1000 : 60 * 1000);
}

// Top fantasy performers for one week, across every game that has
// started. `format` is ppr | half | standard.
async function getWeeklyFantasy({ sport = 'nfl', season, week, seasontype, format = 'ppr' } = {}) {
  const cfg = sportConfig(sport);
  const board = await espn.getScoreboard({ sport: cfg.key, year: season, week, seasontype });
  const started = (board.games || []).filter((g) => g.status && g.status.state && g.status.state !== 'pre');
  const perGame = await Promise.all(started.map(async (game) => {
    try {
      return playersFromBoxscore(await getGameBoxscore(cfg, game), game);
    } catch (err) {
      return [];
    }
  }));
  const players = perGame.flat().map((p) => {
    const line = fantasyLine(p.stats);
    return { ...p, stats: undefined, line, role: role(line, p.position), points: fantasyPoints(line, format) };
  }).filter((p) => p.points !== 0 || p.line.rushAtt || p.line.rec || p.line.passAtt);
  players.sort((a, b) => b.points - a.points);
  return {
    season: board.season || season || null,
    week: board.week || week || null,
    format: FORMATS[format] !== undefined ? format : 'ppr',
    gamesStarted: started.length,
    gamesTotal: (board.games || []).length,
    players: players.slice(0, 150),
  };
}

module.exports = {
  getLeaders, getWeeklyFantasy, parseLeaders, playersFromBoxscore, fantasyLine, fantasyPoints, role, SCORING, FORMATS,
};
