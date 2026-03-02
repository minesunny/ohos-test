import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AUTH_DB_FILENAME = "auth.sqlite";

function ensureAuthSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_gitcode_settings (
      user_id INTEGER PRIMARY KEY,
      gitcode_token TEXT NOT NULL,
      repository_owner TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      api_base TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_gitcode_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      repository_owner TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, repository_owner, repository_name)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_gitcode_targets_user_id_position
    ON user_gitcode_targets(user_id, position);
  `);
}

function createAuthDb(): DatabaseSync {
  const dataDir = path.join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, AUTH_DB_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureAuthSchema(db);
  return db;
}

const globalSqlite = globalThis as unknown as {
  rk3568AuthDb?: DatabaseSync;
};

export function getAuthDb(): DatabaseSync {
  if (!globalSqlite.rk3568AuthDb) {
    globalSqlite.rk3568AuthDb = createAuthDb();
  } else {
    // Keep schema migrations idempotent so hot-reload/old DBs can self-heal.
    ensureAuthSchema(globalSqlite.rk3568AuthDb);
  }
  return globalSqlite.rk3568AuthDb;
}
