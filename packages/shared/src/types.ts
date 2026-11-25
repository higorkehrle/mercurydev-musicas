// Types shared between server and web. Nothing here holds data — contracts only.

/** Track normalized from the Spotify Web API. */
export interface TrackInfo {
  /** Stable key used in cache/history: Spotify id, or "local:<hash>" for local tracks. */
  key: string;
  /** Spotify id; null for local tracks. */
  id: string | null;
  uri: string | null;
  isLocal: boolean;
  name: string;
  artists: string[];
  album: string;
  coverUrl: string | null;
  durationMs: number;
  isrc: string | null;
}

export type PlaybackItemKind = 'track' | 'episode' | 'ad' | 'unknown';

/** Player control actions. */
export type ControlAction = 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'volume';

export interface DeviceInfo {
  name: string;
  type: string;
  volumePercent: number | null;
  supportsVolume: boolean;
  isRestricted: boolean;
  isPrivateSession: boolean;
}

/**
 * Playback state returned by GET /api/player/now.
 * - active: a track (or other item) is playing or paused
 * - idle: nothing playing / no active device
 * - private: private session (Spotify hides the item)
 */
export interface PlaybackSnapshot {
  status: 'active' | 'idle' | 'private';
  kind: PlaybackItemKind | null;
  isPlaying: boolean;
  progressMs: number;
  track: TrackInfo | null;
  /** Actions Spotify reported as disallowed in the current context (actions.disallows). */
  disallows: ControlAction[];
  device: DeviceInfo | null;
}

export type AuthErrorCode =
  | 'config_missing'
  | 'access_denied'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'not_allowlisted'
  | 'owner_premium_required'
  | 'session_expired'
  | 'spotify_unavailable';

export interface SpotifyUser {
  id: string;
  displayName: string;
  /** "premium" | "free" | "open" … as reported by Spotify. */
  product: string | null;
  avatarUrl: string | null;
}

export interface AuthStatus {
  state: 'disconnected' | 'connected' | 'error';
  user: SpotifyUser | null;
  error: { code: AuthErrorCode; message: string } | null;
}

// ---------------------------------------------------------------- lyrics

export interface LyricsLine {
  index: number;
  /** null when the lyrics are not synced. */
  startMs: number | null;
  endMs: number | null;
  /** Original text. Empty string = pause/instrumental break. */
  text: string;
}

export type LyricsSource = 'lrclib' | 'musixmatch';

export interface LyricsMatchInfo {
  trackName: string;
  artistName: string;
  albumName: string | null;
  durationSec: number | null;
}

export type LyricsResult =
  | {
      status: 'found';
      source: LyricsSource;
      sourceId: string;
      synced: boolean;
      /**
       * duration_mismatch: the source had synced lyrics, but for a version with a different
       * duration (live/remix). We use only the text, without timestamps.
       */
      warning: 'duration_mismatch' | null;
      lines: LyricsLine[];
      lyricsHash: string;
      attribution: string;
      copyright: string | null;
      match: LyricsMatchInfo;
      /** true when the user manually chose this candidate ("wrong lyrics?"). */
      userChosen: boolean;
    }
  | { status: 'instrumental'; source: LyricsSource; sourceId: string; attribution: string }
  | { status: 'not_found'; checkedAt: number };

export interface LyricsCandidate {
  id: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  durationSec: number | null;
  hasSynced: boolean;
  instrumental: boolean;
  /** Duration difference from the Spotify track (seconds), when known. */
  durationDeltaSec: number | null;
}

export type SyncMode = 'source' | 'manual' | 'none';

/** Timings marked by the user ("sync while playing"), by line index. */
export interface ManualTimings {
  lyricsHash: string;
  starts: (number | null)[];
  updatedAt: number;
}

// ---------------------------------------------------------------- translation

export interface TranslationResult {
  status: 'translated' | 'partial' | 'not_needed' | 'failed' | 'unavailable';
  targetLang: string;
  /** Detected predominant language (franc ISO 639-3), or null if undetermined. */
  detectedLang: string | null;
  /** Translation by line index. null = no translation for that line. */
  lines: (string | null)[];
  /** Lines already in the target language (intentionally not translated). */
  sameLanguage: boolean[];
  provider: string | null;
  model: string | null;
  message: string | null;
}

// ---------------------------------------------------------------- views / API

export interface TrackView {
  track: TrackInfo;
  lyrics: LyricsResult;
  manualTimings: ManualTimings | null;
  offsetMs: number;
  isFavorite: boolean;
}

export interface Settings {
  targetLang: string;
  showTranslation: boolean;
  /** Lyrics font size multiplier (0.8 – 1.6). */
  fontScale: number;
  /** Estimated auto-scroll when the lyrics are not synced. */
  unsyncedAutoScroll: boolean;
  /** Estimated scroll speed (0.5 – 1.5). Only applies in unsynced mode. */
  unsyncedScrollSpeed: number;
  /** Offset applied to songs without their own offset (ms). */
  defaultOffsetMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'pt-BR',
  showTranslation: true,
  fontScale: 1,
  unsyncedAutoScroll: true,
  unsyncedScrollSpeed: 1,
  defaultOffsetMs: 0,
};

export interface LibraryEntry {
  track: TrackInfo;
  at: number;
  isFavorite: boolean;
}

export interface SearchPage {
  items: TrackInfo[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/** Standard app API error. */
export interface ApiErrorBody {
  error: string;
  message: string;
  retryAfterMs?: number;
}

/** Player control errors with a readable reason. */
export interface ControlErrorBody extends ApiErrorBody {
  error: 'no_active_device' | 'premium_required' | 'restricted' | 'rate_limited' | 'spotify_error' | 'unauthorized';
}

export const OFFSET_LIMIT_MS = 5000;
export const OFFSET_STEP_MS = 100;
