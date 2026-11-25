import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranslationRequest } from '@lyricsync/shared';
import { DeepLTranslationProvider } from './providers.ts';
import { validateTranslation } from './validate.ts';

const req = (n: number): TranslationRequest => ({
  lines: Array.from({ length: n }, (_, k) => ({ i: k * 2, text: `line ${k}` })),
  targetLanguage: 'Brazilian Portuguese',
  sourceLanguageHint: 'eng',
  title: 'Song',
  artist: 'Artist',
  partial: false,
});

function mockFetch(handler: (body: { text: string[]; target_lang: string }, url: string, headers: Record<string, string>) => Response) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body)), String(url), init?.headers as Record<string, string>),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('DeepLTranslationProvider', () => {
  it('uses the Free endpoint for ":fx" keys and returns a valid { translations: [{ i, t }] }', async () => {
    const fn = mockFetch((body, url, headers) => {
      expect(url).toBe('https://api-free.deepl.com/v2/translate');
      expect(headers.authorization).toBe('DeepL-Auth-Key abc:fx');
      expect(body.target_lang).toBe('PT-BR');
      return Response.json({ translations: body.text.map((t) => ({ text: `pt ${t}` })) });
    });
    const p = new DeepLTranslationProvider('abc:fx');
    expect(p.model).toBe('deepl-free');
    const raw = await p.translate(req(3));
    expect(fn).toHaveBeenCalledTimes(1);
    const v = validateTranslation(raw, [0, 2, 4]);
    expect(v.ok && [...v.byIndex.values()]).toEqual(['pt line 0', 'pt line 1', 'pt line 2']);
  });

  it('uses the Pro endpoint for other keys', async () => {
    mockFetch((body, url) => {
      expect(url).toBe('https://api.deepl.com/v2/translate');
      return Response.json({ translations: body.text.map((text) => ({ text })) });
    });
    await new DeepLTranslationProvider('abc').translate(req(1));
  });

  it('splits into batches of 50 texts keeping the indices', async () => {
    const fn = mockFetch((body) => Response.json({ translations: body.text.map((t) => ({ text: t.toUpperCase() })) }));
    const raw = await new DeepLTranslationProvider('k:fx').translate(req(120));
    expect(fn).toHaveBeenCalledTimes(3);
    const v = validateTranslation(raw, Array.from({ length: 120 }, (_, k) => k * 2));
    expect(v.ok && v.byIndex.get(238)).toBe('LINE 119');
  });

  it('a response with fewer lines is rejected by validation', async () => {
    mockFetch(() => Response.json({ translations: [{ text: 'just one' }] }));
    const raw = await new DeepLTranslationProvider('k:fx').translate(req(2));
    expect(validateTranslation(raw, [0, 2]).ok).toBe(false);
  });

  it.each([
    [403, 'translation_auth'],
    [456, 'translation_quota'],
    [400, 'translation_failed'],
  ])('HTTP %i becomes error %s', async (status, code) => {
    mockFetch(() => new Response('{}', { status }));
    await expect(new DeepLTranslationProvider('k:fx').translate(req(1))).rejects.toMatchObject({ code });
  });
});
