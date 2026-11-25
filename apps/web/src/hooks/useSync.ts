import { useEffect, useState } from 'react';
import type { PlaybackAnchor, PlaybackTracker, SyncEngine } from '@lyricsync/shared';

/**
 * Connects the PlaybackTracker to the SyncEngine and returns the active line, updated via
 * requestAnimationFrame (re-renders only when the index changes).
 */
export function useSyncedIndex(
  engine: SyncEngine,
  tracker: PlaybackTracker,
  starts: readonly (number | null)[] | null,
  offsetMs: number,
  active: boolean,
): number {
  const [index, setIndex] = useState(-1);

  useEffect(() => {
    engine.setLines(starts ?? []);
  }, [engine, starts]);

  useEffect(() => {
    engine.setOffset(offsetMs);
  }, [engine, offsetMs]);

  useEffect(() => {
    if (!active || !starts) {
      setIndex(-1);
      return;
    }
    let last: PlaybackAnchor | null = tracker.getState().anchor;
    engine.reset();
    if (last) engine.applyAnchor(last, performance.now(), true);

    const unsubscribe = tracker.subscribe(({ state, events }) => {
      if (!state.anchor || state.anchor === last) return;
      last = state.anchor;
      // Seek, track change and pause/play reposition immediately; the rest is a smooth correction.
      engine.applyAnchor(state.anchor, performance.now(), events.length > 0);
    });

    let raf = 0;
    const loop = () => {
      const i = engine.activeIndex(performance.now());
      setIndex((prev) => (prev === i ? prev : i));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [active, engine, tracker, starts]);

  return index;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}
