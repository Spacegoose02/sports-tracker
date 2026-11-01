// Scrappy's daily recap: once a day, at a time each user picks, a short
// morning summary of their followed teams. Last night's results, anything
// live, the next game with kickoff time and TV, and a headline or two.
//
// Scrappy (Claude) writes it when ANTHROPIC_API_KEY is set. Without a key,
// or if the API call fails, a plain recap is built from the same facts, so
// the feature works either way.
//
// The recap goes out as a push notification to the user's devices and is
// saved, so Home Assistant and Den Duty can read it with the account's feed
// key (GET /api/account/recap, and the `recap` field of /api/account/teams).
//
// Opt-in per account (users.recap_enabled), with a local time (recap_time,
// "HH:MM") and time zone (recap_tz, an IANA name such as America/New_York).

const ds = require('./datasource');
const db = require('./db');
const push = require('./push');
const { myTeamsSummary } = require('./calendar');

const DEFAULT_MODEL = 'claude-opus-5-5';
const POLL_MS = 60 * 1000;
// After downtime, a recap still goes out if the server is back within this
// long of the user's chosen time. Later than that, that day is skipped.
const LATE_WINDOW_MIN = 3 * 60;
const RESULT_WINDOW_MS = 36 * 60 * 60 * 1000;
const NEXT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 15 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---- settings ---------------------------------------------------------------

function cleanTime(value) {
  return typeof value === 'string' && TIME_RE.test(value.trim()) ? value.trim() : null;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

// The user's local calendar date ("2026-11-02") and minutes since midnight.
function localParts(now, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).forEach((p) => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Whether a user's recap should go out now: it's at or past their time
// (within the late window) and today's hasn't been written yet.
function isDue(user, lastRecap, now = Date.now()) {
  if (!user.recap_enabled) return false;
  const tz = isValidTimeZone(user.recap_tz) ? user.recap_tz : 'America/New_York';
  const time = cleanTime(user.recap_time) || '07:30';
  const [h, m] = time.split(':').map(Number);
  const target = h * 60 + m;
  const local = localParts(now, tz);
  if (local.minutes < target || local.minutes >= target + LATE_WINDOW_MIN) return false;
  return !lastRecap || lastRecap.date !== local.date;
}

// ---- facts ------------------------------------------------------------------

function teamName(t) {
  return (t && (t.shortName || t.name || t.abbreviation)) || 'TBD';
}

function sides(game, teamId) {
  const home = game.home || {};
  const away = game.away || {};
  const isHome = String(home.id) === String(teamId);
  return { us: isHome ? home : away, them: isHome ? away : home, isHome };
}

function kickoffText(game, timeZone) {
  if (!game.date) return null;
  const d = new Date(game.date);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  if (game.timeValid === false) return `${day}, time TBD`;
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} ${time}`;
}

function numberOrNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
}

// Turns /api/account/teams-style summaries into the small set of facts a
// recap needs. Exposed for tests.
function factsFromSummaries(summaries, { now = Date.now(), timeZone = 'America/New_York', headlines = new Map() } = {}) {
  return summaries.map((s) => {
    const fact = {
      sport: s.sport,
      sportLabel: s.sportLabel,
      id: s.id,
      team: s.name || s.abbreviation || `Team ${s.id}`,
      rank: s.rank || null,
      record: s.record || null,
      standing: s.standingSummary || null,
      result: null,
      live: null,
      next: null,
      headlines: headlines.get(`${s.sport}:${s.id}`) || [],
    };
    const last = s.lastGame;
    if (last && last.date && now - Date.parse(last.date) <= RESULT_WINDOW_MS) {
      const { us, them, isHome } = sides(last, s.id);
      const ours = numberOrNull(us.score);
      const theirs = numberOrNull(them.score);
      fact.result = {
        opponent: teamName(them),
        home: isHome,
        teamScore: ours,
        opponentScore: theirs,
        outcome: ours === null || theirs === null ? null : ours > theirs ? 'W' : ours < theirs ? 'L' : 'T',
        status: (last.status && last.status.detail) || 'Final',
      };
    }
    const live = s.liveGame;
    if (live) {
      const { us, them, isHome } = sides(live, s.id);
      fact.live = {
        opponent: teamName(them),
        home: isHome,
        teamScore: numberOrNull(us.score),
        opponentScore: numberOrNull(them.score),
        status: (live.status && (live.status.shortDetail || live.status.detail)) || 'In progress',
        tv: live.broadcast || null,
      };
    }
    const next = s.nextGame;
    if (next && next.date && Date.parse(next.date) - now <= NEXT_WINDOW_MS) {
      const { them, isHome } = sides(next, s.id);
      fact.next = {
        opponent: teamName(them),
        opponentRank: them.rank || them.curatedRank || null,
        home: isHome,
        when: kickoffText(next, timeZone),
        date: next.date,
        tv: next.broadcast || null,
        venue: next.venue || null,
      };
    }
    return fact;
  });
}

async function teamHeadlines(follows) {
  const map = new Map();
  await Promise.all(follows.map(async (f) => {
    const items = await ds.getNews({ sport: f.sport, team: String(f.id), limit: 3 }).catch(() => []);
    map.set(`${f.sport}:${f.id}`, (items || []).slice(0, 2).map((n) => n.title).filter(Boolean));
  }));
  return map;
}

async function gatherFacts(follows, { now = Date.now(), timeZone } = {}) {
  const [summaries, headlines] = await Promise.all([
    myTeamsSummary(follows, { now, upcoming: 1 }),
    teamHeadlines(follows),
  ]);
  return factsFromSummaries(summaries, { now, timeZone, headlines });
}

// Something worth a notification: a result, a live game, or a game this
// week. In the offseason the recap is still saved but nobody gets buzzed.
function hasNews(facts) {
  return facts.some((f) => f.result || f.live || f.next);
}

// ---- writing ----------------------------------------------------------------

function rankPrefix(rank) {
  return rank ? `#${rank} ` : '';
}

function scoreLine(teamScore, opponentScore) {
  return teamScore !== null && opponentScore !== null ? ` ${teamScore}-${opponentScore}` : '';
}

// The recap without Claude: one line per team with news.
function basicRecap(facts, { displayName } = {}) {
  const lines = [];
  for (const f of facts) {
    const bits = [];
    if (f.result) {
      const verb = f.result.outcome === 'W' ? 'beat' : f.result.outcome === 'L' ? 'lost to' : f.result.outcome === 'T' ? 'tied' : 'played';
      bits.push(`${verb} ${f.result.opponent}${scoreLine(f.result.teamScore, f.result.opponentScore)}`);
    }
    if (f.live) bits.push(`playing ${f.live.opponent} now${scoreLine(f.live.teamScore, f.live.opponentScore)} (${f.live.status})`);
    if (f.next) bits.push(`next: ${f.next.home ? 'vs' : 'at'} ${rankPrefix(f.next.opponentRank)}${f.next.opponent}, ${f.next.when}${f.next.tv ? ` on ${f.next.tv}` : ''}`);
    if (!bits.length) continue;
    lines.push(`${rankPrefix(f.rank)}${f.team}${f.record ? ` (${f.record})` : ''}: ${bits.join('; ')}.`);
  }
  const wins = facts.filter((f) => f.result && f.result.outcome === 'W');
  let headline;
  if (!lines.length) headline = 'Quiet day for your teams';
  else if (wins.length === 1) headline = `${wins[0].team} won!`;
  else if (wins.length > 1) headline = `${wins.length} of your teams won`;
  else headline = "Today's team rundown";
  const hello = displayName ? `Morning, ${displayName}! ` : 'Morning! ';
  const text = lines.length
    ? `${hello}Here's your team rundown.\n${lines.join('\n')}`
    : `${hello}Nothing on the schedule for your teams this week. Scrappy will keep an eye on things.`;
  return { headline, text };
}

const RECAP_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Notification title, at most 60 characters.' },
    recap: { type: 'string', description: 'The recap, plain text, at most 110 words.' },
  },
  required: ['headline', 'recap'],
  additionalProperties: false,
};

const RECAP_PROMPT = `You are Scrappy, the raccoon mascot of Stat Scraps, a free sports site. Each morning you write a fan a short recap of the teams they follow. It arrives as a phone notification, so it has to read well in a few seconds.

Write from the facts you are given and nothing else. Never add scores, players, injuries or storylines that aren't in the facts; the season is in progress and memory goes stale. Kickoff times are already in the fan's own time zone.

- headline: at most 60 characters, the biggest news first (a win, a big game today). No emoji.
- recap: at most 110 words of plain text. No markdown, bullets, headings or links. Lead with results, then anything live or on today, then what's next this week with day, time and TV. Mention a headline only if it matters. Skip teams with nothing going on, or lump them into one short line.
- Upbeat and a little scrappy, but never mean about the fan's teams. A loss gets a short, kind word.
- If nothing is happening for any team, say so in one or two friendly sentences.`;

function createRecapWriter({ env = process.env, client = null, logger = console } = {}) {
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

  // Returns { headline, text, source }: 'scrappy' when Claude wrote it,
  // 'basic' for the plain fallback.
  async function write(facts, { displayName, localDate, timeZone } = {}) {
    const fallback = { ...basicRecap(facts, { displayName }), source: 'basic' };
    if (!enabled) return fallback;
    const withNews = facts.filter((f) => f.result || f.live || f.next || f.headlines.length);
    try {
      const response = await getClient().beta.messages.create({
        model,
        max_tokens: 2000,
        system: [{ type: 'text', text: RECAP_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Fan's name: ${displayName || 'friend'}\nToday: ${localDate} (${timeZone})\nTeams they follow (${facts.length}), as JSON:\n${JSON.stringify(withNews.length ? withNews : facts)}`,
        }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: RECAP_SCHEMA } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (response.stop_reason !== 'end_turn') throw new Error(`stop_reason ${response.stop_reason}`);
      const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const parsed = JSON.parse(raw);
      const headline = String(parsed.headline || '').trim().slice(0, 100);
      const text = String(parsed.recap || '').trim().slice(0, 1500);
      if (!headline || !text) throw new Error('empty recap');
      return { headline, text, source: 'scrappy' };
    } catch (err) {
      logger.warn(`[recap] Scrappy couldn't write it, using the plain recap: ${err.status || ''} ${err.message}`);
      return fallback;
    }
  }

  return { enabled, model, write };
}

// ---- building and sending ---------------------------------------------------

function displayNameOf(user) {
  return user.display_name || (user.email ? user.email.split('@')[0] : null);
}

function notification(recap) {
  const body = recap.text.length > 300 ? `${recap.text.slice(0, 297).replace(/\s+\S*$/, '')}…` : recap.text;
  return { title: recap.headline, body, url: '/account.html#recap', tag: 'daily-recap' };
}

function createRecapper({ env = process.env, client, logger = console, send = push.sendToSubscriptions } = {}) {
  const writer = createRecapWriter({ env, client, logger });
  const failedAt = new Map();

  // Writes and saves a user's recap for today. Returns null when they
  // follow no teams.
  async function build(user, { now = Date.now() } = {}) {
    const follows = db.listFollows(user.id);
    if (!follows.length) return null;
    const timeZone = isValidTimeZone(user.recap_tz) ? user.recap_tz : 'America/New_York';
    const local = localParts(now, timeZone);
    const facts = await gatherFacts(follows, { now, timeZone });
    const written = await writer.write(facts, { displayName: displayNameOf(user), localDate: local.date, timeZone });
    const teams = facts.map((f) => ({
      sport: f.sport, id: f.id, name: f.team, record: f.record, rank: f.rank, result: f.result, live: f.live, next: f.next,
    }));
    const recap = db.saveRecap(user.id, { date: local.date, headline: written.headline, text: written.text, teams, source: written.source });
    return { recap, newsworthy: hasNews(facts) };
  }

  // Builds the recap and pushes it to the user's devices. `force` sends a
  // notification even on a quiet day (the "Send me one now" button).
  async function deliver(user, { now = Date.now(), force = false } = {}) {
    const built = await build(user, { now });
    if (!built) return null;
    let delivered = 0;
    const subs = db.pushSubscriptionsForUser(user.id);
    if (subs.length && (built.newsworthy || force)) delivered = await send(subs, notification(built.recap));
    return { recap: built.recap, delivered };
  }

  async function runDue({ now = Date.now() } = {}) {
    const results = [];
    for (const user of db.recapUsers()) {
      const failed = failedAt.get(user.id);
      if (failed && now - failed < RETRY_AFTER_FAIL_MS) continue;
      if (!isDue(user, db.getRecap(user.id), now)) continue;
      try {
        const out = await deliver(user, { now });
        if (out) results.push({ userId: user.id, delivered: out.delivered });
        failedAt.delete(user.id);
      } catch (err) {
        failedAt.set(user.id, now);
        logger.warn(`[recap] user ${user.id} failed:`, err.message);
      }
    }
    return results;
  }

  function start() {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await runDue();
      } catch (err) {
        logger.warn('[recap] run failed:', err.message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    timer.unref();
    setTimeout(tick, 10 * 1000).unref();
    return () => clearInterval(timer);
  }

  return { scrappy: writer.enabled, build, deliver, runDue, start };
}

// The settings and latest recap as the API returns them.
function recapState(user) {
  return {
    enabled: !!user.recap_enabled,
    time: cleanTime(user.recap_time) || '07:30',
    timeZone: isValidTimeZone(user.recap_tz) ? user.recap_tz : 'America/New_York',
    recap: db.getRecap(user.id),
  };
}

module.exports = {
  createRecapper,
  createRecapWriter,
  basicRecap,
  factsFromSummaries,
  hasNews,
  isDue,
  localParts,
  cleanTime,
  isValidTimeZone,
  recapState,
  notification,
  RECAP_SCHEMA,
};
