// Game alerts: a push notification when a followed team's game starts and
// when it ends, and (opt-in) on every score by a followed team, a close
// finish or a brewing upset in any game of a sport the person follows. Every minute the poller reads the current scoreboard of
// each sport someone follows a team in (one cached ESPN call per sport and
// division), and notifies the followers of any game that changed state.
//
// The alerts_sent table records each alert, so a restart never repeats
// one. To avoid a burst of stale alerts after downtime, a start alert only
// goes out within START_WINDOW_MS of kickoff, and a final alert only for a
// game this server saw live (or already sent the start alert for).

const ds = require('./datasource');
const db = require('./db');
const push = require('./push');
const { getSport } = require('./sports');
const drama = require('./drama');
const KidsCore = require('../public/js/kids-core.js');

const POLL_MS = 60 * 1000;
const START_WINDOW_MS = 45 * 60 * 1000;

const seenLive = new Set();
// Last score seen for each live game, for score alerts.
const lastScores = new Map();

function teamLabel(team) {
  return (team && (team.shortName || team.name || team.abbreviation)) || 'TBD';
}

function gameUrl(sportKey, game) {
  return `/game.html?id=${encodeURIComponent(game.id)}&source=espn&sport=${encodeURIComponent(sportKey)}`;
}

function alertPayload(sportKey, game, kind) {
  const sport = getSport(sportKey);
  const away = game.away || {};
  const home = game.home || {};
  if (kind === 'start') {
    return {
      title: `${teamLabel(away)} at ${teamLabel(home)} has started`,
      body: [sport && sport.label, game.broadcast ? `On ${game.broadcast}` : null].filter(Boolean).join(' · '),
      url: gameUrl(sportKey, game),
      tag: `${sportKey}-${game.id}`,
    };
  }
  const score = (t) => (t.score !== null && t.score !== undefined ? ` ${t.score}` : '');
  return {
    title: `Final: ${teamLabel(away)}${score(away)}, ${teamLabel(home)}${score(home)}`,
    body: (game.status && game.status.detail && game.status.detail !== 'Final') ? game.status.detail : (sport ? sport.label : ''),
    url: gameUrl(sportKey, game),
    tag: `${sportKey}-${game.id}`,
  };
}

// What to shout for a score, from the kids' celebration words
// ("TOUCHDOWN!", "GOAL!", "RUN SCORES!").
function scoreLabel(sportKey, points) {
  return KidsCore.celebrationLabel(sportKey, points);
}

function scorePayload(sportKey, game, team, points) {
  const away = game.away || {};
  const home = game.home || {};
  const line = `${teamLabel(away)} ${away.score}, ${teamLabel(home)} ${home.score}`;
  const when = game.status && (game.status.shortDetail || game.status.detail);
  return {
    title: `${scoreLabel(sportKey, points)} ${teamLabel(team)}`,
    body: [line, when].filter(Boolean).join(' · '),
    url: gameUrl(sportKey, game),
    tag: `${sportKey}-${game.id}-score`,
  };
}

function closePayload(sportKey, game) {
  const away = game.away || {};
  const home = game.home || {};
  return {
    title: `Close one: ${teamLabel(away)} ${away.score}, ${teamLabel(home)} ${home.score}`,
    body: [game.status && (game.status.shortDetail || game.status.detail), game.broadcast ? `On ${game.broadcast}` : null].filter(Boolean).join(' · '),
    url: gameUrl(sportKey, game),
    tag: `${sportKey}-${game.id}-close`,
  };
}

function upsetPayload(sportKey, game, victim) {
  const away = game.away || {};
  const home = game.home || {};
  const rank = victim && victim.curatedRank ? `No. ${victim.curatedRank} ` : '';
  return {
    title: `Upset alert: ${rank}${teamLabel(victim)} is losing`,
    body: [`${teamLabel(away)} ${away.score}, ${teamLabel(home)} ${home.score}`, game.status && game.status.shortDetail, game.broadcast ? `On ${game.broadcast}` : null].filter(Boolean).join(' · '),
    url: gameUrl(sportKey, game),
    tag: `${sportKey}-${game.id}-upset`,
  };
}

async function deliver(sportKey, game, teamIds, kind, payload, send, sent, dedupeKind = kind) {
  if (!db.markAlertSent(sportKey, game.id, dedupeKind)) return;
  const recipients = db.alertRecipients(sportKey, teamIds, kind);
  if (recipients.length) await send(recipients, payload);
  sent.push({ gameId: String(game.id), kind, recipients: recipients.length });
}

// Works out which alerts a scoreboard calls for and sends them. Exposed
// for tests; `send` defaults to web push.
async function checkGames(sportKey, games, followedIds, { now = Date.now(), send = push.sendToSubscriptions } = {}) {
  const sent = [];
  for (const game of games) {
    if (!game || !game.id || !game.status) continue;
    const teamIds = [game.home && game.home.id, game.away && game.away.id].filter(Boolean).map(String);
    const key = `${sportKey}:${game.id}`;
    const state = game.status.state;

    // Close finishes and upsets: any game of a followed sport.
    if (state === 'in') {
      if (drama.isCloseFinish(game, sportKey) && !db.alertSent(sportKey, game.id, 'close')) {
        await deliver(sportKey, game, teamIds, 'close', closePayload(sportKey, game), send, sent);
      }
      const victim = drama.isUpsetBrewing(game, sportKey);
      if (victim && !db.alertSent(sportKey, game.id, 'upset')) {
        await deliver(sportKey, game, teamIds, 'upset', upsetPayload(sportKey, game, victim), send, sent);
      }
    }

    if (!teamIds.some((id) => followedIds.has(id))) continue;

    // Every score by a followed team (not basketball, which scores every
    // few seconds). Only for a score change this server saw happen, so a
    // restart mid-game stays quiet.
    if (state === 'in' && KidsCore.celebratesEveryScore(sportKey)) {
      const before = lastScores.get(key);
      const nowScores = { home: Number(game.home && game.home.score), away: Number(game.away && game.away.score) };
      lastScores.set(key, nowScores);
      if (before) {
        for (const side of ['away', 'home']) {
          const team = game[side];
          const points = nowScores[side] - before[side];
          if (!team || !followedIds.has(String(team.id)) || !(points > 0)) continue;
          const dedupe = `score:${nowScores.away}-${nowScores.home}`;
          await deliver(sportKey, game, [String(team.id)], 'score', scorePayload(sportKey, game, team, points), send, sent, dedupe);
        }
      }
    } else if (state === 'post') {
      lastScores.delete(key);
    }

    let kind = null;
    if (state === 'in') {
      const startedAgo = now - Date.parse(game.date || 0);
      const wasLive = seenLive.has(key);
      seenLive.add(key);
      if (!wasLive && startedAgo < START_WINDOW_MS && !db.alertSent(sportKey, game.id, 'start')) kind = 'start';
    } else if (state === 'post' && (seenLive.has(key) || db.alertSent(sportKey, game.id, 'start'))) {
      seenLive.delete(key);
      if (!db.alertSent(sportKey, game.id, 'end')) kind = 'end';
    }
    if (!kind) continue;
    await deliver(sportKey, game, teamIds, kind, alertPayload(sportKey, game, kind), send, sent);
  }
  return sent;
}

// CFB FCS teams live in a second division (groups=81), so poll every
// division a sport has. Unused divisions just return games nobody follows.
async function pollOnce(opts = {}) {
  const bySport = db.followedTeamsBySport();
  for (const [sportKey, teamIds] of bySport) {
    const sport = getSport(sportKey);
    if (!sport || sport.teams === false) continue;
    const groups = sport.groups && sport.groups.length ? sport.groups.map((g) => g.value) : [undefined];
    for (const group of groups) {
      try {
        const board = await ds.getScoreboard({ sport: sportKey, groups: group });
        await checkGames(sportKey, board.games || [], teamIds, opts);
      } catch (err) {
        console.warn(`[alerts] ${sportKey} scoreboard failed:`, err.message);
      }
    }
  }
}

function start({ logger = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce();
    } catch (err) {
      logger.warn('[alerts] poll failed:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, POLL_MS);
  timer.unref();
  setTimeout(tick, 5000).unref();
  return () => clearInterval(timer);
}

module.exports = { start, pollOnce, checkGames, alertPayload, seenLive, lastScores, START_WINDOW_MS };
