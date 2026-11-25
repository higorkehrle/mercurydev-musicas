import type { FastifyBaseLogger } from 'fastify';
import { findTargetLanguage, type LyricsLine, type TrackInfo, type TranslationInputLine, type TranslationProvider, type TranslationResult } from '@lyricsync/shared';
import { AppError } from '../lib/http.ts';
import type { Repos } from '../storage/repos.ts';
import { detectPredominant, sameLanguageMask } from './detect.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { validateTranslation } from './validate.ts';

const dedupeKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const BLOCK_MIN = 4;
const BLOCK_MAX = 16;

/**
 * Groups the lines to translate into blocks by stanza (stanzas are separated by empty lines),
 * merging small stanzas and splitting large ones. Indices never change.
 */
export function stanzaBlocks(lines: readonly LyricsLine[], toTranslate: readonly TranslationInputLine[]): TranslationInputLine[][] {
  const wanted = new Map(toTranslate.map((l) => [l.i, l]));
  const stanzas: TranslationInputLine[][] = [];
  let current: TranslationInputLine[] = [];
  for (const line of lines) {
    if (line.text === '') {
      if (current.length) stanzas.push(current);
      current = [];
      continue;
    }
    const item = wanted.get(line.index);
    if (item) current.push(item);
  }
  if (current.length) stanzas.push(current);

  const blocks: TranslationInputLine[][] = [];
  let acc: TranslationInputLine[] = [];
  for (const s of stanzas) {
    for (let k = 0; k < s.length; k += BLOCK_MAX) {
      const piece = s.slice(k, k + BLOCK_MAX);
      if (acc.length && acc.length + piece.length > BLOCK_MAX) {
        blocks.push(acc);
        acc = [];
      }
      acc.push(...piece);
      if (acc.length >= BLOCK_MIN) {
        blocks.push(acc);
        acc = [];
      }
    }
  }
  if (acc.length) blocks.push(acc);
  return blocks;
}

export function createTranslationService(repos: Repos, provider: TranslationProvider | null, log: FastifyBaseLogger) {
  const inflight = new Map<string, Promise<TranslationResult>>();

  async function attempt(req: Parameters<TranslationProvider['translate']>[0]): Promise<Map<number, string> | null> {
    const expected = req.lines.map((l) => l.i);
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      try {
        const raw = await provider!.translate(req);
        const v = validateTranslation(raw, expected);
        if (v.ok) return v.byIndex;
        log.warn({ msg: 'invalid translation', reason: v.error, try: tryNo, lines: expected.length });
      } catch (e) {
        // Configuration/authentication errors do not improve with a retry.
        if (e instanceof AppError && (e.code === 'translation_auth' || e.code === 'translation_model' || e.code === 'translation_quota')) throw e;
        log.warn({ msg: 'translation call failed', err: e instanceof Error ? e.message : String(e), try: tryNo });
        if (e instanceof AppError && e.code === 'rate_limited') throw e;
      }
    }
    return null;
  }

  async function run(track: TrackInfo, lines: LyricsLine[], lyricsHash: string, targetLang: string): Promise<TranslationResult> {
    const target = findTargetLanguage(targetLang)!;
    const predominant = detectPredominant(lines);
    const same = sameLanguageMask(lines, predominant, target.franc);
    const base: TranslationResult = {
      status: 'translated',
      targetLang,
      detectedLang: predominant,
      lines: lines.map(() => null),
      sameLanguage: same,
      provider: provider?.id ?? null,
      model: provider?.model ?? null,
      message: null,
    };

    // One entry per unique text (a chorus is translated once and reused).
    const firstIndexByText = new Map<string, number>();
    const unique: TranslationInputLine[] = [];
    for (const l of lines) {
      if (!l.text || same[l.index]) continue;
      const k = dedupeKey(l.text);
      if (!firstIndexByText.has(k)) {
        firstIndexByText.set(k, l.index);
        unique.push({ i: l.index, text: l.text });
      }
    }

    if (unique.length === 0) {
      return { ...base, status: 'not_needed', message: 'The lyrics are already in the chosen language.' };
    }

    const reqBase = {
      targetLanguage: target.promptName,
      sourceLanguageHint: predominant,
      title: track.name,
      artist: track.artists.join(', '),
    };

    const translated = new Map<number, string>();
    const full = await attempt({ ...reqBase, lines: unique, partial: false });
    if (full) {
      full.forEach((v, k) => translated.set(k, v));
    } else {
      // Fallback: blocks by stanza, each validated independently.
      for (const block of stanzaBlocks(lines, unique)) {
        const part = await attempt({ ...reqBase, lines: block, partial: true });
        if (part) part.forEach((v, k) => translated.set(k, v));
      }
    }

    const out = lines.map((l) => {
      if (!l.text || same[l.index]) return null;
      const first = firstIndexByText.get(dedupeKey(l.text));
      return first === undefined ? null : translated.get(first) ?? null;
    });
    const missing = out.filter((t, i) => t === null && lines[i]!.text !== '' && !same[i]).length;
    if (translated.size === 0) {
      return { ...base, status: 'failed', message: 'Could not translate these lyrics right now.' };
    }
    return {
      ...base,
      lines: out,
      status: missing > 0 ? 'partial' : 'translated',
      message: missing > 0 ? `${missing} line(s) were left untranslated.` : null,
    };
  }

  async function translate(track: TrackInfo, lines: LyricsLine[], lyricsHash: string, targetLang: string, opts: { refresh?: boolean } = {}): Promise<TranslationResult> {
    if (!findTargetLanguage(targetLang)) throw new AppError(400, 'bad_language', 'Unsupported target language.');
    if (!provider) {
      return {
        status: 'unavailable',
        targetLang,
        detectedLang: null,
        lines: lines.map(() => null),
        sameLanguage: lines.map(() => false),
        provider: null,
        model: null,
        message: 'Machine translation is not configured (set TRANSLATION_PROVIDER and TRANSLATION_API_KEY).',
      };
    }
    if (!opts.refresh) {
      const cached = repos.translations.get(track.key, lyricsHash, targetLang, PROMPT_VERSION);
      if (cached) return cached;
    }
    const key = `${track.key}|${lyricsHash}|${targetLang}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = run(track, lines, lyricsHash, targetLang)
      .then((r) => {
        if (r.status !== 'failed') repos.translations.put(track.key, lyricsHash, targetLang, PROMPT_VERSION, r);
        return r;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { translate, available: provider !== null };
}

export type TranslationService = ReturnType<typeof createTranslationService>;
