import { useEffect, useRef, useState } from 'react';
import { AudioLines, Captions, CaptionsOff, Maximize2, Mic, Minimize2, MonitorSpeaker } from 'lucide-react';
import { audioInput, supportsMic, supportsSystemAudio } from '../lib/audio.ts';
import { addRenderer } from '../lib/visualizer/loop.ts';
import { SCENES, ambientGlow, sceneById, type SceneId } from '../lib/visualizer/scenes.ts';
import { usePrefersReducedMotion } from '../hooks/useSync.ts';
import { useAudioStatus, useFrame } from '../hooks/useVisual.ts';
import { useI18n } from '../i18n/i18n.tsx';

// ------------------------------------------------------------------ visualizer canvas

/**
 * `stage`: Visual mode, full screen, 60 fps (30 fps without signal).
 * `ambient`: reactive light behind the lyrics (does not use the chosen scene), at 1/8 resolution and 30 fps.
 */
export function Visualizer({ scene, variant }: { scene: SceneId; variant: 'stage' | 'ambient' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const def = sceneById(scene);
    const inst = variant === 'ambient' ? ambientGlow() : def.create();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const scale = variant === 'ambient' ? 0.125 : dpr * (def.renderScale ?? 1);

    let sized = false;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(r.width * scale));
      const H = Math.max(1, Math.round(r.height * scale));
      // the new scene always gets the size (in StrictMode the canvas arrives already sized)
      if (sized && canvas.width === W && canvas.height === H) return;
      sized = true;
      canvas.width = W;
      canvas.height = H;
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, W, H);
      inst.resize(W, H, scale);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let skip = false;
    const off = addRenderer(variant === 'ambient' ? 30 : 60, (f) => {
      if (!f.live) {
        skip = !skip;
        if (skip) return;
      }
      inst.draw(ctx, f, { reduced });
    });
    return () => {
      off();
      ro.disconnect();
      inst.dispose?.();
    };
  }, [scene, variant, reduced]);

  return <canvas key={scene} ref={ref} className={`vis-canvas ${variant}`} aria-hidden />;
}

// ------------------------------------------------------------------ mini spectrum (the Winamp corner)

/** Small bars under the cover + cover halo pulsing with the bass. Draws only with a signal. */
export function MiniScope({ haloRef }: { haloRef?: React.RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useAudioStatus();
  const live = st.state === 'live';
  const BARS = 32;

  const paint = (bands: Float32Array | null) => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    ctx.clearRect(0, 0, W, H);
    const gap = 3 * dpr;
    const bw = (W - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const v = bands ? bands[Math.min(63, Math.round((i / BARS) * 60) + 1)]! : 0;
      const bh = Math.max(2 * dpr, v * H);
      ctx.fillStyle = v > 0.86 ? '#c9bbff' : `rgba(139,108,255,${0.35 + v * 0.65})`;
      ctx.fillRect(i * (bw + gap), H - bh, bw, bh);
    }
  };

  useEffect(() => {
    if (!live) {
      paint(null);
      if (haloRef?.current) haloRef.current.style.transform = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  useFrame(live, 30, (f) => {
    paint(f.bands);
    const halo = haloRef?.current;
    if (halo) {
      halo.style.transform = `scale(${1 + f.bass * 0.07})`;
      halo.style.opacity = String(0.55 + f.energy * 0.45);
    }
  });

  return (
    <div className={`mini-scope${live ? ' live' : ''}`}>
      <canvas ref={ref} aria-hidden />
      <span className="mini-scope-label" aria-hidden>
        {live ? t('audio.mini.live', { source: st.source === 'mic' ? t('audio.mini.mic') : t('audio.mini.system') }) : t('audio.mini.off')}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ audio connection

export function AudioConnectButtons({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n();
  const st = useAudioStatus();
  const busy = st.state === 'requesting';
  return (
    <div className="audio-connect">
      {supportsSystemAudio && (
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            void audioInput.connect('system').then(onDone);
          }}
        >
          <MonitorSpeaker size={15} strokeWidth={1.5} /> {t('audio.captureSystem')} <span className="arr" aria-hidden>→</span>
        </button>
      )}
      {supportsMic && (
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            void audioInput.connect('mic').then(onDone);
          }}
        >
          <Mic size={15} strokeWidth={1.5} /> {t('audio.useMic')}
        </button>
      )}
      {supportsSystemAudio && <p className="audio-help">{t('audio.helpSystem')}</p>}
      {!supportsSystemAudio && supportsMic && <p className="audio-help">{t('audio.helpMic')}</p>}
      {!supportsSystemAudio && !supportsMic && <p className="audio-help">{t('audio.unsupported')}</p>}
      {st.state === 'error' && st.error && (
        <p className="audio-error" role="alert">
          {t(`audio.err.${st.error}`)}
        </p>
      )}
    </div>
  );
}

/** Header "Audio" chip, with the connection popover. */
export function AudioControl() {
  const { t, fmt } = useI18n();
  const st = useAudioStatus();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const live = st.state === 'live';
  const label = live ? t('audio.chip.live') : st.state === 'requesting' ? t('audio.chip.waiting') : t('audio.chip.off');
  return (
    <div className="audio-control" ref={wrap}>
      <button className={`audio-chip state-${st.state}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={live ? t('audio.chip.liveLabel') : t('audio.chip.offLabel')}>
        {live ? <span className="audio-dot" aria-hidden /> : <AudioLines size={16} strokeWidth={1.5} aria-hidden />}
        <span className="audio-chip-label">{label}</span>
      </button>
      {open && (
        <div className="popover audio-pop" role="dialog" aria-label={t('audio.pop.label')}>
          <p className="pop-title">{t('audio.pop.title')}</p>
          <p className="pop-help">{t('audio.pop.body')}</p>
          {live ? (
            <>
              <p className="audio-status">
                <span className="audio-dot" aria-hidden /> {st.source === 'mic' ? t('audio.pop.listeningMic') : t('audio.pop.listeningSystem')}
                {st.sampleRate ? ` · ${fmt.number(st.sampleRate / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kHz` : ''} · {st.stereo ? t('audio.pop.stereo') : t('audio.pop.mono')}
              </p>
              <button
                className="btn ghost small"
                onClick={() => {
                  audioInput.disconnect();
                  setOpen(false);
                }}
              >
                {t('audio.pop.disconnect')}
              </button>
            </>
          ) : (
            <AudioConnectButtons onDone={() => audioInput.getStatus().state === 'live' && setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ stage controls

export function StageControls({
  scene,
  onScene,
  captions,
  onCaptions,
}: {
  scene: SceneId;
  onScene: (id: SceneId) => void;
  captions: boolean;
  onCaptions: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const st = useAudioStatus();
  const live = st.state === 'live';
  const meters = useRef<(HTMLElement | null)[]>([]);
  const fsSupported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);
  const [fs, setFs] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const on = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useFrame(live, 30, (f) => {
    const vals = [f.bass, f.mid, f.treble];
    meters.current.forEach((m, i) => m && (m.style.transform = `scaleY(${0.04 + vals[i]! * 0.96})`));
  });
  useEffect(() => {
    if (!live) meters.current.forEach((m) => m && (m.style.transform = 'scaleY(0.04)'));
  }, [live]);

  return (
    <div className="stage-controls" role="toolbar" aria-label={t('vis.toolbar')}>
      <div className="signal" aria-hidden title={t('vis.meters')}>
        {[t('vis.meter.bass'), t('vis.meter.mid'), t('vis.meter.treble')].map((l, i) => (
          <span key={i} className="meter">
            <i ref={(el) => void (meters.current[i] = el)} />
            <b>{l}</b>
          </span>
        ))}
      </div>
      <div className="scene-list" role="radiogroup" aria-label={t('vis.settings.style')}>
        {SCENES.map((d, i) => (
          <button key={d.id} role="radio" aria-checked={d.id === scene} className="scene-chip" onClick={() => onScene(d.id)} title={t('vis.sceneHint', { hint: t(`vis.hint.${d.id}`), key: i + 1 })}>
            <span className="n">{String(i + 1).padStart(2, '0')}</span>
            {t(`vis.scene.${d.id}`)}
          </button>
        ))}
      </div>
      <div className="stage-tools">
        <button className="icon-btn" aria-pressed={captions} onClick={() => onCaptions(!captions)} title={captions ? t('vis.captionsHide') : t('vis.captionsShow')} aria-label={t('vis.settings.captions')}>
          {captions ? <Captions size={17} strokeWidth={1.5} /> : <CaptionsOff size={17} strokeWidth={1.5} />}
        </button>
        {fsSupported && (
          <button className="icon-btn" onClick={() => void toggleFullscreen()} title={`${fs ? t('vis.fullscreenExit') : t('vis.fullscreen')} (F)`} aria-label={fs ? t('vis.fullscreenExit') : t('vis.fullscreen')}>
            {fs ? <Minimize2 size={17} strokeWidth={1.5} /> : <Maximize2 size={17} strokeWidth={1.5} />}
          </button>
        )}
      </div>
    </div>
  );
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* rejected by the browser */
  }
}

/** Center card on the stage when there is no signal. */
export function NoSignal() {
  const { t } = useI18n();
  return (
    <div className="no-signal" role="region" aria-label={t('vis.noSignal.code')}>
      <p className="no-signal-code">
        <span aria-hidden>→</span> {t('vis.noSignal.code')}
      </p>
      <h2>{t('vis.noSignal.title')}</h2>
      <p>{t('vis.noSignal.body')}</p>
      <AudioConnectButtons />
    </div>
  );
}
