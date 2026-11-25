/**
 * SyncEngine — local playback clock + active line selection.
 *
 * The PlaybackTracker delivers "anchors" (progress reported by Spotify + the local instant
 * when the response arrived). Between anchors time advances with the local clock. When
 * a new anchor arrives:
 *  - small difference (< snapThresholdMs) while playing → the correction is spread
 *    over slewMs (no visible jump; the clock just runs slightly faster/slower);
 *  - large difference, seek, track change, pause/play → reposition immediately.
 *
 * Active line = largest startMs ≤ currentTime + manualOffset. Original and translation share the
 * same index, so they never drift apart.
 */

export interface PlaybackAnchor {
  /** Progress (ms) at instant `at`. */
  progressMs: number;
  /** Local instant (performance.now()) that progressMs corresponds to. */
  at: number;
  isPlaying: boolean;
  durationMs: number;
}

export interface SyncEngineOptions {
  /** Below this, drift correction is smooth. */
  snapThresholdMs?: number;
  /** Window over which a smooth correction is absorbed. */
  slewMs?: number;
}

export class SyncEngine {
  private anchor: PlaybackAnchor | null = null;
  private correctionMs = 0;
  private correctionAt = 0;
  private starts: { index: number; startMs: number }[] = [];
  private offsetMs = 0;
  readonly snapThresholdMs: number;
  readonly slewMs: number;

  constructor(opts: SyncEngineOptions = {}) {
    this.snapThresholdMs = opts.snapThresholdMs ?? 400;
    this.slewMs = opts.slewMs ?? 1200;
  }

  /** Sets the start of each line (by index). Untimed lines (null) are ignored. */
  setLines(starts: readonly (number | null)[]): void {
    this.starts = starts
      .map((startMs, index) => ({ index, startMs }))
      .filter((s): s is { index: number; startMs: number } => s.startMs !== null && Number.isFinite(s.startMs))
      .sort((a, b) => a.startMs - b.startMs || a.index - b.index);
  }

  setOffset(ms: number): void {
    this.offsetMs = ms;
  }

  getOffset(): number {
    return this.offsetMs;
  }

  hasAnchor(): boolean {
    return this.anchor !== null;
  }

  reset(): void {
    this.anchor = null;
    this.correctionMs = 0;
  }

  /**
   * Applies a new anchor. `forceSnap` must be true on seek, track change and pause/play
   * detected by the tracker.
   */
  applyAnchor(next: PlaybackAnchor, now: number, forceSnap = false): void {
    const prev = this.anchor;
    if (prev && !forceSnap && prev.isPlaying && next.isPlaying) {
      const shown = this.timeAt(now);
      this.anchor = next;
      this.correctionMs = 0;
      const truth = this.timeAt(now);
      const diff = shown - truth;
      if (Math.abs(diff) < this.snapThresholdMs) {
        this.correctionMs = diff;
        this.correctionAt = now;
      }
      return;
    }
    this.anchor = next;
    this.correctionMs = 0;
  }

  /** Displayed playback time (without offset), in ms. */
  timeAt(now: number): number {
    const a = this.anchor;
    if (!a) return 0;
    let t = a.isPlaying ? a.progressMs + (now - a.at) : a.progressMs;
    if (a.isPlaying && this.correctionMs !== 0) {
      const remaining = 1 - (now - this.correctionAt) / this.slewMs;
      if (remaining > 0) t += this.correctionMs * remaining;
      else this.correctionMs = 0;
    }
    if (t < 0) return 0;
    if (a.durationMs > 0 && t > a.durationMs) return a.durationMs;
    return t;
  }

  /** Time used to choose the line (time + manual offset). */
  lyricTimeAt(now: number): number {
    return this.timeAt(now) + this.offsetMs;
  }

  /** Index of the active line, or -1 before the first line / without an anchor. */
  activeIndex(now: number): number {
    if (!this.anchor) return -1;
    return SyncEngine.indexAt(this.starts, this.lyricTimeAt(now));
  }

  /** Binary search: largest startMs ≤ t. */
  static indexAt(starts: readonly { index: number; startMs: number }[], t: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = starts[mid]!;
      if (s.startMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found === -1 ? -1 : starts[found]!.index;
  }
}
