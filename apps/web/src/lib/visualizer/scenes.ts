import { BAND_COUNT, type AudioFrame } from '../audio.ts';

/**
 * Visualizer scenes (Canvas 2D). Everything that moves comes from the AudioFrame:
 * bass → expansion/pulse, mids → rotation/deformation, highs → particles and glow,
 * energy → intensity. Without a signal, each scene shows an honest resting state
 * (still lines or very slow rotation), never pretending to react.
 */

export type SceneId = 'spectrum' | 'fluid' | 'particles' | 'scope' | 'geometry' | 'vector';

export interface Scene {
  resize(w: number, h: number, s: number): void;
  draw(ctx: CanvasRenderingContext2D, f: AudioFrame, o: DrawOpts): void;
  dispose?(): void;
}

export interface DrawOpts {
  reduced: boolean;
}

export interface SceneDef {
  id: SceneId;
  /** Fraction of the canvas resolution used by this scene (feedback scenes run lower). */
  renderScale?: number;
  create: () => Scene;
}

// MercuryDev palette
const BG = '#050505';
const VIOLET = [139, 108, 255] as const;
const ELECTRIC = [98, 54, 255] as const;
const LAVENDER = [201, 187, 255] as const;
const GOLD = [242, 195, 91] as const;

type RGB = readonly [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function fade(ctx: CanvasRenderingContext2D, w: number, h: number, a: number) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(5,5,5,${a})`;
  ctx.fillRect(0, 0, w, h);
}

function bandAvg(bands: Float32Array, from: number, to: number) {
  let s = 0;
  for (let i = from; i < to; i++) s += bands[i]!;
  return s / (to - from);
}

// ====================================================================== A. Spectrum
// Bars mirrored from the center (bass in the middle), a "floor" reflection,
// slowly falling peaks and sparks on the highs. A tribute to classic bar visualizers.
function spectrum(): Scene {
  let w = 1;
  let h = 1;
  let s = 1;
  const N = 44; // bars per side
  const peaks = new Float32Array(N);
  const prev = new Float32Array(N);
  const sparks: { x: number; y: number; vx: number; vy: number; life: number; gold: boolean }[] = [];
  let barGrad: CanvasGradient | null = null;
  let reflGrad: CanvasGradient | null = null;

  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
      barGrad = reflGrad = null;
      sparks.length = 0;
    },
    draw(ctx, f, o) {
      fade(ctx, w, h, 0.5);
      const horizon = h * 0.56;
      const maxH = h * 0.42;
      if (!barGrad) {
        barGrad = ctx.createLinearGradient(0, horizon - maxH, 0, horizon);
        barGrad.addColorStop(0, rgba(LAVENDER, 1));
        barGrad.addColorStop(0.45, rgba(VIOLET, 1));
        barGrad.addColorStop(1, rgba(ELECTRIC, 0.9));
        reflGrad = ctx.createLinearGradient(0, horizon, 0, horizon + maxH * 0.28);
        reflGrad.addColorStop(0, rgba(VIOLET, 0.2));
        reflGrad.addColorStop(1, rgba(VIOLET, 0));
      }

      // background glow that breathes with the bass
      const glowR = Math.max(w, h) * (0.32 + f.bass * 0.16);
      const g = ctx.createRadialGradient(w / 2, horizon, 0, w / 2, horizon, glowR);
      g.addColorStop(0, rgba(VIOLET, 0.05 + f.energy * 0.16));
      g.addColorStop(1, rgba(VIOLET, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const span = Math.min(w * 0.86, 1400 * s);
      const gap = Math.max(1, span * 0.0045);
      const bw = (span / 2 - gap * N) / N;
      const cx = w / 2;

      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        const b = Math.min(BAND_COUNT - 1, Math.round((i / N) * (BAND_COUNT - 8)) + 1);
        const v = f.bands[b]!;
        const bh = Math.max(2 * s, v * maxH);
        const xr = cx + gap / 2 + i * (bw + gap);
        const xl = cx - gap / 2 - (i + 1) * (bw + gap) + gap;
        ctx.fillStyle = barGrad!;
        ctx.fillRect(xr, horizon - bh, bw, bh);
        ctx.fillRect(xl, horizon - bh, bw, bh);
        ctx.fillStyle = reflGrad!;
        ctx.fillRect(xr, horizon + 2 * s, bw, bh * 0.28);
        ctx.fillRect(xl, horizon + 2 * s, bw, bh * 0.28);

        // slowly falling peaks; gold only when the band saturates
        peaks[i] = Math.max(v, peaks[i]! - f.dt * 0.35);
        const py = horizon - peaks[i]! * maxH - 5 * s;
        ctx.fillStyle = peaks[i]! > 0.84 ? rgba(GOLD, 0.95) : rgba(LAVENDER, 0.7);
        ctx.fillRect(xr, py, bw, 2 * s);
        ctx.fillRect(xl, py, bw, 2 * s);

        // sparks: sharp rise in the high bands
        if (!o.reduced && f.live && i > N * 0.55 && v - prev[i]! > 0.12 && sparks.length < 140) {
          for (const x of [xr + bw / 2, xl + bw / 2]) {
            sparks.push({ x, y: horizon - bh, vx: (Math.random() - 0.5) * 0.6 * s, vy: -(1.2 + v * 3) * s, life: 1, gold: v > 0.8 });
          }
        }
        prev[i] = v;
      }

      for (let k = sparks.length - 1; k >= 0; k--) {
        const p = sparks[k]!;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.02 * s;
        p.life -= f.dt * 1.4;
        if (p.life <= 0) {
          sparks.splice(k, 1);
          continue;
        }
        ctx.fillStyle = p.gold ? rgba(GOLD, p.life) : rgba(LAVENDER, p.life * 0.9);
        ctx.fillRect(p.x, p.y, 2 * s, 2 * s);
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(LAVENDER, 0.18 + f.energy * 0.3);
      ctx.fillRect(cx - span / 2, horizon, span, Math.max(1, s));
    },
  };
}

// ====================================================================== B. Fluid (feedback)
// Classic feedback visualizer: the previous frame is redrawn with zoom and rotation
// (bass increases zoom, mids rotate and shift) and the waveform is drawn as
// a ring on top. Runs at half resolution: the blur is part of the look.
function fluid(): Scene {
  let a = document.createElement('canvas');
  let b = document.createElement('canvas');
  let w = 1;
  let h = 1;
  let s = 1;
  let spin = 0;
  let hue = 0;

  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
      for (const c of [a, b]) {
        c.width = W;
        c.height = H;
        const x = c.getContext('2d')!;
        x.fillStyle = BG;
        x.fillRect(0, 0, W, H);
      }
    },
    draw(ctx, f, o) {
      const bx = b.getContext('2d')!;
      bx.globalCompositeOperation = 'source-over';
      bx.globalAlpha = 1;
      bx.fillStyle = BG;
      bx.fillRect(0, 0, w, h);

      // warp the previous frame
      spin += f.dt * (f.mid - 0.35) * 0.5;
      // sound presence: with audio connected but silent, the tunnel stops
      const presence = clamp01(f.rms * 30);
      const zoom = 1 + (0.008 + f.bass * (o.reduced ? 0.01 : 0.03)) * presence;
      const rot = f.live ? (0.002 + Math.sin(spin) * f.mid * 0.012) * clamp01(f.rms * 30) : 0;
      bx.save();
      bx.translate(w / 2 + Math.sin(f.t * 0.37) * f.mid * w * 0.006, h / 2 + Math.cos(f.t * 0.29) * f.mid * h * 0.006);
      bx.rotate(rot);
      bx.scale(zoom, zoom);
      bx.translate(-w / 2, -h / 2);
      bx.globalAlpha = f.live ? 0.94 : 0.9;
      bx.drawImage(a, 0, 0);
      bx.restore();

      if (f.live) {
        // color: violet → magenta → lavender with energy; gold on strong beats
        hue += f.dt * (0.08 + f.treble * 0.5);
        const k = 0.5 + 0.5 * Math.sin(hue);
        let col: RGB = mix(VIOLET, [214, 92, 255], k * f.energy);
        col = mix(col, LAVENDER, f.treble * 0.5);
        if (f.beat > 0.6) col = mix(col, GOLD, (f.beat - 0.6) * 1.6);

        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) * (0.16 + f.bass * 0.1);
        const wave = f.wave;
        const n = 180;
        const step = Math.floor(wave.length / n);
        bx.globalCompositeOperation = 'lighter';
        for (let ring = 0; ring < 2; ring++) {
          const rr = R * (ring === 0 ? 1 : 0.55 + f.mid * 0.2);
          const amp = rr * (ring === 0 ? 1.1 : 0.8);
          bx.beginPath();
          for (let i = 0; i <= n; i++) {
            const ang = (i / n) * Math.PI * 2 + spin * (ring ? -1 : 1);
            const v = wave[(i % n) * step]!;
            const r = rr + v * amp;
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            if (i === 0) bx.moveTo(x, y);
            else bx.lineTo(x, y);
          }
          bx.strokeStyle = rgba(ring === 0 ? col : LAVENDER, (ring === 0 ? 0.85 : 0.45) * presence);
          bx.lineWidth = (ring === 0 ? 1.6 : 1) * s;
          bx.stroke();
        }
        // radial burst on beats
        if (f.beat > 0.75 && !o.reduced) {
          bx.beginPath();
          const spokes = 24;
          for (let i = 0; i < spokes; i++) {
            const ang = (i / spokes) * Math.PI * 2 + spin;
            bx.moveTo(cx + Math.cos(ang) * R * 0.4, cy + Math.sin(ang) * R * 0.4);
            bx.lineTo(cx + Math.cos(ang) * R * (1.3 + f.bass), cy + Math.sin(ang) * R * (1.3 + f.bass));
          }
          bx.strokeStyle = rgba(GOLD, 0.25 * f.beat);
          bx.lineWidth = s;
          bx.stroke();
        }
      } else {
        bx.beginPath();
        bx.arc(w / 2, h / 2, Math.min(w, h) * 0.16, 0, Math.PI * 2);
        bx.strokeStyle = rgba(VIOLET, 0.35);
        bx.lineWidth = s;
        bx.stroke();
      }

      const t = a;
      a = b;
      b = t;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(a, 0, 0);
    },
    dispose() {
      a.width = a.height = b.width = b.height = 0;
    },
  };
}

// ====================================================================== C. Particle universe
// Particles bound to a hexagonal formation: bass expands the formation and,
// on beats, pushes everything outward; mids rotate; highs light up the particles.
function particles(): Scene {
  let w = 1;
  let h = 1;
  let s = 1;
  let ps: Float32Array = new Float32Array(0); // x, y, vx, vy, theta, ring, jitter, kind
  const STRIDE = 8;
  let count = 0;
  let rot = 0;

  const init = () => {
    count = w * h > 900_000 ? 620 : 300;
    ps = new Float32Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
      const o = i * STRIDE;
      ps[o + 4] = Math.random() * Math.PI * 2;
      ps[o + 5] = i % 3;
      ps[o + 6] = Math.random();
      ps[o + 7] = Math.random() < 0.06 ? 2 : Math.random() < 0.4 ? 1 : 0;
      ps[o] = w / 2;
      ps[o + 1] = h / 2;
    }
  };

  const polyR = (theta: number, sides: number, r: number, rotation: number) => {
    const seg = (Math.PI * 2) / sides;
    let a = (theta - rotation) % seg;
    if (a < 0) a += seg;
    return (r * Math.cos(Math.PI / sides)) / Math.cos(a - seg / 2);
  };

  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
      init();
    },
    draw(ctx, f, o) {
      fade(ctx, w, h, f.live ? 0.24 : 0.4);
      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h);
      rot += f.dt * (0.04 + f.mid * 0.5);
      const kick = o.reduced ? 0 : f.beat > 0.95 ? (5 + f.bass * 12) * s : 0;
      ctx.globalCompositeOperation = 'lighter';
      const paths = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < count; i++) {
        const q = i * STRIDE;
        const ring = ps[q + 5]!;
        const dir = ring === 1 ? -1 : 1;
        ps[q + 4]! += f.dt * (0.02 + f.mid * 0.25) * dir * (0.6 + ps[q + 6]! * 0.8);
        const theta = ps[q + 4]!;
        const R = base * (0.14 + ring * 0.08) * (1 + f.bass * 0.38);
        const r = polyR(theta, ring === 2 ? 3 : 6, R, rot * dir);
        const tx = cx + Math.cos(theta) * r;
        const ty = cy + Math.sin(theta) * r;
        let vx = ps[q + 2]! + (tx - ps[q]!) * 0.05;
        let vy = ps[q + 3]! + (ty - ps[q + 1]!) * 0.05;
        if (kick) {
          const dx = ps[q]! - cx;
          const dy = ps[q + 1]! - cy;
          const d = Math.hypot(dx, dy) || 1;
          const k = kick * (0.5 + ps[q + 6]!);
          vx += (dx / d) * k;
          vy += (dy / d) * k;
        }
        vx *= 0.86;
        vy *= 0.86;
        ps[q + 2] = vx;
        ps[q + 3] = vy;
        ps[q] = ps[q]! + vx;
        ps[q + 1] = ps[q + 1]! + vy;
        const kind = ps[q + 7]!;
        // highs light up: bigger, brighter particles
        const size = (1.2 + (kind === 2 ? 0.6 : 0) + f.treble * ps[q + 6]! * 2.2) * s;
        paths[kind]!.rect(ps[q]!, ps[q + 1]!, size, size);
      }
      ctx.fillStyle = rgba(VIOLET, 0.55 + f.energy * 0.4);
      ctx.fill(paths[0]!);
      ctx.fillStyle = rgba(LAVENDER, 0.45 + f.treble * 0.5);
      ctx.fill(paths[1]!);
      ctx.fillStyle = rgba(GOLD, 0.35 + f.bass * 0.6);
      ctx.fill(paths[2]!);
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}

// ====================================================================== D. Oscilloscope
// CRT phosphor: waveform stabilized by a trigger (zero crossing),
// three overlapping traces for the glow and a subtle graticule.
function scope(): Scene {
  let w = 1;
  let h = 1;
  let s = 1;
  let peak = 0.2;
  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
    },
    draw(ctx, f) {
      fade(ctx, w, h, 0.3);
      // graticule 10 × 8
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = Math.max(1, s * 0.75);
      ctx.beginPath();
      for (let i = 1; i < 10; i++) {
        const x = Math.round((w * i) / 10) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let j = 1; j < 8; j++) {
        const y = Math.round((h * j) / 8) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      const wave = f.wave;
      let trig = 0;
      for (let i = 1; i < wave.length / 2; i++) {
        if (wave[i - 1]! < 0 && wave[i]! >= 0) {
          trig = i;
          break;
        }
      }
      let m = 0;
      for (let i = 0; i < wave.length; i++) m = Math.max(m, Math.abs(wave[i]!));
      peak = Math.max(m, peak * Math.pow(0.5, f.dt / 3), 0.06);
      const n = 512;
      const amp = (h * 0.36) / peak;
      const cy = h / 2;
      const path = new Path2D();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = cy - (wave[trig + i] ?? 0) * amp;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = rgba(mix(VIOLET, GOLD, clamp01(f.beat - 0.4) * 0.8), 0.14 + f.energy * 0.12);
      ctx.lineWidth = 9 * s;
      ctx.stroke(path);
      ctx.strokeStyle = rgba(LAVENDER, 0.5);
      ctx.lineWidth = 3 * s;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1.1 * s;
      ctx.stroke(path);
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}

// ====================================================================== E. Geometric waves
// Concentric polygons (the MercuryDev website lines): each ring follows a group of
// frequencies, expands with it and rotates with the mids; saturated rings turn gold.
// Outer rays form a circular spectrum.
function geometry(): Scene {
  let w = 1;
  let h = 1;
  let s = 1;
  const RINGS = 7;
  const rots = new Float32Array(RINGS);
  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
    },
    draw(ctx, f) {
      fade(ctx, w, h, 0.34);
      const cx = w / 2;
      const cy = h * 0.46;
      const base = Math.min(w, h) * 0.32;
      const per = Math.floor(BAND_COUNT / RINGS);
      ctx.lineJoin = 'miter';
      for (let k = 0; k < RINGS; k++) {
        const v = bandAvg(f.bands, k * per, (k + 1) * per);
        rots[k]! += f.dt * (0.03 + f.mid * 0.45) * (k % 2 ? -1 : 1) * (1 + k * 0.12);
        const sides = [3, 4, 6, 4, 6, 8, 12][k]!;
        const r = base * (0.16 + k * 0.12) * (1 + v * 0.22);
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const a = rots[k]! + (i / sides) * Math.PI * 2;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const hot = v > 0.9;
        ctx.strokeStyle = hot ? rgba(GOLD, 0.6 + (v - 0.9) * 3) : rgba(mix(VIOLET, LAVENDER, v), 0.18 + v * 0.6);
        ctx.lineWidth = (hot ? 1.6 : 1) * s;
        ctx.stroke();
      }
      // radial spectrum
      const R0 = base * 0.98;
      const spokes = BAND_COUNT * 2;
      ctx.beginPath();
      for (let i = 0; i < spokes; i++) {
        const b = i < BAND_COUNT ? i : spokes - 1 - i;
        const v = f.bands[b]!;
        const a = -Math.PI / 2 + (i / spokes) * Math.PI * 2;
        const L = 3 * s + v * base * 0.24;
        ctx.moveTo(cx + Math.cos(a) * R0, cy + Math.sin(a) * R0);
        ctx.lineTo(cx + Math.cos(a) * (R0 + L), cy + Math.sin(a) * (R0 + L));
      }
      ctx.strokeStyle = rgba(LAVENDER, 0.35 + f.energy * 0.45);
      ctx.lineWidth = 1.2 * s;
      ctx.stroke();
      // core
      ctx.beginPath();
      ctx.arc(cx, cy, 2 * s + f.bass * 10 * s, 0, Math.PI * 2);
      ctx.fillStyle = rgba(f.beat > 0.7 ? GOLD : VIOLET, 0.5 + f.bass * 0.5);
      ctx.fill();
    },
  };
}

// ====================================================================== F. Vectorscope (original)
// Studio goniometer: side (L−R) on the X axis, mid (L+R) on the Y axis. Shows the
// stereo width of the mix — with a (mono) microphone it becomes a vertical line.
function vector(): Scene {
  let w = 1;
  let h = 1;
  let s = 1;
  let peak = 0.2;
  return {
    resize(W, H, S) {
      w = W;
      h = H;
      s = S;
    },
    draw(ctx, f) {
      fade(ctx, w, h, 0.22);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.4;
      // guides
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = s;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();

      const L = f.waveL;
      const Rr = f.waveR;
      let m = 0;
      for (let i = 0; i < L.length; i++) m = Math.max(m, Math.abs(L[i]!), Math.abs(Rr[i]!));
      peak = Math.max(m, peak * Math.pow(0.5, f.dt / 3), 0.06);
      const k = (R * 0.8) / peak;
      const path = new Path2D();
      for (let i = 0; i < L.length; i += 2) {
        const side = (L[i]! - Rr[i]!) * 0.7071;
        const midv = (L[i]! + Rr[i]!) * 0.7071;
        const x = cx + side * k;
        const y = cy - midv * k;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(VIOLET, 0.25);
      ctx.lineWidth = 5 * s;
      ctx.stroke(path);
      ctx.strokeStyle = rgba(mix(LAVENDER, GOLD, clamp01(f.energy - 0.7) * 2), 0.75);
      ctx.lineWidth = 1 * s;
      ctx.stroke(path);
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}

// ====================================================================== reactive light (Lyrics mode background)
// Not a stage scene: three large, soft lights behind the cover and the lyrics.
// Bass lights up the purple, mids the lavender; gold only shows on beats.
export function ambientGlow(): Scene {
  let w = 1;
  let h = 1;
  return {
    resize(W, H) {
      w = W;
      h = H;
    },
    draw(ctx, f) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const blob = (x: number, y: number, r: number, c: RGB, a: number) => {
        if (a <= 0.003) return;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(c, a));
        g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      const m = Math.max(w, h);
      blob(w * 0.27, h * 0.45, m * (0.3 + f.bass * 0.14), VIOLET, 0.1 + f.bass * 0.42);
      blob(w * 0.62, h * 0.5, m * (0.34 + f.mid * 0.1), LAVENDER, f.mid * 0.16);
      blob(w * 0.27, h * 0.45, m * 0.12, GOLD, f.beat * f.bass * 0.22);
      ctx.globalCompositeOperation = 'source-over';
    },
  };
}

export const SCENES: SceneDef[] = [
  { id: 'spectrum', create: spectrum },
  { id: 'fluid', create: fluid, renderScale: 0.5 },
  { id: 'particles', create: particles },
  { id: 'scope', create: scope },
  { id: 'geometry', create: geometry },
  { id: 'vector', create: vector },
];

export const sceneById = (id: string) => SCENES.find((d) => d.id === id) ?? SCENES[0]!;
