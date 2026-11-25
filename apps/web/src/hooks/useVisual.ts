import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { audioInput, type AudioFrame, type AudioStatus } from '../lib/audio.ts';
import { addRenderer } from '../lib/visualizer/loop.ts';
import type { SceneId } from '../lib/visualizer/scenes.ts';

export function useAudioStatus(): AudioStatus {
  return useSyncExternalStore(audioInput.subscribe, audioInput.getStatus);
}

export interface VisualPrefs {
  scene: SceneId;
  /** Visualizer as background light in Lyrics mode (only with audio connected). */
  ambient: boolean;
  /** Current lyric line as a caption in Visual mode. */
  captions: boolean;
  /** Sensitivity (gain on top of the automatic gain). */
  gain: number;
}

const KEY = 'md-musicas.visual';
const DEFAULTS: VisualPrefs = { scene: 'spectrum', ambient: true, captions: true, gain: 1 };

function load(): VisualPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<VisualPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Visualizer preferences: this browser only (not sent to the server). */
export function useVisualPrefs() {
  const [prefs, setPrefs] = useState<VisualPrefs>(load);
  useEffect(() => {
    audioInput.gain = prefs.gain;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage blocked: keep it in memory only */
    }
  }, [prefs]);
  const update = useCallback((p: Partial<VisualPrefs>) => setPrefs((v) => ({ ...v, ...p })), []);
  return { prefs, update };
}

/** Registers a drawer in the shared loop while `enabled`. */
export function useFrame(enabled: boolean, fps: number, draw: (f: AudioFrame, now: number) => void) {
  const ref = useRef(draw);
  ref.current = draw;
  useEffect(() => {
    if (!enabled) return;
    return addRenderer(fps, (f, now) => ref.current(f, now));
  }, [enabled, fps]);
}
