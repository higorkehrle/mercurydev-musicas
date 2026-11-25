import type { LyricsCandidate, LyricsProvider, LyricsQuery, LyricsResult, ProviderLyrics, TrackInfo } from '@lyricsync/shared';
import { AppError } from '../lib/http.ts';
import type { Repos } from '../storage/repos.ts';
import { hasTimedText, lyricsHash, parseLrc, parsePlain } from './lrc.ts';

function toQuery(t: TrackInfo): LyricsQuery {
  return { trackName: t.name, artists: t.artists, albumName: t.album || null, durationMs: t.durationMs, isrc: t.isrc };
}

/** Removes "non-commercial use" footers that some APIs append to the text. */
function stripFooters(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\*{3,}.*\*{3,}$/.test(l.trim()) && !/^\(\d{6,}\)$/.test(l.trim()))
    .join('\n');
}

export function toLyricsResult(p: ProviderLyrics, provider: LyricsProvider, track: TrackInfo, userChosen: boolean): LyricsResult {
  if (p.instrumental) return { status: 'instrumental', source: provider.id, sourceId: p.sourceId, attribution: provider.attribution };

  let lines = p.syncedLrc ? parseLrc(p.syncedLrc, track.durationMs) : [];
  let synced = hasTimedText(lines);
  if (!synced) {
    const plainSource = p.plain ?? p.syncedLrc ?? '';
    // Text that came as LRC but cannot be used with timings: keep the text only.
    const fromLrc = /^\s*\[\d{1,3}:\d{1,2}/m.test(plainSource);
    lines = fromLrc
      ? parseLrc(plainSource).map((l, index) => ({ index, startMs: null, endMs: null, text: l.text }))
      : parsePlain(stripFooters(plainSource));
    synced = false;
  }
  if (lines.every((l) => l.text === '')) return { status: 'not_found', checkedAt: Date.now() };

  return {
    status: 'found',
    source: provider.id,
    sourceId: p.sourceId,
    synced,
    warning: p.warning,
    lines,
    lyricsHash: lyricsHash(lines),
    attribution: provider.attribution,
    copyright: p.copyright,
    match: p.match,
    userChosen,
  };
}

export function createLyricsService(repos: Repos, providers: LyricsProvider[]) {
  const inflight = new Map<string, Promise<LyricsResult>>();
  const primary = providers[0]!;

  async function fetchFresh(track: TrackInfo): Promise<LyricsResult> {
    const q = toQuery(track);
    const choice = repos.lyrics.getChoice(track.key);
    if (choice) {
      const provider = providers.find((p) => p.id === choice.source);
      const chosen = provider?.getById ? await provider.getById(choice.source_id, q) : null;
      if (provider && chosen) return toLyricsResult(chosen, provider, track, true);
    }
    let lastError: unknown = null;
    for (const provider of providers) {
      try {
        const found = await provider.find(q);
        if (found) {
          const result = toLyricsResult(found, provider, track, false);
          if (result.status !== 'not_found') return result;
        }
      } catch (e) {
        lastError = e;
      }
    }
    // If a provider failed (network/limit), we cannot claim "not found".
    if (lastError) throw lastError instanceof AppError ? lastError : new AppError(502, 'lyrics_unavailable', 'Could not look up lyrics right now.');
    return { status: 'not_found', checkedAt: Date.now() };
  }

  async function resolve(track: TrackInfo, opts: { refresh?: boolean } = {}): Promise<LyricsResult> {
    if (!opts.refresh) {
      const cached = repos.lyrics.get(track.key);
      if (cached) return cached;
    }
    const existing = inflight.get(track.key);
    if (existing) return existing;
    const p = fetchFresh(track)
      .then((result) => {
        repos.lyrics.put(track.key, result);
        return result;
      })
      .finally(() => inflight.delete(track.key));
    inflight.set(track.key, p);
    return p;
  }

  async function candidates(track: TrackInfo): Promise<LyricsCandidate[]> {
    if (!primary.candidates) return [];
    return primary.candidates(toQuery(track));
  }

  async function choose(track: TrackInfo, candidateId: string): Promise<LyricsResult> {
    if (!primary.getById) throw new AppError(400, 'unsupported', 'The provider does not support choosing candidates.');
    const chosen = await primary.getById(candidateId, toQuery(track));
    if (!chosen) throw new AppError(404, 'candidate_not_found', 'This candidate no longer exists on LRCLIB.');
    repos.lyrics.setChoice(track.key, primary.id, candidateId);
    const result = toLyricsResult(chosen, primary, track, true);
    repos.lyrics.put(track.key, result);
    return result;
  }

  async function resetChoice(track: TrackInfo): Promise<LyricsResult> {
    repos.lyrics.clearChoice(track.key);
    return resolve(track, { refresh: true });
  }

  return { resolve, candidates, choose, resetChoice };
}

export type LyricsService = ReturnType<typeof createLyricsService>;
