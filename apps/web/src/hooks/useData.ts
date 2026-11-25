import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type TrackView, type TranslationResult } from '@lyricsync/shared';
import { api, ApiError } from '../lib/api.ts';

export type Load<T> =
  | { status: 'idle' }
  | { status: 'loading'; data?: T }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: ApiError };

const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, 'unknown', 'unknown'));

/** Lyrics + metadata for a track. */
export function useTrackView(key: string | null) {
  const [state, setState] = useState<Load<TrackView>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) {
      setState({ status: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    api
      .track(key, ctrl.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: 'error', error: asApiError(e) });
      });
    return () => ctrl.abort();
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback((fn: (v: TrackView) => TrackView) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', data: fn(s.data) } : s));
  }, []);
  return { state, reload, patch };
}

/** Translation (loads after the lyrics; may take a few seconds the first time). */
export function useTranslation(key: string | null, lyricsHash: string | null, lang: string, enabled: boolean) {
  const [state, setState] = useState<Load<TranslationResult>>({ status: 'idle' });
  const refreshNext = useRef(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key || !lyricsHash || !enabled) {
      setState({ status: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    const refresh = refreshNext.current;
    refreshNext.current = false;
    setState({ status: 'loading' });
    api
      .translation(key, lang, refresh, ctrl.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: 'error', error: asApiError(e) });
      });
    return () => ctrl.abort();
  }, [key, lyricsHash, lang, enabled, nonce]);

  const retry = useCallback(() => {
    refreshNext.current = true;
    setNonce((n) => n + 1);
  }, []);
  return { state, retry };
}

/** Settings persisted on the server (with optimistic updates). */
export function useSettings(connected: boolean) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!connected) return;
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [connected]);

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    try {
      setSettings(await api.saveSettings(patch));
    } catch {
      /* keep the local value; retry on the next change */
    }
  }, []);

  return { settings, update, loaded };
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}
