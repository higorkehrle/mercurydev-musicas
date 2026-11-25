import { describe, expect, it } from 'vitest';
import type { LyricsLine, TranslationProvider, TranslationRequest } from '@lyricsync/shared';
import { openDatabase } from '../storage/db.ts';
import { createRepos } from '../storage/repos.ts';
import { detectPredominant, sameLanguageMask } from './detect.ts';
import { createTranslationService, stanzaBlocks } from './service.ts';
import { validateTranslation } from './validate.ts';

const L = (texts: string[]): LyricsLine[] => texts.map((text, index) => ({ index, startMs: index * 1000, endMs: null, text }));

describe('validateTranslation', () => {
  const ok = { translations: [{ i: 0, t: 'a' }, { i: 2, t: 'b' }] };

  it('accepts the same count and the same indices in order', () => {
    const v = validateTranslation(ok, [0, 2]);
    expect(v.ok && [...v.byIndex.entries()]).toEqual([[0, 'a'], [2, 'b']]);
  });

  it('accepts a JSON string', () => {
    expect(validateTranslation(JSON.stringify(ok), [0, 2]).ok).toBe(true);
  });

  it.each([
    ['contagem diferente', { translations: [{ i: 0, t: 'a' }] }],
    ['swapped index', { translations: [{ i: 2, t: 'b' }, { i: 0, t: 'a' }] }],
    ['shifted index', { translations: [{ i: 0, t: 'a' }, { i: 3, t: 'b' }] }],
    ['texto vazio', { translations: [{ i: 0, t: 'a' }, { i: 2, t: '  ' }] }],
    ['missing field', { lines: [] }],
    ['non-integer index', { translations: [{ i: 0, t: 'a' }, { i: 2.5, t: 'b' }] }],
  ])('rejects %s', (_name, raw) => {
    expect(validateTranslation(raw, [0, 2]).ok).toBe(false);
  });

  it('rejects broken JSON', () => {
    expect(validateTranslation('{"translations": [', [0]).ok).toBe(false);
  });
});

describe('stanzaBlocks', () => {
  it('groups by stanza without losing or reordering indices', () => {
    const lines = L(['a', 'b', '', 'c', 'd', 'e', 'f', '', 'g']);
    const toTr = lines.filter((l) => l.text).map((l) => ({ i: l.index, text: l.text }));
    const blocks = stanzaBlocks(lines, toTr);
    expect(blocks.flat().map((x) => x.i)).toEqual(toTr.map((x) => x.i));
    expect(blocks.every((b) => b.length <= 16)).toBe(true);
  });
});

describe('language detection', () => {
  it('marks Portuguese lines in an English song as "already in target"', () => {
    const lines = L([
      'I walked along the empty road tonight',
      'Thinking about the things we left behind',
      'Every single promise that we made',
      'Eu ainda lembro de você todas as noites quando a cidade dorme',
      'And the morning never came for us',
    ]);
    const predominant = detectPredominant(lines);
    expect(predominant).toBe('eng');
    const mask = sameLanguageMask(lines, predominant, 'por');
    expect(mask).toEqual([false, false, false, true, false]);
  });

  it('Portuguese song with an English chorus: translates only the English', () => {
    const lines = L([
      'A janela do quarto ainda guarda a luz da tarde',
      'E cada passo meu na rua lembra a nossa casa',
      'The paper boats are drifting slowly down the river',
      'Que o vento leve embora o que ficou',
    ]);
    const predominant = detectPredominant(lines);
    expect(predominant).toBe('por');
    expect(sameLanguageMask(lines, predominant, 'por')).toEqual([true, true, false, true]);
  });
});

/** Test provider: returns scripted responses (tests only). */
class ScriptedProvider implements TranslationProvider {
  readonly id = 'test';
  readonly model = 'test';
  calls: TranslationRequest[] = [];
  constructor(private readonly respond: (req: TranslationRequest, call: number) => unknown) {}
  async translate(req: TranslationRequest) {
    this.calls.push(req);
    return this.respond(req, this.calls.length);
  }
}

const silentLog = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
const track = { key: 't1', id: 't1', uri: null, isLocal: false, name: 'Song', artists: ['A'], album: 'B', coverUrl: null, durationMs: 1000, isrc: null };
const echo = (req: TranslationRequest) => ({ translations: req.lines.map((l) => ({ i: l.i, t: `PT:${l.text}` })) });

describe('translation service', () => {
  const english = [
    'I walked along the empty road tonight',
    'Paper lanterns in the rain',
    '',
    'Paper lanterns in the rain',
    'Thinking about the things we left behind',
  ];

  it('translates in one call and reuses repeated lines', async () => {
    const p = new ScriptedProvider(echo);
    const svc = createTranslationService(createRepos(openDatabase(':memory:')), p, silentLog);
    const r = await svc.translate(track, L(english), 'h1', 'pt-BR');
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.lines.map((l) => l.i)).toEqual([0, 1, 4]);
    expect(r.status).toBe('translated');
    expect(r.lines[3]).toBe('PT:Paper lanterns in the rain');
    expect(r.lines[2]).toBeNull();
  });

  it('retries once, then falls back to blocks keeping indices', async () => {
    const p = new ScriptedProvider((req, call) => (call <= 2 ? { translations: req.lines.slice(1).map((l) => ({ i: l.i, t: 'x' })) } : echo(req)));
    const svc = createTranslationService(createRepos(openDatabase(':memory:')), p, silentLog);
    const r = await svc.translate(track, L(english), 'h2', 'pt-BR');
    expect(p.calls.length).toBeGreaterThanOrEqual(3);
    expect(p.calls[2]!.partial).toBe(true);
    expect(r.lines[0]).toBe('PT:I walked along the empty road tonight');
    expect(r.lines[4]).toBe('PT:Thinking about the things we left behind');
  });

  it('uses the cache the second time', async () => {
    const p = new ScriptedProvider(echo);
    const svc = createTranslationService(createRepos(openDatabase(':memory:')), p, silentLog);
    await svc.translate(track, L(english), 'h3', 'pt-BR');
    await svc.translate(track, L(english), 'h3', 'pt-BR');
    expect(p.calls).toHaveLength(1);
  });

  it('total failure → status failed, without inventing text', async () => {
    const p = new ScriptedProvider(() => 'not json');
    const svc = createTranslationService(createRepos(openDatabase(':memory:')), p, silentLog);
    const r = await svc.translate(track, L(english), 'h4', 'pt-BR');
    expect(r.status).toBe('failed');
    expect(r.lines.every((x) => x === null)).toBe(true);
  });

  it('no provider configured → unavailable', async () => {
    const svc = createTranslationService(createRepos(openDatabase(':memory:')), null, silentLog);
    expect((await svc.translate(track, L(english), 'h5', 'pt-BR')).status).toBe('unavailable');
  });
});
