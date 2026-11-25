// Title normalization and best lyrics candidate selection.

const VERSION_WORDS =
  'remaster(?:ed)?|live|ao vivo|en vivo|mono|stereo|version|versão|edit|radio edit|single|album|deluxe|bonus|explicit|clean|remix|mix|demo|acoustic|acústico|instrumental|original|anniversary|edition|mixed|from|feat\\.?|ft\\.?|featuring|with|com|part\\.?|pt\\.?|taylor\'s version|sped up|slowed';

const PAREN_VERSION = new RegExp(`\\s*[\\(\\[][^\\)\\]]*\\b(?:${VERSION_WORDS})\\b[^\\)\\]]*[\\)\\]]`, 'gi');
const DASH_VERSION = new RegExp(`\\s+[-–—]\\s+[^-–—]*\\b(?:${VERSION_WORDS}|\\d{4})\\b.*$`, 'i');
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;

function baseNormalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strips version suffixes ("- Remastered 2011", "(Live)", "feat. X"…) — for comparison/search only. */
export function cleanTitle(title: string): string {
  let t = title.replace(PAREN_VERSION, '');
  t = t.replace(DASH_VERSION, '');
  t = t.replace(FEAT, '');
  return t.trim() || title.trim();
}

export function normalizeTitle(title: string): string {
  return baseNormalize(cleanTitle(title));
}

export function normalizeArtist(artist: string): string {
  return baseNormalize(artist.replace(FEAT, ''));
}

export interface CandidateRecord {
  id: number | string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null; // seconds
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface MatchQuery {
  trackName: string;
  artists: string[];
  durationSec: number;
}

export interface MatchResult<T extends CandidateRecord> {
  record: T;
  /** Synced lyrics can be used (duration within tolerance). */
  useSynced: boolean;
  warning: 'duration_mismatch' | null;
  durationDeltaSec: number | null;
}

export const DURATION_TOLERANCE_SEC = 2;

function titleScore(q: string, c: string): number {
  if (!q || !c) return 0;
  if (q === c) return 2;
  if (c.includes(q) || q.includes(c)) return 1;
  return 0;
}

function artistMatches(queryArtists: string[], candidateArtist: string): boolean {
  const c = normalizeArtist(candidateArtist);
  if (!c) return false;
  return queryArtists.map(normalizeArtist).some((a) => a && (a === c || c.includes(a) || a.includes(c)));
}

const hasLyrics = (r: CandidateRecord) => Boolean(r.syncedLyrics?.trim() || r.plainLyrics?.trim());

/**
 * Picks the candidate:
 *  1. compatible normalized title and compatible artist (required);
 *  2. among those within ±2s of duration: prefer syncedLyrics, then exact title,
 *     then the smallest duration difference;
 *  3. if none matches the duration (live/remix): use the best by title, but WITHOUT sync,
 *     and set warning = duration_mismatch when synced lyrics were discarded.
 */
export function chooseCandidate<T extends CandidateRecord>(q: MatchQuery, records: readonly T[]): MatchResult<T> | null {
  const qTitle = normalizeTitle(q.trackName);
  const scored = records
    .map((r) => ({
      r,
      title: titleScore(qTitle, normalizeTitle(r.trackName)),
      delta: r.duration === null ? null : Math.abs(r.duration - q.durationSec),
    }))
    .filter((s) => s.title > 0 && artistMatches(q.artists, s.r.artistName) && (hasLyrics(s.r) || s.r.instrumental));

  if (scored.length === 0) return null;

  const within = scored.filter((s) => s.delta !== null && s.delta <= DURATION_TOLERANCE_SEC);
  if (within.length > 0) {
    within.sort(
      (a, b) =>
        Number(Boolean(b.r.syncedLyrics?.trim())) - Number(Boolean(a.r.syncedLyrics?.trim())) ||
        b.title - a.title ||
        (a.delta ?? 99) - (b.delta ?? 99),
    );
    const best = within[0]!;
    return { record: best.r, useSynced: Boolean(best.r.syncedLyrics?.trim()), warning: null, durationDeltaSec: best.delta };
  }

  scored.sort(
    (a, b) =>
      b.title - a.title ||
      Number(Boolean(b.r.plainLyrics?.trim())) - Number(Boolean(a.r.plainLyrics?.trim())) ||
      (a.delta ?? 9999) - (b.delta ?? 9999),
  );
  const best = scored[0]!;
  return {
    record: best.r,
    useSynced: false,
    warning: best.r.syncedLyrics?.trim() ? 'duration_mismatch' : null,
    durationDeltaSec: best.delta,
  };
}
