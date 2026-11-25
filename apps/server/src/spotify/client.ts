import type { ControlErrorBody, DeviceInfo, PlaybackSnapshot, SearchPage, TrackInfo } from '@lyricsync/shared';
import { AppError, RateLimitedError, fetchWithBackoff, parseRetryAfter } from '../lib/http.ts';
import type { SessionRow } from '../storage/repos.ts';
import { AuthFlowError, AUTH_ERROR_MESSAGES, classifyForbidden, type SpotifyAuth } from './auth.ts';
import { IDLE_SNAPSHOT, mapCurrentlyPlaying, mapDevice, mapTrack, type SpCurrentlyPlaying, type SpDevice, type SpTrack } from './mappers.ts';

const API = 'https://api.spotify.com/v1';
const DEVICE_TTL_MS = 30_000;
const SEARCH_PAGE_SIZE = 10; // current Spotify search limit per page

interface RequestOpts {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Wait for short Retry-After values inside the request (false = return 429 immediately). */
  waitOnRateLimit?: boolean;
}

interface SpResponse {
  status: number;
  text: string;
}

/**
 * Per-session Spotify Web API client.
 * - 401 → refreshes the token once and retries.
 * - 429 → honors Retry-After and keeps a per-user "cooldown": while it lasts,
 *   no call goes out to Spotify (we return 429 with the remaining time).
 */
export function createSpotifyClient(auth: SpotifyAuth) {
  const cooldownUntil = new Map<string, number>();
  const deviceCache = new Map<string, { at: number; device: DeviceInfo | null; privateSession: boolean }>();

  async function call(session: SessionRow, method: string, path: string, opts: RequestOpts = {}): Promise<SpResponse> {
    const blocked = cooldownUntil.get(session.user_id) ?? 0;
    if (blocked > Date.now()) throw new RateLimitedError(blocked - Date.now(), 'O Spotify');

    const url = new URL(API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      const token = await auth.accessToken(session, attempt > 0);
      let res: Response;
      try {
        res = await fetchWithBackoff(
          url,
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          },
          { service: 'O Spotify', retries: opts.waitOnRateLimit ? 3 : 1, maxWaitMs: opts.waitOnRateLimit ? 5000 : 0 },
        );
      } catch (e) {
        if (e instanceof RateLimitedError) {
          cooldownUntil.set(session.user_id, Date.now() + (e.retryAfterMs ?? 5000));
        }
        throw e;
      }
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'));
        cooldownUntil.set(session.user_id, Date.now() + wait);
        throw new RateLimitedError(wait, 'O Spotify');
      }
      return { status: res.status, text: await res.text() };
    }
  }

  function parse<T>(r: SpResponse): T {
    return JSON.parse(r.text) as T;
  }

  function apiError(r: SpResponse): AppError {
    if (r.status === 401) return new AppError(401, 'session_expired', AUTH_ERROR_MESSAGES.session_expired);
    if (r.status === 403) {
      const code = classifyForbidden(r.text);
      return new AppError(403, code, AUTH_ERROR_MESSAGES[code]);
    }
    return new AppError(502, 'spotify_error', `Spotify responded with error ${r.status}.`);
  }

  async function device(session: SessionRow, fresh = false): Promise<{ device: DeviceInfo | null; privateSession: boolean }> {
    const cached = deviceCache.get(session.id_hash);
    if (!fresh && cached && Date.now() - cached.at < DEVICE_TTL_MS) return cached;
    const r = await call(session, 'GET', '/me/player');
    let entry = { at: Date.now(), device: null as DeviceInfo | null, privateSession: false };
    if (r.status === 200 && r.text) {
      const body = parse<{ device?: SpDevice }>(r);
      entry = { at: Date.now(), device: mapDevice(body.device), privateSession: Boolean(body.device?.is_private_session) };
    } else if (r.status !== 204) {
      throw apiError(r);
    }
    deviceCache.set(session.id_hash, entry);
    return entry;
  }

  async function nowPlaying(session: SessionRow): Promise<PlaybackSnapshot> {
    const r = await call(session, 'GET', '/me/player/currently-playing', { query: { additional_types: 'track,episode' } });
    if (r.status === 204 || (r.status === 200 && !r.text)) {
      // Nothing playing — or a private session (Spotify hides the item). /me/player tells which.
      const d = await device(session).catch(() => ({ device: null, privateSession: false }));
      if (d.privateSession) return { ...IDLE_SNAPSHOT, status: 'private', device: d.device };
      return { ...IDLE_SNAPSHOT, device: d.device };
    }
    if (r.status !== 200) throw apiError(r);
    const cp = parse<SpCurrentlyPlaying>(r);
    const d = await device(session).catch(() => ({ device: null, privateSession: false }));
    return mapCurrentlyPlaying(cp, d.device);
  }

  async function getTrack(session: SessionRow, id: string): Promise<TrackInfo | null> {
    const r = await call(session, 'GET', `/tracks/${encodeURIComponent(id)}`, { waitOnRateLimit: true });
    if (r.status === 404 || r.status === 400) return null;
    if (r.status !== 200) throw apiError(r);
    return mapTrack(parse<SpTrack>(r));
  }

  async function search(session: SessionRow, q: string, offset: number): Promise<SearchPage> {
    const r = await call(session, 'GET', '/search', { query: { q, type: 'track', limit: SEARCH_PAGE_SIZE, offset }, waitOnRateLimit: true });
    if (r.status !== 200) throw apiError(r);
    const body = parse<{ tracks: { items: (SpTrack | null)[]; total: number; offset: number; limit: number; next: string | null } }>(r);
    const items = body.tracks.items.filter((t): t is SpTrack => t !== null).map(mapTrack);
    return { items, offset: body.tracks.offset, limit: body.tracks.limit, total: body.tracks.total, hasMore: body.tracks.next !== null };
  }

  /** Player commands. Maps Spotify 403/404 to readable reasons. */
  async function control(
    session: SessionRow,
    action: 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'volume' | 'play_track',
    arg?: number | string,
  ): Promise<void> {
    let r: SpResponse;
    switch (action) {
      case 'play':
        r = await call(session, 'PUT', '/me/player/play');
        break;
      case 'play_track':
        r = await call(session, 'PUT', '/me/player/play', { body: { uris: [String(arg)] } });
        break;
      case 'pause':
        r = await call(session, 'PUT', '/me/player/pause');
        break;
      case 'next':
        r = await call(session, 'POST', '/me/player/next');
        break;
      case 'previous':
        r = await call(session, 'POST', '/me/player/previous');
        break;
      case 'seek':
        r = await call(session, 'PUT', '/me/player/seek', { query: { position_ms: Math.max(0, Math.round(Number(arg))) } });
        break;
      case 'volume':
        r = await call(session, 'PUT', '/me/player/volume', { query: { volume_percent: Math.max(0, Math.min(100, Math.round(Number(arg)))) } });
        break;
    }
    deviceCache.delete(session.id_hash);
    if (r.status >= 200 && r.status < 300) return;
    throw controlError(r);
  }

  function controlError(r: SpResponse): AppError {
    let reason = '';
    let message = '';
    try {
      const b = JSON.parse(r.text) as { error?: { reason?: string; message?: string } };
      reason = b.error?.reason ?? '';
      message = b.error?.message ?? '';
    } catch {
      /* non-JSON body */
    }
    const make = (status: number, code: ControlErrorBody['error'], msg: string) => new AppError(status, code, msg);
    if (r.status === 404 || reason === 'NO_ACTIVE_DEVICE') {
      return make(409, 'no_active_device', 'No active device. Open Spotify on any device and press play once.');
    }
    if (r.status === 403) {
      if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message)) {
        return make(403, 'premium_required', 'Controlling playback through the Web API requires Spotify Premium on this account.');
      }
      return make(403, 'restricted', 'This device or content does not allow that command right now.');
    }
    if (r.status === 401) return make(401, 'unauthorized', AUTH_ERROR_MESSAGES.session_expired);
    return make(502, 'spotify_error', `O Spotify recusou o comando (HTTP ${r.status}).`);
  }

  return { nowPlaying, getTrack, search, control, device };
}

export type SpotifyClient = ReturnType<typeof createSpotifyClient>;
export { AuthFlowError };
