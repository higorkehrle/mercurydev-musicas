import Anthropic from '@anthropic-ai/sdk';
import type { TranslationProvider, TranslationRequest } from '@lyricsync/shared';
import { config } from '../config.ts';
import { AppError, RateLimitedError, fetchWithBackoff } from '../lib/http.ts';
import { systemPrompt, TRANSLATION_SCHEMA, userPrompt } from './prompt.ts';

/**
 * Claude via the official SDK. Structured JSON output (output_config.format) and a server-side
 * refusal fallback (fallbacks: "default"). The SDK already retries 429/5xx honoring retry-after.
 */
export class AnthropicTranslationProvider implements TranslationProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  }

  async translate(req: TranslationRequest): Promise<unknown> {
    let msg;
    try {
      msg = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: TRANSLATION_SCHEMA } },
        system: systemPrompt(req.targetLanguage),
        messages: [{ role: 'user', content: userPrompt(req) }],
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new RateLimitedError(30_000, 'The translation provider');
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new AppError(502, 'translation_auth', 'The translation provider rejected the key (TRANSLATION_API_KEY).');
      }
      if (e instanceof Anthropic.NotFoundError) throw new AppError(502, 'translation_model', `Translation model not found: ${this.model}.`);
      if (e instanceof Anthropic.APIError) throw new AppError(502, 'translation_failed', `The translation provider failed (HTTP ${e.status ?? '?'}).`);
      throw e;
    }
    if (msg.stop_reason === 'refusal') throw new AppError(502, 'translation_refused', 'The model refused to translate these lyrics.');
    if (msg.stop_reason === 'max_tokens') throw new AppError(502, 'translation_truncated', 'The translation response was truncated.');
    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return text;
  }
}

/** Any /chat/completions-compatible API (OpenAI, OpenRouter, local servers…). */
export class OpenAICompatibleTranslationProvider implements TranslationProvider {
  readonly id = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async translate(req: TranslationRequest): Promise<unknown> {
    const res = await fetchWithBackoff(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_schema', json_schema: { name: 'translations', strict: true, schema: TRANSLATION_SCHEMA } },
          messages: [
            { role: 'system', content: systemPrompt(req.targetLanguage) },
            { role: 'user', content: userPrompt(req) },
          ],
        }),
      },
      { service: 'The translation provider', retries: 3, maxWaitMs: 30_000, timeoutMs: 120_000 },
    );
    if (res.status === 401 || res.status === 403) throw new AppError(502, 'translation_auth', 'The translation provider rejected the key (TRANSLATION_API_KEY).');
    if (!res.ok) throw new AppError(502, 'translation_failed', `The translation provider failed (HTTP ${res.status}).`);
    const body = (await res.json()) as { choices?: { message?: { content?: string; refusal?: string | null } }[] };
    const choice = body.choices?.[0]?.message;
    if (choice?.refusal) throw new AppError(502, 'translation_refused', 'The model refused to translate these lyrics.');
    return choice?.content ?? '';
  }
}

/** DeepL target language codes, keyed by the TARGET_LANGUAGES promptName. */
const DEEPL_TARGET: Record<string, string> = {
  'Brazilian Portuguese': 'PT-BR',
  English: 'EN-US',
  Spanish: 'ES',
  French: 'FR',
  Italian: 'IT',
  German: 'DE',
  Japanese: 'JA',
  Korean: 'KO',
  'Simplified Chinese': 'ZH-HANS',
  Russian: 'RU',
};
/** DeepL accepts up to 50 texts per request. */
const DEEPL_BATCH = 50;

/**
 * Classic machine translation (DeepL), no LLM. Free-plan keys end with ":fx" and use
 * api-free.deepl.com. Returns the same { translations: [{ i, t }] } shape as the models, so it
 * goes through the same validation.
 */
export class DeepLTranslationProvider implements TranslationProvider {
  readonly id = 'deepl';
  readonly model: string;
  private readonly endpoint: string;

  constructor(private readonly apiKey: string) {
    const free = apiKey.endsWith(':fx');
    this.model = free ? 'deepl-free' : 'deepl-pro';
    this.endpoint = free ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
  }

  async translate(req: TranslationRequest): Promise<unknown> {
    const target = DEEPL_TARGET[req.targetLanguage];
    if (!target) throw new AppError(400, 'bad_language', `DeepL does not support the language ${req.targetLanguage}.`);
    const translations: { i: number; t: string }[] = [];
    for (let k = 0; k < req.lines.length; k += DEEPL_BATCH) {
      const batch = req.lines.slice(k, k + DEEPL_BATCH);
      const res = await fetchWithBackoff(
        this.endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${this.apiKey}` },
          body: JSON.stringify({
            text: batch.map((l) => l.text),
            target_lang: target,
            // Context is neither translated nor billed; it helps DeepL understand these are verses.
            context: `Song lyrics: "${req.title}" by ${req.artist}.`,
            preserve_formatting: true,
          }),
        },
        { service: 'O DeepL', retries: 3, maxWaitMs: 30_000, timeoutMs: 60_000 },
      );
      if (res.status === 401 || res.status === 403) throw new AppError(502, 'translation_auth', 'DeepL rejected the key (TRANSLATION_API_KEY).');
      if (res.status === 456) throw new AppError(502, 'translation_quota', 'The monthly DeepL quota is used up.');
      if (!res.ok) throw new AppError(502, 'translation_failed', `O DeepL falhou (HTTP ${res.status}).`);
      const body = (await res.json()) as { translations?: { text?: string }[] };
      const out = body.translations ?? [];
      // If the count does not match, validation rejects the whole response.
      batch.forEach((l, j) => {
        if (out[j]?.text !== undefined) translations.push({ i: l.i, t: out[j]!.text! });
      });
    }
    return { translations };
  }
}

export function createTranslationProvider(): TranslationProvider | null {
  const t = config.translation;
  if (t.provider === 'none' || !t.apiKey) return null;
  if (t.provider === 'anthropic') return new AnthropicTranslationProvider(t.apiKey, t.model || 'claude-opus-5-5');
  if (t.provider === 'openai') {
    if (!t.model) throw new Error('TRANSLATION_MODEL is required with TRANSLATION_PROVIDER=openai');
    return new OpenAICompatibleTranslationProvider(t.apiKey, t.model, t.baseUrl);
  }
  if (t.provider === 'deepl') return new DeepLTranslationProvider(t.apiKey);
  throw new Error(`TRANSLATION_PROVIDER desconhecido: ${t.provider}`);
}
