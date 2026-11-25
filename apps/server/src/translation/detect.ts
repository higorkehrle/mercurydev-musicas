import { franc, francAll } from 'franc';
import type { LyricsLine } from '@lyricsync/shared';

/** Languages considered during detection (restricting them greatly improves accuracy on short texts). */
const CANDIDATES = ['por', 'eng', 'spa', 'fra', 'ita', 'deu', 'nld', 'jpn', 'kor', 'cmn', 'rus', 'pol', 'swe', 'tur', 'ind', 'tgl'];
/** The other language must score below this (the winner always scores 1). */
const MARGIN = 0.8;

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
const longEnough = (s: string) => letters(s) >= 12 && words(s) >= 3;

/** Predominant language of the whole lyrics (ISO 639-3) or null. */
export function detectPredominant(lines: readonly LyricsLine[]): string | null {
  // Per-line vote (weighted by letter count): more robust than analyzing the whole text
  // when the song mixes languages.
  const votes = new Map<string, number>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (!longEnough(l.text) || seen.has(l.text)) continue;
    seen.add(l.text);
    const top = franc(l.text, { only: CANDIDATES, minLength: 10 });
    if (top !== 'und') votes.set(top, (votes.get(top) ?? 0) + letters(l.text));
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length) return ranked[0]![0];
  const text = lines.map((l) => l.text).filter(Boolean).join('\n');
  const p = franc(text, { only: CANDIDATES, minLength: 20 });
  return p === 'und' ? null : p;
}

function scoreOf(ranked: [string, number][], lang: string): number {
  return ranked.find(([l]) => l === lang)?.[1] ?? 0;
}

/**
 * Marks lines that are already in the target language (they will not be translated).
 *
 * Short lines are too ambiguous for isolated detection, so:
 * - song in another language: a line only counts as "target" if, in a head-to-head
 *   comparison between the predominant language and the target, the target wins clearly;
 * - song in the target language: a line is only translated if it is clearly another language.
 */
export function sameLanguageMask(lines: readonly LyricsLine[], predominant: string | null, targetFranc: string): boolean[] {
  return lines.map((l) => {
    if (!l.text) return false;
    if (predominant === targetFranc) {
      if (!longEnough(l.text)) return true;
      const ranked = francAll(l.text, { only: CANDIDATES, minLength: 10 }) as [string, number][];
      const top = ranked[0]?.[0];
      const foreign = top !== undefined && top !== 'und' && top !== targetFranc && scoreOf(ranked, targetFranc) < MARGIN;
      return !foreign;
    }
    if (!longEnough(l.text) || words(l.text) < 4) return false;
    const pair = predominant ? [predominant, targetFranc] : CANDIDATES;
    const ranked = francAll(l.text, { only: pair, minLength: 10 }) as [string, number][];
    const top = ranked[0]?.[0];
    if (top !== targetFranc) return false;
    const runnerUp = ranked[1]?.[1] ?? 0;
    return runnerUp < MARGIN;
  });
}
