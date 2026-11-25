import { useEffect, useRef, useState } from 'react';
import { AudioWaveform, Minus, Pause, Play, Plus, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { OFFSET_LIMIT_MS, OFFSET_STEP_MS, type ControlAction, type PlaybackSnapshot, type SyncMode } from '@lyricsync/shared';
import { formatTime } from '../lib/format.ts';
import { useI18n } from '../i18n/i18n.tsx';
import type { LiveContext } from './LyricsView.tsx';
import type { ViewMode } from '../App.tsx';

interface Props {
  snapshot: PlaybackSnapshot | null;
  live: LiveContext | null;
  reasons: Partial<Record<ControlAction, string | null>>;
  onControl: (a: 'play' | 'pause' | 'next' | 'previous') => void;
  onSeek: (ms: number) => void;
  onVolume: (v: number) => void;
  mode: ViewMode;
  onToggleMode: () => void;
  sync: {
    mode: SyncMode | 'reader' | null;
    sourceLabel: string | null;
    offsetMs: number;
    offsetEditable: boolean;
    onOffset: (ms: number | null) => void;
    canTapSync: boolean;
    onTapSync: () => void;
    hasManual: boolean;
    onClearManual: () => void;
  };
}

export function Tip({ text, children }: { text: string | null | undefined; children: React.ReactNode }) {
  return (
    <span className="tip" data-tip={text || undefined}>
      {children}
    </span>
  );
}

export function PlayerBar({ snapshot, live, reasons, onControl, onSeek, onVolume, mode, onToggleMode, sync }: Props) {
  const { t, fmt } = useI18n();
  const durationMs = snapshot?.track?.durationMs ?? 0;
  const isPlaying = snapshot?.status === 'active' && snapshot.isPlaying;

  // ---------------------------------------------------------------- progress (RAF, no re-render)
  const rangeRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const previewRef = useRef<HTMLSpanElement>(null);

  // time preview under the cursor on the progress bar
  const showPreview = (e: React.PointerEvent<HTMLInputElement>) => {
    const el = previewRef.current;
    if (!el || durationMs <= 0 || e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    el.textContent = formatTime(k * durationMs);
    el.style.left = `${k * 100}%`;
    el.dataset.on = '1';
  };
  const hidePreview = () => {
    if (previewRef.current) delete previewRef.current.dataset.on;
  };

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (!dragging.current && live && durationMs > 0) {
        const now = performance.now();
        const t = live.matches && live.engine.hasAnchor() ? live.engine.timeAt(now) : live.tracker.estimateProgress(now);
        if (rangeRef.current) {
          rangeRef.current.value = String(t);
          rangeRef.current.style.setProperty('--pct', `${(t / durationMs) * 100}%`);
        }
        if (timeRef.current) timeRef.current.textContent = formatTime(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, durationMs]);

  // ---------------------------------------------------------------- volume (debounce)
  const deviceVolume = snapshot?.device?.volumePercent ?? null;
  const [volume, setVolume] = useState<number | null>(deviceVolume);
  const volTimer = useRef<number>(0);
  const lastSent = useRef(0);
  useEffect(() => {
    // Only accept Spotify's value if the user has not touched the slider recently.
    if (Date.now() - lastSent.current > 4000) setVolume(deviceVolume);
  }, [deviceVolume]);
  const changeVolume = (v: number) => {
    setVolume(v);
    lastSent.current = Date.now();
    window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => onVolume(v), 250);
  };

  const [offsetOpen, setOffsetOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offsetOpen) return;
    const close = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOffsetOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [offsetOpen]);

  const playReason = reasons[isPlaying ? 'pause' : 'play'];
  const VolIcon = volume === 0 ? VolumeX : (volume ?? 0) < 50 ? Volume1 : Volume2;
  const syncText =
    sync.mode === 'source'
      ? sync.sourceLabel
        ? t('sync.sourceFrom', { source: sync.sourceLabel })
        : t('sync.source')
      : sync.mode === 'manual'
        ? t('sync.manual')
        : sync.mode === 'none'
          ? t('sync.none')
          : sync.mode === 'reader'
            ? t('sync.reader')
            : null;

  return (
    <footer className="player">
      <div className="player-controls">
        <Tip text={reasons.previous}>
          <button className="icon-btn" aria-label={t('player.previous')} disabled={Boolean(reasons.previous)} onClick={() => onControl('previous')}>
            <SkipBack size={19} strokeWidth={1.5} />
          </button>
        </Tip>
        <Tip text={playReason}>
          <button className="icon-btn play" aria-label={isPlaying ? t('player.pause') : t('player.play')} disabled={Boolean(playReason)} onClick={() => onControl(isPlaying ? 'pause' : 'play')}>
            {isPlaying ? <Pause size={18} fill="currentColor" strokeWidth={1.5} /> : <Play size={18} fill="currentColor" strokeWidth={1.5} style={{ marginLeft: 2 }} />}
          </button>
        </Tip>
        <Tip text={reasons.next}>
          <button className="icon-btn" aria-label={t('player.next')} disabled={Boolean(reasons.next)} onClick={() => onControl('next')}>
            <SkipForward size={19} strokeWidth={1.5} />
          </button>
        </Tip>
      </div>

      <div className="player-progress">
        <span className="time" ref={timeRef}>
          {dragValue !== null ? formatTime(dragValue) : formatTime(snapshot?.progressMs ?? 0)}
        </span>
        <Tip text={durationMs > 0 ? reasons.seek : null}>
          <span className="seek-preview" ref={previewRef} aria-hidden />
          <input
            ref={rangeRef}
            type="range"
            className="range progress"
            min={0}
            max={Math.max(1, durationMs)}
            step={500}
            defaultValue={0}
            disabled={durationMs === 0 || Boolean(reasons.seek)}
            aria-label={t('player.seek')}
            onPointerDown={() => (dragging.current = true)}
            onPointerMove={reasons.seek ? undefined : showPreview}
            onPointerLeave={hidePreview}
            onInput={(e) => {
              dragging.current = true;
              const v = Number(e.currentTarget.value);
              setDragValue(v);
              e.currentTarget.style.setProperty('--pct', `${(v / Math.max(1, durationMs)) * 100}%`);
              if (timeRef.current) timeRef.current.textContent = formatTime(v);
            }}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              dragging.current = false;
              setDragValue(null);
              onSeek(v);
            }}
            onPointerUp={() => {
              dragging.current = false;
              setDragValue(null);
            }}
          />
        </Tip>
        <span className="time dim">{durationMs > 0 ? formatTime(durationMs) : '0:00'}</span>
      </div>

      <div className="player-side">
        <button className={`icon-btn mode-toggle${mode === 'visual' ? ' on' : ''}`} aria-pressed={mode === 'visual'} onClick={onToggleMode} aria-label={t('mode.visual')} title={t('mode.hint', { mode: t('mode.visual') })}>
          <AudioWaveform size={18} strokeWidth={1.5} />
        </button>
        {syncText && (
          <div className="sync-wrap" ref={popRef}>
            <button className={`sync-chip mode-${sync.mode}`} onClick={() => setOffsetOpen((o) => !o)} aria-expanded={offsetOpen}>
              <span className="sync-dot" aria-hidden />
              {syncText}
              {sync.offsetMs !== 0 && sync.mode !== 'none' && sync.mode !== 'reader' && <span className="sync-offset">{fmt.offset(sync.offsetMs)}</span>}
            </button>
            {offsetOpen && (
              <div className="popover" role="dialog" aria-label={t('sync.popLabel')}>
                {sync.offsetEditable ? (
                  <>
                    <p className="pop-title">{t('sync.fineTune')}</p>
                    <p className="pop-help">{t('sync.help')}</p>
                    <div className="offset-row">
                      <button
                        className="icon-btn small"
                        aria-label={t('sync.later', { amount: fmt.seconds(OFFSET_STEP_MS / 1000) })}
                        disabled={sync.offsetMs <= -OFFSET_LIMIT_MS}
                        onClick={() => sync.onOffset(Math.max(-OFFSET_LIMIT_MS, sync.offsetMs - OFFSET_STEP_MS))}
                      >
                        <Minus size={15} strokeWidth={1.5} />
                      </button>
                      <output className="offset-value">{fmt.offset(sync.offsetMs)}</output>
                      <button
                        className="icon-btn small"
                        aria-label={t('sync.earlier', { amount: fmt.seconds(OFFSET_STEP_MS / 1000) })}
                        disabled={sync.offsetMs >= OFFSET_LIMIT_MS}
                        onClick={() => sync.onOffset(Math.min(OFFSET_LIMIT_MS, sync.offsetMs + OFFSET_STEP_MS))}
                      >
                        <Plus size={15} strokeWidth={1.5} />
                      </button>
                    </div>
                    <input
                      type="range"
                      className="range"
                      min={-OFFSET_LIMIT_MS}
                      max={OFFSET_LIMIT_MS}
                      step={OFFSET_STEP_MS}
                      value={sync.offsetMs}
                      onChange={(e) => sync.onOffset(Number(e.currentTarget.value))}
                      aria-label={t('sync.offsetLabel')}
                    />
                    <button className="btn ghost small" disabled={sync.offsetMs === 0} onClick={() => sync.onOffset(null)}>
                      {t('sync.reset')}
                    </button>
                  </>
                ) : (
                  <p className="pop-help">
                    {sync.mode === 'reader' ? t('sync.readerHelp') : t('sync.unsyncedHelp')}
                  </p>
                )}
                {sync.canTapSync && (
                  <button
                    className="btn ghost small"
                    onClick={() => {
                      setOffsetOpen(false);
                      sync.onTapSync();
                    }}
                  >
                    {sync.mode === 'manual' ? t('sync.redoManual') : t('sync.tapSync')}
                  </button>
                )}
                {sync.hasManual && (
                  <button className="btn ghost small danger" onClick={sync.onClearManual}>
                    {t('sync.clearManual')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="volume">
          <Tip text={reasons.volume}>
            <VolIcon size={17} strokeWidth={1.5} className="vol-icon" aria-hidden />
          </Tip>
          <Tip text={reasons.volume}>
            <input
              type="range"
              className="range volume-range"
              min={0}
              max={100}
              value={volume ?? 0}
              disabled={Boolean(reasons.volume) || volume === null}
              onChange={(e) => changeVolume(Number(e.currentTarget.value))}
              style={{ '--pct': `${volume ?? 0}%` } as React.CSSProperties}
              aria-label={t('player.volume')}
            />
          </Tip>
        </div>
      </div>
    </footer>
  );
}
