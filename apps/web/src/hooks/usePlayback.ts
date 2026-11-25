import { useEffect, useMemo, useRef, useState } from 'react';
import { PlaybackTracker, type FetchOutcome, type TrackerState, type Visibility } from '@lyricsync/shared';
import { api, ApiError } from '../lib/api.ts';

function currentVisibility(): Visibility {
  if (document.visibilityState === 'hidden') return 'hidden';
  return document.hasFocus() ? 'focused' : 'visible';
}

/**
 * Keeps a PlaybackTracker running while `enabled` (user connected).
 * `authErrorCode` keeps the reason when the server rejects the session (401/403).
 */
export function usePlayback(enabled: boolean) {
  const authErrorCode = useRef<string | null>(null);
  const tracker = useMemo(
    () =>
      new PlaybackTracker({
        fetchSnapshot: async (): Promise<FetchOutcome> => {
          try {
            return { ok: true, snapshot: await api.now() };
          } catch (e) {
            if (!(e instanceof ApiError)) return { ok: false, kind: 'network', message: 'Unexpected failure.' };
            if (e.status === 429) return { ok: false, kind: 'rate_limited', retryAfterMs: e.retryAfterMs ?? 10_000 };
            if (e.status === 401 || e.code === 'not_allowlisted' || e.code === 'owner_premium_required') {
              authErrorCode.current = e.code;
              return { ok: false, kind: 'unauthorized', message: e.message };
            }
            if (e.status === 0) return { ok: false, kind: 'network', message: e.message };
            return { ok: false, kind: 'server', message: e.message };
          }
        },
        now: () => performance.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
      }),
    [],
  );
  const [state, setState] = useState<TrackerState>(tracker.getState());

  useEffect(() => tracker.subscribe((u) => setState(u.state)), [tracker]);

  useEffect(() => {
    if (!enabled) {
      tracker.stop();
      return;
    }
    authErrorCode.current = null;
    tracker.setVisibility(currentVisibility());
    tracker.start();
    const onVis = () => tracker.setVisibility(currentVisibility());
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('blur', onVis);
    const onOnline = () => tracker.pollSoon(0);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('blur', onVis);
      window.removeEventListener('online', onOnline);
      tracker.stop();
    };
  }, [enabled, tracker]);

  return { tracker, state, authErrorCode };
}
