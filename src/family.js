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
const GamedayCore = require('../public/js/gameday-core.js');
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

  -- Watch party chat: messages league members post on a game's page.
  CREATE TABLE IF NOT EXISTS league_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS league_chat_game ON league_chat (league_id, game, id);
`);

const KEYS = ['players', 'picks', 'stickers', 'brackets', 'xp', 'cards'];
const MAX_PLAYERS = 12;
const MAX_PICKS = 1500; // per player
const MAX_BRACKET_PICKS = 300; // per player
const MAX_STICKERS = 500; // per player, same as the browser
const MAX_LEAGUES = 10; // per account
const MAX_MEMBERS = 40; // per league
const MAX_CARDS = 300; // per player
const MAX_XP_LOG = 200; // per player, same as the browser
const MAX_AWARD = 100; // XP for one thing

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
  if (raw.result && typeof raw.result === 'object') {
    result = { winnerId: safeId(raw.result.winnerId) };
    const sc = raw.result.scores;
    if (sc && typeof sc === 'object' && away && home) {
      const a = Number(sc[away.id]);
      const h = Number(sc[home.id]);
      if (Number.isInteger(a) && Number.isInteger(h) && a >= 0 && h >= 0 && a < 1000 && h < 1000) result.scores = { [away.id]: a, [home.id]: h };
    }
  }
  // Against the spread: the home line when picked, in half points.
  const spreadNum = Number(raw.spread);
  const spread = raw.spread !== null && raw.spread !== undefined && Number.isFinite(spreadNum) && Math.abs(spreadNum) <= 80
    ? Math.round(spreadNum * 2) / 2 : null;
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
    ...(spread !== null ? { spread } : {}),
    ...(cleanGuess(raw.guess) ? { guess: cleanGuess(raw.guess) } : {}),
  };
}

// A final-score guess: { away, home }, whole numbers.
function cleanGuess(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = Number(raw.away);
  const h = Number(raw.home);
  if (!Number.isInteger(a) || !Number.isInteger(h) || a < 0 || h < 0 || a > 300 || h > 300) return null;
  return { away: a, home: h };
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

// XP: { [playerId]: { total, log: [{ key, points, reason, at, game }],
// streak: { last, days, best }, outfit } }. Points are capped per award;
// the browser can't hand itself a big number in one go.
function cleanXpRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set();
  const log = (Array.isArray(raw.log) ? raw.log : []).map((l) => {
    const key = l && text(l.key, 120);
    const points = Number(l && l.points);
    if (!key || seen.has(key) || !Number.isInteger(points) || points <= 0 || points > MAX_AWARD) return null;
    seen.add(key);
    const at = Number(l.at);
    return {
      key, points,
      reason: text(l.reason, 80) || '',
      at: Number.isFinite(at) && at > 0 ? at : Date.now(),
      game: typeof l.game === 'string' && /^[a-z0-9]{2,10}:[A-Za-z0-9_-]{1,40}$/.test(l.game) ? l.game : null,
    };
  }).filter(Boolean).slice(-MAX_XP_LOG);
  const total = Number(raw.total);
  const logSum = log.reduce((s, l) => s + l.points, 0);
  const st = raw.streak && typeof raw.streak === 'object' ? raw.streak : null;
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const int = (v, max) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : 0);
  return {
    total: Number.isInteger(total) && total >= logSum && total < 10000000 ? total : logSum,
    log,
    streak: st && day(st.last) ? { last: day(st.last), days: int(st.days, 10000), best: int(st.best, 10000) } : null,
    outfit: typeof raw.outfit === 'string' && GamedayCore.OUTFITS.some((o) => o.key === raw.outfit) ? raw.outfit : null,
  };
}

function cleanXpMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, MAX_PLAYERS + 1).forEach(([playerId, rec]) => {
    const pid = safeId(playerId);
    const clean = pid && cleanXpRecord(rec);
    if (clean) out[pid] = clean;
  });
  return out;
}

// Union of two records' logs. The total grows by the awards the stored
// copy hasn't seen, so two devices earning at once both count.
function mergeXpRecord(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  const known = new Set(stored.log.map((l) => l.key));
  const fresh = incoming.log.filter((l) => !known.has(l.key));
  const log = [...stored.log, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_XP_LOG);
  const later = (a, b) => (!a ? b : !b ? a : a.last >= b.last ? a : b);
  return {
    total: stored.total + fresh.reduce((s, l) => s + l.points, 0),
    log,
    streak: later(stored.streak, incoming.streak),
    outfit: incoming.outfit || stored.outfit || null,
  };
}

function mergeXpMaps(stored, incoming, keepPlayers) {
  const out = {};
  const players = keepPlayers || [...new Set([...Object.keys(stored), ...Object.keys(incoming)])];
  players.forEach((pid) => {
    const m = mergeXpRecord(stored[pid] || null, incoming[pid] || null);
    if (m) out[pid] = m;
  });
  return out;
}

const RARITIES = Object.keys(GamedayCore.RARITY);
function cleanCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sport = sportKey(raw.sport);
  const gameId = safeId(raw.gameId);
  const name = text(raw.name, 80);
  if (!sport || !gameId || !name) return null;
  const athleteId = safeId(raw.athleteId);
  const at = Number(raw.at);
  return {
    id: `${sport}:${gameId}:${athleteId || name}`.slice(0, 160),
    sport, gameId, athleteId, name,
    headshot: safeHttpUrl(raw.headshot),
    position: text(raw.position, 10),
    stat: text(raw.stat, 40),
    line: text(raw.line, 80),
    team: text(raw.team, 80),
    teamId: safeId(raw.teamId),
    teamLogo: safeHttpUrl(raw.teamLogo),
    color: color(raw.color),
    opponent: text(raw.opponent, 80),
    date: isoDate(raw.date),
    rarity: RARITIES.includes(raw.rarity) ? raw.rarity : 'common',
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

function cleanCardMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, MAX_PLAYERS + 1).forEach(([owner, list]) => {
    const id = safeId(owner);
    if (!id || !Array.isArray(list)) return;
    out[id] = list.map(cleanCard).filter(Boolean).slice(-MAX_CARDS);
  });
  return out;
}

function mergeCardMaps(stored, incoming, keepOwners) {
  const out = {};
  const owners = keepOwners || [...new Set([...Object.keys(stored), ...Object.keys(incoming)])];
  owners.forEach((owner) => {
    const seen = new Set();
    const list = [...(stored[owner] || []), ...(incoming[owner] || [])].filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    out[owner] = list.slice(-MAX_CARDS);
  });
  return out;
}

const CLEAN = {
  players: cleanPlayers,
  picks: (raw) => cleanPickMap(raw, cleanPick, MAX_PICKS),
  brackets: (raw) => cleanPickMap(raw, cleanBracketPick, MAX_BRACKET_PICKS),
  stickers: cleanStickerMap,
  xp: cleanXpMap,
  cards: cleanCardMap,
};

const EMPTY = { players: () => [], picks: () => ({}), stickers: () => ({}), brackets: () => ({}), xp: () => ({}), cards: () => ({}) };

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
  if (key === 'xp') return writeKey(userId, key, mergeXpMaps(stored, incoming, Object.keys(incoming)));
  if (key === 'cards') return writeKey(userId, key, mergeCardMaps(stored, incoming, Object.keys(incoming)));
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
  writeKey(userId, 'xp', mergeXpMaps(stored.xp, CLEAN.xp(local.xp)));
  writeKey(userId, 'cards', mergeCardMaps(stored.cards, CLEAN.cards(local.cards)));
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

  // Closest final-score guess in the league for each finished game.
  const closest = new Map();
  gameIds.forEach((gid) => {
    const game = games.get(gid);
    const res = game && KidsCore.gameResult(game);
    if (!res || !game.away || !game.home) return;
    const start = Date.parse(game.date);
    const entries = [];
    everyone.forEach(({ player, data }) => {
      const p = (data.picks[player.id] || {})[`${group.sport}:${gid}`];
      if (p && p.guess && p.pickedAt && Number.isFinite(start) && p.pickedAt < start) entries.push({ id: player.id, guess: p.guess });
    });
    const best = GamedayCore.closestGuesses(entries, { away: game.away.score, home: game.home.score });
    best.ids.forEach((id) => closest.set(id, (closest.get(id) || 0) + 1));
  });

  const rows = everyone.map(({ user, player, data }) => {
    const stats = { right: 0, wrong: 0, pending: 0, total: 0, late: 0, closest: closest.get(player.id) || 0 };
    Object.values(data.picks[player.id] || {}).filter(inWeek).forEach((p) => {
      const game = games.get(String(p.gameId));
      const start = Date.parse((game && game.date) || p.date);
      if (!p.pickedAt || !Number.isFinite(start) || p.pickedAt >= start) { stats.late += 1; return; }
      stats.total += 1;
      // Spread picks are scored on ESPN's line for the game when it has
      // one, not on whatever line the browser saved.
      const espnSpread = game && game.odds && Number.isFinite(Number(game.odds.homeSpread)) ? Number(game.odds.homeSpread) : null;
      const scored = p.spread !== undefined && p.spread !== null && espnSpread !== null ? { ...p, spread: espnSpread } : p;
      const outcome = KidsCore.pickOutcome({ ...scored, result: KidsCore.gameResult(game) });
      if (outcome === 'right') stats.right += 1;
      else if (outcome === 'wrong') stats.wrong += 1;
      else if (outcome === 'pending') stats.pending += 1;
    });
    return { userId: user.id, member: memberName(user), playerId: player.id, name: player.name, emoji: player.emoji, ...stats };
  });
  rows.sort((a, b) => b.right - a.right || a.wrong - b.wrong || b.closest - a.closest || String(a.name).localeCompare(String(b.name)));
  return {
    week: { key: group.key, label: group.label, sport: group.sport },
    weeks: weekList.map((g) => ({ key: g.key, label: g.label, sport: g.sport })),
    rows,
  };
}

// XP standings for a league: everyone's level and total, XP since `since`
// (the start of this week) and, with `game` ("cfb:401..."), XP earned
// during that game (bingo, play calls, score guesses).
function xpStandings(leagueId, { since, game } = {}) {
  const rows = leaguePlayers(leagueId).map(({ user, player, data }) => {
    const rec = (data.xp || {})[player.id] || { total: 0, log: [] };
    const lv = GamedayCore.levelFor(rec.total);
    return {
      userId: user.id,
      member: memberName(user),
      playerId: player.id,
      name: player.name,
      emoji: player.emoji,
      total: rec.total || 0,
      level: lv.level,
      outfit: rec.outfit || null,
      streak: (rec.streak && rec.streak.days) || 0,
      week: Number.isFinite(since) ? GamedayCore.xpSince(rec, since) : 0,
      game: game ? GamedayCore.xpForGame(rec, game) : 0,
    };
  });
  const by = game ? 'game' : 'week';
  rows.sort((a, b) => b[by] - a[by] || b.total - a.total || String(a.name).localeCompare(String(b.name)));
  return { rows };
}

// ---- Watch party chat ----------------------------------------------------------

const CHAT_KEEP = 300; // newest messages kept per league and game
const CHAT_MAX_LEN = 280;
const CHAT_REACTIONS = ['🎉', '😱', '🔥', '👏', '😭', '🙌', '😂', '🦝'];

function chatGameKey(value) {
  return typeof value === 'string' && /^[a-z0-9]{2,10}:[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
}

// Who a message is from: one of the account's Kids Zone players when the
// browser names one, otherwise the account's own name.
function chatAuthor(user, playerId) {
  const players = readKey(user.id, 'players');
  const player = playerId ? players.find((p) => p.id === playerId) : null;
  if (player) return { name: player.name, emoji: player.emoji };
  return { name: memberName(user), emoji: null };
}

function listChat(leagueId, game, { after = 0, userId } = {}) {
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT id, user_id, name, emoji, body, created_at FROM league_chat
      WHERE league_id = ? AND game = ? AND id > ? ORDER BY id DESC LIMIT 100
    ) ORDER BY id ASC
  `).all(leagueId, game, Number(after) || 0);
  return rows.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji, text: r.body, at: r.created_at, mine: r.user_id === userId }));
}

// Plain text only (the page never renders it as HTML), one line, trimmed.
function postChat(leagueId, game, user, { text: raw, playerId } = {}, now = Date.now()) {
  const body = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, CHAT_MAX_LEN) : '';
  if (!body) return null;
  const who = chatAuthor(user, safeId(playerId));
  const info = db.prepare('INSERT INTO league_chat (league_id, game, user_id, name, emoji, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(leagueId, game, user.id, who.name, who.emoji, body, now);
  db.prepare(`
    DELETE FROM league_chat WHERE league_id = ? AND game = ? AND id <= (
      SELECT id FROM league_chat WHERE league_id = ? AND game = ? ORDER BY id DESC LIMIT 1 OFFSET ?
    )
  `).run(leagueId, game, leagueId, game, CHAT_KEEP);
  return { id: Number(info.lastInsertRowid), name: who.name, emoji: who.emoji, text: body, at: now, mine: true };
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
  xpStandings,
  listChat,
  postChat,
  chatGameKey,
  CHAT_REACTIONS,
  cleanXpMap,
  mergeXpMaps,
  publicLeague,
};
