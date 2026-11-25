import { AUTH_ERROR_MESSAGES, type AuthErrorCode, type SpotifyUser } from '@lyricsync/shared';
import { config, SPOTIFY_SCOPES } from '../config.ts';
import { decrypt, encrypt, pkceChallenge, randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, fetchWithBackoff } from '../lib/http.ts';
import type { Repos, SessionRow } from '../storage/repos.ts';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const PENDING_TTL_MS = 10 * 60_000;
/** Refresh the access token when less than this remains before expiry. */
const REFRESH_MARGIN_MS = 90_000;

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export class AuthFlowError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message);
  }
}

export { AUTH_ERROR_MESSAGES };

/** Classifies Spotify's 403 for accounts outside the allowlist / owner without Premium. */
export function classifyForbidden(body: string): AuthErrorCode {
  return /premium/i.test(body) ? 'owner_premium_required' : 'not_allowlisted';
}

interface Pending {
  verifier: string;
  createdAt: number;
}

export function createSpotifyAuth(repos: Repos) {
  const pending = new Map<string, Pending>();
  const refreshing = new Map<string, Promise<string>>();
  const key = () => {
    if (!config.encryptionKey) throw new AuthFlowError('config_missing', AUTH_ERROR_MESSAGES.config_missing);
    return config.encryptionKey;
  };

  function prunePending() {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  }

  function beginLogin(): { url: string; state: string } {
    if (config.problems.length) throw new AuthFlowError('config_missing', AUTH_ERROR_MESSAGES.config_missing);
    prunePending();
    const state = randomToken(16);
    const verifier = randomToken(64);
    pending.set(state, { verifier, createdAt: Date.now() });
    const url = new URL(`${ACCOUNTS}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.spotify.clientId,
      scope: SPOTIFY_SCOPES.join(' '),
      redirect_uri: config.spotify.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier),
    }).toString();
    return { url: url.toString(), state };
  }

  async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const res = await fetchWithBackoff(
      `${ACCOUNTS}/api/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.spotify.clientId, ...body }),
      },
      { service: 'Spotify Accounts', retries: 2 },
    );
    if (!res.ok) {
      const text = await res.text();
      let err = '';
      try {
        err = (JSON.parse(text) as { error?: string }).error ?? '';
      } catch {
        /* non-JSON body */
      }
      if (body.grant_type === 'refresh_token' && (err === 'invalid_grant' || res.status === 400 || res.status === 401)) {
        throw new AuthFlowError('session_expired', AUTH_ERROR_MESSAGES.session_expired);
      }
      throw new AuthFlowError('token_exchange_failed', AUTH_ERROR_MESSAGES.token_exchange_failed);
    }
    return (await res.json()) as TokenResponse;
  }

  async function fetchMe(accessToken: string): Promise<SpotifyUser> {
    const res = await fetchWithBackoff(`${API}/me`, { headers: { authorization: `Bearer ${accessToken}` } }, { service: 'Spotify' });
    if (res.status === 403) throw new AuthFlowError(classifyForbidden(await res.text()), '');
    if (!res.ok) throw new AuthFlowError('spotify_unavailable', AUTH_ERROR_MESSAGES.spotify_unavailable);
    const me = (await res.json()) as { id: string; display_name: string | null; product?: string; images?: { url: string }[] };
    return { id: me.id, displayName: me.display_name ?? me.id, product: me.product ?? null, avatarUrl: me.images?.[0]?.url ?? null };
  }

  /** Completes the callback: exchanges the code, validates the account and creates the session. Returns the session id (cookie). */
  async function completeLogin(state: string, code: string): Promise<{ sessionId: string; user: SpotifyUser }> {
    prunePending();
    const p = pending.get(state);
    pending.delete(state);
    if (!p) throw new AuthFlowError('state_mismatch', AUTH_ERROR_MESSAGES.state_mismatch);
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.spotify.redirectUri, code_verifier: p.verifier });
    if (!tokens.refresh_token) throw new AuthFlowError('token_exchange_failed', AUTH_ERROR_MESSAGES.token_exchange_failed);
    let user: SpotifyUser;
    try {
      user = await fetchMe(tokens.access_token);
    } catch (e) {
      if (e instanceof AuthFlowError && !e.message) throw new AuthFlowError(e.code, AUTH_ERROR_MESSAGES[e.code]);
      throw e;
    }
    const sessionId = randomToken(32);
    const now = Date.now();
    repos.sessions.insert({
      id_hash: sha256(sessionId),
      user_id: user.id,
      display_name: user.displayName,
      product: user.product,
      avatar_url: user.avatarUrl,
      access_enc: encrypt(tokens.access_token, key()),
      refresh_enc: encrypt(tokens.refresh_token, key()),
      expires_at: now + tokens.expires_in * 1000,
      created_at: now,
      last_seen_at: now,
    });
    return { sessionId, user };
  }

  /** Valid access token for the session, refreshed before expiry (one refresh at a time). */
  async function accessToken(session: SessionRow, force = false): Promise<string> {
    if (!force && session.expires_at - Date.now() > REFRESH_MARGIN_MS) return decrypt(session.access_enc, key());
    const inflight = refreshing.get(session.id_hash);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const current = repos.sessions.get(session.id_hash);
        if (!current) throw new AuthFlowError('session_expired', AUTH_ERROR_MESSAGES.session_expired);
        if (!force && current.expires_at - Date.now() > REFRESH_MARGIN_MS) return decrypt(current.access_enc, key());
        const refreshToken = decrypt(current.refresh_enc, key());
        let tokens: TokenResponse;
        try {
          tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
        } catch (e) {
          if (e instanceof AuthFlowError && e.code === 'session_expired') repos.sessions.delete(session.id_hash);
          throw e;
        }
        const accessEnc = encrypt(tokens.access_token, key());
        // With PKCE Spotify may return a new refresh token (the old one stops working).
        const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token, key()) : current.refresh_enc;
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        repos.sessions.updateTokens(session.id_hash, accessEnc, refreshEnc, expiresAt);
        session.access_enc = accessEnc;
        session.refresh_enc = refreshEnc;
        session.expires_at = expiresAt;
        return tokens.access_token;
      } finally {
        refreshing.delete(session.id_hash);
      }
    })();
    refreshing.set(session.id_hash, p);
    return p;
  }

  function logout(sessionId: string) {
    repos.sessions.delete(sha256(sessionId));
  }

  function findSession(sessionId: string | undefined): SessionRow | null {
    if (!sessionId) return null;
    return repos.sessions.get(sha256(sessionId)) ?? null;
  }

  return { beginLogin, completeLogin, accessToken, logout, findSession };
}

export type SpotifyAuth = ReturnType<typeof createSpotifyAuth>;

export function assertNoProblems() {
  if (config.problems.length) throw new AppError(503, 'config_missing', AUTH_ERROR_MESSAGES.config_missing);
}
