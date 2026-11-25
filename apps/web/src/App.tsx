import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Heart, Play } from 'lucide-react';
import {
  AUTH_ERROR_MESSAGES,
  SyncEngine,
  findTargetLanguage,
  type AuthErrorCode,
  type AuthStatus,
  type ControlAction,
  type LyricsResult,
  type SyncMode,
  type TrackInfo,
  type TrackView,
  type TranslationResult,
} from '@lyricsync/shared';
import { Header, LanguageGrid } from './components/Header.tsx';
import { LyricsView, type LiveContext } from './components/LyricsView.tsx';
import { Onboarding, onboardingDone } from './components/Onboarding.tsx';
import { CandidatesDialog, LibraryPanel, SettingsPanel } from './components/Panels.tsx';
import { PlayerBar, Tip } from './components/PlayerBar.tsx';
import { MiniScope, NoSignal, StageControls, Visualizer, toggleFullscreen } from './components/Visual.tsx';
import { useSettings, useTrackView, useTranslation, type Load } from './hooks/useData.ts';
import { useFavorites, type FavoritesStore } from './hooks/useFavorites.ts';
import { usePlayback } from './hooks/usePlayback.ts';
import { usePrefersReducedMotion } from './hooks/useSync.ts';
import { useAudioStatus, useVisualPrefs } from './hooks/useVisual.ts';
import { useI18n } from './i18n/i18n.tsx';
import { authErrorText, errorText } from './i18n/errors.ts';
import { SCENES } from './lib/visualizer/scenes.ts';
import { api, ApiError, type AppMeta } from './lib/api.ts';
import { dominantColor, toTint } from './lib/color.ts';
import { formatArtists } from './lib/format.ts';

type Panel = 'library' | 'favorites' | 'settings' | 'candidates' | null;
export type ViewMode = 'lyrics' | 'visual';

function readAuthErrorFromUrl(): AuthErrorCode | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('auth_error') as AuthErrorCode | null;
  if (code) {
    params.delete('auth_error');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }
  return code && code in AUTH_ERROR_MESSAGES ? code : null;
}

export function App() {
  const { t, lang } = useI18n();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authProblem, setAuthProblem] = useState<AuthErrorCode | null>(() => readAuthErrorFromUrl());
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [serverDown, setServerDown] = useState(false);

  const loadAuth = useCallback(() => {
    api
      .authStatus()
      .then((a) => {
        setAuth(a);
        setServerDown(false);
      })
      .catch(() => setServerDown(true));
  }, []);

  useEffect(() => {
    loadAuth();
    api.meta().then(setMeta).catch(() => {});
  }, [loadAuth]);

  // Server down at load time: retry every 5 s.
  useEffect(() => {
    if (!serverDown) return;
    const timer = window.setTimeout(loadAuth, 5000);
    return () => window.clearTimeout(timer);
  }, [serverDown, loadAuth]);

  const connected = auth?.state === 'connected' && authProblem === null;
  const { tracker, state: pb, authErrorCode } = usePlayback(connected);
  const { settings, update: updateSettings, loaded: settingsLoaded } = useSettings(connected);
  const engine = useMemo(() => new SyncEngine(), []);
  const favorites = useFavorites(connected, connected && auth?.user ? auth.user : null);

  // Session rejected while in use (token revoked, account removed from the allowlist…).
  useEffect(() => {
    if (pb.connection !== 'unauthorized') return;
    const code = authErrorCode.current as AuthErrorCode | null;
    if (code === 'not_allowlisted' || code === 'owner_premium_required') setAuthProblem(code);
    else setAuthProblem('session_expired');
    loadAuth();
  }, [pb.connection, authErrorCode, loadAuth]);

  // The UI language is also the translation target: keep the server in sync.
  useEffect(() => {
    if (connected && settingsLoaded && settings.targetLang !== lang) void updateSettings({ targetLang: lang });
  }, [connected, settingsLoaded, settings.targetLang, lang, updateSettings]);

  // ---------------------------------------------------------------- which track to show
  const [reader, setReader] = useState<TrackInfo | null>(null);
  const snap = pb.snapshot;
  const liveTrack = snap?.status === 'active' ? snap.track : null;
  const isReader = reader !== null && reader.key !== liveTrack?.key;
  const viewKey = connected ? (isReader ? reader.key : (liveTrack?.key ?? null)) : null;
  const { state: viewState, reload: reloadView, patch: patchView } = useTrackView(viewKey);
  const view = viewState.status === 'ready' && viewState.data.track.key === viewKey ? viewState.data : null;
  const lyrics = view?.lyrics ?? null;
  const found = lyrics?.status === 'found' ? lyrics : null;
  const displayTrack = view?.track ?? (isReader ? reader : liveTrack);

  // Switching language re-translates the open lyrics (the hook depends on `lang`).
  const { state: translation, retry: retryTranslation } = useTranslation(found ? view!.track.key : null, found?.lyricsHash ?? null, lang, Boolean(found) && settings.showTranslation);

  // ---------------------------------------------------------------- sync
  const syncMode: SyncMode = view?.manualTimings ? 'manual' : found?.synced ? 'source' : 'none';
  const starts = useMemo(() => {
    if (!found) return null;
    if (view?.manualTimings) return view.manualTimings.starts;
    if (found.synced) return found.lines.map((l) => l.startMs);
    return null;
  }, [found, view?.manualTimings]);

  const [offsetMs, setOffsetMs] = useState(0);
  useEffect(() => setOffsetMs(view?.offsetMs ?? 0), [view?.track.key, view?.offsetMs]);
  const offsetTimer = useRef(0);
  const changeOffset = (ms: number | null) => {
    if (!view) return;
    const key = view.track.key;
    setOffsetMs(ms ?? settings.defaultOffsetMs);
    window.clearTimeout(offsetTimer.current);
    offsetTimer.current = window.setTimeout(() => {
      void api.setOffset(key, ms).then((r) => {
        if (ms === null) setOffsetMs(r.offsetMs);
        patchView((v) => (v.track.key === key ? { ...v, offsetMs: r.offsetMs } : v));
      });
    }, 350);
  };

  const [tapSyncing, setTapSyncing] = useState(false);
  const [failed, setFailed] = useState<Partial<Record<ControlAction, string>>>({});
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    setTapSyncing(false);
    setFailed({});
  }, [viewKey]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const live: LiveContext | null =
    connected && snap?.status === 'active'
      ? {
          tracker,
          engine,
          matches: !isReader && Boolean(liveTrack) && liveTrack?.key === view?.track.key,
          isPlaying: snap.isPlaying,
          durationMs: liveTrack?.durationMs ?? 0,
        }
      : null;

  // ---------------------------------------------------------------- controls
  const premium = auth?.user?.product === 'premium';
  const reasonFor = (a: ControlAction): string | null => {
    if (!connected) return t('reason.connect');
    if (auth?.user?.product && !premium) return t('reason.premium');
    if (!snap || snap.status !== 'active') return t('reason.nothingPlaying');
    if (!snap.device) return t('reason.noDevice');
    if (snap.device.isRestricted) return t('reason.restricted');
    if (a === 'volume' && !snap.device.supportsVolume) return t('reason.noVolume');
    if (snap.disallows.includes(a)) return t('reason.disallowed');
    return failed[a] ?? null;
  };
  const reasons = Object.fromEntries((['play', 'pause', 'next', 'previous', 'seek', 'volume'] as const).map((a) => [a, reasonFor(a)])) as Record<ControlAction, string | null>;

  const handleControlError = (a: ControlAction, e: unknown) => {
    const err = e instanceof ApiError ? e : null;
    const msg = errorText(e, 'errors.controlRejected');
    setToast(msg);
    if (err && ['premium_required', 'restricted', 'no_active_device'].includes(err.code)) setFailed((f) => ({ ...f, [a]: msg }));
    tracker.pollSoon(0);
  };

  const control = async (a: 'play' | 'pause' | 'next' | 'previous') => {
    if (a === 'play' || a === 'pause') tracker.applyOptimistic({ isPlaying: a === 'play' });
    try {
      await api.control(a);
      tracker.pollSoon(a === 'next' || a === 'previous' ? 600 : 400);
    } catch (e) {
      handleControlError(a, e);
    }
  };
  const seek = async (ms: number) => {
    if (reasons.seek) return;
    tracker.applyOptimistic({ progressMs: ms });
    try {
      await api.seek(ms);
      tracker.pollSoon(900);
    } catch (e) {
      handleControlError('seek', e);
    }
  };
  const volume = async (v: number) => {
    try {
      await api.volume(v);
    } catch (e) {
      handleControlError('volume', e);
    }
  };

  // ---------------------------------------------------------------- track actions
  const [panel, setPanel] = useState<Panel>(null);
  const closePanel = useCallback(() => setPanel(null), []);

  // ---------------------------------------------------------------- first-run tutorial
  const [tutorial, setTutorial] = useState(false);
  const tutorialChecked = useRef(false);
  useEffect(() => {
    if (tutorialChecked.current || !auth || serverDown) return;
    tutorialChecked.current = true;
    if (!onboardingDone()) setTutorial(true);
  }, [auth, serverDown]);

  // ---------------------------------------------------------------- Visual mode
  const [mode, setMode] = useState<ViewMode>('lyrics');
  const { prefs: visual, update: updateVisual } = useVisualPrefs();
  const audioStatus = useAudioStatus();
  const audioLive = audioStatus.state === 'live';
  const reducedMotion = usePrefersReducedMotion();
  const toggleMode = useCallback(() => setMode((m) => (m === 'visual' ? 'lyrics' : 'visual')), []);

  // Shortcuts: V toggles Lyrics/Visual; in Visual, 1–6 switch the style and F goes fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || panel || tapSyncing || tutorial) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, select, textarea, [contenteditable="true"], [role="dialog"], [role="listbox"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'v') toggleMode();
      else if (mode === 'visual' && k === 'f') void toggleFullscreen();
      else if (mode === 'visual' && /^[1-9]$/.test(k) && SCENES[Number(k) - 1]) updateVisual({ scene: SCENES[Number(k) - 1]!.id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, panel, tapSyncing, tutorial, toggleMode, updateVisual]);

  // In Visual mode the UI fades out after a few idle seconds (comes back on movement).
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (mode !== 'visual') {
      setIdle(false);
      return;
    }
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 3200);
    };
    wake();
    const evs = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    evs.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      evs.forEach((e) => window.removeEventListener(e, wake));
    };
  }, [mode]);
  useEffect(() => {
    if (mode === 'lyrics' && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [mode]);

  const openTrack = (tr: TrackInfo) => {
    setPanel(null);
    setReader(tr.key === liveTrack?.key ? null : tr);
  };

  const toggleFavorite = async () => {
    if (!view) return;
    const next = !view.isFavorite;
    patchView((v) => ({ ...v, isFavorite: next }));
    try {
      await favorites.setFavorite(view.track, next);
      setToast(t(next ? 'fav.added' : 'fav.removed'));
    } catch (e) {
      patchView((v) => ({ ...v, isFavorite: !next }));
      setToast(errorText(e));
    }
  };

  const unfavorite = async (tr: TrackInfo) => {
    await favorites.setFavorite(tr, false);
    patchView((v) => (v.track.key === tr.key ? { ...v, isFavorite: false } : v));
    setToast(t('fav.removed'));
  };

  const saveTapSync = async (s: (number | null)[] | null) => {
    setTapSyncing(false);
    if (!s || !view || !found) return;
    try {
      const timings = await api.saveTimings(view.track.key, found.lyricsHash, s);
      patchView((v) => ({ ...v, manualTimings: timings }));
      setToast(t('toast.timingsSaved'));
    } catch (e) {
      setToast(errorText(e, 'toast.timingsFailed'));
    }
  };
  const clearManual = async () => {
    if (!view) return;
    await api.clearTimings(view.track.key);
    patchView((v) => ({ ...v, manualTimings: null }));
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    setPanel(null);
    setReader(null);
    setAuthProblem(null);
    loadAuth();
  };

  // ---------------------------------------------------------------- ambient light: brand purple + cover color
  const [tint, setTint] = useState<{ base: string } | null>(null);
  const coverUrl = displayTrack?.coverUrl ?? null;
  useEffect(() => {
    if (!coverUrl) {
      setTint(null);
      return;
    }
    let alive = true;
    void dominantColor(coverUrl).then((c) => alive && setTint(c ? toTint(c) : null));
    return () => {
      alive = false;
    };
  }, [coverUrl]);
  const appStyle = (tint ? { '--tint': tint.base } : {}) as CSSProperties;

  // ---------------------------------------------------------------- render
  const effectiveAuth: AuthStatus | null =
    auth && authProblem ? { state: 'error', user: auth.user, error: { code: authProblem, message: AUTH_ERROR_MESSAGES[authProblem] } } : auth;

  const openFavorites = () => setPanel('favorites');
  const favShortcut = <FavShortcut store={favorites} onOpen={openFavorites} />;

  let main: React.ReactNode;
  if (serverDown) {
    main = <Empty title={t('empty.serverDown.title')} body={t('empty.serverDown.body')} />;
  } else if (!auth) {
    main = <Empty title={t('common.loading')} quiet />;
  } else if (effectiveAuth?.state === 'error') {
    main = <AuthErrorScreen status={effectiveAuth} onRetry={() => setAuthProblem(null)} />;
  } else if (!connected) {
    main = <Welcome favorites={favorites} onOpenFavorites={openFavorites} />;
  } else if (!isReader && !snap) {
    main =
      pb.connection === 'offline' ? (
        <Empty title={t('empty.offline.title')} body={t('empty.offline.body')} />
      ) : pb.connection === 'error' || pb.connection === 'rate_limited' ? (
        <Empty title={t('empty.spotifyError.title')} body={pb.connection === 'rate_limited' ? t('errors.rate_limited') : t('empty.spotifyError.body')}>
          <button className="btn ghost" onClick={() => setPanel('library')}>
            {t('empty.openLibrary')}
          </button>
        </Empty>
      ) : (
        <Empty title={t('empty.looking')} quiet />
      );
  } else if (!isReader && snap?.status === 'idle') {
    main = (
      <Empty title={t('empty.idle.title')} body={t('empty.idle.body')}>
        <button className="btn ghost" onClick={() => setPanel('library')}>
          {t('empty.openLibrary')}
        </button>
        {favShortcut}
      </Empty>
    );
  } else if (!isReader && snap?.status === 'private') {
    main = <Empty title={t('empty.private.title')} body={t('empty.private.body')} />;
  } else if (!isReader && snap?.status === 'active' && !liveTrack) {
    const kind = snap.kind;
    main = (
      <Empty
        title={kind === 'episode' ? t('empty.podcast.title') : kind === 'ad' ? t('empty.ad.title') : t('empty.notMusic.title')}
        body={kind === 'ad' ? t('empty.ad.body') : t('empty.notMusic.body')}
      />
    );
  } else {
    main = (
      <TrackScreen
        track={displayTrack!}
        viewState={viewState.status === 'ready' && !view ? { status: 'loading' } : viewState}
        view={view}
        lyrics={lyrics}
        translation={translation}
        onRetryTranslation={retryTranslation}
        onRetryLyrics={reloadView}
        settings={settings}
        isReader={isReader}
        onBackToLive={() => setReader(null)}
        canPlayHere={Boolean(isReader && view?.track.uri && premium)}
        onPlayHere={() => {
          if (!view?.track.uri) return;
          api
            .playTrack(view.track.uri)
            .then(() => {
              setReader(null);
              tracker.pollSoon(700);
            })
            .catch((e: unknown) => setToast(errorText(e, 'toast.playFailed')));
        }}
        onToggleFavorite={toggleFavorite}
        onWrongLyrics={() => setPanel('candidates')}
        visualMode={mode === 'visual'}
        lyricsBody={
          found ? (
            <LyricsView
              lines={found.lines}
              syncMode={syncMode}
              starts={starts}
              offsetMs={offsetMs}
              translation={translation}
              settings={settings}
              live={isReader ? null : live}
              canSeek={!reasons.seek}
              onSeek={(ms) => void seek(ms)}
              tapSyncing={tapSyncing}
              onTapSyncDone={(s) => void saveTapSync(s)}
              footer={<LyricsCredits lyrics={found} />}
              presentation={mode === 'visual' ? 'caption' : 'list'}
            />
          ) : null
        }
      />
    );
  }

  const showPlayer = connected && !serverDown;
  const ambient = mode === 'lyrics' && visual.ambient && audioLive && !reducedMotion;
  const appClass = ['app', tint && 'tinted', `mode-${mode}`, mode === 'visual' && !visual.captions && 'captions-off', idle && 'idle', audioLive && 'audio-live']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={appClass} style={appStyle}>
      <div className="backdrop" aria-hidden>
        {coverUrl && connected && <img className="wash" key={coverUrl} src={coverUrl} alt="" />}
        <i className="aura a" />
        <i className="aura b" />
        <i className="geo" />
        {ambient && <Visualizer scene={visual.scene} variant="ambient" />}
        {mode === 'visual' && <Visualizer scene={visual.scene} variant="stage" />}
      </div>
      <Header
        auth={effectiveAuth}
        onOpenLibrary={() => setPanel('library')}
        onOpenFavorites={openFavorites}
        onOpenSettings={() => setPanel('settings')}
        onLogout={() => void logout()}
        onTutorial={() => setTutorial(true)}
        connected={connected}
        mode={mode}
        onMode={setMode}
      />
      {connected && (pb.connection === 'offline' || pb.connection === 'error' || pb.connection === 'rate_limited') && snap && (
        <div className="banner" role="status">
          {pb.connection === 'rate_limited' ? t('banner.rateLimited') : pb.connection === 'offline' ? t('banner.offline') : t('banner.spotifyError')}
        </div>
      )}
      <main className="main">
        {main}
        {mode === 'visual' && (
          <div className="stage-ui">
            {!audioLive && <NoSignal />}
            <StageControls scene={visual.scene} onScene={(scene) => updateVisual({ scene })} captions={visual.captions} onCaptions={(captions) => updateVisual({ captions })} />
          </div>
        )}
      </main>
      {showPlayer && (
        <PlayerBar
          snapshot={isReader ? null : snap}
          live={isReader ? null : live}
          reasons={isReader ? Object.fromEntries(Object.keys(reasons).map((k) => [k, t('reason.reader')])) : reasons}
          onControl={(a) => void control(a)}
          onSeek={(ms) => void seek(ms)}
          onVolume={(v) => void volume(v)}
          mode={mode}
          onToggleMode={toggleMode}
          sync={{
            mode: isReader && found ? 'reader' : found ? syncMode : null,
            sourceLabel: found ? (found.source === 'lrclib' ? 'LRCLIB' : 'Musixmatch') : null,
            offsetMs,
            offsetEditable: !isReader && syncMode !== 'none',
            onOffset: changeOffset,
            canTapSync: Boolean(found && live?.matches && !isReader),
            onTapSync: () => {
              setMode('lyrics');
              setTapSyncing(true);
            },
            hasManual: Boolean(view?.manualTimings),
            onClearManual: () => void clearManual(),
          }}
        />
      )}

      {(panel === 'library' || panel === 'favorites') && (
        <LibraryPanel
          key={panel}
          initialTab={panel === 'favorites' ? 'favorites' : 'history'}
          connected={connected}
          favorites={favorites}
          onClose={closePanel}
          onOpenTrack={openTrack}
          onUnfavorite={unfavorite}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          update={(p) => void updateSettings(p)}
          meta={meta}
          connected={connected}
          onLogout={() => void logout()}
          onClose={closePanel}
          visual={visual}
          updateVisual={updateVisual}
          onTutorial={() => setTutorial(true)}
        />
      )}
      {panel === 'candidates' && view && (
        <CandidatesDialog
          track={view.track}
          currentSourceId={found?.source === 'lrclib' ? found.sourceId : lyrics?.status === 'instrumental' ? lyrics.sourceId : null}
          userChosen={Boolean(found?.userChosen)}
          onPick={async (id) => {
            const next = await api.chooseLyrics(view.track.key, id);
            patchView(() => next);
          }}
          onClose={closePanel}
        />
      )}
      {tutorial && (
        <Onboarding
          auth={auth}
          authProblem={authProblem}
          snapshot={snap}
          pbConnection={pb.connection}
          onClose={() => setTutorial(false)}
          onOpenFavorites={openFavorites}
        />
      )}
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ==================================================================== screens

function Empty({ title, body, children, quiet }: { title: string; body?: string; children?: React.ReactNode; quiet?: boolean }) {
  return (
    <section className={`empty${quiet ? ' quiet' : ''}`}>
      <h1>{title}</h1>
      {body && <p>{body}</p>}
      {children && <div className="empty-actions">{children}</div>}
    </section>
  );
}

/** Shortcut to favorites (home screen and "nothing playing"). */
function FavShortcut({ store, onOpen }: { store: FavoritesStore; onOpen: () => void }) {
  const { t } = useI18n();
  const n = store.items?.length ?? 0;
  return (
    <button className="fav-shortcut" onClick={onOpen}>
      <Heart size={14} strokeWidth={1.5} fill="currentColor" aria-hidden />
      <span>{t('fav.title')}</span>
      <span className="fav-shortcut-count">{t('fav.count', { count: n })}</span>
      <span className="arr" aria-hidden>
        →
      </span>
    </button>
  );
}

function Welcome({ favorites, onOpenFavorites }: { favorites: FavoritesStore; onOpenFavorites: () => void }) {
  const { t } = useI18n();
  return (
    <section className="welcome">
      <p className="welcome-eyebrow">
        Spotify <b>→</b> LRCLIB <b>→</b> {t('welcome.translation')}
      </p>
      <h1>{t('welcome.title')}</h1>
      <p>{t('welcome.body')}</p>
      <div className="welcome-actions">
        <a className="btn spotify large" href="/login">
          {t('welcome.connect')} <span className="arr" aria-hidden>→</span>
        </a>
        {(favorites.items?.length ?? 0) > 0 && <FavShortcut store={favorites} onOpen={onOpenFavorites} />}
      </div>
      <div className="welcome-lang">
        <p className="welcome-lang-label">{t('welcome.langLabel')}</p>
        <LanguageGrid />
      </div>
      <p className="fine">{t('welcome.fine')}</p>
    </section>
  );
}

function AuthErrorScreen({ status, onRetry }: { status: AuthStatus; onRetry: () => void }) {
  const { t } = useI18n();
  const code = status.error?.code;
  return (
    <Empty title={code === 'config_missing' ? t('auth.configTitle') : t('auth.failedTitle')} body={authErrorText(code)}>
      {code === 'config_missing' && status.error?.message && <p className="config-details">{status.error.message}</p>}
      {code !== 'config_missing' && (
        <a className="btn spotify" href="/login" onClick={onRetry}>
          {t('conn.reconnect')} <span className="arr" aria-hidden>→</span>
        </a>
      )}
    </Empty>
  );
}

interface TrackScreenProps {
  track: TrackInfo;
  viewState: Load<TrackView>;
  view: TrackView | null;
  lyrics: LyricsResult | null;
  translation: Load<TranslationResult>;
  onRetryTranslation: () => void;
  onRetryLyrics: () => void;
  settings: { showTranslation: boolean };
  isReader: boolean;
  onBackToLive: () => void;
  canPlayHere: boolean;
  onPlayHere: () => void;
  onToggleFavorite: () => void;
  onWrongLyrics: () => void;
  lyricsBody: React.ReactNode;
  visualMode: boolean;
}

function TrackScreen(p: TrackScreenProps) {
  const { t } = useI18n();
  const tr = p.track;
  const haloRef = useRef<HTMLImageElement>(null);
  let body: React.ReactNode = p.lyricsBody;
  if (!body) {
    if (p.viewState.status === 'loading' || p.viewState.status === 'idle') body = <LyricsSkeleton />;
    else if (p.viewState.status === 'error') {
      const e = p.viewState.error;
      body = (
        <Empty title={e.code === 'offline' ? t('lyrics.err.offline') : e.code === 'rate_limited' ? t('lyrics.err.rateLimited') : t('lyrics.err.generic')} body={errorText(e)}>
          <button className="btn ghost" onClick={p.onRetryLyrics}>
            {t('common.retry')}
          </button>
        </Empty>
      );
    } else if (p.lyrics?.status === 'instrumental') {
      body = <Empty title={t('lyrics.instrumental.title')} body={t('lyrics.instrumental.body')} />;
    } else if (p.lyrics?.status === 'not_found') {
      body = (
        <Empty title={t('lyrics.notFound.title')} body={t('lyrics.notFound.body')}>
          <button className="btn ghost" onClick={p.onWrongLyrics}>
            {t('lyrics.notFound.cta')} <span className="arr" aria-hidden>→</span>
          </button>
        </Empty>
      );
    }
  }

  const fav = Boolean(p.view?.isFavorite);
  return (
    <div className="track-screen">
      <aside className="now">
        {p.isReader && (
          <button className="btn ghost small back" onClick={p.onBackToLive}>
            <ArrowLeft size={15} strokeWidth={1.5} /> {t('track.backToLive')}
          </button>
        )}
        <div className="cover-stage">
          {tr.coverUrl && <img className="cover-halo" key={`h${tr.coverUrl}`} ref={haloRef} src={tr.coverUrl} alt="" aria-hidden />}
          <div className="cover">{tr.coverUrl ? <img key={tr.coverUrl} src={tr.coverUrl} alt={t('track.coverAlt', { album: tr.album })} /> : <div className="cover-ph" aria-hidden />}</div>
        </div>
        {!p.visualMode && <MiniScope haloRef={haloRef} />}
        <div className="now-meta" key={tr.key}>
          <p className="now-eyebrow">
            {p.isReader ? (
              t('track.readerMode')
            ) : (
              <>
                <span className="live" aria-hidden />
                {t('track.nowPlaying')}
              </>
            )}
          </p>
          <div className="now-title-row">
            <h1 className="now-title">{tr.name}</h1>
            {p.view && (
              <button
                className={`icon-btn fav${fav ? ' on' : ''}`}
                onClick={p.onToggleFavorite}
                aria-pressed={fav}
                aria-label={t('fav.toggle', { title: tr.name })}
                title={fav ? t('fav.remove') : t('fav.add')}
              >
                <Heart size={18} strokeWidth={1.5} fill={fav ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          <p className="now-artist">{formatArtists(tr.artists)}</p>
          {tr.album && <p className="now-album">{tr.album}</p>}
          {tr.isLocal && <p className="now-album">{t('track.localFile')}</p>}
        </div>
        <div className="now-badges">
          <LyricsBadges lyrics={p.lyrics} />
          <TranslationBadge state={p.translation} enabled={p.settings.showTranslation} onRetry={p.onRetryTranslation} hasLyrics={p.lyrics?.status === 'found'} />
        </div>
        <div className="now-actions">
          {p.canPlayHere && (
            <button className="btn ghost small" onClick={p.onPlayHere}>
              <Play size={13} strokeWidth={1.5} fill="currentColor" /> {t('track.playOnSpotify')}
            </button>
          )}
          {p.view && p.lyrics?.status !== 'not_found' && (
            <button className="link-arrow" onClick={p.onWrongLyrics}>
              {t('track.wrongLyrics')} <span className="arr" aria-hidden>→</span>
            </button>
          )}
        </div>
      </aside>
      <section className="lyrics-pane">{body}</section>
    </div>
  );
}

function LyricsBadges({ lyrics }: { lyrics: LyricsResult | null }) {
  const { t } = useI18n();
  if (!lyrics || lyrics.status !== 'found') return null;
  const mismatch = lyrics.warning === 'duration_mismatch';
  return (
    <>
      {!lyrics.synced && (
        <Tip text={mismatch ? t('badge.versionMismatchTip') : t('badge.noTimesTip')}>
          <span className="badge warn">{mismatch ? t('badge.versionMismatch') : t('badge.unsynced')}</span>
        </Tip>
      )}
      {lyrics.userChosen && <span className="badge">{t('badge.userChosen')}</span>}
    </>
  );
}

function TranslationBadge({ state, enabled, onRetry, hasLyrics }: { state: Load<TranslationResult>; enabled: boolean; onRetry: () => void; hasLyrics: boolean }) {
  const { t, fmt } = useI18n();
  if (!enabled || !hasLyrics) return null;
  const failed = (
    <span className="badge err">
      {t('badge.translationFailed')}{' '}
      <button className="link-btn" onClick={onRetry}>
        {t('common.tryAgain')}
      </button>
    </span>
  );
  if (state.status === 'loading') return <span className="badge pending">{t('badge.translating')}</span>;
  if (state.status === 'error') return failed;
  if (state.status !== 'ready') return null;
  const r = state.data;
  const target = findTargetLanguage(r.targetLang)?.label ?? r.targetLang;
  switch (r.status) {
    case 'translated':
    case 'partial': {
      const tip = [r.provider, r.model, r.detectedLang ? t('badge.detected', { language: fmt.languageName(r.detectedLang) }) : null, r.status === 'partial' ? t('badge.partialTip') : null]
        .filter(Boolean)
        .join(' · ');
      return (
        <Tip text={tip}>
          <span className="badge accent">
            {t('badge.translated')}
            {r.status === 'partial' ? ` · ${t('badge.partial')}` : ''}
          </span>
        </Tip>
      );
    }
    case 'not_needed':
      return <span className="badge">{t('badge.alreadyIn', { language: target })}</span>;
    case 'unavailable':
      return (
        <Tip text={t('badge.unconfiguredTip')}>
          <span className="badge">{t('badge.unconfigured')}</span>
        </Tip>
      );
    case 'failed':
      return failed;
  }
}

function LyricsCredits({ lyrics }: { lyrics: Extract<LyricsResult, { status: 'found' }> }) {
  const { t } = useI18n();
  return (
    <div className="credits">
      <span>{t('credits.lyricsBy', { source: lyrics.source === 'lrclib' ? 'LRCLIB' : 'Musixmatch' })}</span>
      {lyrics.copyright && <span>{lyrics.copyright}</span>}
      <span>{t('credits.personal')}</span>
    </div>
  );
}

function LyricsSkeleton() {
  const { t } = useI18n();
  const text = t('lyrics.loading');
  return (
    <div className="loading-type" role="status" aria-label={text}>
      <span className="prompt" aria-hidden>
        →
      </span>
      <span className="typed" aria-hidden style={{ '--steps': [...text].length } as CSSProperties}>
        {text}
      </span>
      <span className="caret" aria-hidden />
    </div>
  );
}
