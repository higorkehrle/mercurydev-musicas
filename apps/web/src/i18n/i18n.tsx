import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DEFAULT_LANGUAGE, TARGET_LANGUAGES, findTargetLanguage } from '@lyricsync/shared';
import ptBR from '../locales/pt-BR.json';

/**
 * Dependency-free i18n: one flat JSON dictionary per language in src/locales/<code>.json.
 * pt-BR is the source of truth and the fallback; the others are lazy-loaded.
 *
 * - t("group.key", { name: 'x' }) interpolates {name}.
 * - t("group.key", { count: 3 }) looks up 'key.<Intl.PluralRules category>' and falls back to 'key.other'.
 * - key missing in the current language → pt-BR; missing in pt-BR → the key itself (+ a dev warning).
 */

export type Dict = Record<string, string>;
export type Vars = Record<string, string | number>;

const STORAGE_KEY = 'mercurydev-musicas:lang';
const FALLBACK = ptBR as Dict;
const loaders = import.meta.glob<Dict>(['../locales/*.json', '!../locales/pt-BR.json'], { import: 'default' });
const cache = new Map<string, Dict>([[DEFAULT_LANGUAGE, FALLBACK]]);

let current = { lang: DEFAULT_LANGUAGE, dict: FALLBACK };
const warned = new Set<string>();

export function isSupported(code: string | null | undefined): code is string {
  return Boolean(code && findTargetLanguage(code));
}

export function readStoredLang(): string {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (isSupported(v)) return v;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_LANGUAGE;
}

function storeLang(code: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* keep it in memory only */
  }
}

export async function loadDict(code: string): Promise<Dict> {
  const hit = cache.get(code);
  if (hit) return hit;
  const loader = loaders[`../locales/${code}.json`];
  const dict = loader ? await loader() : FALLBACK;
  cache.set(code, dict);
  return dict;
}

function pick(dict: Dict, key: string): string | undefined {
  return dict[key] ?? FALLBACK[key];
}

function interpolate(s: string, vars?: Vars, lang = current.lang): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined) return m;
    return typeof v === 'number' ? new Intl.NumberFormat(lang).format(v) : v;
  });
}

function translateWith(lang: string, dict: Dict, key: string, vars?: Vars): string {
  let s: string | undefined;
  if (vars && typeof vars.count === 'number') {
    const cat = new Intl.PluralRules(lang).select(vars.count);
    // an explicit "zero" wins (e.g. "no songs" instead of "0 songs")
    if (vars.count === 0) s = dict[`${key}.zero`];
    s ??= dict[`${key}.${cat}`] ?? dict[`${key}.other`] ?? FALLBACK[`${key}.${new Intl.PluralRules(DEFAULT_LANGUAGE).select(vars.count)}`] ?? FALLBACK[`${key}.other`];
  }
  s ??= pick(dict, key);
  if (s === undefined) {
    if (import.meta.env.DEV && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] chave ausente: ${key}`);
    }
    return key;
  }
  return interpolate(s, vars, lang);
}

/** Translation outside components (error messages, modules). Uses the active language. */
export function translate(key: string, vars?: Vars): string {
  return translateWith(current.lang, current.dict, key, vars);
}

/** Is there text for this key (in the current language or the fallback)? Useful for dynamic codes. */
export function hasKey(key: string): boolean {
  return pick(current.dict, key) !== undefined;
}

function applyDocument(lang: string, dict: Dict) {
  const meta = findTargetLanguage(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = meta?.dir ?? 'ltr';
  document.title = translateWith(lang, dict, 'app.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', translateWith(lang, dict, 'app.description'));
}

/** Called before the first render: loads the right dictionary so the wrong language never flashes. */
export async function bootI18n(): Promise<string> {
  const lang = readStoredLang();
  const dict = await loadDict(lang);
  current = { lang, dict };
  applyDocument(lang, dict);
  return lang;
}

// ------------------------------------------------------------------ formatting (Intl)

export function makeFormat(lang: string) {
  const num1 = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  const dateFmt = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  let langNames: Intl.DisplayNames | null = null;
  try {
    langNames = new Intl.DisplayNames([lang], { type: 'language' });
  } catch {
    langNames = null;
  }
  return {
    number: (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(lang, opts).format(n),
    /** Sync offset: "+0,3 s" / "+0.3 s". */
    offset: (ms: number) => {
      const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
      return `${sign}${num1.format(Math.abs(ms) / 1000)} s`;
    },
    seconds: (s: number) => `${num1.format(s)} s`,
    /** "há 5 min", "5 min ago", "il y a 5 min"… */
    relative: (ts: number) => {
      const diff = (ts - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (abs < 60) return rtf.format(0, 'second');
      if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
      if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
      return dateFmt.format(ts);
    },
    date: (ts: number) => dateFmt.format(ts),
    /** Name of a detected language (franc ISO 639-3) in the UI language. */
    languageName: (iso3: string) => {
      const two: Record<string, string> = { por: 'pt', eng: 'en', spa: 'es', fra: 'fr', ita: 'it', deu: 'de', jpn: 'ja', kor: 'ko', cmn: 'zh', rus: 'ru', nld: 'nl', swe: 'sv', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', tgl: 'tl', ind: 'id' };
      try {
        return langNames?.of(two[iso3] ?? iso3) ?? iso3;
      } catch {
        return iso3;
      }
    },
  };
}

export type Format = ReturnType<typeof makeFormat>;

// ------------------------------------------------------------------ React context

interface I18nValue {
  lang: string;
  t: (key: string, vars?: Vars) => string;
  fmt: Format;
  /** Switches UI + translation target without reloading the page. */
  setLang: (code: string) => Promise<void>;
}

const Ctx = createContext<I18nValue | null>(null);

export function I18nProvider({ initialLang, children }: { initialLang: string; children: React.ReactNode }) {
  const [state, setState] = useState(() => ({ lang: initialLang, dict: cache.get(initialLang) ?? FALLBACK }));

  const setLang = useCallback(async (code: string) => {
    if (!isSupported(code)) return;
    const dict = await loadDict(code);
    current = { lang: code, dict };
    storeLang(code);
    applyDocument(code, dict);
    setState({ lang: code, dict });
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang: state.lang,
      t: (key, vars) => translateWith(state.lang, state.dict, key, vars),
      fmt: makeFormat(state.lang),
      setLang,
    }),
    [state, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n used outside I18nProvider');
  return v;
}

export const LANGUAGES = TARGET_LANGUAGES;
