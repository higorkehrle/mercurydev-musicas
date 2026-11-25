import type { TranslationOutputLine } from '@lyricsync/shared';

export type ValidationResult =
  | { ok: true; byIndex: Map<number, string> }
  | { ok: false; error: string };

/**
 * Validates the model response: it must be { translations: [{ i, t }] } with exactly the
 * requested indices, in the same order, without duplicates, and non-empty texts.
 * Any deviation invalidates the whole response — we never try to "fit" lines.
 */
export function validateTranslation(raw: unknown, expected: readonly number[]): ValidationResult {
  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, error: 'response is not valid JSON' };
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { translations?: unknown }).translations)) {
    return { ok: false, error: 'campo "translations" ausente' };
  }
  const list = (data as { translations: unknown[] }).translations;
  if (list.length !== expected.length) {
    return { ok: false, error: `line count mismatch: expected ${expected.length}, got ${list.length}` };
  }
  const byIndex = new Map<number, string>();
  for (let k = 0; k < list.length; k++) {
    const item = list[k] as Partial<TranslationOutputLine> | null;
    if (!item || typeof item !== 'object') return { ok: false, error: `invalid item ${k}` };
    if (typeof item.i !== 'number' || !Number.isInteger(item.i)) return { ok: false, error: `item ${k} has no integer index` };
    if (item.i !== expected[k]) return { ok: false, error: `index out of order at position ${k}: expected ${expected[k]}, got ${item.i}` };
    if (typeof item.t !== 'string' || item.t.trim() === '') return { ok: false, error: `empty translation at index ${item.i}` };
    if (byIndex.has(item.i)) return { ok: false, error: `duplicate index ${item.i}` };
    byIndex.set(item.i, item.t.trim());
  }
  return { ok: true, byIndex };
}
