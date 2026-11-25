import type { LyricsLine } from '@lyricsync/shared';
import { sha256 } from '../lib/crypto.ts';

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]\s*$/;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function fractionToMs(frac: string | undefined): number {
  if (!frac) return 0;
  if (frac.length === 1) return Number(frac) * 100;
  if (frac.length === 2) return Number(frac) * 10;
  return Number(frac.slice(0, 3));
}

/**
 * LRC parser.
 * - Several timestamps on one line ([00:12.00][01:30.50]text) become several lines.
 * - A timed line without text = pause (text '').
 * - Word tags (<mm:ss.xx>, "enhanced" LRC) are removed.
 * - [offset:±ms] is honored (positive = lyrics show earlier).
 * - Lines without timestamps (comments, credits) are ignored.
 * Returns lines sorted by time, with endMs = start of the next one (last: durationMs).
 */
export function parseLrc(lrc: string, durationMs: number | null = null): LyricsLine[] {
  let offset = 0;
  const raw: { startMs: number; text: string; order: number }[] = [];
  let order = 0;

  for (const rawLine of lrc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = META_TAG.exec(line);
    if (meta && !/^\d/.test(meta[1]!)) {
      if (meta[1]!.toLowerCase() === 'offset') {
        const n = Number(meta[2]!.trim());
        if (Number.isFinite(n)) offset = n;
      }
      continue;
    }

    const times: number[] = [];
    TIME_TAG.lastIndex = 0;
    let pos = 0;
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      times.push(min * 60_000 + sec * 1000 + fractionToMs(m[3]));
      pos = TIME_TAG.lastIndex;
      // allow spaces between consecutive tags
      while (line[pos] === ' ') pos++;
      TIME_TAG.lastIndex = pos;
    }
    if (times.length === 0) continue;

    const text = line.slice(pos).replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
    for (const t of times) raw.push({ startMs: Math.max(0, t - offset), text, order: order++ });
  }

  raw.sort((a, b) => a.startMs - b.startMs || a.order - b.order);

  // Consecutive pauses collapse into one; a trailing pause only makes sense with a duration.
  const merged: { startMs: number; text: string }[] = [];
  for (const r of raw) {
    const prev = merged.at(-1);
    if (r.text === '' && prev && prev.text === '') continue;
    merged.push({ startMs: r.startMs, text: r.text });
  }

  return merged.map((r, index) => ({
    index,
    startMs: r.startMs,
    endMs: merged[index + 1]?.startMs ?? durationMs ?? null,
    text: r.text,
  }));
}

/** Untimed lyrics: one line per verse, empty lines mark stanzas. */
export function parsePlain(text: string): LyricsLine[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out.map((t, index) => ({ index, startMs: null, endMs: null, text: t }));
}

/** true if the LRC text has at least one line with a timestamp and text. */
export function hasTimedText(lines: LyricsLine[]): boolean {
  return lines.some((l) => l.startMs !== null && l.text !== '');
}

/** Hash of the text content (independent of timings) — key for the translation cache and manual timings. */
export function lyricsHash(lines: LyricsLine[]): string {
  return sha256(lines.map((l) => l.text).join('\n')).slice(0, 20);
}
