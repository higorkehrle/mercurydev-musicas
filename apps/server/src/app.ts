import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {

  OFFSET_LIMIT_MS,
  TARGET_LANGUAGES,
  findTargetLanguage,
  type AuthStatus,
  type LyricsProvider,
  type Settings,
  type TrackInfo,
  type TrackView,
} from '@lyricsync/shared';
import { config } from './config.ts';
import { AppError } from './lib/http.ts';
import { loggerOptions } from './lib/logger.ts';
import { LrclibProvider } from './lyrics/lrclib.ts';
import { MusixmatchProvider } from './lyrics/musixmatch.ts';
import { createLyricsService } from './lyrics/service.ts';
import { AUTH_ERROR_MESSAGES, AuthFlowError, createSpotifyAuth } from './spotify/auth.ts';
import { createSpotifyClient } from './spotify/client.ts';
import { openDatabase } from './storage/db.ts';
import { createRepos, type SessionRow } from './storage/repos.ts';
import { createTranslationProvider } from './translation/providers.ts';
import { createTranslationService } from './translation/service.ts';

const SESSION_COOKIE = 'ls_sid';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 60; // 60 days

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
  }
}

export async function buildApp(opts: { databasePath?: string } = {}) {
  const app = Fastify({ logger: loggerOptions, trustProxy: false });

  const db = openDatabase(opts.databasePath ?? config.databasePath);
  const repos = createRepos(db);
  repos.sessions.purgeStale(Date.now() - SESSION_MAX_AGE_S * 1000);

  const auth = createSpotifyAuth(repos);
  const spotify = createSpotifyClient(auth);
  const providers: LyricsProvider[] = [new LrclibProvider()];
  if (config.musixmatchApiKey) providers.push(new MusixmatchProvider(config.musixmatchApiKey));
  const lyrics = createLyricsService(repos, providers);
  const translation = createTranslationService(repos, createTranslationProvider(), app.log);

  if (config.problems.length) {
    for (const p of config.problems) app.log.warn({ msg: 'incomplete configuration', problem: p });
  }

  await app.register(cookie);

  // ------------------------------------------------------------------ errors

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterMs !== undefined) reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000));
      return reply.status(err.status).send({ error: err.code, message: err.message, retryAfterMs: err.retryAfterMs });
    }
    if (err instanceof AuthFlowError) {
      const status = err.code === 'session_expired' ? 401 : err.code === 'config_missing' ? 503 : 403;
      return reply.status(status).send({ error: err.code, message: err.message || AUTH_ERROR_MESSAGES[err.code] });
    }
    const e = err as { statusCode?: number; message?: string; validation?: unknown };
    if (e.validation || e.statusCode === 400) return reply.status(400).send({ error: 'bad_request', message: e.message ?? 'Invalid request.' });
    req.log.error({ msg: 'unexpected error', err: e.message });
    return reply.status(500).send({ error: 'internal', message: 'Internal server error.' });
  });

  // ------------------------------------------------------------------ session and CSRF
  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    req.session = auth.findSession(req.cookies[SESSION_COOKIE]);
    // Mutations only from the app origin (SameSite=Lax + Origin check).
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin !== config.webOrigin) throw new AppError(403, 'bad_origin', 'Request origin not allowed.');
    }
  });

  function requireSession(req: FastifyRequest): SessionRow {
    if (!req.session) throw new AppError(401, 'not_connected', 'Connect your Spotify account.');
    return req.session;
  }

  function setSessionCookie(reply: FastifyReply, id: string) {
    reply.setCookie(SESSION_COOKIE, id, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S });
  }

  // ------------------------------------------------------------------ auth
  app.get('/login', async (_req, reply) => {
    try {
      const { url } = auth.beginLogin();
      return reply.redirect(url);
    } catch (e) {
      const code = e instanceof AuthFlowError ? e.code : 'spotify_unavailable';
      return reply.redirect(`${config.webOrigin}/?auth_error=${code}`);
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    if (error) return reply.redirect(`${config.webOrigin}/?auth_error=${error === 'access_denied' ? 'access_denied' : 'token_exchange_failed'}`);
    if (!code || !state) return reply.redirect(`${config.webOrigin}/?auth_error=state_mismatch`);
    try {
      const { sessionId, user } = await auth.completeLogin(state, code);
      setSessionCookie(reply, sessionId);
      req.log.info({ msg: 'login completed', user: user.id });
      return reply.redirect(`${config.webOrigin}/`);
    } catch (e) {
      const codeOut = e instanceof AuthFlowError ? e.code : 'spotify_unavailable';
      req.log.warn({ msg: 'login falhou', code: codeOut });
      return reply.redirect(`${config.webOrigin}/?auth_error=${codeOut}`);
    }
  });

  app.get('/api/auth/status', async (req): Promise<AuthStatus> => {
    if (config.problems.length) {
      return { state: 'error', user: null, error: { code: 'config_missing', message: `${AUTH_ERROR_MESSAGES.config_missing} ${config.problems.join(' ')}` } };
    }
    const s = req.session;
    if (!s) return { state: 'disconnected', user: null, error: null };
    repos.sessions.touch(s.id_hash);
    return { state: 'connected', user: { id: s.user_id, displayName: s.display_name ?? s.user_id, product: s.product, avatarUrl: s.avatar_url }, error: null };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (id) auth.logout(id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/meta', async () => ({
    translation: translation.available ? { provider: config.translation.provider, model: config.translation.model } : null,
    lyricsProviders: providers.map((p) => p.id),
    languages: TARGET_LANGUAGES.map(({ code, label }) => ({ code, label })),
  }));

  // ------------------------------------------------------------------ player
  const lastTrackKey = new Map<string, string>();

  // Polled every ~3s: request logs only at warn level.
  app.get('/api/player/now', { logLevel: 'warn' }, async (req) => {
    const s = requireSession(req);
    const snap = await spotify.nowPlaying(s);
    if (snap.track && lastTrackKey.get(s.id_hash) !== snap.track.key) {
      repos.tracks.upsert(snap.track);
      lastTrackKey.set(s.id_hash, snap.track.key);
    }
    return snap;
  });

  app.post<{ Params: { action: string }; Body: { positionMs?: number; volumePercent?: number; uri?: string } | undefined }>(
    '/api/player/:action',
    async (req) => {
      const s = requireSession(req);
      const body = req.body ?? {};
      switch (req.params.action) {
        case 'play':
        case 'pause':
        case 'next':
        case 'previous':
          await spotify.control(s, req.params.action);
          break;
        case 'seek':
          if (typeof body.positionMs !== 'number') throw new AppError(400, 'bad_request', 'positionMs is required.');
          await spotify.control(s, 'seek', body.positionMs);
          break;
        case 'volume':
          if (typeof body.volumePercent !== 'number') throw new AppError(400, 'bad_request', 'volumePercent is required.');
          await spotify.control(s, 'volume', body.volumePercent);
          break;
        case 'play-track':
          if (typeof body.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]+$/.test(body.uri)) throw new AppError(400, 'bad_request', 'Invalid uri.');
          await spotify.control(s, 'play_track', body.uri);
          break;
        default:
          throw new AppError(404, 'not_found', 'Unknown action.');
      }
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ tracks, lyrics and translation
  async function loadTrack(s: SessionRow, key: string): Promise<TrackInfo> {
    const known = repos.tracks.get(key);
    if (known) return known;
    if (/^[A-Za-z0-9]{22}$/.test(key)) {
      const t = await spotify.getTrack(s, key);
      if (t) {
        repos.tracks.upsert(t);
        return t;
      }
    }
    throw new AppError(404, 'track_not_found', 'Faixa desconhecida.');
  }

  async function buildView(s: SessionRow, track: TrackInfo, lyricsResult?: Awaited<ReturnType<typeof lyrics.resolve>>): Promise<TrackView> {
    const result = lyricsResult ?? (await lyrics.resolve(track));
    const settings = repos.settings.get(s.user_id);
    const timings = repos.sync.getTimings(s.user_id, track.key);
    const validTimings = result.status === 'found' && timings && timings.lyricsHash === result.lyricsHash && timings.starts.length === result.lines.length ? timings : null;
    return {
      track,
      lyrics: result,
      manualTimings: validTimings,
      offsetMs: repos.sync.getOffset(s.user_id, track.key) ?? settings.defaultOffsetMs,
      isFavorite: repos.library.isFavorite(s.user_id, track.key),
    };
  }

  app.get<{ Params: { key: string }; Querystring: { record?: string } }>('/api/tracks/:key', async (req) => {
    const s = requireSession(req);
    const track = await loadTrack(s, req.params.key);
    const view = await buildView(s, track);
    if (req.query.record !== '0') repos.library.recordView(s.user_id, track.key);
    return view;
  });

  app.get<{ Params: { key: string }; Querystring: { lang?: string; refresh?: string } }>('/api/tracks/:key/translation', async (req) => {
    const s = requireSession(req);
    const track = await loadTrack(s, req.params.key);
    const result = await lyrics.resolve(track);
    if (result.status !== 'found') throw new AppError(409, 'no_lyrics', 'There are no lyrics to translate.');
    const lang = req.query.lang ?? repos.settings.get(s.user_id).targetLang;
    return translation.translate(track, result.lines, result.lyricsHash, lang, { refresh: req.query.refresh === '1' });
  });

  app.get<{ Params: { key: string } }>('/api/tracks/:key/candidates', async (req) => {
    const s = requireSession(req);
    return lyrics.candidates(await loadTrack(s, req.params.key));
  });

  app.post<{ Params: { key: string }; Body: { candidateId?: string | null } }>('/api/tracks/:key/lyrics-choice', async (req) => {
    const s = requireSession(req);
    const track = await loadTrack(s, req.params.key);
    const id = req.body?.candidateId;
    const result = id ? await lyrics.choose(track, String(id)) : await lyrics.resetChoice(track);
    return buildView(s, track, result);
  });

  app.put<{ Params: { key: string }; Body: { offsetMs?: number | null } }>('/api/tracks/:key/offset', async (req) => {
    const s = requireSession(req);
    const v = req.body?.offsetMs;
    if (v === null || v === undefined) {
      repos.sync.clearOffset(s.user_id, req.params.key);
      return { offsetMs: repos.settings.get(s.user_id).defaultOffsetMs };
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new AppError(400, 'bad_request', 'Invalid offsetMs.');
    return { offsetMs: repos.sync.setOffset(s.user_id, req.params.key, v) };
  });

  app.put<{ Params: { key: string }; Body: { lyricsHash?: string; starts?: unknown } }>('/api/tracks/:key/timings', async (req) => {
    const s = requireSession(req);
    const track = await loadTrack(s, req.params.key);
    const result = await lyrics.resolve(track);
    const { lyricsHash, starts } = req.body ?? {};
    if (result.status !== 'found' || lyricsHash !== result.lyricsHash) throw new AppError(409, 'lyrics_changed', 'The lyrics changed since syncing started.');
    if (!Array.isArray(starts) || starts.length !== result.lines.length || !starts.every((x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0))) {
      throw new AppError(400, 'bad_request', 'Invalid timings.');
    }
    // Timings must increase in line order.
    let last = -1;
    for (const x of starts as (number | null)[]) {
      if (x === null) continue;
      if (x < last) throw new AppError(400, 'bad_request', 'Os tempos precisam estar em ordem crescente.');
      last = x;
    }
    const timings = { lyricsHash, starts: (starts as (number | null)[]).map((x) => (x === null ? null : Math.round(x))), updatedAt: Date.now() };
    repos.sync.setTimings(s.user_id, track.key, timings);
    return timings;
  });

  app.delete<{ Params: { key: string } }>('/api/tracks/:key/timings', async (req) => {
    const s = requireSession(req);
    repos.sync.clearTimings(s.user_id, req.params.key);
    return { ok: true };
  });

  app.put<{ Params: { key: string }; Body: { favorite?: boolean } }>('/api/tracks/:key/favorite', async (req) => {
    const s = requireSession(req);
    const track = await loadTrack(s, req.params.key);
    repos.library.setFavorite(s.user_id, track.key, Boolean(req.body?.favorite));
    return { isFavorite: Boolean(req.body?.favorite) };
  });

  // ------------------------------------------------------------------ library, search, settings
  app.get('/api/library/history', async (req) => repos.library.history(requireSession(req).user_id, 100));
  app.delete('/api/library/history', async (req) => {
    repos.library.clearHistory(requireSession(req).user_id);
    return { ok: true };
  });
  app.get('/api/library/favorites', async (req) => repos.library.favorites(requireSession(req).user_id));

  app.get<{ Querystring: { q?: string; offset?: string } }>('/api/search', async (req) => {
    const s = requireSession(req);
    const q = (req.query.q ?? '').trim();
    if (!q) throw new AppError(400, 'bad_request', 'Type something to search for.');
    const offset = Math.max(0, Math.min(1000, Number(req.query.offset ?? 0) || 0));
    const page = await spotify.search(s, q.slice(0, 200), offset);
    repos.tracks.upsertMany(page.items);
    return page;
  });

  app.get('/api/settings', async (req) => repos.settings.get(requireSession(req).user_id));

  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
    const s = requireSession(req);
    const cur = repos.settings.get(s.user_id);
    const b = req.body ?? {};
    const clamp = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
    const next: Settings = {
      targetLang: typeof b.targetLang === 'string' && findTargetLanguage(b.targetLang) ? b.targetLang : cur.targetLang,
      showTranslation: typeof b.showTranslation === 'boolean' ? b.showTranslation : cur.showTranslation,
      fontScale: clamp(b.fontScale, 0.8, 1.6, cur.fontScale),
      unsyncedAutoScroll: typeof b.unsyncedAutoScroll === 'boolean' ? b.unsyncedAutoScroll : cur.unsyncedAutoScroll,
      unsyncedScrollSpeed: clamp(b.unsyncedScrollSpeed, 0.5, 1.5, cur.unsyncedScrollSpeed),
      defaultOffsetMs: Math.round(clamp(b.defaultOffsetMs, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS, cur.defaultOffsetMs) / 100) * 100,
    };
    repos.settings.put(s.user_id, next);
    return next;
  });

  // ------------------------------------------------------------------ frontend (production build)
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Route not found.' });
    });
  }

  app.addHook('onClose', async () => db.close());
  return app;
}
