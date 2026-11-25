import type { PlaybackSnapshot } from './types.ts';
import type { PlaybackAnchor } from './syncEngine.ts';

/**
 * PlaybackTracker — periodic "now playing" polling with an adaptive pace.
 *
 * - ~3s with the app focused, ~10s when visible but unfocused / in the background, and stops
 *   entirely when the tab stays hidden for a long time (resumes on return).
 * - Between polls, progress is estimated locally:
 *   progress_ms + (now − response_instant), minus half the latency.
 * - Detects track changes, seeks (> 1.5s between predicted and reported) and pause/play.
 * - On 429 honors Retry-After; on other failures uses exponential backoff.
 *
 * No DOM dependency: clock, timers and fetch are injected (testable).
 */

export type Visibility = 'focused' | 'visible' | 'hidden';

export type FetchOutcome =
  | { ok: true; snapshot: PlaybackSnapshot }
  | { ok: false; kind: 'rate_limited'; retryAfterMs: number }
  | { ok: false; kind: 'unauthorized'; message: string }
  | { ok: false; kind: 'network' | 'server'; message: string };

export type TrackerEvent =
  | { type: 'track_change'; fromKey: string | null; toKey: string | null }
  | { type: 'seek'; fromMs: number; toMs: number }
  | { type: 'pause' }
  | { type: 'play' };

export interface TrackerState {
  snapshot: PlaybackSnapshot | null;
  anchor: PlaybackAnchor | null;
  /** 'ok' | no connection to the server | rate-limited by Spotify | invalid session | stopped (hidden tab). */
  connection: 'ok' | 'offline' | 'error' | 'rate_limited' | 'unauthorized' | 'suspended';
  message: string | null;
  lastSuccessAt: number | null;
}

export interface TrackerDeps {
  fetchSnapshot: () => Promise<FetchOutcome>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface TrackerOptions {
  focusedIntervalMs?: number;
  backgroundIntervalMs?: number;
  /** How long hidden before polling stops. */
  hiddenSuspendAfterMs?: number;
  seekThresholdMs?: number;
  maxBackoffMs?: number;
}

export interface TrackerUpdate {
  state: TrackerState;
  events: TrackerEvent[];
}

export class PlaybackTracker {
  private state: TrackerState = {
    snapshot: null,
    anchor: null,
    connection: 'ok',
    message: null,
    lastSuccessAt: null,
  };
  private timer: unknown = null;
  private running = false;
  private inFlight = false;
  private pendingImmediate = false;
  private visibility: Visibility = 'focused';
  private hiddenSince: number | null = null;
  private failures = 0;
  private listeners = new Set<(u: TrackerUpdate) => void>();
  private readonly o: Required<TrackerOptions>;

  constructor(private readonly deps: TrackerDeps, opts: TrackerOptions = {}) {
    this.o = {
      focusedIntervalMs: opts.focusedIntervalMs ?? 3000,
      backgroundIntervalMs: opts.backgroundIntervalMs ?? 10000,
      hiddenSuspendAfterMs: opts.hiddenSuspendAfterMs ?? 2 * 60_000,
      seekThresholdMs: opts.seekThresholdMs ?? 1500,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
    };
  }

  subscribe(fn: (u: TrackerUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): TrackerState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    this.clear();
  }

  setVisibility(v: Visibility): void {
    const prev = this.visibility;
    this.visibility = v;
    if (v === 'hidden') {
      this.hiddenSince ??= this.deps.now();
      return;
    }
    const wasSuspended = this.state.connection === 'suspended';
    this.hiddenSince = null;
    if (!this.running) return;
    if (wasSuspended || prev === 'hidden' || (prev === 'visible' && v === 'focused')) {
      // Back in the app: refresh right away instead of waiting for the next cycle.
      this.pollSoon(0);
    }
  }

  /** Schedules an early poll (e.g. after a play/pause/next command). */
  pollSoon(delayMs = 400): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.pendingImmediate = true;
      return;
    }
    this.schedule(delayMs);
  }

  /** Estimated progress now (ms), from the last anchor. */
  estimateProgress(now = this.deps.now()): number {
    return PlaybackTracker.project(this.state.anchor, now);
  }

  /** Applies an optimistic change (e.g. the user pressed pause/seek in the app). */
  applyOptimistic(patch: { isPlaying?: boolean; progressMs?: number }): void {
    const a = this.state.anchor;
    if (!a) return;
    const now = this.deps.now();
    const progressMs = patch.progressMs ?? PlaybackTracker.project(a, now);
    const isPlaying = patch.isPlaying ?? a.isPlaying;
    const events: TrackerEvent[] = [];
    if (patch.progressMs !== undefined) events.push({ type: 'seek', fromMs: PlaybackTracker.project(a, now), toMs: progressMs });
    if (patch.isPlaying !== undefined && patch.isPlaying !== a.isPlaying) events.push({ type: patch.isPlaying ? 'play' : 'pause' });
    const snapshot = this.state.snapshot ? { ...this.state.snapshot, isPlaying, progressMs } : null;
    this.state = { ...this.state, snapshot, anchor: { ...a, progressMs, isPlaying, at: now } };
    this.emit(events);
  }

  static project(a: PlaybackAnchor | null, now: number): number {
    if (!a) return 0;
    const t = a.isPlaying ? a.progressMs + (now - a.at) : a.progressMs;
    return Math.max(0, a.durationMs > 0 ? Math.min(t, a.durationMs) : t);
  }

  // ------------------------------------------------------------------ internals

  private clear(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    this.clear();
    if (!this.running) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, Math.max(0, ms));
  }

  private baseInterval(): number {
    return this.visibility === 'focused' ? this.o.focusedIntervalMs : this.o.backgroundIntervalMs;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.inFlight) return;

    // Tab hidden for a long time: suspend until it becomes visible again.
    if (this.visibility === 'hidden' && this.hiddenSince !== null && this.deps.now() - this.hiddenSince >= this.o.hiddenSuspendAfterMs) {
      this.state = { ...this.state, connection: 'suspended', message: 'Updates paused while the tab is hidden.' };
      this.emit([]);
      return;
    }

    this.inFlight = true;
    const sentAt = this.deps.now();
    let outcome: FetchOutcome;
    try {
      outcome = await this.deps.fetchSnapshot();
    } catch (err) {
      outcome = { ok: false, kind: 'network', message: err instanceof Error ? err.message : String(err) };
    }
    const receivedAt = this.deps.now();
    this.inFlight = false;
    if (!this.running) return;

    let next = this.baseInterval();

    if (outcome.ok) {
      this.failures = 0;
      const events = this.ingest(outcome.snapshot, sentAt, receivedAt);
      this.emit(events);
      // Near the end of the track: poll right after it ends to catch the next song.
      const a = this.state.anchor;
      if (a && a.isPlaying && a.durationMs > 0) {
        const remaining = a.durationMs - PlaybackTracker.project(a, receivedAt);
        if (remaining >= 0 && remaining + 600 < next) next = Math.max(1000, remaining + 600);
      }
    } else if (outcome.kind === 'unauthorized') {
      this.state = { ...this.state, connection: 'unauthorized', message: outcome.message };
      this.emit([]);
      this.running = false;
      return;
    } else {
      this.failures += 1;
      const backoff = Math.min(this.o.maxBackoffMs, this.baseInterval() * 2 ** Math.min(this.failures, 6));
      if (outcome.kind === 'rate_limited') {
        next = Math.max(outcome.retryAfterMs, backoff);
        this.state = { ...this.state, connection: 'rate_limited', message: `Spotify rate limit. Retrying in ${Math.ceil(next / 1000)}s.` };
      } else {
        next = backoff;
        this.state = { ...this.state, connection: outcome.kind === 'network' ? 'offline' : 'error', message: outcome.message };
      }
      this.emit([]);
    }

    if (this.pendingImmediate) {
      this.pendingImmediate = false;
      next = Math.min(next, 250);
    }
    this.schedule(next);
  }

  /** Ingests a snapshot and returns the detected events. Public for tests. */
  ingest(snapshot: PlaybackSnapshot, sentAt: number, receivedAt: number): TrackerEvent[] {
    const prevSnap = this.state.snapshot;
    const prevAnchor = this.state.anchor;
    const events: TrackerEvent[] = [];

    const latencyHalf = Math.max(0, (receivedAt - sentAt) / 2);
    const durationMs = snapshot.track?.durationMs ?? 0;
    const anchor: PlaybackAnchor | null =
      snapshot.status === 'active'
        ? {
            progressMs: snapshot.isPlaying ? snapshot.progressMs + latencyHalf : snapshot.progressMs,
            at: receivedAt,
            isPlaying: snapshot.isPlaying,
            durationMs,
          }
        : null;

    const prevKey = prevSnap?.status === 'active' ? itemKey(prevSnap) : null;
    const nextKey = snapshot.status === 'active' ? itemKey(snapshot) : null;

    if (prevSnap === null || prevKey !== nextKey || prevSnap.status !== snapshot.status) {
      events.push({ type: 'track_change', fromKey: prevKey, toKey: nextKey });
    } else if (prevAnchor && anchor) {
      if (prevAnchor.isPlaying !== anchor.isPlaying) {
        events.push({ type: anchor.isPlaying ? 'play' : 'pause' });
      }
      const predicted = PlaybackTracker.project(prevAnchor, receivedAt);
      if (Math.abs(anchor.progressMs - predicted) > this.o.seekThresholdMs) {
        events.push({ type: 'seek', fromMs: predicted, toMs: anchor.progressMs });
      }
    }

    this.state = { snapshot, anchor, connection: 'ok', message: null, lastSuccessAt: receivedAt };
    return events;
  }

  private emit(events: TrackerEvent[]): void {
    const update = { state: this.state, events };
    for (const l of this.listeners) l(update);
  }
}

function itemKey(s: PlaybackSnapshot): string {
  if (s.track) return s.track.key;
  return `kind:${s.kind ?? 'unknown'}`;
}
