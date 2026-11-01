// SQLite persistence for the one thing that actually needs to be
// remembered between restarts: the admin-curated "Notable Games" picks
// per week. Everything else (schedules/scores) is fetched live and cached
// in memory, so it never needs to touch disk.

const path = require('path');
const fs = require('fs');
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
`);

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

module.exports = {
  db,
  listNotableGames,
  addNotableGame,
  removeNotableGame,
  reorderNotableGames,
};
