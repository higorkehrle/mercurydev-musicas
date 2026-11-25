import type { LyricsCandidate, LyricsMatchInfo, LyricsSource } from './types.ts';

// Pluggable provider interfaces (implementations live in apps/server).

export interface LyricsQuery {
  trackName: string;
  artists: string[];
  albumName: string | null;
  durationMs: number;
  isrc: string | null;
}

/** Raw lyrics as returned by the provider (before parsing). */
export interface ProviderLyrics {
  sourceId: string;
  instrumental: boolean;
  /** Lyrics in LRC format (with timestamps), if any. */
  syncedLrc: string | null;
  plain: string | null;
  match: LyricsMatchInfo;
  copyright: string | null;
  /** Synced lyrics available but with an incompatible duration → text only. */
  warning: 'duration_mismatch' | null;
}

export interface LyricsProvider {
  readonly id: LyricsSource;
  /** Credit for the source, e.g. "Lyrics: LRCLIB". */
  readonly attribution: string;
  find(q: LyricsQuery): Promise<ProviderLyrics | null>;
  /** Alternative candidates (for "wrong lyrics?"). */
  candidates?(q: LyricsQuery): Promise<LyricsCandidate[]>;
  getById?(id: string, q: LyricsQuery): Promise<ProviderLyrics | null>;
}

export interface TranslationInputLine {
  /** Index of the original line. */
  i: number;
  text: string;
}

export interface TranslationOutputLine {
  i: number;
  t: string;
}

export interface TranslationRequest {
  lines: TranslationInputLine[];
  targetLanguage: string;
  sourceLanguageHint: string | null;
  title: string;
  artist: string;
  /** true when this is a block of a larger song (fallback mode). */
  partial: boolean;
}

export interface TranslationProvider {
  readonly id: string;
  readonly model: string;
  /** Returns the model's raw JSON; validation happens outside the provider. */
  translate(req: TranslationRequest): Promise<unknown>;
}
