import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

// .env at the monorepo root (optional — real environment variables take precedence).
const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const SPOTIFY_SCOPES = ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'];
export const APP_VERSION = '0.1.0';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function parseKey(raw: string): Buffer | null {
  if (!raw) return null;
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null;
  const buf = hex ?? Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

const isProd = process.env.NODE_ENV === 'production';
const port = Number(str('PORT', '8787'));
const host = str('HOST', '127.0.0.1');

/** Configuration problems that block login (shown in the UI, never with secrets). */
const problems: string[] = [];

// Placeholder values from .env.example ("your_..._here") count as unset.
const clientId = /^your_/i.test(str('SPOTIFY_CLIENT_ID')) ? '' : str('SPOTIFY_CLIENT_ID');
if (!clientId) problems.push('SPOTIFY_CLIENT_ID is not set in .env.');

const redirectUri = str('SPOTIFY_REDIRECT_URI', `http://127.0.0.1:${port}/callback`);
try {
  const u = new URL(redirectUri);
  if (u.hostname === 'localhost') problems.push('SPOTIFY_REDIRECT_URI cannot use "localhost" — Spotify requires 127.0.0.1.');
  if (u.pathname !== '/callback') problems.push('SPOTIFY_REDIRECT_URI deve terminar em /callback.');
  if (u.protocol === 'http:' && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') {
    problems.push('Spotify only accepts an http SPOTIFY_REDIRECT_URI for loopback addresses (127.0.0.1).');
  }
} catch {
  problems.push('Invalid SPOTIFY_REDIRECT_URI.');
}

const encryptionKey = parseKey(str('TOKEN_ENCRYPTION_KEY'));
if (!encryptionKey) problems.push('TOKEN_ENCRYPTION_KEY is missing or invalid (it must be 32 bytes, hex or base64).');

const webOrigin = str('WEB_ORIGIN', isProd ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173');
if (new URL(webOrigin).hostname === 'localhost') problems.push('WEB_ORIGIN must use 127.0.0.1, not localhost (the session cookie is per host).');

const provider = str('TRANSLATION_PROVIDER', 'none').toLowerCase();

export const config = {
  isProd,
  port,
  host,
  webOrigin,
  logLevel: str('LOG_LEVEL', isProd ? 'info' : 'debug'),
  cookieSecure: str('COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  databasePath: path.resolve(REPO_ROOT, str('DATABASE_PATH', 'data/lyricsync.db')),
  webDist: path.join(REPO_ROOT, 'apps/web/dist'),
  spotify: { clientId, redirectUri },
  encryptionKey,
  problems,
  translation: {
    provider: provider as 'anthropic' | 'openai' | 'deepl' | 'none',
    apiKey: str('TRANSLATION_API_KEY'),
    model:
      provider === 'deepl'
        ? str('TRANSLATION_API_KEY').endsWith(':fx') ? 'deepl-free' : 'deepl-pro'
        : str('TRANSLATION_MODEL', provider === 'anthropic' ? 'claude-opus-5-5' : ''),
    baseUrl: str('TRANSLATION_BASE_URL', 'https://api.openai.com/v1'),
  },
  musixmatchApiKey: str('MUSIXMATCH_API_KEY'),
  /** User-Agent sent to LRCLIB and other public services (no personal data). */
  userAgent: `MercuryDevMusicas/${APP_VERSION} (self-hosted personal lyrics viewer${str('APP_HOMEPAGE') ? `; ${str('APP_HOMEPAGE')}` : ''})`,
};

export type AppConfig = typeof config;
