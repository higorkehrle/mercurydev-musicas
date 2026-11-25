import { describe, expect, it } from 'vitest';
import { SyncEngine } from './syncEngine.ts';

const LINES = [0, 5000, 10000, 15000, 20000];

function engine() {
  const e = new SyncEngine({ snapThresholdMs: 400, slewMs: 1000 });
  e.setLines(LINES);
  return e;
}

describe('SyncEngine', () => {
  it('no anchor means no active line', () => {
    expect(engine().activeIndex(0)).toBe(-1);
  });

  it('active line = largest startMs ≤ time', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 4999, at: 0, isPlaying: false, durationMs: 30000 }, 0);
    expect(e.activeIndex(0)).toBe(0);
    e.applyAnchor({ progressMs: 5000, at: 0, isPlaying: false, durationMs: 30000 }, 0, true);
    expect(e.activeIndex(0)).toBe(1);
  });

  it('returns -1 before the first line', () => {
    const e = new SyncEngine();
    e.setLines([3000, 6000]);
    e.applyAnchor({ progressMs: 1000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    expect(e.activeIndex(500)).toBe(-1);
    expect(e.activeIndex(2100)).toBe(0);
  });

  it('ignores untimed lines and keeps the original index', () => {
    const e = new SyncEngine();
    e.setLines([0, null, 4000]);
    e.applyAnchor({ progressMs: 4500, at: 0, isPlaying: false, durationMs: 9000 }, 0);
    expect(e.activeIndex(0)).toBe(2);
  });

  it('advances with the local clock while playing', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 4000, at: 1000, isPlaying: true, durationMs: 30000 }, 1000);
    expect(e.timeAt(2000)).toBe(5000);
    expect(e.activeIndex(2000)).toBe(1);
  });

  it('pause freezes time and the active line', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 7000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    e.applyAnchor({ progressMs: 7200, at: 200, isPlaying: false, durationMs: 30000 }, 200, true);
    expect(e.timeAt(200)).toBe(7200);
    expect(e.timeAt(60_000)).toBe(7200);
    expect(e.activeIndex(60_000)).toBe(1);
  });

  it('seek repositions immediately', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 1000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    e.applyAnchor({ progressMs: 16000, at: 500, isPlaying: true, durationMs: 30000 }, 500, true);
    expect(e.timeAt(500)).toBe(16000);
    expect(e.activeIndex(500)).toBe(3);
  });

  it('large drift without a seek flag also repositions immediately', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 1000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    // Predicted at t=1000: 2000. Reported: 2900 (difference 900ms ≥ 400ms).
    e.applyAnchor({ progressMs: 2900, at: 1000, isPlaying: true, durationMs: 30000 }, 1000);
    expect(e.timeAt(1000)).toBe(2900);
  });

  it('small drift is corrected smoothly, without a jump', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 1000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    // Predicted at t=1000: 2000. Reported: 1800 (local clock 200ms ahead).
    e.applyAnchor({ progressMs: 1800, at: 1000, isPlaying: true, durationMs: 30000 }, 1000);
    // Continuity: at the moment of correction the displayed value does not change.
    expect(e.timeAt(1000)).toBeCloseTo(2000, 5);
    // Halfway through the window: half of the correction absorbed.
    expect(e.timeAt(1500)).toBeCloseTo(2300 + 100, 5);
    // After the window: converges to the truth.
    expect(e.timeAt(2000)).toBeCloseTo(2800, 5);
    expect(e.timeAt(3000)).toBeCloseTo(3800, 5);
  });

  it('smooth correction keeps time monotonic', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 1000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    e.applyAnchor({ progressMs: 1650, at: 1000, isPlaying: true, durationMs: 30000 }, 1000);
    let last = -Infinity;
    for (let t = 1000; t <= 2500; t += 16) {
      const v = e.timeAt(t);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('manual offset shifts the line choice', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 4600, at: 0, isPlaying: false, durationMs: 30000 }, 0);
    expect(e.activeIndex(0)).toBe(0);
    e.setOffset(500);
    expect(e.activeIndex(0)).toBe(1);
    e.setOffset(-5000);
    expect(e.activeIndex(0)).toBe(-1);
  });

  it('does not go past the track duration', () => {
    const e = engine();
    e.applyAnchor({ progressMs: 29000, at: 0, isPlaying: true, durationMs: 30000 }, 0);
    expect(e.timeAt(10_000)).toBe(30000);
  });
});
