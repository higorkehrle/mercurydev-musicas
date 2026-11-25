import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TARGET_LANGUAGES } from '@lyricsync/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const localesDir = path.join(src, 'locales');
const load = (code: string) => JSON.parse(readFileSync(path.join(localesDir, `${code}.json`), 'utf8')) as Record<string, string>;
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const base = (k: string) => k.replace(PLURAL, '');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const pt = load('pt-BR');
const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

describe('language dictionaries', () => {
  it('there is a dictionary for every TARGET_LANGUAGES entry', () => {
    for (const l of TARGET_LANGUAGES) expect(files, l.code).toContain(`${l.code}.json`);
  });

  for (const file of files) {
    const code = file.replace('.json', '');
    if (code === 'pt-BR') continue;
    const dict = load(code);

    it(`${code}: has exactly the pt-BR keys (plural forms per language)`, () => {
      const want = new Set(Object.keys(pt).map(base));
      const got = new Set(Object.keys(dict).map(base));
      expect([...want].filter((k) => !got.has(k)), 'faltando').toEqual([]);
      expect([...got].filter((k) => !want.has(k)), 'sobrando').toEqual([]);
      // every plural key needs the "other" form (Intl.PluralRules fallback)
      for (const k of Object.keys(dict).filter((k) => PLURAL.test(k))) expect(dict[`${base(k)}.other`], k).toBeDefined();
    });

    it(`${code}: keeps the same {placeholders}`, () => {
      for (const [k, v] of Object.entries(dict)) {
        const ref = pt[k] ?? pt[`${base(k)}.other`];
        expect(placeholders(v), k).toEqual(placeholders(ref!));
      }
    });

    it(`${code}: no empty strings`, () => {
      for (const [k, v] of Object.entries(dict)) expect(v.trim().length, k).toBeGreaterThan(0);
    });
  }
});

describe('keys used in the code', () => {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|ts)$/.test(e.name) && !e.name.endsWith('.test.ts')) sources.push(readFileSync(p, 'utf8'));
    }
  };
  walk(src);
  const code = sources.join('\n');

  it('every literal key in t()/translate()/errorText() exists in pt-BR', () => {
    const used = new Set<string>();
    for (const m of code.matchAll(/\b(?:t|translate)\(\s*'([\w.-]+)'/g)) used.add(m[1]!);
    for (const m of code.matchAll(/\bt\(\s*\w+\s*\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'/g)) used.add(m[1]!).add(m[2]!);
    for (const m of code.matchAll(/errorText\([^,)]+,\s*'([\w.-]+)'\)/g)) used.add(m[1]!);
    const missing = [...used].filter((k) => !(k in pt) && !(`${k}.other` in pt));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(200);
  });

  it('dynamic key families are complete', () => {
    const families: Record<string, string[]> = {
      'auth.error': ['config_missing', 'access_denied', 'state_mismatch', 'token_exchange_failed', 'not_allowlisted', 'owner_premium_required', 'session_expired', 'spotify_unavailable'],
      'onb.scope': ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'],
      'vis.scene': ['spectrum', 'fluid', 'particles', 'scope', 'geometry', 'vector'],
      'vis.hint': ['spectrum', 'fluid', 'particles', 'scope', 'geometry', 'vector'],
      'audio.err': ['denied_system', 'denied_mic', 'not_found', 'unsupported', 'no_audio'],
    };
    for (const [prefix, ids] of Object.entries(families)) for (const id of ids) expect(pt[`${prefix}.${id}`], `${prefix}.${id}`).toBeDefined();
  });
});
