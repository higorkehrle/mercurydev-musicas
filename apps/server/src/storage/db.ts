import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id_hash       TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    display_name  TEXT,
    product       TEXT,
    avatar_url    TEXT,
    access_enc    TEXT NOT NULL,
    refresh_enc   TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE tracks (
    key         TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE lyrics_cache (
    track_key   TEXT PRIMARY KEY,
    result      TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );

  CREATE TABLE lyrics_choice (
    track_key   TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    chosen_at   INTEGER NOT NULL
  );

  CREATE TABLE translations (
    track_key       TEXT NOT NULL,
    lyrics_hash     TEXT NOT NULL,
    target_lang     TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    result          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (track_key, lyrics_hash, target_lang, prompt_version)
  );

  CREATE TABLE history (
    user_id    TEXT NOT NULL,
    track_key  TEXT NOT NULL,
    viewed_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  );
  CREATE INDEX history_recent ON history(user_id, viewed_at DESC);

  CREATE TABLE favorites (
    user_id     TEXT NOT NULL,
    track_key   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  );

  CREATE TABLE offsets (
    user_id    TEXT NOT NULL,
    track_key  TEXT NOT NULL,
    offset_ms  INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  );

  CREATE TABLE manual_timings (
    user_id      TEXT NOT NULL,
    track_key    TEXT NOT NULL,
    lyrics_hash  TEXT NOT NULL,
    starts       TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  );

  CREATE TABLE settings (
    user_id     TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
