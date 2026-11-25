export interface TargetLanguage {
  /** BCP-47 code: UI language and lyrics translation target. */
  code: string;
  /** Language name in the language itself (picker). */
  label: string;
  /** Short Geist Mono label in the picker ("PT-BR", "EN"). */
  short: string;
  /** English name sent to the translation model. */
  promptName: string;
  /** ISO 639-3 code returned by franc. */
  franc: string;
  /** UI text direction (ready for RTL in the future). */
  dir: 'ltr' | 'rtl';
}

/**
 * Single list of languages: the same choice sets the UI and the translation target.
 * To add a language: one entry here + apps/web/src/locales/<code>.json
 * (+ the DeepL code in apps/server/src/translation/providers.ts, if you use DeepL).
 */
export const TARGET_LANGUAGES: TargetLanguage[] = [
  { code: 'pt-BR', label: 'Português', short: 'PT-BR', promptName: 'Brazilian Portuguese', franc: 'por', dir: 'ltr' },
  { code: 'en', label: 'English', short: 'EN', promptName: 'English', franc: 'eng', dir: 'ltr' },
  { code: 'es', label: 'Español', short: 'ES', promptName: 'Spanish', franc: 'spa', dir: 'ltr' },
  { code: 'fr', label: 'Français', short: 'FR', promptName: 'French', franc: 'fra', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', short: 'DE', promptName: 'German', franc: 'deu', dir: 'ltr' },
  { code: 'it', label: 'Italiano', short: 'IT', promptName: 'Italian', franc: 'ita', dir: 'ltr' },
  { code: 'ja', label: '日本語', short: 'JA', promptName: 'Japanese', franc: 'jpn', dir: 'ltr' },
  { code: 'ko', label: '한국어', short: 'KO', promptName: 'Korean', franc: 'kor', dir: 'ltr' },
  { code: 'zh-CN', label: '简体中文', short: 'ZH-CN', promptName: 'Simplified Chinese', franc: 'cmn', dir: 'ltr' },
  { code: 'ru', label: 'Русский', short: 'RU', promptName: 'Russian', franc: 'rus', dir: 'ltr' },
];

export const DEFAULT_LANGUAGE = 'pt-BR';

export function findTargetLanguage(code: string): TargetLanguage | undefined {
  return TARGET_LANGUAGES.find((l) => l.code === code);
}

/** Readable names for the ISO 639-3 codes we detect. */
export const DETECTED_LANGUAGE_NAMES: Record<string, string> = {
  por: 'Portuguese',
  eng: 'English',
  spa: 'espanhol',
  fra: 'French',
  ita: 'italiano',
  deu: 'German',
  jpn: 'Japanese',
  kor: 'coreano',
  cmn: 'Chinese',
  rus: 'russo',
  nld: 'Dutch',
  swe: 'sueco',
  pol: 'Polish',
  tur: 'turco',
  ara: 'Arabic',
  hin: 'hindi',
  tgl: 'tagalo',
  ind: 'Indonesian',
};
