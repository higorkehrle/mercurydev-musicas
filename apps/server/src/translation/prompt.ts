import type { TranslationRequest } from '@lyricsync/shared';

/** Bump when the prompt changes — invalidates cached translations. */
export const PROMPT_VERSION = 'v1';

export function systemPrompt(targetLanguage: string): string {
  return `You translate song lyrics into ${targetLanguage} for a bilingual, line-by-line subtitle display.

How to translate:
- Convey what each line means, not word-for-word. Render slang, metaphors, wordplay and idioms with a natural ${targetLanguage} equivalent that carries the same sense and tone; keep the register (casual, crude, poetic) of the original.
- Use the whole song as context: the same image or phrase should be translated consistently.
- Keep proper names, brand names and places as they are. Non-lexical vocables ("oh", "yeah", "na na na") may stay unchanged.
- Do not add explanations, notes, quotes or brackets that are not in the original.

Line correspondence is strict, because each translation is shown directly under its original line:
- Return exactly one item per input line, with the same "i" value, in the same order.
- Never merge, split, drop, reorder or shift lines, even when a sentence continues on the next line — translate each fragment so that it reads naturally on its own line.

Output only JSON of the form {"translations":[{"i":<input index>,"t":"<translation>"}]}.`;
}

export function userPrompt(req: TranslationRequest): string {
  return JSON.stringify(
    {
      song: req.title,
      artist: req.artist,
      source_language_hint: req.sourceLanguageHint,
      target_language: req.targetLanguage,
      note: req.partial ? 'This is one section of a longer song.' : undefined,
      line_count: req.lines.length,
      lines: req.lines,
    },
    null,
    1,
  );
}

/** JSON Schema for structured output. */
export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, t: { type: 'string' } },
        required: ['i', 't'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
} as const;
