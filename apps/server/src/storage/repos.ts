import {
  DEFAULT_SETTINGS,
  OFFSET_LIMIT_MS,
  type LibraryEntry,
  type LyricsResult,
  type ManualTimings,
  type Settings,
  type TrackInfo,
  type TranslationResult,
} from '@lyricsync/shared';
import type { DB } from './db.ts';

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id_hash: string;
  user_id: string;
  display_name: string | null;
  product: string | null;
  avatar_url: string | null;
  access_enc: string;
  refresh_enc: string;
  expires_at: number;
  created_at: number;
  last_seen_at: number;
}

export function createRepos(db: DB) {
  const sessions = {
    get: (idHash: string) => db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined,
    insert: (row: SessionRow) =>
      db
        .prepare(
          `INSERT INTO sessions (id_hash,user_id,display_name,product,avatar_url,access_enc,refresh_enc,expires_at,created_at,last_seen_at)
           VALUES (@id_hash,@user_id,@display_name,@product,@avatar_url,@access_enc,@refresh_enc,@expires_at,@created_at,@last_seen_at)`,
        )
        .run(row),
    updateTokens: (idHash: string, accessEnc: string, refreshEnc: string, expiresAt: number) =>
      db.prepare('UPDATE sessions SET access_enc=?, refresh_enc=?, expires_at=? WHERE id_hash=?').run(accessEnc, refreshEnc, expiresAt, idHash),
    touch: (idHash: string) => db.prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(Date.now(), idHash),
    delete: (idHash: string) => db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash),
    purgeStale: (olderThan: number) => db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(olderThan),
  };

  const tracks = {
    upsert: (t: TrackInfo) =>
      db
        .prepare('INSERT INTO tracks (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
        .run(t.key, JSON.stringify(t), Date.now()),
    upsertMany: (list: TrackInfo[]) => db.transaction(() => list.forEach((t) => tracks.upsert(t)))(),
    get: (key: string): TrackInfo | null => {
      const row = db.prepare('SELECT data FROM tracks WHERE key = ?').get(key) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as TrackInfo) : null;
    },
  };

  const lyrics = {
    get: (trackKey: string): LyricsResult | null => {
      const row = db.prepare('SELECT result, expires_at FROM lyrics_cache WHERE track_key = ?').get(trackKey) as
        | { result: string; expires_at: number | null }
        | undefined;
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at < Date.now()) return null;
      return JSON.parse(row.result) as LyricsResult;
    },
    put: (trackKey: string, result: LyricsResult) => {
      const now = Date.now();
      const expires = result.status === 'not_found' ? now + NOT_FOUND_TTL_MS : null;
      db.prepare(
        'INSERT INTO lyrics_cache (track_key,result,fetched_at,expires_at) VALUES (?,?,?,?) ON CONFLICT(track_key) DO UPDATE SET result=excluded.result, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at',
      ).run(trackKey, JSON.stringify(result), now, expires);
    },
    delete: (trackKey: string) => db.prepare('DELETE FROM lyrics_cache WHERE track_key = ?').run(trackKey),
    getChoice: (trackKey: string) =>
      db.prepare('SELECT source, source_id FROM lyrics_choice WHERE track_key = ?').get(trackKey) as { source: string; source_id: string } | undefined,
    setChoice: (trackKey: string, source: string, sourceId: string) =>
      db
        .prepare('INSERT INTO lyrics_choice (track_key,source,source_id,chosen_at) VALUES (?,?,?,?) ON CONFLICT(track_key) DO UPDATE SET source=excluded.source, source_id=excluded.source_id, chosen_at=excluded.chosen_at')
        .run(trackKey, source, sourceId, Date.now()),
    clearChoice: (trackKey: string) => db.prepare('DELETE FROM lyrics_choice WHERE track_key = ?').run(trackKey),
  };

  const translations = {
    get: (trackKey: string, hash: string, lang: string, promptVersion: string): TranslationResult | null => {
      const row = db
        .prepare('SELECT result FROM translations WHERE track_key=? AND lyrics_hash=? AND target_lang=? AND prompt_version=?')
        .get(trackKey, hash, lang, promptVersion) as { result: string } | undefined;
      return row ? (JSON.parse(row.result) as TranslationResult) : null;
    },
    put: (trackKey: string, hash: string, lang: string, promptVersion: string, result: TranslationResult) =>
      db
        .prepare(
          'INSERT INTO translations (track_key,lyrics_hash,target_lang,prompt_version,result,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET result=excluded.result, created_at=excluded.created_at',
        )
        .run(trackKey, hash, lang, promptVersion, JSON.stringify(result), Date.now()),
  };

  const library = {
    recordView: (userId: string, trackKey: string) =>
      db
        .prepare('INSERT INTO history (user_id,track_key,viewed_at) VALUES (?,?,?) ON CONFLICT DO UPDATE SET viewed_at=excluded.viewed_at')
        .run(userId, trackKey, Date.now()),
    history: (userId: string, limit = 50): LibraryEntry[] =>
      (
        db
          .prepare(
            `SELECT t.data, h.viewed_at AS at, (f.track_key IS NOT NULL) AS fav
             FROM history h JOIN tracks t ON t.key = h.track_key
             LEFT JOIN favorites f ON f.user_id = h.user_id AND f.track_key = h.track_key
             WHERE h.user_id = ? ORDER BY h.viewed_at DESC LIMIT ?`,
          )
          .all(userId, limit) as { data: string; at: number; fav: number }[]
      ).map((r) => ({ track: JSON.parse(r.data) as TrackInfo, at: r.at, isFavorite: r.fav === 1 })),
    clearHistory: (userId: string) => db.prepare('DELETE FROM history WHERE user_id = ?').run(userId),
    favorites: (userId: string): LibraryEntry[] =>
      (
        db
          .prepare(
            `SELECT t.data, f.created_at AS at FROM favorites f JOIN tracks t ON t.key = f.track_key
             WHERE f.user_id = ? ORDER BY f.created_at DESC`,
          )
          .all(userId) as { data: string; at: number }[]
      ).map((r) => ({ track: JSON.parse(r.data) as TrackInfo, at: r.at, isFavorite: true })),
    isFavorite: (userId: string, trackKey: string) =>
      db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND track_key=?').get(userId, trackKey) !== undefined,
    setFavorite: (userId: string, trackKey: string, fav: boolean) => {
      if (fav) db.prepare('INSERT OR IGNORE INTO favorites (user_id,track_key,created_at) VALUES (?,?,?)').run(userId, trackKey, Date.now());
      else db.prepare('DELETE FROM favorites WHERE user_id=? AND track_key=?').run(userId, trackKey);
    },
  };

  const sync = {
    getOffset: (userId: string, trackKey: string): number | null => {
      const row = db.prepare('SELECT offset_ms FROM offsets WHERE user_id=? AND track_key=?').get(userId, trackKey) as { offset_ms: number } | undefined;
      return row ? row.offset_ms : null;
    },
    setOffset: (userId: string, trackKey: string, offsetMs: number) => {
      const clamped = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(offsetMs / 100) * 100));
      db.prepare('INSERT INTO offsets (user_id,track_key,offset_ms) VALUES (?,?,?) ON CONFLICT DO UPDATE SET offset_ms=excluded.offset_ms').run(userId, trackKey, clamped);
      return clamped;
    },
    clearOffset: (userId: string, trackKey: string) => db.prepare('DELETE FROM offsets WHERE user_id=? AND track_key=?').run(userId, trackKey),
    getTimings: (userId: string, trackKey: string): ManualTimings | null => {
      const row = db.prepare('SELECT lyrics_hash, starts, updated_at FROM manual_timings WHERE user_id=? AND track_key=?').get(userId, trackKey) as
        | { lyrics_hash: string; starts: string; updated_at: number }
        | undefined;
      return row ? { lyricsHash: row.lyrics_hash, starts: JSON.parse(row.starts) as (number | null)[], updatedAt: row.updated_at } : null;
    },
    setTimings: (userId: string, trackKey: string, t: ManualTimings) =>
      db
        .prepare('INSERT INTO manual_timings (user_id,track_key,lyrics_hash,starts,updated_at) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET lyrics_hash=excluded.lyrics_hash, starts=excluded.starts, updated_at=excluded.updated_at')
        .run(userId, trackKey, t.lyricsHash, JSON.stringify(t.starts), t.updatedAt),
    clearTimings: (userId: string, trackKey: string) => db.prepare('DELETE FROM manual_timings WHERE user_id=? AND track_key=?').run(userId, trackKey),
  };

  const settings = {
    get: (userId: string): Settings => {
      const row = db.prepare('SELECT data FROM settings WHERE user_id=?').get(userId) as { data: string } | undefined;
      return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.data) as Partial<Settings>) : {}) };
    },
    put: (userId: string, s: Settings) =>
      db.prepare('INSERT INTO settings (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(userId, JSON.stringify(s), Date.now()),
  };

  return { sessions, tracks, lyrics, translations, library, sync, settings };
}

export type Repos = ReturnType<typeof createRepos>;
