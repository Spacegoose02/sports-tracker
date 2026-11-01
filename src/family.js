// Family play saved to accounts: the Kids Zone players, pick'em picks,
// stickers and bracket challenge picks, plus family leagues (a group of
// accounts that share a weekly pick'em leaderboard and bracket standings).
//
// Signed-out visitors keep all of this in their browser (public/js/kids.js).
// On sign-in the browser hands its copy to mergeKidsData() and from then on
// reads and writes the account copy here.
//
// Every pick saved here gets a server-side `pickedAt`. League standings only
// count picks saved before kickoff and score them against ESPN's results,
// never against the result a browser sent, so nobody can pick after the fact.

const crypto = require('crypto');
const { db } = require('./db');
const { isSafeId, safeHttpUrl } = require('./security');
const { getSport } = require('./sports');
const espn = require('./espn');
const KidsCore = require('../public/js/kids-core.js');
const BracketsCore = require('../public/js/brackets-core.js');
const brackets = require('./brackets');

db.exec(`
  -- One JSON value per account and key (players, picks, stickers, brackets).
  CREATE TABLE IF NOT EXISTS kids_data (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS leagues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS league_members (
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (league_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS league_members_user ON league_members (user_id);
`);

const KEYS = ['players', 'picks', 'stickers', 'brackets'];
const MAX_PLAYERS = 12;
const MAX_PICKS = 1500; // per player
const MAX_BRACKET_PICKS = 300; // per player
const MAX_STICKERS = 500; // per player, same as the browser
const MAX_LEAGUES = 10; // per account
const MAX_MEMBERS = 40; // per league

// ---- Cleaning what the browser sends ---------------------------------------

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function safeId(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return isSafeId(s) ? s : null;
}

function color(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function team(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = safeId(raw.id);
  if (!id) return null;
  return { id, name: text(raw.name, 80), logo: safeHttpUrl(raw.logo), color: color(raw.color) };
}

function sportKey(value) {
  const s = getSport(String(value || ''));
  return s && s.teams !== false ? s.key : null;
}

function cleanPlayers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((p) => {
    const id = p && safeId(p.id);
    const name = p && text(p.name, 20);
    if (!id || !name || seen.has(id) || out.length >= MAX_PLAYERS) return;
    seen.add(id);
    out.push({ id, name, emoji: text(p.emoji, 8) || '⭐' });
  });
  return out;
}

function cleanPick(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sport = sportKey(raw.sport);
  const gameId = safeId(raw.gameId);
  const teamId = safeId(raw.teamId);
  if (!sport || !gameId || !teamId) return null;
  const away = team(raw.away);
  const home = team(raw.home);
  const ranks = {};
  [away, home].filter(Boolean).forEach((t) => {
    const r = raw.ranks && Number(raw.ranks[t.id]);
    ranks[t.id] = Number.isInteger(r) && r > 0 && r < 100 ? r : null;
  });
  let result = null;
  if (raw.result && typeof raw.result === 'object') result = { winnerId: safeId(raw.result.winnerId) };
  return {
    sport,
    gameId,
    teamId,
    week: typeof raw.week === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.week) ? raw.week : null,
    date: isoDate(raw.date),
    away,
    home,
    ranks,
    result,
  };
}

function cleanBracketPick(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sport = brackets.SPORTS.includes(raw.sport) ? raw.sport : null;
  const gameId = safeId(raw.gameId);
  const teamId = safeId(raw.teamId);
  const season = Number(raw.season);
  if (!sport || !gameId || !teamId || !Number.isInteger(season) || season < 2000 || season > 2100) return null;
  return {
    sport,
    season,
    gameId,
    teamId,
    round: typeof raw.round === 'string' && /^[a-z0-9]{1,10}$/.test(raw.round) ? raw.round : null,
    date: isoDate(raw.date),
    away: team(raw.away),
    home: team(raw.home),
  };
}

function cleanSticker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sport = sportKey(raw.sport);
  const gameId = safeId(raw.gameId);
  const teamId = safeId(raw.teamId);
  const reason = raw.reason === 'watched' || raw.reason === 'picked' ? raw.reason : null;
  if (!sport || !gameId || !teamId || !reason) return null;
  const at = Number(raw.at);
  return {
    sport, gameId, teamId, reason,
    name: text(raw.name, 80),
    logo: safeHttpUrl(raw.logo),
    color: color(raw.color),
    label: text(raw.label, 80),
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

// { [playerId]: { [`${sport}:${gameId}`]: pick } } through `clean`; keys
// are rebuilt from the pick so a mismatched key can't sneak in.
function cleanPickMap(raw, clean, max) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, MAX_PLAYERS + 1).forEach(([playerId, list]) => {
    const pid = safeId(playerId);
    if (!pid || !list || typeof list !== 'object') return;
    const picks = {};
    Object.values(list).forEach((p) => {
      const c = clean(p);
      if (c) picks[`${c.sport}:${c.gameId}`] = c;
    });
    out[pid] = trimPicks(picks, max);
  });
  return out;
}

// Keeps the newest `max` picks (by game date).
function trimPicks(picks, max) {
  const entries = Object.entries(picks);
  if (entries.length <= max) return picks;
  entries.sort((a, b) => Date.parse(b[1].date || 0) - Date.parse(a[1].date || 0));
  return Object.fromEntries(entries.slice(0, max));
}

function cleanStickerMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, MAX_PLAYERS + 1).forEach(([owner, list]) => {
    const id = safeId(owner);
    if (!id || !Array.isArray(list)) return;
    out[id] = list.map(cleanSticker).filter(Boolean).slice(-MAX_STICKERS);
  });
  return out;
}

const CLEAN = {
  players: cleanPlayers,
  picks: (raw) => cleanPickMap(raw, cleanPick, MAX_PICKS),
  brackets: (raw) => cleanPickMap(raw, cleanBracketPick, MAX_BRACKET_PICKS),
  stickers: cleanStickerMap,
};

const EMPTY = { players: () => [], picks: () => ({}), stickers: () => ({}), brackets: () => ({}) };

// ---- Merging -----------------------------------------------------------------

// Union of two { [player]: { [key]: pick } } maps. `prefer` wins when both
// have the same game. The server stamps pickedAt: a pick keeps its stamp
// while the chosen team stays the same, and gets `now` when it's new or
// changed.
function mergePickMaps(stored, incoming, { prefer, keepPlayers, now }) {
  const out = {};
  const players = keepPlayers || [...new Set([...Object.keys(stored), ...Object.keys(incoming)])];
  players.forEach((pid) => {
    const before = stored[pid] || {};
    const fresh = incoming[pid] || {};
    const merged = { ...before };
    Object.entries(fresh).forEach(([key, pick]) => {
      const old = before[key];
      if (old && prefer === 'stored') return;
      const sameTeam = old && String(old.teamId) === String(pick.teamId);
      merged[key] = { ...pick, pickedAt: sameTeam && old.pickedAt ? old.pickedAt : now };
      // A result the server already saved beats one from the browser.
      if (old && old.result && sameTeam) merged[key].result = old.result;
    });
    out[pid] = merged;
  });
  return out;
}

function mergeStickerMaps(stored, incoming, keepOwners) {
  const out = {};
  const owners = keepOwners || [...new Set([...Object.keys(stored), ...Object.keys(incoming)])];
  owners.forEach((owner) => {
    const seen = new Set();
    const list = [...(stored[owner] || []), ...(incoming[owner] || [])].filter((s) => {
      const k = KidsCore.stickerKey(s);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    out[owner] = list.slice(-MAX_STICKERS);
  });
  return out;
}

// ---- Storage -----------------------------------------------------------------

function readKey(userId, key) {
  const row = db.prepare('SELECT value FROM kids_data WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return EMPTY[key]();
  try { return JSON.parse(row.value); } catch (err) { return EMPTY[key](); }
}

function writeKey(userId, key, value) {
  db.prepare(`
    INSERT INTO kids_data (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, key, JSON.stringify(value));
  return value;
}

function getKidsData(userId) {
  const out = {};
  KEYS.forEach((k) => { out[k] = readKey(userId, k); });
  return out;
}

// One key from a signed-in browser. The browser always sends the whole
// value, so a player (or sticker owner) missing from it was removed; for
// players still there, games are merged so two devices picking different
// games at once both keep their picks.
const saveKidsKey = db.transaction((userId, key, raw, now = Date.now()) => {
  if (!KEYS.includes(key)) throw new Error(`Unknown key ${key}`);
  const incoming = CLEAN[key](raw);
  if (key === 'players') return writeKey(userId, key, incoming);
  const stored = readKey(userId, key);
  if (key === 'stickers') return writeKey(userId, key, mergeStickerMaps(stored, incoming, Object.keys(incoming)));
  const max = key === 'picks' ? MAX_PICKS : MAX_BRACKET_PICKS;
  const merged = mergePickMaps(stored, incoming, { prefer: 'incoming', keepPlayers: Object.keys(incoming), now });
  Object.keys(merged).forEach((pid) => { merged[pid] = trimPicks(merged[pid], max); });
  return writeKey(userId, key, merged);
});

// Everything a browser saved before signing in, added to the account. The
// account wins where both have the same pick.
const mergeKidsData = db.transaction((userId, raw, now = Date.now()) => {
  const local = raw && typeof raw === 'object' ? raw : {};
  const stored = getKidsData(userId);
  const players = cleanPlayers([...stored.players, ...cleanPlayers(local.players)]);
  writeKey(userId, 'players', players);
  writeKey(userId, 'stickers', mergeStickerMaps(stored.stickers, CLEAN.stickers(local.stickers)));
  ['picks', 'brackets'].forEach((key) => {
    const max = key === 'picks' ? MAX_PICKS : MAX_BRACKET_PICKS;
    const merged = mergePickMaps(stored[key], CLEAN[key](local[key]), { prefer: 'stored', now });
    Object.keys(merged).forEach((pid) => { merged[pid] = trimPicks(merged[pid], max); });
    writeKey(userId, key, merged);
  });
  return getKidsData(userId);
});

// ---- Leagues -------------------------------------------------------------------

// No 0/O or 1/I/L, so a code read aloud or off a fridge note works.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function memberName(user) {
  return (user && user.display_name) || `Fan #${user ? user.id : '?'}`;
}

function getLeague(id) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id) || null;
}

function isMember(leagueId, userId) {
  return !!db.prepare('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ?').get(leagueId, userId);
}

function leagueMembers(leagueId) {
  return db.prepare(`
    SELECT u.id, u.display_name FROM league_members m JOIN users u ON u.id = m.user_id
    WHERE m.league_id = ? ORDER BY m.joined_at ASC, m.rowid ASC
  `).all(leagueId);
}

function publicLeague(league, userId) {
  return {
    id: league.id,
    name: league.name,
    code: league.code,
    isOwner: league.owner_id === userId,
    members: leagueMembers(league.id).map((u) => ({ id: u.id, name: memberName(u), isOwner: u.id === league.owner_id })),
  };
}

function listLeagues(userId) {
  return db.prepare(`
    SELECT l.* FROM leagues l JOIN league_members m ON m.league_id = l.id
    WHERE m.user_id = ? ORDER BY m.joined_at ASC
  `).all(userId).map((l) => publicLeague(l, userId));
}

function countLeagues(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM league_members WHERE user_id = ?').get(userId).n;
}

const createLeague = db.transaction((userId, name) => {
  if (countLeagues(userId) >= MAX_LEAGUES) return { error: `You can be in up to ${MAX_LEAGUES} leagues.` };
  let code = newCode();
  while (db.prepare('SELECT 1 FROM leagues WHERE code = ?').get(code)) code = newCode();
  const info = db.prepare('INSERT INTO leagues (name, code, owner_id) VALUES (?, ?, ?)').run(name, code, userId);
  db.prepare('INSERT INTO league_members (league_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, userId);
  return { league: publicLeague(getLeague(info.lastInsertRowid), userId) };
});

const joinLeague = db.transaction((userId, code) => {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const league = clean ? db.prepare('SELECT * FROM leagues WHERE code = ?').get(clean) : null;
  if (!league) return { error: 'No league has that code. Check it and try again.' };
  if (isMember(league.id, userId)) return { league: publicLeague(league, userId) };
  if (countLeagues(userId) >= MAX_LEAGUES) return { error: `You can be in up to ${MAX_LEAGUES} leagues.` };
  if (leagueMembers(league.id).length >= MAX_MEMBERS) return { error: 'That league is full.' };
  db.prepare('INSERT INTO league_members (league_id, user_id) VALUES (?, ?)').run(league.id, userId);
  return { league: publicLeague(league, userId) };
});

// Leaving hands the league to the longest-standing member; the last one
// out deletes it.
const leaveLeague = db.transaction((userId, leagueId) => {
  const league = getLeague(leagueId);
  if (!league || !isMember(leagueId, userId)) return false;
  db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?').run(leagueId, userId);
  const rest = leagueMembers(leagueId);
  if (!rest.length) db.prepare('DELETE FROM leagues WHERE id = ?').run(leagueId);
  else if (league.owner_id === userId) db.prepare('UPDATE leagues SET owner_id = ? WHERE id = ?').run(rest[0].id, leagueId);
  return true;
});

function removeMember(ownerId, leagueId, memberId) {
  const league = getLeague(leagueId);
  if (!league || league.owner_id !== ownerId || memberId === ownerId) return false;
  return db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?').run(leagueId, memberId).changes === 1;
}

function renameLeague(ownerId, leagueId, name) {
  const league = getLeague(leagueId);
  if (!league || league.owner_id !== ownerId) return null;
  db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run(name, leagueId);
  return publicLeague(getLeague(leagueId), ownerId);
}

// A new invite code; the old one stops working.
function resetCode(ownerId, leagueId) {
  const league = getLeague(leagueId);
  if (!league || league.owner_id !== ownerId) return null;
  let code = newCode();
  while (db.prepare('SELECT 1 FROM leagues WHERE code = ?').get(code)) code = newCode();
  db.prepare('UPDATE leagues SET code = ? WHERE id = ?').run(code, leagueId);
  return publicLeague(getLeague(leagueId), ownerId);
}

// ---- League standings ----------------------------------------------------------

// Every player in the league, with their account's saved data:
// [{ user, player, data }]
function leaguePlayers(leagueId) {
  const out = [];
  leagueMembers(leagueId).forEach((u) => {
    const data = getKidsData(u.id);
    data.players.forEach((p) => out.push({ user: u, player: p, data }));
  });
  return out;
}

// Finished-game lookup for one league week: the scoreboards that week
// covers, then the game summary for anything missing (an FCS game picked
// from the FCS view, say). Map gameId -> game.
async function weekGames(group, gameIds, deps) {
  const { getScoreboard, getGameSummary } = deps;
  const games = new Map();
  const add = (sb) => (sb && sb.games || []).forEach((g) => games.set(String(g.id), g));
  try {
    if (group.kind === 'week') {
      add(await getScoreboard({ sport: group.sport, year: group.year, week: group.week, seasontype: group.seasontype }));
    } else {
      const today = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
      const days = group.days.filter((d) => Number(d) <= today + 1);
      (await Promise.all(days.map((d) => getScoreboard({ sport: group.sport, dates: d }).catch(() => null)))).forEach(add);
    }
  } catch (err) { /* fall through to summaries */ }
  const missing = [...gameIds].filter((id) => !games.has(id)).slice(0, 15);
  (await Promise.all(missing.map((id) => getGameSummary(id, group.sport).catch(() => null)))).forEach((g) => {
    if (g && g.id) games.set(String(g.id), g);
  });
  return games;
}

const realDeps = { getScoreboard: espn.getScoreboard, getGameSummary: espn.getGameSummary, getPostseason: brackets.getPostseason };

// Weekly pick'em standings for a league. `weekKey` is a week label as
// KidsCore.weekGroup() makes ("cfb-2026-2-10", "nba-wk-20261026"); with
// none, the latest week anyone in the league has a pick in for `sport`.
async function weeklyLeaderboard(leagueId, { sport, weekKey } = {}, deps = realDeps) {
  const everyone = leaguePlayers(leagueId);
  const weeks = new Map();
  everyone.forEach(({ player, data }) => Object.values(data.picks[player.id] || {}).forEach((p) => {
    const g = KidsCore.weekGroup(p.week);
    if (g && (!sport || g.sport === sport)) weeks.set(g.key, g);
  }));
  const weekList = [...weeks.values()].sort((a, b) => weekOrder(b) - weekOrder(a));
  const group = (weekKey && KidsCore.weekGroup(weekKey)) || weekList[0] || null;
  if (!group) return { week: null, weeks: [], rows: [] };

  const inWeek = (p) => {
    const g = KidsCore.weekGroup(p.week);
    return g && g.key === group.key && p.sport === group.sport;
  };
  const gameIds = new Set();
  everyone.forEach(({ player, data }) => Object.values(data.picks[player.id] || {}).filter(inWeek).forEach((p) => gameIds.add(String(p.gameId))));
  const games = gameIds.size ? await weekGames(group, gameIds, deps) : new Map();

  const rows = everyone.map(({ user, player, data }) => {
    const stats = { right: 0, wrong: 0, pending: 0, total: 0, late: 0 };
    Object.values(data.picks[player.id] || {}).filter(inWeek).forEach((p) => {
      const game = games.get(String(p.gameId));
      const start = Date.parse((game && game.date) || p.date);
      if (!p.pickedAt || !Number.isFinite(start) || p.pickedAt >= start) { stats.late += 1; return; }
      stats.total += 1;
      const outcome = KidsCore.pickOutcome({ ...p, result: KidsCore.gameResult(game) });
      if (outcome === 'right') stats.right += 1;
      else if (outcome === 'wrong') stats.wrong += 1;
      else if (outcome === 'pending') stats.pending += 1;
    });
    return { userId: user.id, member: memberName(user), playerId: player.id, name: player.name, emoji: player.emoji, ...stats };
  });
  rows.sort((a, b) => b.right - a.right || a.wrong - b.wrong || String(a.name).localeCompare(String(b.name)));
  return {
    week: { key: group.key, label: group.label, sport: group.sport },
    weeks: weekList.map((g) => ({ key: g.key, label: g.label, sport: g.sport })),
    rows,
  };
}

function weekOrder(g) {
  if (g.kind === 'week') return g.year * 10000 + g.seasontype * 100 + g.week;
  return Number(g.days[0]);
}

// Bracket challenge standings for a league: points by round, counting only
// picks saved before each game started.
async function bracketStandings(leagueId, { sport, season }, deps = realDeps) {
  const data = await deps.getPostseason({ sport, season });
  const index = BracketsCore.gameIndex(data, sport);
  const everyone = leaguePlayers(leagueId);
  const picksFor = ({ player, data: d }) => Object.fromEntries(Object.entries(d.brackets[player.id] || {})
    .filter(([, p]) => p.sport === sport && p.season === data.season));
  const rows = everyone.map((e) => ({
    userId: e.user.id,
    member: memberName(e.user),
    playerId: e.player.id,
    name: e.player.name,
    emoji: e.player.emoji,
    ...BracketsCore.scorePicks(picksFor(e), index, { strict: true }),
  }));
  rows.sort((a, b) => b.points - a.points || b.right - a.right || b.possible - a.possible || String(a.name).localeCompare(String(b.name)));
  return { sport, season: data.season, rows };
}

module.exports = {
  KEYS,
  getKidsData,
  saveKidsKey,
  mergeKidsData,
  listLeagues,
  getLeague,
  isMember,
  createLeague,
  joinLeague,
  leaveLeague,
  removeMember,
  renameLeague,
  resetCode,
  weeklyLeaderboard,
  bracketStandings,
  publicLeague,
};
