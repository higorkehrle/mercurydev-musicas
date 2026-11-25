import { audioInput, type AudioFrame } from '../audio.ts';

/**
 * A single requestAnimationFrame for everything that draws from audio
 * (stage, reactive background, mini spectrum). The analyser is read once per frame and the
 * same AudioFrame is handed to every drawer, each at its own FPS cap.
 * The loop only exists while someone is registered.
 */
interface Renderer {
  fps: number;
  last: number;
  draw: (f: AudioFrame, now: number) => void;
}

const renderers = new Set<Renderer>();
let raf = 0;

function tick(now: number) {
  raf = 0;
  if (renderers.size === 0) return;
  const f = audioInput.sample(now);
  for (const r of renderers) {
    if (now - r.last >= 1000 / r.fps - 1.5) {
      r.last = now;
      r.draw(f, now);
    }
  }
  raf = requestAnimationFrame(tick);
}

export function addRenderer(fps: number, draw: Renderer['draw']): () => void {
  const r: Renderer = { fps, last: 0, draw };
  renderers.add(r);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    renderers.delete(r);
    if (renderers.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** For QA: how many drawers are active right now. */
export function activeRenderers(): number {
  return renderers.size;
}

if (import.meta.env.DEV) (window as unknown as { __mdRenderers: () => number }).__mdRenderers = activeRenderers;
