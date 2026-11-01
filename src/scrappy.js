// Scrappy: the site's AI sports guide, a raccoon who knows college football
// and every other sport the app covers. Answers come from Claude, and every
// fact comes from this app's own data (ESPN scores, schedules, rankings,
// standings, stats, TV/radio, news) through the tools below, so answers are
// live rather than whatever the model remembers.
//
// Off unless ANTHROPIC_API_KEY is set. SCRAPPY_MODEL overrides the model.

const ds = require('./datasource');
const news = require('./news');
const radio = require('./radio');
const players = require('./players');
const leaders = require('./leaders');
const { SPORTS, getSport, DEFAULT_SPORT } = require('./sports');
const { isSafeId } = require('./security');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 12; // messages kept from the browser's side of the chat
const MAX_MESSAGE_CHARS = 1000;

const SPORT_KEYS = Object.keys(SPORTS);
const sportProp = {
  type: 'string',
  enum: SPORT_KEYS,
  description: `League key. ${Object.values(SPORTS).map((s) => `${s.key} = ${s.label}`).join(', ')}. Default cfb.`,
};

const TOOLS = [
  {
    name: 'find_team',
    description: 'Look up a team by name, nickname, city or abbreviation (e.g. "Hokies", "Virginia Tech", "VT", "Lakers"). Returns matching team ids for the other tools. Call this first whenever the user names a team.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, sport: sportProp },
      required: ['query'],
    },
  },
  {
    name: 'get_scoreboard',
    description: 'Scores and schedule for a week or day: live, final and upcoming games with status, TV network and betting line. With no week/date, returns the current week (football) or today (other sports). Optionally filter to one team by name.',
    input_schema: {
      type: 'object',
      properties: {
        sport: sportProp,
        week: { type: 'integer', description: 'Football week number.' },
        seasontype: { type: 'integer', description: '2 = regular season, 3 = postseason/bowls/playoffs.' },
        date: { type: 'string', description: 'YYYYMMDD, for day-based sports.' },
        team: { type: 'string', description: 'Only games involving a team whose name contains this text.' },
      },
    },
  },
  {
    name: 'get_team',
    description: "A team's record, ranking, standing summary and full season schedule with results. Set include_stats for season team statistics.",
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'string' },
        sport: sportProp,
        include_stats: { type: 'boolean' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'get_game',
    description: 'One game in detail: score by period, live situation, game leaders, team box score, TV/streaming and radio, odds, win probability, injuries, venue and weather. Get game ids from get_scoreboard or get_team.',
    input_schema: {
      type: 'object',
      properties: { game_id: { type: 'string' }, sport: sportProp },
      required: ['game_id'],
    },
  },
  {
    name: 'get_rankings',
    description: 'Current poll rankings (AP Top 25, Coaches, CFP when published) for college football or college basketball.',
    input_schema: {
      type: 'object',
      properties: {
        sport: { type: 'string', enum: SPORT_KEYS.filter((k) => SPORTS[k].rankings) },
        poll: { type: 'string', description: 'Poll name contains this text, e.g. "AP", "Coaches", "Playoff". Default AP.' },
      },
    },
  },
  {
    name: 'get_standings',
    description: 'Conference/division standings with overall and conference records.',
    input_schema: {
      type: 'object',
      properties: {
        sport: sportProp,
        conference: { type: 'string', description: 'Only conferences whose name contains this text, e.g. "ACC", "SEC", "AFC East".' },
      },
    },
  },
  {
    name: 'get_stat_leaders',
    description: 'Season individual stat leaders for a league (passing, rushing, receiving, points, etc.).',
    input_schema: {
      type: 'object',
      properties: { sport: sportProp },
    },
  },
  {
    name: 'find_player',
    description: "Search a team's roster for a player by name or jersey number. Leave name empty to list the roster.",
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'string' },
        sport: sportProp,
        name: { type: 'string' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'get_player',
    description: "A player's bio, career stats by season and recent game log. Get player ids from find_player or get_stat_leaders.",
    input_schema: {
      type: 'object',
      properties: { player_id: { type: 'string' }, sport: sportProp },
      required: ['player_id'],
    },
  },
  {
    name: 'get_news',
    description: 'Latest headlines for a league, optionally for one team.',
    input_schema: {
      type: 'object',
      properties: { sport: sportProp, team_id: { type: 'string' } },
    },
  },
];

const SYSTEM_PROMPT = `You are Scrappy, the raccoon mascot and sports guru of Stat Scraps, a free sports site. You wear a backwards maroon-and-orange cap and you love college football most of all, but you know every sport on the site: ${Object.values(SPORTS).map((s) => s.label).join(', ')}.

How you answer:
- Use your tools for anything about scores, schedules, kickoff times, TV channels, radio, rankings, standings, records, stats, players or news. Never guess or answer those from memory; the season is in progress and old facts go stale fast. Use find_team first when someone names a team.
- If a tool comes back empty or with an error, say you couldn't find it right now instead of making something up.
- Keep replies short and easy to skim: a few sentences, or a short list. Plain text with simple **bold** and "- " bullets only; no tables, headings or links.
- Give times in US Eastern unless asked otherwise, and say the day.
- Be upbeat, friendly and fun, with a light raccoon flavor (digging through the stat pile, scrapping for scraps). Don't overdo the bits.
- Kids use this site. Keep everything family-friendly. Don't help with sports betting: you can mention a published point spread or over/under as a fact if asked, but never recommend bets.
- Stay on sports. For anything else, politely steer back to sports.
- You are an AI. If asked, say so.`;

// ---- small helpers ----------------------------------------------------------

function sportKey(value) {
  return getSport(String(value || DEFAULT_SPORT)) ? String(value || DEFAULT_SPORT) : DEFAULT_SPORT;
}

function safeId(value, label) {
  const id = String(value || '');
  if (!isSafeId(id)) throw new Error(`invalid ${label}`);
  return id;
}

function contains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

function teamLine(t) {
  if (!t) return null;
  const rank = t.curatedRank || t.rank;
  return {
    id: t.id,
    name: `${rank ? `#${rank} ` : ''}${t.name || t.shortName || ''}`,
    score: t.score !== undefined ? t.score : undefined,
    record: (t.records && t.records[0] && t.records[0].summary) || t.record || undefined,
    winner: t.winner || undefined,
  };
}

function gameLine(g) {
  return {
    id: g.id,
    date: g.date,
    name: g.name || g.shortName,
    status: (g.status && (g.status.detail || g.status.shortDetail)) || null,
    state: g.status && g.status.state,
    away: teamLine(g.away),
    home: teamLine(g.home),
    venue: g.venue || undefined,
    tv: g.broadcast || undefined,
    line: g.odds ? { spread: g.odds.details || g.odds.spread, overUnder: g.odds.overUnder } : undefined,
    lastPlay: (g.situation && g.situation.lastPlay) || undefined,
    downDistance: (g.situation && g.situation.down) || undefined,
  };
}

// Keeps tool results small so a whole season schedule or a full league of
// standings doesn't blow up the prompt.
function clip(value, max = 12000) {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

// ---- tools ------------------------------------------------------------------

const handlers = {
  async find_team({ query, sport }) {
    const key = sportKey(sport);
    const teams = await ds.getTeams({ sport: key });
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { matches: [] };
    const scored = teams
      .map((t) => {
        const name = String(t.name || '').toLowerCase();
        const abbr = String(t.abbreviation || '').toLowerCase();
        let score = 0;
        if (abbr === q || name === q) score = 3;
        else if (name.startsWith(q)) score = 2;
        else if (name.includes(q)) score = 1;
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ t }) => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }));
    return { sport: key, matches: scored };
  },

  async get_scoreboard({ sport, week, seasontype, date, team }) {
    const key = sportKey(sport);
    const cfg = getSport(key);
    const opts = { sport: key };
    if (week) opts.week = Number(week);
    if (seasontype) opts.seasontype = Number(seasontype);
    if (date && /^\d{8}$/.test(String(date))) opts.dates = String(date);
    if (cfg.groups) opts.groups = cfg.groups[0].value;
    const board = await ds.getScoreboard(opts);
    let games = board.games || [];
    if (team) {
      games = games.filter((g) => [g.home, g.away].some((t) => t && (contains(t.name, team) || contains(t.shortName, team) || contains(t.abbreviation, team))));
    }
    // UFC cards and NASCAR races have their own shape; pass them through.
    const list = cfg.format === 'game' ? games.map(gameLine) : games;
    return { sport: key, season: board.season, week: board.week, count: list.length, games: list.slice(0, 60) };
  },

  async get_team({ team_id, sport, include_stats }) {
    const key = sportKey(sport);
    const id = safeId(team_id, 'team_id');
    const [info, schedule, stats] = await Promise.all([
      ds.getTeamInfo(id, key).catch(() => null),
      ds.getTeamSchedule(id, undefined, key).catch(() => null),
      include_stats ? ds.getTeamStatistics(id, undefined, key).catch(() => null) : null,
    ]);
    if (!info && !schedule) throw new Error('team not found');
    return {
      team: info && { id: info.id, name: info.name, record: info.record, rank: info.rank, standing: info.standingSummary },
      schedule: schedule ? schedule.games.map(gameLine) : [],
      stats: stats ? stats.categories : undefined,
    };
  },

  async get_game({ game_id, sport }) {
    const key = sportKey(sport);
    const id = safeId(game_id, 'game_id');
    const [g, listen] = await Promise.all([
      ds.getGameSummary(id, 'espn', key),
      radio.getGameRadio(id, key).catch(() => null),
    ]);
    return {
      id: g.id,
      date: g.date,
      venue: g.venue,
      status: g.status,
      situation: g.situation,
      teams: (g.teams || []).map((t) => ({ ...teamLine(t), homeAway: t.homeAway, byPeriod: t.linescores })),
      leaders: g.leaders,
      teamStats: g.boxscore && g.boxscore.teams,
      tv: (g.broadcasts || []).map((b) => `${b.network}${b.type && b.type !== 'TV' ? ` (${b.type})` : ''}`),
      streaming: g.streaming,
      radio: listen && {
        national: (listen.national || []).map((s) => s.name),
        teams: (listen.teams || []).map((t) => ({ team: t.name, flagship: t.flagship && t.flagship.station, stations: (t.stations || []).map((s) => s.name) })),
        siriusxm: listen.siriusxm,
      },
      odds: g.odds,
      winProbability: g.winProbability,
      injuries: g.injuries,
      gameInfo: g.gameInfo,
      recentPlays: g.drives ? g.drives.plays : undefined,
    };
  },

  async get_rankings({ sport, poll }) {
    const key = sport && getSport(sport) && getSport(sport).rankings ? sport : DEFAULT_SPORT;
    const data = await ds.getRankings({ sport: key });
    const polls = data.polls || [];
    const want = poll || 'AP';
    const chosen = polls.find((p) => contains(p.name, want) || contains(p.shortName, want)) || polls[0];
    return {
      sport: key,
      week: data.week,
      availablePolls: polls.map((p) => p.name),
      poll: chosen && {
        name: chosen.name,
        ranks: chosen.ranks.map((r) => ({ rank: r.rank, team: r.team && r.team.name, teamId: r.team && r.team.id, record: r.recordSummary, previous: r.previousRank, firstPlaceVotes: r.firstPlaceVotes || undefined })),
        othersReceivingVotes: (chosen.others || []).slice(0, 10).map((o) => o.team && o.team.name),
      },
    };
  },

  async get_standings({ sport, conference }) {
    const key = sportKey(sport);
    if (!getSport(key).standings) return { error: `${getSport(key).label} has no standings` };
    const data = await ds.getStandings({ sport: key });
    let confs = data.conferences || [];
    if (conference) confs = confs.filter((c) => contains(c.name, conference) || contains(c.abbreviation, conference));
    return {
      sport: key,
      conferences: confs.map((c) => ({
        name: c.name,
        teams: c.entries.map((e) => ({ team: e.team.name, id: e.team.id, overall: e.overall, conference: e.conference || undefined, gamesBehind: e.gamesBehind || undefined, streak: e.streak || undefined })),
      })),
    };
  },

  async get_stat_leaders({ sport }) {
    const key = sportKey(sport);
    if (!getSport(key).leaders) return { error: `${getSport(key).label} has no stat leaders` };
    const data = await leaders.getLeaders({ sport: key });
    return {
      sport: key,
      categories: data.categories.map((c) => ({
        category: c.label,
        leaders: c.leaders.slice(0, 5).map((l) => ({ rank: l.rank, player: l.athlete.name, playerId: l.athlete.id, team: l.team && (l.team.name || l.team.abbreviation), value: l.value })),
      })),
    };
  },

  async find_player({ team_id, sport, name }) {
    const key = sportKey(sport);
    const roster = await players.getTeamRoster(safeId(team_id, 'team_id'), key);
    const all = roster.groups.flatMap((g) => g.athletes);
    const q = String(name || '').trim();
    const hits = q ? all.filter((a) => contains(a.name, q) || String(a.jersey) === q.replace('#', '')) : all;
    return {
      coach: roster.coach,
      players: hits.slice(0, q ? 10 : 120).map((a) => ({ id: a.id, name: a.name, jersey: a.jersey, position: a.position, experience: a.experience, injury: a.injury || undefined })),
    };
  },

  async get_player({ player_id, sport }) {
    const key = sportKey(sport);
    const data = await players.getPlayer(safeId(player_id, 'player_id'), key);
    return {
      player: data.player,
      careerStats: data.careerStats.map((c) => ({ category: c.name, labels: c.labels, seasons: c.rows.slice(-3), totals: c.totals })),
      recentGames: { labels: data.gameLog.labels, games: data.gameLog.games.slice(0, 5) },
    };
  },

  async get_news({ sport, team_id }) {
    const key = sportKey(sport);
    const team = team_id ? safeId(team_id, 'team_id') : undefined;
    let items = await ds.getNews({ sport: key, team, limit: 10 }).catch(() => []);
    if (!items.length && key === DEFAULT_SPORT && !team) items = await news.getNews().catch(() => []);
    return { sport: key, headlines: items.slice(0, 10).map((n) => ({ title: n.title, source: n.source, date: n.pubDate, summary: n.summary })) };
  },
};

async function runTool(name, input) {
  const fn = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
  if (!fn) return { content: `Unknown tool ${name}`, isError: true };
  try {
    return { content: clip(await fn(input || {})), isError: false };
  } catch (err) {
    return { content: `Couldn't load that: ${err.message}`, isError: true };
  }
}

// ---- chat -------------------------------------------------------------------

// Browser-supplied history: only plain text turns, alternating, starting and
// ending with the user, each capped in length.
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY);
  // Merge back-to-back turns from the same side.
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  if (!merged.length || merged[merged.length - 1].role !== 'user') return null;
  return merged;
}

function todayLine(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Right now it is ${fmt.format(now)} US Eastern.`;
}

function createScrappy({ env = process.env, client = null, logger = console } = {}) {
  const enabled = Boolean(client || env.ANTHROPIC_API_KEY);
  const model = env.SCRAPPY_MODEL || DEFAULT_MODEL;
  let anthropic = client;
  function getClient() {
    if (!anthropic) {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60 * 1000, maxRetries: 2 });
    }
    return anthropic;
  }

  async function chat(history) {
    const messages = history.map((m) => ({ role: m.role, content: m.content }));
    const system = [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: todayLine() },
    ];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const response = await getClient().beta.messages.create({
        model,
        max_tokens: 4000,
        system,
        tools: TOOLS,
        messages,
        output_config: { effort: 'low' },
        // On a safety decline, the API reruns the request on Anthropic's
        // recommended fallback model instead of returning a refusal.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });

      if (response.stop_reason === 'refusal') {
        return "Whoa, that one's outside my den. Ask me about a team, a game, or some stats!";
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length || round === MAX_TOOL_ROUNDS) {
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return text || "I dug around but came up empty. Try asking another way?";
      }
      messages.push({ role: 'assistant', content: response.content });
      const results = await Promise.all(toolUses.map(async (t) => {
        const r = await runTool(t.name, t.input);
        return { type: 'tool_result', tool_use_id: t.id, content: r.content, is_error: r.isError || undefined };
      }));
      messages.push({ role: 'user', content: results });
    }
    logger.warn('[scrappy] tool loop ended without an answer');
    return "I dug around but came up empty. Try asking another way?";
  }

  return { enabled, model, chat };
}

module.exports = { createScrappy, cleanHistory, runTool, TOOLS, SYSTEM_PROMPT, gameLine };
