import type { AuthErrorCode } from './types.ts';

/** Technical fallback message for each Spotify connection error (the UI uses the i18n dictionaries). */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  config_missing: 'The app is not configured. Check your .env (see the README).',
  access_denied: 'You cancelled the authorization on Spotify.',
  state_mismatch: 'The login attempt expired or came from another tab. Try connecting again.',
  token_exchange_failed: 'Spotify rejected the authorization code exchange. Check SPOTIFY_CLIENT_ID and the Redirect URI registered in the Dashboard.',
  not_allowlisted:
    'Your account is not authorized for this app. In the Spotify Developer Dashboard, open the app → User Management and add your Spotify account name and email.',
  owner_premium_required:
    'Spotify blocked the app: in Development Mode the app owner needs an active Spotify Premium subscription.',
  session_expired: 'Your Spotify session expired or was revoked. Connect again.',
  spotify_unavailable: 'Spotify did not respond. Try again in a moment.',
};
