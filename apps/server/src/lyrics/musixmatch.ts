import type { LyricsProvider, LyricsQuery, ProviderLyrics } from '@lyricsync/shared';
import { config } from '../config.ts';
import { AppError, fetchWithBackoff } from '../lib/http.ts';
import { DURATION_TOLERANCE_SEC } from './match.ts';

const BASE = 'https://api.musixmatch.com/ws/1.1';

interface MxmEnvelope<T> {
  message: { header: { status_code: number }; body: T | '' | [] };
}

/**
 * Optional provider: the official Musixmatch API. Only enabled with a MUSIXMATCH_API_KEY from a
 * licensed plan (the free plan returns partial lyrics and no access to "subtitles").
 */
export class MusixmatchProvider implements LyricsProvider {
  readonly id = 'musixmatch' as const;
  readonly attribution = 'Lyrics: Musixmatch';

  constructor(private readonly apiKey: string) {}

  private async call<T>(method: string, params: Record<string, string>): Promise<T | null> {
    const url = new URL(`${BASE}/${method}`);
    url.search = new URLSearchParams({ ...params, apikey: this.apiKey, format: 'json' }).toString();
    const res = await fetchWithBackoff(url, { headers: { 'user-agent': config.userAgent } }, { service: 'O Musixmatch' });
    if (!res.ok) throw new AppError(502, 'lyrics_unavailable', `Musixmatch responded with error ${res.status}.`);
    const body = (await res.json()) as MxmEnvelope<T>;
    const status = body.message.header.status_code;
    if (status === 404) return null;
    if (status === 401 || status === 402 || status === 403) {
      throw new AppError(502, 'lyrics_unavailable', 'The Musixmatch key has no access to this resource.');
    }
    if (status !== 200 || !body.message.body || Array.isArray(body.message.body)) return null;
    return body.message.body;
  }

  async find(q: LyricsQuery): Promise<ProviderLyrics | null> {
    const artist = q.artists[0] ?? '';
    const durationSec = Math.round(q.durationMs / 1000);
    const base: Record<string, string> = { q_track: q.trackName, q_artist: artist };
    if (q.isrc) base.track_isrc = q.isrc;

    const sub = await this.call<{ subtitle: { subtitle_id: number; subtitle_body: string; subtitle_length?: number; lyrics_copyright?: string } }>(
      'matcher.subtitle.get',
      { ...base, subtitle_format: 'lrc', f_subtitle_length: String(durationSec), f_subtitle_length_max_deviation: String(DURATION_TOLERANCE_SEC) },
    ).catch(() => null);
    if (sub?.subtitle?.subtitle_body) {
      return {
        sourceId: `sub:${sub.subtitle.subtitle_id}`,
        instrumental: false,
        syncedLrc: sub.subtitle.subtitle_body,
        plain: null,
        match: { trackName: q.trackName, artistName: artist, albumName: q.albumName, durationSec: sub.subtitle.subtitle_length ?? null },
        copyright: sub.subtitle.lyrics_copyright ?? null,
        warning: null,
      };
    }

    const lyr = await this.call<{ lyrics: { lyrics_id: number; lyrics_body: string; instrumental: number; lyrics_copyright?: string; restricted?: number } }>(
      'matcher.lyrics.get',
      base,
    );
    if (!lyr?.lyrics) return null;
    if (lyr.lyrics.instrumental) {
      return { sourceId: `lyr:${lyr.lyrics.lyrics_id}`, instrumental: true, syncedLrc: null, plain: null, match: { trackName: q.trackName, artistName: artist, albumName: q.albumName, durationSec: null }, copyright: null, warning: null };
    }
    if (!lyr.lyrics.lyrics_body.trim() || lyr.lyrics.restricted) return null;
    return {
      sourceId: `lyr:${lyr.lyrics.lyrics_id}`,
      instrumental: false,
      syncedLrc: null,
      plain: lyr.lyrics.lyrics_body,
      match: { trackName: q.trackName, artistName: artist, albumName: q.albumName, durationSec: null },
      copyright: lyr.lyrics.lyrics_copyright ?? null,
      warning: null,
    };
  }
}
