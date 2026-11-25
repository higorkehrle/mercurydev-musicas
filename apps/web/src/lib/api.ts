import type {
  AuthStatus,
  LibraryEntry,
  LyricsCandidate,
  ManualTimings,
  PlaybackSnapshot,
  SearchPage,
  Settings,
  TrackView,
  TranslationResult,
} from '@lyricsync/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'offline', 'offline');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const b = (data ?? {}) as { error?: string; message?: string; retryAfterMs?: number };
    const retry = b.retryAfterMs ?? (res.headers.get('retry-after') ? Number(res.headers.get('retry-after')) * 1000 : undefined);
    throw new ApiError(res.status, b.error ?? 'http_error', b.message ?? `Error ${res.status}`, retry);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface AppMeta {
  translation: { provider: string; model: string } | null;
  lyricsProviders: string[];
  languages: { code: string; label: string }[];
}

export const api = {
  meta: () => request<AppMeta>('GET', '/api/meta'),
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),

  now: () => request<PlaybackSnapshot>('GET', '/api/player/now'),
  control: (action: 'play' | 'pause' | 'next' | 'previous') => request<{ ok: true }>('POST', `/api/player/${action}`, {}),
  seek: (positionMs: number) => request<{ ok: true }>('POST', '/api/player/seek', { positionMs }),
  volume: (volumePercent: number) => request<{ ok: true }>('POST', '/api/player/volume', { volumePercent }),
  playTrack: (uri: string) => request<{ ok: true }>('POST', '/api/player/play-track', { uri }),

  track: (key: string, signal?: AbortSignal) => request<TrackView>('GET', `/api/tracks/${enc(key)}`, undefined, signal),
  translation: (key: string, lang: string, refresh = false, signal?: AbortSignal) =>
    request<TranslationResult>('GET', `/api/tracks/${enc(key)}/translation?lang=${enc(lang)}${refresh ? '&refresh=1' : ''}`, undefined, signal),
  candidates: (key: string) => request<LyricsCandidate[]>('GET', `/api/tracks/${enc(key)}/candidates`),
  chooseLyrics: (key: string, candidateId: string | null) => request<TrackView>('POST', `/api/tracks/${enc(key)}/lyrics-choice`, { candidateId }),
  setOffset: (key: string, offsetMs: number | null) => request<{ offsetMs: number }>('PUT', `/api/tracks/${enc(key)}/offset`, { offsetMs }),
  saveTimings: (key: string, lyricsHash: string, starts: (number | null)[]) =>
    request<ManualTimings>('PUT', `/api/tracks/${enc(key)}/timings`, { lyricsHash, starts }),
  clearTimings: (key: string) => request<{ ok: true }>('DELETE', `/api/tracks/${enc(key)}/timings`),
  setFavorite: (key: string, favorite: boolean) => request<{ isFavorite: boolean }>('PUT', `/api/tracks/${enc(key)}/favorite`, { favorite }),

  history: () => request<LibraryEntry[]>('GET', '/api/library/history'),
  clearHistory: () => request<{ ok: true }>('DELETE', '/api/library/history'),
  favorites: () => request<LibraryEntry[]>('GET', '/api/library/favorites'),
  search: (q: string, offset: number) => request<SearchPage>('GET', `/api/search?q=${enc(q)}&offset=${offset}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/api/settings', s),
};
