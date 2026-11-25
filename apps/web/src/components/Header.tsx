import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Heart, Library, Settings as SettingsIcon } from 'lucide-react';
import { findTargetLanguage, type AuthStatus } from '@lyricsync/shared';
import type { ViewMode } from '../App.tsx';
import { LANGUAGES, useI18n } from '../i18n/i18n.tsx';
import { authErrorText } from '../i18n/errors.ts';
import { AudioControl } from './Visual.tsx';

interface Props {
  auth: AuthStatus | null;
  onOpenLibrary: () => void;
  onOpenFavorites: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  onTutorial: () => void;
  connected: boolean;
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
}

export function Logo() {
  const { t } = useI18n();
  return (
    <span className="logo" aria-label={t('app.name')}>
      <span className="logo-word" aria-hidden>
        MercuryDev
      </span>
      <span className="logo-dot" aria-hidden />
      <span className="logo-sub" aria-hidden>
        músicas
      </span>
    </span>
  );
}

export function Header({ auth, onOpenLibrary, onOpenFavorites, onOpenSettings, onLogout, onTutorial, connected, mode, onMode }: Props) {
  const { t } = useI18n();
  return (
    <header className="header">
      <Logo />
      <div className="mode-switch" role="tablist" aria-label={t('mode.label')}>
        {(
          [
            ['lyrics', '01', t('mode.lyrics')],
            ['visual', '02', t('mode.visual')],
          ] as const
        ).map(([id, n, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? 'on' : ''} onClick={() => onMode(id)} title={t('mode.hint', { mode: label })}>
            <span className="n">{n}</span>
            {label}
          </button>
        ))}
      </div>
      <div className="header-right">
        <ConnectionStatus auth={auth} onLogout={onLogout} onTutorial={onTutorial} />
        <AudioControl />
        <LanguagePicker />
        <button className="icon-btn fav-btn" onClick={onOpenFavorites} aria-label={t('fav.open')} title={t('fav.open')}>
          <Heart size={16} strokeWidth={1.5} />
        </button>
        <button className="icon-btn" onClick={onOpenLibrary} disabled={!connected} aria-label={t('library.open')} title={connected ? t('library.openHint') : t('library.needsSpotify')}>
          <Library size={17} strokeWidth={1.5} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label={t('settings.title')} title={t('settings.title')}>
          <SettingsIcon size={17} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ close popovers on outside click / Esc

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

// ------------------------------------------------------------------ Spotify status (log style)

function ConnectionStatus({ auth, onLogout, onTutorial }: { auth: AuthStatus | null; onLogout: () => void; onTutorial: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, wrap);

  if (!auth) {
    return (
      <span className="conn conn-wait" role="status">
        <span className="conn-dot" aria-hidden>
          ·
        </span>
        <span className="conn-text">{t('conn.checking')}</span>
      </span>
    );
  }
  if (auth.state === 'disconnected') {
    return (
      <a className="conn conn-off" href="/login" aria-label={`${t('conn.disconnected')}. ${t('conn.connect')}`}>
        <span className="conn-dot" aria-hidden>
          ○
        </span>
        <span className="conn-text">{t('conn.disconnected')}</span>
        <span className="conn-cta" aria-hidden>
          → {t('conn.connect')}
        </span>
      </a>
    );
  }

  const ok = auth.state === 'connected' && auth.user;
  const product = auth.user?.product ?? null;
  return (
    <div className="conn-wrap" ref={wrap}>
      <button
        className={`conn ${ok ? 'conn-on' : 'conn-err'}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ok ? t('conn.connectedAs', { name: auth.user!.displayName }) : t('conn.error')}
      >
        <span className="conn-dot" aria-hidden>
          ●
        </span>
        <span className="conn-text">{ok ? t('conn.connectedAs', { name: auth.user!.displayName }) : t('conn.error')}</span>
      </button>
      {open && (
        <div className="popover conn-pop" role="dialog" aria-label={t('conn.title')}>
          <p className="pop-title">{t('conn.title')}</p>
          {ok ? (
            <>
              <p className="conn-log">
                <span className="ok" aria-hidden>
                  ●
                </span>{' '}
                {t('conn.connectedAs', { name: auth.user!.displayName })}
              </p>
              <p className="pop-help">{product === 'premium' ? t('conn.planPremium') : product ? t('conn.planFree') : t('conn.planUnknown')}</p>
              <button
                className="btn ghost small danger"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
              >
                {t('conn.logout')}
              </button>
              <p className="hint">{t('conn.logoutHint')}</p>
            </>
          ) : (
            <>
              <p className="pop-help">{authErrorText(auth.error?.code)}</p>
              <a className="btn primary small" href="/login">
                {t('conn.reconnect')} <span className="arr" aria-hidden>→</span>
              </a>
            </>
          )}
          <button
            className="link-arrow"
            onClick={() => {
              setOpen(false);
              onTutorial();
            }}
          >
            {t('onb.reopen')} <span className="arr" aria-hidden>→</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ language picker (accessible listbox)

export function LanguagePicker() {
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const idx = Math.max(0, LANGUAGES.findIndex((l) => l.code === lang));
  const [active, setActive] = useState(idx);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const cur = findTargetLanguage(lang) ?? LANGUAGES[0]!;
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, wrap);

  useEffect(() => {
    if (open) {
      setActive(idx);
      list.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (code: string) => {
    setOpen(false);
    btn.current?.focus();
    void setLang(code);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const n = LANGUAGES.length;
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(LANGUAGES[active]!.code);
    else if (e.key === 'Escape') {
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="lang-picker" ref={wrap}>
      <button
        ref={btn}
        className="lang-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('lang.pickerLabel', { language: cur.label })}
        title={t('lang.pickerHint')}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="lang-code">{cur.short}</span>
        <span className="lang-name" lang={cur.code}>
          {cur.label}
        </span>
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
      </button>
      {open && (
        <ul className="popover lang-list" role="listbox" tabIndex={-1} ref={list} aria-label={t('lang.listLabel')} aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey}>
          {LANGUAGES.map((l, i) => (
            <li
              key={l.code}
              id={`${id}-${i}`}
              role="option"
              aria-selected={l.code === lang}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(l.code)}
            >
              <span className="lang-code">{l.short}</span>
              <span lang={l.code}>{l.label}</span>
              {l.code === lang && <Check size={14} strokeWidth={1.5} aria-hidden className="lang-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Language choice as a grid (home screen and tutorial): radiogroup with arrow keys. */
export function LanguageGrid() {
  const { t, lang, setLang } = useI18n();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const n = LANGUAGES.length;
    const next = (from + delta + n) % n;
    refs.current[next]?.focus();
    void setLang(LANGUAGES[next]!.code);
  };
  return (
    <div className="lang-grid" role="radiogroup" aria-label={t('lang.listLabel')}>
      {LANGUAGES.map((l, i) => {
        const on = l.code === lang;
        return (
          <button
            key={l.code}
            ref={(el) => void (refs.current[i] = el)}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`lang-opt${on ? ' on' : ''}`}
            onClick={() => void setLang(l.code)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                move(i, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                move(i, -1);
              }
            }}
          >
            <span className="lang-code">{l.short}</span>
            <span className="lang-name" lang={l.code}>
              {l.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
