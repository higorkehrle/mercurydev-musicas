import { describe, expect, it } from 'vitest';
import { PlaybackTracker, type FetchOutcome } from './playbackTracker.ts';
import type { PlaybackSnapshot, TrackInfo } from './types.ts';

function track(key: string, durationMs = 200_000): TrackInfo {
  return { key, id: key, uri: `spotify:track:${key}`, isLocal: false, name: key, artists: ['A'], album: 'B', coverUrl: null, durationMs, isrc: null };
}

function snap(key: string, progressMs: number, isPlaying = true): PlaybackSnapshot {
  return { status: 'active', kind: 'track', isPlaying, progressMs, track: track(key), disallows: [], device: null };
}

function makeTracker() {
  let now = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const t = new PlaybackTracker({
    fetchSnapshot: async (): Promise<FetchOutcome> => ({ ok: true, snapshot: snap('a', 0) }),
    now: () => now,
    setTimer: (fn, ms) => {
      const h = { fn, at: now + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as never);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return { t, setNow: (n: number) => (now = n), timers };
}

describe('PlaybackTracker.ingest', () => {
  it('first response emits track_change', () => {
    const { t } = makeTracker();
    const ev = t.ingest(snap('a', 1000), 0, 100);
    expect(ev).toEqual([{ type: 'track_change', fromKey: null, toKey: 'a' }]);
  });

  it('subtracts half the latency while playing', () => {
    const { t } = makeTracker();
    t.ingest(snap('a', 1000), 0, 200);
    expect(t.getState().anchor?.progressMs).toBe(1100);
    expect(t.estimateProgress(1200)).toBe(2100);
  });

  it('does not subtract latency while paused', () => {
    const { t } = makeTracker();
    t.ingest(snap('a', 1000, false), 0, 200);
    expect(t.estimateProgress(5000)).toBe(1000);
  });

  it('detects a seek above 1.5s', () => {
    const { t } = makeTracker();
    t.ingest(snap('a', 1000), 0, 0);
    expect(t.ingest(snap('a', 4000 + 1400), 3000, 3000)).toEqual([]);
    const ev = t.ingest(snap('a', 60_000), 6000, 6000);
    expect(ev[0]?.type).toBe('seek');
  });

  it('detects pause and play', () => {
    const { t } = makeTracker();
    t.ingest(snap('a', 1000), 0, 0);
    expect(t.ingest(snap('a', 4000, false), 3000, 3000)).toEqual([{ type: 'pause' }]);
    expect(t.ingest(snap('a', 4000, true), 6000, 6000)).toEqual([{ type: 'play' }]);
  });

  it('detects track change and nothing playing', () => {
    const { t } = makeTracker();
    t.ingest(snap('a', 1000), 0, 0);
    expect(t.ingest(snap('b', 0), 3000, 3000)[0]).toEqual({ type: 'track_change', fromKey: 'a', toKey: 'b' });
    const idle: PlaybackSnapshot = { status: 'idle', kind: null, isPlaying: false, progressMs: 0, track: null, disallows: [], device: null };
    expect(t.ingest(idle, 6000, 6000)[0]).toEqual({ type: 'track_change', fromKey: 'b', toKey: null });
    expect(t.getState().anchor).toBeNull();
  });
});

function scripted(outcomes: FetchOutcome[]) {
  let now = 0;
  let timer: { fn: () => void; at: number } | null = null;
  const t = new PlaybackTracker({
    fetchSnapshot: async () => outcomes.shift() ?? { ok: true, snapshot: snap('a', 0) },
    now: () => now,
    setTimer: (fn, ms) => (timer = { fn, at: now + ms }),
    clearTimer: () => (timer = null),
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const fire = async () => {
    const tm = timer!;
    now = tm.at;
    timer = null;
    tm.fn();
    await flush();
  };
  return { t, flush, fire, next: () => timer?.at ?? null, setNow: (n: number) => (now = n) };
}

describe('PlaybackTracker limits and visibility', () => {
  it('429 waits at least Retry-After', async () => {
    const s = scripted([{ ok: false, kind: 'rate_limited', retryAfterMs: 20_000 }]);
    s.t.start();
    await s.flush();
    expect(s.t.getState().connection).toBe('rate_limited');
    expect(s.next()).toBe(20_000);
  });

  it('consecutive failures increase the interval (exponential backoff)', async () => {
    const fail: FetchOutcome = { ok: false, kind: 'network', message: 'x' };
    const s = scripted([fail, fail, fail]);
    s.t.start();
    await s.flush();
    const first = s.next()!;
    await s.fire();
    const second = s.next()! - first;
    await s.fire();
    const third = s.next()! - first - second;
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('suspends when the tab is hidden for a long time and resumes on return', async () => {
    const s = scripted([]);
    s.t.start();
    await s.flush();
    s.t.setVisibility('hidden');
    // Hidden: polls every ~10s until 2 min have passed, then stops.
    let polls = 0;
    while (s.next() !== null && polls < 50) {
      await s.fire();
      polls++;
    }
    expect(polls).toBeGreaterThan(5);
    expect(polls).toBeLessThan(20);
    expect(s.t.getState().connection).toBe('suspended');
    expect(s.next()).toBeNull();
    s.t.setVisibility('focused');
    expect(s.next()).not.toBeNull();
  });

  it('a rejected session stops the polling', async () => {
    const s = scripted([{ ok: false, kind: 'unauthorized', message: 'x' }]);
    s.t.start();
    await s.flush();
    expect(s.t.getState().connection).toBe('unauthorized');
    expect(s.next()).toBeNull();
  });
});

describe('PlaybackTracker schedule', () => {
  it('3s when focused and 10s in the background', async () => {
    const { t, timers } = makeTracker();
    t.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.at(-1)!.at).toBe(3000);
    t.stop();

    const b = makeTracker();
    b.t.setVisibility('visible');
    b.t.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.timers.at(-1)!.at).toBe(10000);
  });
});
