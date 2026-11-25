import type { LyricsCandidate, LyricsProvider, LyricsQuery, ProviderLyrics } from '@lyricsync/shared';
import { config } from '../config.ts';
import { AppError, fetchWithBackoff } from '../lib/http.ts';
import { chooseCandidate, cleanTitle, DURATION_TOLERANCE_SEC, type CandidateRecord } from './match.ts';

const BASE = 'https://lrclib.net/api';

/** Some LRCLIB records contain the string "null" instead of null. */
const nullish = (v: string | null) => (v === null || v.trim() === '' || v.trim().toLowerCase() === 'null' ? null : v);
function clean(r: LrclibRecord): LrclibRecord {
  return { ...r, albumName: nullish(r.albumName), plainLyrics: nullish(r.plainLyrics), syncedLyrics: nullish(r.syncedLyrics) };
}

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** Primary provider: LRCLIB (public, documented API — https://lrclib.net/docs). */
export class LrclibProvider implements LyricsProvider {
  readonly id = 'lrclib' as const;
  readonly attribution = 'Lyrics: LRCLIB';

  private async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    const url = new URL(BASE + path);
    if (params) url.search = new URLSearchParams(params).toString();
    const res = await fetchWithBackoff(url, { headers: { 'user-agent': config.userAgent, accept: 'application/json' } }, { service: 'O LRCLIB', retries: 2 });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new AppError(502, 'lyrics_unavailable', `LRCLIB responded with error ${res.status}.`);
    return (await res.json()) as T;
  }

  private async search(trackName: string, artistName: string | null): Promise<LrclibRecord[]> {
    const params: Record<string, string> = { track_name: trackName };
    if (artistName) params.artist_name = artistName;
    return ((await this.get<LrclibRecord[]>('/search', params)) ?? []).map(clean);
  }

  private toProvider(r: LrclibRecord, useSynced: boolean, warning: ProviderLyrics['warning']): ProviderLyrics {
    return {
      sourceId: String(r.id),
      instrumental: r.instrumental,
      syncedLrc: useSynced ? r.syncedLyrics : null,
      // No plainLyrics but synced lyrics were discarded: the service extracts the text from the LRC.
      plain: r.plainLyrics ?? (useSynced ? null : r.syncedLyrics),
      match: { trackName: r.trackName, artistName: r.artistName, albumName: r.albumName, durationSec: r.duration },
      copyright: null,
      warning,
    };
  }

  async find(q: LyricsQuery): Promise<ProviderLyrics | null> {
    const durationSec = q.durationMs / 1000;
    const artist = q.artists[0] ?? '';

    // 1) Exact lookup by signature (LRCLIB already compares duration with a ±2s tolerance).
    if (artist && q.albumName) {
      const exactRaw = await this.get<LrclibRecord>('/get', {
        track_name: q.trackName,
        artist_name: artist,
        album_name: q.albumName,
        duration: String(Math.round(durationSec)),
      });
      const exact = exactRaw ? clean(exactRaw) : null;
      if (exact && (exact.instrumental || exact.syncedLyrics || exact.plainLyrics)) {
        const delta = exact.duration === null ? null : Math.abs(exact.duration - durationSec);
        const durationOk = delta !== null && delta <= DURATION_TOLERANCE_SEC;
        if (durationOk) return this.toProvider(exact, Boolean(exact.syncedLyrics), null);
      }
    }

    // 2) Open search with the original and the cleaned title; pick the best candidate.
    const records = await this.collect(q);
    const best = chooseCandidate({ trackName: q.trackName, artists: q.artists, durationSec }, records);
    if (!best) return null;
    return this.toProvider(best.record, best.useSynced, best.warning);
  }

  private async collect(q: LyricsQuery): Promise<LrclibRecord[]> {
    const artist = q.artists[0] ?? null;
    const cleaned = cleanTitle(q.trackName);
    const seen = new Map<number, LrclibRecord>();
    const add = (list: LrclibRecord[]) => list.forEach((r) => seen.set(r.id, r));
    add(await this.search(q.trackName, artist));
    if (cleaned !== q.trackName) add(await this.search(cleaned, artist));
    if (seen.size === 0 && artist) add(await this.search(cleaned, null));
    return [...seen.values()];
  }

  async candidates(q: LyricsQuery): Promise<LyricsCandidate[]> {
    const durationSec = q.durationMs / 1000;
    const records = await this.collect(q);
    return records
      .filter((r) => r.instrumental || r.syncedLyrics || r.plainLyrics)
      .map((r) => ({
        id: String(r.id),
        trackName: r.trackName,
        artistName: r.artistName,
        albumName: r.albumName,
        durationSec: r.duration,
        hasSynced: Boolean(r.syncedLyrics),
        instrumental: r.instrumental,
        durationDeltaSec: r.duration === null ? null : Math.round(Math.abs(r.duration - durationSec) * 10) / 10,
      }))
      .sort((a, b) => (a.durationDeltaSec ?? 9999) - (b.durationDeltaSec ?? 9999) || Number(b.hasSynced) - Number(a.hasSynced))
      .slice(0, 25);
  }

  async getById(id: string, q: LyricsQuery): Promise<ProviderLyrics | null> {
    if (!/^\d+$/.test(id)) return null;
    const raw = await this.get<LrclibRecord>(`/get/${id}`);
    if (!raw) return null;
    const r = clean(raw);
    const delta = r.duration === null ? null : Math.abs(r.duration - q.durationMs / 1000);
    const durationOk = delta !== null && delta <= DURATION_TOLERANCE_SEC;
    const useSynced = Boolean(r.syncedLyrics) && durationOk;
    return this.toProvider(r, useSynced, r.syncedLyrics && !durationOk ? 'duration_mismatch' : null);
  }
}

export type { CandidateRecord };
