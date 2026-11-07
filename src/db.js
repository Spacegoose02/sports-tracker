// SQLite persistence for what has to survive a restart: "Notable Games"
// picks (each account's own, plus the admin's site-wide defaults), user accounts with their followed teams and push
// subscriptions, and which game alerts were already sent. Schedules and
// scores are fetched live and cached in memory, so they never touch disk.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cfb-tracker.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS notable_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'espn',
    label TEXT,
    game_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(season, week, event_id)
  );

  -- Each account's own notable games. notable_games above holds the
  -- admin's site-wide picks, which visitors who aren't signed in see.
  CREATE TABLE IF NOT EXISTS user_notable_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'espn',
    label TEXT,
    game_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, season, week, event_id)
  );
  CREATE INDEX IF NOT EXISTS user_notable_week ON user_notable_games (user_id, season, week);

  -- A user signs in with email + password, with SSO (oidc_sub), or both.
  -- feed_token is the private key in their calendar link and the Den Duty
  -- API; resetting it revokes both.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    display_name TEXT,
    oidc_sub TEXT UNIQUE,
    feed_token TEXT NOT NULL UNIQUE,
    alert_start INTEGER NOT NULL DEFAULT 1,
    alert_end INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_follows (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sport TEXT NOT NULL,
    team_id TEXT NOT NULL,
    name TEXT,
    abbreviation TEXT,
    logo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, sport, team_id)
  );
  CREATE INDEX IF NOT EXISTS user_follows_team ON user_follows (sport, team_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per game alert already sent, so a restart never repeats one.
  CREATE TABLE IF NOT EXISTS alerts_sent (
    sport TEXT NOT NULL,
    game_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sport, game_id, kind)
  );

  -- Scrappy's daily recap: the latest one written for each user, so Home
  -- Assistant and Den Duty can read it, and so a day is never sent twice.
  CREATE TABLE IF NOT EXISTS recaps (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    local_date TEXT NOT NULL,
    headline TEXT NOT NULL,
    body TEXT NOT NULL,
    teams TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'basic',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Admin-edited radio and TV info for one team or one game. These win
  -- over what ESPN reports (see src/overrides.js). tv and radio hold JSON
  -- arrays of names.
  CREATE TABLE IF NOT EXISTS broadcast_overrides (
    sport TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('team', 'game')),
    target_id TEXT NOT NULL,
    label TEXT,
    tv TEXT,
    radio TEXT,
    radio_city TEXT,
    listen_url TEXT,
    watch_name TEXT,
    watch_url TEXT,
    note TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sport, scope, target_id)
  );
`);
db.pragma('foreign_keys = ON');

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
// an existing table alone, so add them to older databases here.
function addColumn(table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('users', 'recap_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'recap_time', "TEXT NOT NULL DEFAULT '07:30'");
addColumn('users', 'recap_tz', "TEXT NOT NULL DEFAULT 'America/New_York'");

function listNotableGames(season, week) {
  return db
    .prepare('SELECT * FROM notable_games WHERE season = ? AND week = ? ORDER BY sort_order ASC, id ASC')
    .all(season, week);
}

function addNotableGame({ season, week, eventId, source, label, gameName, sortOrder }) {
  const stmt = db.prepare(`
    INSERT INTO notable_games (season, week, event_id, source, label, game_name, sort_order)
    VALUES (@season, @week, @eventId, @source, @label, @gameName, @sortOrder)
    ON CONFLICT(season, week, event_id) DO UPDATE SET
      label = excluded.label,
      sort_order = excluded.sort_order,
      game_name = excluded.game_name
  `);
  stmt.run({
    season,
    week,
    eventId,
    source: source || 'espn',
    label: label || null,
    gameName: gameName || null,
    sortOrder: sortOrder || 0,
  });
  return listNotableGames(season, week);
}

function removeNotableGame(id) {
  db.prepare('DELETE FROM notable_games WHERE id = ?').run(id);
}

function reorderNotableGames(season, week, orderedIds) {
  const update = db.prepare('UPDATE notable_games SET sort_order = ? WHERE id = ? AND season = ? AND week = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id, season, week));
  });
  tx(orderedIds);
  return listNotableGames(season, week);
}

// ---- Each account's notable games ----------------------------------------

const MAX_NOTABLE_PER_WEEK = 40;

function listUserNotableGames(userId, season, week) {
  return db
    .prepare('SELECT * FROM user_notable_games WHERE user_id = ? AND season = ? AND week = ? ORDER BY sort_order ASC, id ASC')
    .all(userId, season, week);
}

// Returns the week's list, or null when the week is already full.
function addUserNotableGame(userId, { season, week, eventId, source, label, gameName, sortOrder }) {
  const existing = db.prepare('SELECT id FROM user_notable_games WHERE user_id = ? AND season = ? AND week = ? AND event_id = ?')
    .get(userId, season, week, eventId);
  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM user_notable_games WHERE user_id = ? AND season = ? AND week = ?')
      .get(userId, season, week).n;
    if (count >= MAX_NOTABLE_PER_WEEK) return null;
  }
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM user_notable_games WHERE user_id = ? AND season = ? AND week = ?')
    .get(userId, season, week).n;
  db.prepare(`
    INSERT INTO user_notable_games (user_id, season, week, event_id, source, label, game_name, sort_order)
    VALUES (@userId, @season, @week, @eventId, @source, @label, @gameName, @sortOrder)
    ON CONFLICT(user_id, season, week, event_id) DO UPDATE SET
      label = excluded.label,
      game_name = COALESCE(excluded.game_name, user_notable_games.game_name)
  `).run({
    userId,
    season,
    week,
    eventId,
    source: source || 'espn',
    label: label || null,
    gameName: gameName || null,
    sortOrder: Number.isInteger(sortOrder) ? sortOrder : nextOrder,
  });
  return listUserNotableGames(userId, season, week);
}

function removeUserNotableGame(userId, id) {
  return db.prepare('DELETE FROM user_notable_games WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function reorderUserNotableGames(userId, season, week, orderedIds) {
  const update = db.prepare('UPDATE user_notable_games SET sort_order = ? WHERE id = ? AND user_id = ? AND season = ? AND week = ?');
  db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id, userId, season, week));
  })(orderedIds);
  return listUserNotableGames(userId, season, week);
}

// Copies the admin's site-wide picks into an account (all weeks, or one
// season/week), keeping any picks the account already has. Returns how
// many were added.
function copySiteNotableToUser(userId, { season, week } = {}) {
  const where = [];
  const args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (week) { where.push('week = ?'); args.push(week); }
  const rows = db.prepare(`SELECT * FROM notable_games ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_notable_games (user_id, season, week, event_id, source, label, game_name, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  db.transaction(() => {
    rows.forEach((r) => {
      added += insert.run(userId, r.season, r.week, r.event_id, r.source, r.label, r.game_name, r.sort_order).changes;
    });
  })();
  return added;
}

// ---- Users ---------------------------------------------------------------

const MAX_FOLLOWS = 30;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserByOidcSub(sub) {
  return db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) || null;
}

function getUserByFeedToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return db.prepare('SELECT * FROM users WHERE feed_token = ?').get(token) || null;
}

function createUser({ email, passwordHash, displayName, oidcSub }) {
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, oidc_sub, feed_token)
    VALUES (?, ?, ?, ?, ?)
  `).run(email || null, passwordHash || null, displayName || null, oidcSub || null, newToken());
  return getUser(info.lastInsertRowid);
}

function linkOidc(userId, oidcSub) {
  db.prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run(oidcSub, userId);
  return getUser(userId);
}

function updateUser(userId, fields) {
  const allowed = {
    displayName: 'display_name',
    alertStart: 'alert_start',
    alertEnd: 'alert_end',
    recapEnabled: 'recap_enabled',
    recapTime: 'recap_time',
    recapTz: 'recap_tz',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof fields[key] === 'boolean' ? Number(fields[key]) : fields[key]);
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, userId);
  return getUser(userId);
}

function resetFeedToken(userId) {
  db.prepare('UPDATE users SET feed_token = ? WHERE id = ?').run(newToken(), userId);
  return getUser(userId);
}

// ---- Followed teams --------------------------------------------------------

function listFollows(userId) {
  return db.prepare(`
    SELECT sport, team_id AS id, name, abbreviation, logo FROM user_follows
    WHERE user_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(userId);
}

// Adds a team (or refreshes its name/logo). Returns false when the user is
// already at the follow limit.
function addFollow(userId, team) {
  const exists = db.prepare('SELECT 1 FROM user_follows WHERE user_id = ? AND sport = ? AND team_id = ?')
    .get(userId, team.sport, team.id);
  if (!exists) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE user_id = ?').get(userId);
    if (n >= MAX_FOLLOWS) return false;
  }
  db.prepare(`
    INSERT INTO user_follows (user_id, sport, team_id, name, abbreviation, logo)
    VALUES (@userId, @sport, @id, @name, @abbreviation, @logo)
    ON CONFLICT(user_id, sport, team_id) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      abbreviation = COALESCE(excluded.abbreviation, abbreviation),
      logo = COALESCE(excluded.logo, logo)
  `).run({ userId, sport: team.sport, id: team.id, name: team.name || null, abbreviation: team.abbreviation || null, logo: team.logo || null });
  return true;
}

function removeFollow(userId, sport, teamId) {
  db.prepare('DELETE FROM user_follows WHERE user_id = ? AND sport = ? AND team_id = ?').run(userId, sport, teamId);
}

// Merges teams followed in a browser before signing in into the account.
const mergeFollows = db.transaction((userId, teams) => {
  teams.forEach((team) => addFollow(userId, team));
  return listFollows(userId);
});

// Every (sport, team) anyone follows, for the alert poller.
function followedTeamsBySport() {
  const rows = db.prepare('SELECT DISTINCT sport, team_id FROM user_follows').all();
  const bySport = new Map();
  rows.forEach((r) => {
    if (!bySport.has(r.sport)) bySport.set(r.sport, new Set());
    bySport.get(r.sport).add(r.team_id);
  });
  return bySport;
}

// ---- Push subscriptions and alerts ----------------------------------------

function savePushSubscription(userId, { endpoint, keys }) {
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(userId, endpoint, keys.p256dh, keys.auth);
}

function removePushSubscription(endpoint, userId) {
  if (userId === undefined) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  else db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

function countPushSubscriptions(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
}

function pushSubscriptionsForUser(userId) {
  return db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId)
    .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

// Push subscriptions of users who follow either team and want this kind of
// alert ('start' or 'end').
function alertRecipients(sport, teamIds, kind) {
  const ids = teamIds.filter(Boolean).map(String);
  if (!ids.length) return [];
  const column = kind === 'start' ? 'alert_start' : 'alert_end';
  return db.prepare(`
    SELECT DISTINCT p.endpoint, p.p256dh, p.auth, u.id AS user_id
    FROM push_subscriptions p
    JOIN users u ON u.id = p.user_id
    JOIN user_follows f ON f.user_id = u.id
    WHERE f.sport = ? AND f.team_id IN (${ids.map(() => '?').join(',')}) AND u.${column} = 1
  `).all(sport, ...ids).map((r) => ({ userId: r.user_id, endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

function alertSent(sport, gameId, kind) {
  return !!db.prepare('SELECT 1 FROM alerts_sent WHERE sport = ? AND game_id = ? AND kind = ?').get(sport, String(gameId), kind);
}

// Returns true only for the first caller, so an alert goes out once.
function markAlertSent(sport, gameId, kind) {
  return db.prepare('INSERT OR IGNORE INTO alerts_sent (sport, game_id, kind) VALUES (?, ?, ?)').run(sport, String(gameId), kind).changes === 1;
}

// ---- Daily recaps ----------------------------------------------------------

function recapUsers() {
  return db.prepare('SELECT * FROM users WHERE recap_enabled = 1').all();
}

function getRecap(userId) {
  const row = db.prepare('SELECT * FROM recaps WHERE user_id = ?').get(userId);
  if (!row) return null;
  let teams = [];
  try { teams = JSON.parse(row.teams); } catch (err) { teams = []; }
  return {
    date: row.local_date,
    headline: row.headline,
    text: row.body,
    teams,
    source: row.source,
    createdAt: `${row.created_at.replace(' ', 'T')}Z`,
  };
}

function saveRecap(userId, { date, headline, text, teams, source }) {
  db.prepare(`
    INSERT INTO recaps (user_id, local_date, headline, body, teams, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET local_date = excluded.local_date, headline = excluded.headline,
      body = excluded.body, teams = excluded.teams, source = excluded.source, created_at = excluded.created_at
  `).run(userId, date, headline, text, JSON.stringify(teams || []), source || 'basic');
  return getRecap(userId);
}

// ---- Radio and TV overrides ---------------------------------------------

function parseList(value) {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.map(String) : [];
  } catch (err) {
    return [];
  }
}

function overrideFromRow(row) {
  if (!row) return null;
  return {
    sport: row.sport,
    scope: row.scope,
    targetId: row.target_id,
    label: row.label,
    tv: parseList(row.tv),
    radio: parseList(row.radio),
    radioCity: row.radio_city,
    listenUrl: row.listen_url,
    watchName: row.watch_name,
    watchUrl: row.watch_url,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

function listBroadcastOverrides(sport) {
  const rows = sport
    ? db.prepare('SELECT * FROM broadcast_overrides WHERE sport = ? ORDER BY updated_at DESC').all(sport)
    : db.prepare('SELECT * FROM broadcast_overrides ORDER BY updated_at DESC').all();
  return rows.map(overrideFromRow);
}

function getBroadcastOverride(sport, scope, targetId) {
  return overrideFromRow(db
    .prepare('SELECT * FROM broadcast_overrides WHERE sport = ? AND scope = ? AND target_id = ?')
    .get(sport, scope, String(targetId)));
}

function saveBroadcastOverride(o) {
  db.prepare(`
    INSERT INTO broadcast_overrides
      (sport, scope, target_id, label, tv, radio, radio_city, listen_url, watch_name, watch_url, note, updated_at)
    VALUES (@sport, @scope, @targetId, @label, @tv, @radio, @radioCity, @listenUrl, @watchName, @watchUrl, @note, datetime('now'))
    ON CONFLICT(sport, scope, target_id) DO UPDATE SET
      label = excluded.label, tv = excluded.tv, radio = excluded.radio,
      radio_city = excluded.radio_city, listen_url = excluded.listen_url,
      watch_name = excluded.watch_name, watch_url = excluded.watch_url,
      note = excluded.note, updated_at = excluded.updated_at
  `).run({
    sport: o.sport,
    scope: o.scope,
    targetId: String(o.targetId),
    label: o.label || null,
    tv: o.tv && o.tv.length ? JSON.stringify(o.tv) : null,
    radio: o.radio && o.radio.length ? JSON.stringify(o.radio) : null,
    radioCity: o.radioCity || null,
    listenUrl: o.listenUrl || null,
    watchName: o.watchName || null,
    watchUrl: o.watchUrl || null,
    note: o.note || null,
  });
  return getBroadcastOverride(o.sport, o.scope, o.targetId);
}

function removeBroadcastOverride(sport, scope, targetId) {
  db.prepare('DELETE FROM broadcast_overrides WHERE sport = ? AND scope = ? AND target_id = ?')
    .run(sport, scope, String(targetId));
}

module.exports = {
  db,
  recapUsers,
  getRecap,
  saveRecap,
  listBroadcastOverrides,
  getBroadcastOverride,
  saveBroadcastOverride,
  removeBroadcastOverride,
  MAX_FOLLOWS,
  getUser,
  getUserByEmail,
  getUserByOidcSub,
  getUserByFeedToken,
  createUser,
  linkOidc,
  updateUser,
  resetFeedToken,
  listFollows,
  addFollow,
  removeFollow,
  mergeFollows,
  followedTeamsBySport,
  savePushSubscription,
  removePushSubscription,
  countPushSubscriptions,
  pushSubscriptionsForUser,
  alertRecipients,
  alertSent,
  markAlertSent,
  listNotableGames,
  listUserNotableGames,
  addUserNotableGame,
  removeUserNotableGame,
  reorderUserNotableGames,
  copySiteNotableToUser,
  MAX_NOTABLE_PER_WEEK,
  addNotableGame,
  removeNotableGame,
  reorderNotableGames,
};
