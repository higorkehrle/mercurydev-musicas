import { ApiError } from '../lib/api.ts';
import { hasKey, translate } from './i18n.tsx';

/** Translated message for an API error, by code (server text is a technical fallback only). */
export function errorText(e: unknown, fallbackKey = 'errors.generic'): string {
  if (e instanceof ApiError) {
    if (hasKey(`errors.${e.code}`)) return translate(`errors.${e.code}`);
    if (e.status === 429) return translate('errors.rate_limited');
    if (e.status === 0) return translate('errors.offline');
  }
  return translate(fallbackKey);
}

/** Spotify connection errors (AuthErrorCode codes). */
export function authErrorText(code: string | null | undefined): string {
  return code && hasKey(`auth.error.${code}`) ? translate(`auth.error.${code}`) : translate('auth.error.spotify_unavailable');
}
