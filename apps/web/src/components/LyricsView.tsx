import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PlaybackTracker as PT, SyncEngine as SE, type LyricsLine, type PlaybackTracker, type Settings, type SyncEngine, type SyncMode, type TranslationResult } from '@lyricsync/shared';
import type { Load } from '../hooks/useData.ts';
import { usePrefersReducedMotion, useSyncedIndex } from '../hooks/useSync.ts';
import { useI18n } from '../i18n/i18n.tsx';

export interface LiveContext {
  tracker: PlaybackTracker;
  engine: SyncEngine;
  /** The tracker is playing exactly this track. */
  matches: boolean;
  isPlaying: boolean;
  durationMs: number;
}

interface Props {
  lines: LyricsLine[];
  syncMode: SyncMode;
  starts: (number | null)[] | null;
  offsetMs: number;
  translation: Load<TranslationResult>;
  settings: Settings;
  live: LiveContext | null;
  canSeek: boolean;
  onSeek: (ms: number) => void;
  tapSyncing: boolean;
  onTapSyncDone: (starts: (number | null)[] | null) => void;
  footer?: React.ReactNode;
  /** `list`: full scrolling lyrics. `caption`: only the current line, as a caption in Visual mode. */
  presentation?: 'list' | 'caption';
}

const USER_SCROLL_HOLD_MS = 5000;

export function LyricsView(p: Props) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const userScrollAt = useRef(0);
  const [detached, setDetached] = useState(false);
  const reduced = usePrefersReducedMotion();

  const synced = p.syncMode !== 'none' && p.starts !== null;
  const caption = p.presentation === 'caption' && !p.tapSyncing;
  const liveSync = Boolean(p.live?.matches) && synced && !p.tapSyncing;
  const autoScroll = !caption && !synced && !p.tapSyncing && p.settings.unsyncedAutoScroll && Boolean(p.live?.matches);
  const active = useSyncedIndex(p.live?.engine ?? dummyEngine, p.live?.tracker ?? dummyTracker, synced ? p.starts : null, p.offsetMs, liveSync && p.live !== null);

  // ------------------------------------------------------------ "sync while playing"
  const [tapStarts, setTapStarts] = useState<(number | null)[]>([]);
  const [tapPointer, setTapPointer] = useState(0);
  useEffect(() => {
    if (p.tapSyncing) {
      setTapStarts(p.lines.map(() => null));
      setTapPointer(firstTextLine(p.lines, 0));
    }
  }, [p.tapSyncing, p.lines]);

  const markLine = useCallback(
    (i: number) => {
      if (!p.live) return;
      const t = Math.round(p.live.tracker.estimateProgress(performance.now()));
      setTapStarts((prev) => prev.map((v, k) => (k === i ? t : k > i && v !== null && v < t ? null : v)));
      setTapPointer(firstTextLine(p.lines, i + 1));
    },
    [p.live, p.lines],
  );

  const undoMark = useCallback(() => {
    setTapStarts((prev) => {
      let last = -1;
      prev.forEach((v, k) => {
        if (v !== null) last = k;
      });
      if (last === -1) return prev;
      setTapPointer(last);
      return prev.map((v, k) => (k === last ? null : v));
    });
  }, []);

  useEffect(() => {
    if (!p.tapSyncing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (tapPointer < p.lines.length) markLine(tapPointer);
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        undoMark();
      } else if (e.code === 'Escape') {
        p.onTapSyncDone(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.tapSyncing, tapPointer, p.lines.length, markLine, undoMark, p]);

  const highlighted = p.tapSyncing ? tapPointer : active;

  // ------------------------------------------------------------ scrolling
  // Custom scrolling (long "out" easing, like the website) instead of the browser's smooth scroll:
  // duration proportional to distance, cancelled when the user scrolls by hand.
  const scrollAnim = useRef(0);
  const stopScrollAnim = () => cancelAnimationFrame(scrollAnim.current);
  useEffect(() => stopScrollAnim, []);

  const centerOn = useCallback(
    (i: number, instant = false) => {
      const box = scroller.current;
      const el = lineRefs.current[i];
      if (!box || !el) return;
      const target = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, el.offsetTop - box.clientHeight * 0.38 + el.offsetHeight / 2));
      cancelAnimationFrame(scrollAnim.current);
      const from = box.scrollTop;
      const delta = target - from;
      if (instant || reduced || Math.abs(delta) < 1) {
        box.scrollTop = target;
        return;
      }
      const duration = Math.min(900, 480 + Math.abs(delta) * 0.5);
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - k, 4);
        box.scrollTop = from + delta * eased;
        if (k < 1) scrollAnim.current = requestAnimationFrame(step);
      };
      scrollAnim.current = requestAnimationFrame(step);
    },
    [reduced],
  );

  useEffect(() => {
    if (highlighted < 0) return;
    if (!p.tapSyncing && Date.now() - userScrollAt.current < USER_SCROLL_HOLD_MS) return;
    centerOn(highlighted);
    setDetached(false);
  }, [highlighted, centerOn, p.tapSyncing]);

  // Font size / translation changes alter line heights: re-center without animation.
  useLayoutEffect(() => {
    if (highlighted >= 0) centerOn(highlighted, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.settings.fontScale, p.settings.showTranslation, p.translation.status]);

  // Coming back from caption to list: re-center without animation.
  useEffect(() => {
    if (!caption && highlighted >= 0) centerOn(highlighted, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption]);

  // A new track starts: back to the top.
  useEffect(() => {
    stopScrollAnim();
    scroller.current?.scrollTo({ top: 0 });
    userScrollAt.current = 0;
    setDetached(false);
  }, [p.lines]);

  const onUserScroll = () => {
    stopScrollAnim();
    userScrollAt.current = Date.now();
    if (liveSync || autoScroll) setDetached(true);
  };

  // No sync: scrolling proportional to the (estimated) duration, if enabled.
  useEffect(() => {
    if (!autoScroll || !p.live) return;
    const { tracker, durationMs } = p.live;
    let raf = 0;
    const loop = () => {
      const box = scroller.current;
      if (box && durationMs > 0 && Date.now() - userScrollAt.current > USER_SCROLL_HOLD_MS) {
        const frac = Math.min(1, (tracker.estimateProgress(performance.now()) / durationMs) * p.settings.unsyncedScrollSpeed);
        box.scrollTop = frac * (box.scrollHeight - box.clientHeight);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoScroll, p.live, p.settings.unsyncedScrollSpeed]);

  // ------------------------------------------------------------ render
  const style = { '--font-scale': p.settings.fontScale } as CSSProperties;

  // "07 / 42" counter of lines with text (instrumental pauses do not count).
  const textOrdinal = useMemo(() => {
    let n = 0;
    return p.lines.map((l) => (l.text !== '' ? ++n : n));
  }, [p.lines]);
  const textTotal = textOrdinal[textOrdinal.length - 1] ?? 0;
  const pad = (n: number) => String(n).padStart(2, '0');

  // Subtle sync indicator: a purple thread that fills up during the active line.
  // Computed only when the line changes (CSS animation, no per-frame loop).
  const lineTiming = useMemo(() => {
    if (!liveSync || active < 0 || !p.starts || !p.live) return null;
    const start = p.starts[active];
    let next: number | null = null;
    for (let j = active + 1; j < p.starts.length; j++) {
      if (p.starts[j] != null) {
        next = p.starts[j]!;
        break;
      }
    }
    if (start == null || next == null || next <= start) return null;
    const dur = next - start;
    const elapsed = Math.min(dur, Math.max(0, p.live.engine.lyricTimeAt(performance.now()) - start));
    return { dur, elapsed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, liveSync, p.starts]);
  const playing = p.live?.isPlaying ?? false;
  const progressBar = (i: number) =>
    lineTiming && i === active ? (
      <i
        key={`p${i}`}
        className="line-progress"
        aria-hidden
        style={{ animationDuration: `${lineTiming.dur}ms`, animationDelay: `${-lineTiming.elapsed}ms`, animationPlayState: playing ? 'running' : 'paused' }}
      />
    ) : null;

  const tr0 = p.translation.status === 'ready' ? p.translation.data : null;
  const showTr0 = p.settings.showTranslation && tr0 !== null && (tr0.status === 'translated' || tr0.status === 'partial');

  // ------------------------------------------------------------ caption (Visual mode)
  if (caption) {
    let shown: number[] = [];
    if (liveSync) {
      if (highlighted < 0) {
        const first = firstTextLine(p.lines, 0);
        if (first < p.lines.length) shown = [first];
      } else {
        shown = [highlighted - 1, highlighted, highlighted + 1].filter((i) => i >= 0 && i < p.lines.length);
      }
    }
    return (
      <div className="caption-wrap" style={style}>
        {liveSync ? (
          <div className="caption">
            {shown.map((i) => {
              const line = p.lines[i]!;
              const st = highlighted < 0 ? 'next' : i < highlighted ? 'past' : i === highlighted ? 'active' : 'next';
              const trLine = showTr0 ? tr0!.lines[i] : null;
              return (
                <div key={i} className={`cap-line${line.text === '' ? ' pause' : ''}`} data-state={st} aria-hidden={st !== 'active' || undefined}>
                  {line.text === '' ? (
                    <span className="pause-dots" aria-label={t('lyrics.instrumentalBreak')}>
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <>
                      <p className="orig">{line.text}</p>
                      {trLine && <p className="trans">{trLine}</p>}
                      {progressBar(i)}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="caption-note">
            <span aria-hidden>→</span>{' '}
            {!synced ? t('caption.unsynced') : t('caption.notLive')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="lyrics-wrap" style={style}>
      {liveSync && highlighted >= 0 && textOrdinal[highlighted]! > 0 && (
        <div className="line-counter" aria-hidden>
          <b>{pad(textOrdinal[highlighted]!)}</b> / {pad(textTotal)}
        </div>
      )}
      {p.tapSyncing && (
        <div className="tap-bar" role="region" aria-label={t('sync.tapSync')}>
          <div className="tap-bar-text">
            <strong>{t('sync.tapSync')}</strong>
            <span>{t('tap.help')}</span>
          </div>
          <div className="tap-bar-actions">
            <button className="btn ghost" onClick={undoMark}>
              {t('tap.undo')}
            </button>
            <button className="btn ghost" onClick={() => p.onTapSyncDone(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={!tapStarts.some((v) => v !== null)} onClick={() => p.onTapSyncDone(tapStarts)}>
              {t('tap.save')}
            </button>
          </div>
        </div>
      )}

      <div
        ref={scroller}
        className={`lyrics-scroller${synced ? ' is-synced' : ' is-unsynced'}${liveSync ? ' is-live' : ''}`}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onKeyDown={(e) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) onUserScroll();
        }}
        tabIndex={0}
        aria-label={t('lyrics.label')}
      >
        <div className="lyrics-list">
          {p.lines.map((line, i) => {
            const d = highlighted < 0 ? 99 : Math.abs(i - highlighted);
            const state = highlighted < 0 ? (synced && liveSync ? 'future' : 'plain') : i === highlighted ? 'active' : i < highlighted ? 'past' : 'future';
            const translationText = showTr0 ? tr0!.lines[i] : null;
            const clickable = p.tapSyncing ? line.text !== '' : liveSync && p.canSeek && p.starts?.[i] != null;
            const marked = p.tapSyncing && tapStarts[i] != null;
            const seekable = clickable && !p.tapSyncing;
            const activate = () => {
              if (p.tapSyncing) markLine(i);
              else p.onSeek(Math.max(0, (p.starts![i] as number) - p.offsetMs));
            };
            return (
              <div
                key={i}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                className={`line ${line.text === '' ? 'pause' : ''}`}
                data-state={state}
                data-dist={Math.min(d, 4)}
                data-marked={marked || undefined}
                onClick={clickable ? activate : undefined}
                // In "sync while playing" Space already marks the line via the global shortcut.
                tabIndex={seekable ? 0 : undefined}
                onKeyDown={
                  seekable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          activate();
                        }
                      }
                    : undefined
                }
                role={clickable ? 'button' : undefined}
                aria-label={seekable ? t('lyrics.seekTo', { line: line.text }) : undefined}
                aria-current={state === 'active' ? 'true' : undefined}
              >
                {line.text === '' ? (
                  <span className="pause-dots" aria-label={t('lyrics.instrumentalBreak')}>
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <>
                    <p className="orig">
                      {line.text}
                      {seekable && (
                        <span className="hint-anchor" aria-hidden>
                          <span className="line-hint">→ {t('lyrics.goTo')}</span>
                        </span>
                      )}
                    </p>
                    {translationText && <p className="trans">{translationText}</p>}
                    {progressBar(i)}
                  </>
                )}
              </div>
            );
          })}
          {p.footer}
        </div>
      </div>

      {detached && !p.tapSyncing && (
        <button
          className="btn pill back-to-line"
          onClick={() => {
            userScrollAt.current = 0;
            setDetached(false);
            if (highlighted >= 0) centerOn(highlighted);
          }}
        >
          <span aria-hidden>↓</span> {synced ? t('lyrics.backToLine') : t('lyrics.resumeScroll')}
        </button>
      )}
    </div>
  );
}

function firstTextLine(lines: LyricsLine[], from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i]!.text !== '') return i;
  return lines.length;
}

// Inert objects for when there is no live playback (the hook is never enabled with them).
const dummyEngine = new SE();
const dummyTracker = new PT({
  fetchSnapshot: async () => ({ ok: false, kind: 'network', message: '' }),
  now: () => 0,
  setTimer: () => 0,
  clearTimer: () => {},
});
