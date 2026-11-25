import { useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import type { AuthErrorCode, AuthStatus, PlaybackSnapshot } from '@lyricsync/shared';
import { useI18n } from '../i18n/i18n.tsx';
import { authErrorText } from '../i18n/errors.ts';
import { formatArtists } from '../lib/format.ts';
import { LanguageGrid } from './Header.tsx';

/**
 * First-run tutorial (4 steps). Shown while the flag
 * `mercurydev-musicas:onboarding-done` does not exist; reopened from Settings → "Show tutorial again".
 * Step 02 leads to OAuth (Authorization Code + PKCE, handled by the server); when coming back from
 * Spotify the tutorial reopens on the same step and shows the result.
 */

export const ONBOARDING_DONE_KEY = 'mercurydev-musicas:onboarding-done';
const STEP_KEY = 'mercurydev-musicas:onboarding-step';
const STEPS = 4;

export function onboardingDone(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DONE_KEY) === '1';
  } catch {
    return true; // no storage: do not insist on the tutorial on every visit
  }
}

function storedStep(): number {
  try {
    const n = Number(window.sessionStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n >= 0 && n < STEPS ? n : 0;
  } catch {
    return 0;
  }
}

function setStoredStep(n: number | null) {
  try {
    if (n === null) window.sessionStorage.removeItem(STEP_KEY);
    else window.sessionStorage.setItem(STEP_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function markDone() {
  try {
    window.localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* ignore */
  }
  setStoredStep(null);
}

/** Scopes requested from Spotify (the same as SPOTIFY_SCOPES on the server). */
const SCOPES = ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'] as const;

interface Props {
  auth: AuthStatus | null;
  authProblem: AuthErrorCode | null;
  snapshot: PlaybackSnapshot | null;
  /** State of the Spotify polling (offline, rate_limited…). */
  pbConnection: string;
  onClose: () => void;
  onOpenFavorites: () => void;
}

export function Onboarding({ auth, authProblem, snapshot, pbConnection, onClose, onOpenFavorites }: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState(storedStep);
  const dialog = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const connected = auth?.state === 'connected' && !authProblem;
  const finish = () => {
    markDone();
    onClose();
  };
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS - 1, n)));

  // Focus the heading on every step (screen readers announce the change).
  useEffect(() => {
    titleRef.current?.focus();
  }, [step]);

  // Keyboard: ←/→ navigate, Enter advances (outside buttons/links), Esc skips. Tab is trapped in the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const interactive = target.closest('button, a, input, select, [role="radio"], [role="listbox"]');
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      } else if (e.key === 'ArrowRight' && !interactive?.matches('[role="radio"]')) {
        if (step < STEPS - 1) go(step + 1);
      } else if (e.key === 'ArrowLeft' && !interactive?.matches('[role="radio"]')) {
        go(step - 1);
      } else if (e.key === 'Enter' && !interactive) {
        e.preventDefault();
        primary();
      } else if (e.key === 'Tab' && dialog.current) {
        const f = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"], h2[tabindex]')];
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const connect = () => {
    setStoredStep(1);
    window.location.href = '/login';
  };

  function primary() {
    if (step === 1 && !connected) return connect();
    if (step === STEPS - 1) return finish();
    go(step + 1);
  }

  const n = String(step + 1).padStart(2, '0');
  const total = String(STEPS).padStart(2, '0');

  let body: React.ReactNode;
  let primaryLabel = t('onb.next');
  if (step === 0) {
    body = (
      <>
        <h2 ref={titleRef} tabIndex={-1} id="onb-title">
          {t('onb.welcome.title')}
        </h2>
        <p className="onb-lead">{t('onb.welcome.body')}</p>
        <div className="onb-demo" aria-hidden>
          <span className="l past" />
          <span className="l active">
            <i />
          </span>
          <span className="l trans" />
          <span className="l next" />
        </div>
        <p className="onb-note">{t('onb.welcome.note')}</p>
      </>
    );
  } else if (step === 1) {
    if (!connected) primaryLabel = t('onb.connect.cta');
    body = (
      <>
        <h2 ref={titleRef} tabIndex={-1} id="onb-title">
          {t('onb.connect.title')}
        </h2>
        <p className="onb-lead">{t('onb.connect.body')}</p>
        <ul className="onb-scopes" aria-label={t('onb.connect.scopesLabel')}>
          {SCOPES.map((s) => (
            <li key={s}>
              <code>{s}</code>
              <span>{t(`onb.scope.${s}`)}</span>
            </li>
          ))}
        </ul>
        <p className="onb-note">{t('onb.connect.scopesNote')}</p>
        <ConnectState auth={auth} authProblem={authProblem} snapshot={snapshot} pbConnection={pbConnection} />
      </>
    );
  } else if (step === 2) {
    body = (
      <>
        <h2 ref={titleRef} tabIndex={-1} id="onb-title">
          {t('onb.lang.title')}
        </h2>
        <p className="onb-lead">{t('onb.lang.body')}</p>
        <LanguageGrid />
      </>
    );
  } else {
    primaryLabel = t('onb.done.cta');
    body = (
      <>
        <h2 ref={titleRef} tabIndex={-1} id="onb-title">
          {t('onb.done.title')}
        </h2>
        <ul className="onb-tips">
          <li>
            <span className="onb-tip-icon" aria-hidden>
              <Heart size={15} strokeWidth={1.5} fill="currentColor" />
            </span>
            <span>{t('onb.done.favorite')}</span>
          </li>
          <li>
            <span className="onb-tip-icon" aria-hidden>
              →
            </span>
            <span>
              {t('onb.done.favoritesWhere')}{' '}
              <button
                className="link-arrow"
                onClick={() => {
                  finish();
                  onOpenFavorites();
                }}
              >
                {t('fav.title')} <span className="arr" aria-hidden>→</span>
              </button>
            </span>
          </li>
          <li>
            <span className="onb-tip-icon mono" aria-hidden>
              V
            </span>
            <span>{t('onb.done.visual')}</span>
          </li>
        </ul>
      </>
    );
  }

  return (
    <div className="onb-backdrop">
      <div className="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title" ref={dialog}>
        <div className="onb-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step + 1} aria-label={t('onb.progress', { step: step + 1, total: STEPS })}>
          <i style={{ transform: `scaleX(${(step + 1) / STEPS})` }} />
        </div>
        <div className="onb-top">
          <span className="onb-count" aria-hidden>
            <b>{n}</b> / {total}
          </span>
          <button className="onb-skip" onClick={finish}>
            {t('onb.skip')}
          </button>
        </div>
        <div className="onb-body" key={step}>
          {body}
        </div>
        <div className="onb-actions">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => go(step - 1)}>
              <span aria-hidden>←</span> {t('onb.back')}
            </button>
          ) : (
            <span />
          )}
          <div className="onb-actions-right">
            {step === 1 && !connected && (
              <button className="btn ghost" onClick={() => go(step + 1)}>
                {t('onb.connect.later')}
              </button>
            )}
            <button className="btn primary" onClick={primary}>
              {primaryLabel} <span className="arr" aria-hidden>→</span>
            </button>
          </div>
        </div>
        <p className="onb-keys" aria-hidden>
          {t('onb.keys')}
        </p>
      </div>
    </div>
  );
}

/** Connection result on step 02: error, success, nothing playing, private session… */
function ConnectState({ auth, authProblem, snapshot, pbConnection }: { auth: AuthStatus | null; authProblem: AuthErrorCode | null; snapshot: PlaybackSnapshot | null; pbConnection: string }) {
  const { t } = useI18n();
  if (!auth) return null;
  const code = authProblem ?? (auth.state === 'error' ? auth.error?.code : null);
  if (code) {
    return (
      <p className="onb-state err" role="alert">
        <span aria-hidden>●</span> {authErrorText(code)}
      </p>
    );
  }
  if (auth.state !== 'connected' || !auth.user) {
    return <p className="onb-state off">{t('onb.connect.needsAllowlist')}</p>;
  }
  let line: string;
  let tone = 'ok';
  if (pbConnection === 'offline') {
    line = t('errors.offline');
    tone = 'warn';
  } else if (pbConnection === 'rate_limited') {
    line = t('errors.rate_limited');
    tone = 'warn';
  } else if (pbConnection === 'error') {
    line = t('errors.spotify_error');
    tone = 'warn';
  } else if (!snapshot) line = t('onb.connect.checking');
  else if (snapshot.status === 'idle') {
    line = t('onb.connect.idle');
    tone = 'warn';
  } else if (snapshot.status === 'private') {
    line = t('onb.connect.private');
    tone = 'warn';
  } else if (snapshot.track) line = t('onb.connect.playing', { title: snapshot.track.name, artist: formatArtists(snapshot.track.artists) });
  else line = t('onb.connect.notMusic');
  return (
    <div className={`onb-state ${tone}`} role="status">
      <p>
        <span aria-hidden>●</span> {t('conn.connectedAs', { name: auth.user.displayName })}
      </p>
      <p>
        <span aria-hidden>→</span> {line}
      </p>
      {auth.user.product && auth.user.product !== 'premium' && <p className="onb-premium">{t('conn.planFree')}</p>}
    </div>
  );
}
