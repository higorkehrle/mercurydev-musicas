import { useEffect, useMemo, useRef, useState } from 'react';
import { Heart, Search, X } from 'lucide-react';
import { OFFSET_LIMIT_MS, type LibraryEntry, type LyricsCandidate, type SearchPage, type Settings, type TrackInfo } from '@lyricsync/shared';
import { api, type AppMeta } from '../lib/api.ts';
import { formatArtists, formatTime } from '../lib/format.ts';
import { SCENES, type SceneId } from '../lib/visualizer/scenes.ts';
import type { VisualPrefs } from '../hooks/useVisual.ts';
import { itemToTrack, type FavoritesStore } from '../hooks/useFavorites.ts';
import { useI18n } from '../i18n/i18n.tsx';
import { errorText } from '../i18n/errors.ts';
import { LanguagePicker } from './Header.tsx';
import { AudioControl } from './Visual.tsx';

// ------------------------------------------------------------------ side panel shell

export function Drawer({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X size={17} strokeWidth={1.5} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function TrackRow({ track, meta, onOpen, fav }: { track: TrackInfo; meta?: string; onOpen: () => void; fav?: boolean }) {
  const { t } = useI18n();
  return (
    <button className="track-row" onClick={onOpen}>
      {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className="cover-ph" />}
      <span className="track-row-text">
        <span className="t">{track.name}</span>
        <span className="a">{formatArtists(track.artists)}</span>
      </span>
      {fav && <Heart size={13} strokeWidth={1.5} className="row-fav" fill="currentColor" aria-label={t('fav.isFavorite')} />}
      {meta && <span className="track-row-meta">{meta}</span>}
    </button>
  );
}

// ------------------------------------------------------------------ library

export type LibraryTab = 'search' | 'history' | 'favorites';

export function LibraryPanel({
  initialTab,
  connected,
  favorites,
  onClose,
  onOpenTrack,
  onUnfavorite,
}: {
  initialTab: LibraryTab;
  connected: boolean;
  favorites: FavoritesStore;
  onClose: () => void;
  onOpenTrack: (t: TrackInfo) => void;
  onUnfavorite: (t: TrackInfo) => Promise<void>;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<LibraryTab>(connected ? initialTab : 'favorites');
  const tabs: [LibraryTab, string][] = [
    ['favorites', t('library.tab.favorites')],
    ['history', t('library.tab.history')],
    ['search', t('library.tab.search')],
  ];
  return (
    <Drawer title={tab === 'favorites' ? t('fav.title') : t('library.title')} onClose={onClose} wide={tab === 'favorites'}>
      <div className="tabs" role="tablist" aria-label={t('library.title')}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            disabled={!connected && id !== 'favorites'}
            title={!connected && id !== 'favorites' ? t('library.needsSpotify') : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'favorites' && <FavoritesView store={favorites} connected={connected} onOpenTrack={onOpenTrack} onUnfavorite={onUnfavorite} onClose={onClose} />}
      {tab === 'history' && <HistoryTab onOpenTrack={onOpenTrack} />}
      {tab === 'search' && <SearchTab onOpenTrack={onOpenTrack} />}
      {connected && <p className="panel-note">{t('library.readerNote')}</p>}
    </Drawer>
  );
}

// ------------------------------------------------------------------ favorites

type Sort = 'recent' | 'oldest' | 'title' | 'artist';

function FavoritesView({
  store,
  connected,
  onOpenTrack,
  onUnfavorite,
  onClose,
}: {
  store: FavoritesStore;
  connected: boolean;
  onOpenTrack: (t: TrackInfo) => void;
  onUnfavorite: (t: TrackInfo) => Promise<void>;
  onClose: () => void;
}) {
  const { t, lang, fmt } = useI18n();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [note, setNote] = useState<string | null>(null);
  const items = store.items;

  const shown = useMemo(() => {
    if (!items) return null;
    const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase(lang);
    const needle = norm(q.trim());
    const list = needle ? items.filter((f) => norm(`${f.name} ${f.artists.join(' ')}`).includes(needle)) : [...items];
    const coll = new Intl.Collator(lang, { sensitivity: 'base' });
    if (sort === 'recent') list.sort((a, b) => b.at - a.at);
    else if (sort === 'oldest') list.sort((a, b) => a.at - b.at);
    else if (sort === 'title') list.sort((a, b) => coll.compare(a.name, b.name));
    else list.sort((a, b) => coll.compare(a.artists.join(', '), b.artists.join(', ')) || coll.compare(a.name, b.name));
    return list;
  }, [items, q, sort, lang]);

  if (!items) return <p className="panel-empty">{store.error ? errorText(store.error) : t('common.loading')}</p>;

  if (items.length === 0) {
    return (
      <div className="fav-empty">
        <p className="fav-empty-code">
          <span aria-hidden>→</span> {t('fav.count', { count: 0 })}
        </p>
        <p className="fav-empty-title">{t('fav.emptyTitle')}</p>
        <p className="fav-empty-body">{connected ? t('fav.emptyBody') : t('fav.emptyOffline')}</p>
        <button className="link-arrow" onClick={onClose}>
          {t('fav.backToPlayer')} <span className="arr" aria-hidden>→</span>
        </button>
      </div>
    );
  }

  return (
    <div className="fav-view">
      {!connected && (
        <p className="fav-offline" role="note">
          <span className="conn-dot" aria-hidden>
            ○
          </span>{' '}
          {store.owner ? t('fav.offlineOwner', { name: store.owner }) : t('fav.offline')}{' '}
          <a className="link-arrow" href="/login">
            {t('conn.reconnect')} <span className="arr" aria-hidden>→</span>
          </a>
        </p>
      )}
      <div className="fav-toolbar">
        <p className="fav-count" aria-live="polite">
          {q ? t('fav.countFiltered', { shown: shown!.length, count: items.length }) : t('fav.count', { count: items.length })}
        </p>
        <label className="fav-sort">
          <span className="sr-only">{t('fav.sortLabel')}</span>
          <select value={sort} onChange={(e) => setSort(e.currentTarget.value as Sort)}>
            <option value="recent">{t('fav.sort.recent')}</option>
            <option value="oldest">{t('fav.sort.oldest')}</option>
            <option value="title">{t('fav.sort.title')}</option>
            <option value="artist">{t('fav.sort.artist')}</option>
          </select>
        </label>
      </div>
      <label className="search-form">
        <Search size={15} strokeWidth={1.5} aria-hidden />
        <input type="search" value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder={t('fav.filterPlaceholder')} aria-label={t('fav.filterLabel')} />
      </label>
      {note && (
        <p className="fav-note" role="status">
          {note}
        </p>
      )}
      {shown!.length === 0 ? (
        <p className="panel-empty">{t('fav.noMatch', { query: q.trim() })}</p>
      ) : (
        <ul className="fav-list">
          {shown!.map((f) => {
            const track = itemToTrack(f);
            return (
              <li key={f.key} className="fav-row">
                <button
                  className="fav-open"
                  onClick={() => (connected ? onOpenTrack(track) : setNote(t('fav.needsSpotify')))}
                  aria-label={t('fav.openTrack', { title: f.name, artist: formatArtists(f.artists) })}
                >
                  {f.coverUrl ? <img src={f.coverUrl} alt="" loading="lazy" /> : <span className="cover-ph" />}
                  <span className="track-row-text">
                    <span className="t">{f.name}</span>
                    <span className="a">{formatArtists(f.artists)}</span>
                  </span>
                  <span className="fav-meta">
                    <span className="fav-dur">{formatTime(f.durationMs)}</span>
                    <span className="fav-at">{fmt.relative(f.at)}</span>
                  </span>
                </button>
                <button
                  className="icon-btn fav-remove"
                  disabled={!connected}
                  title={connected ? t('fav.remove') : t('fav.needsSpotify')}
                  aria-label={t('fav.removeTrack', { title: f.name })}
                  onClick={() => {
                    void onUnfavorite(track).catch((e: unknown) => setNote(errorText(e)));
                  }}
                >
                  <Heart size={16} strokeWidth={1.5} fill="currentColor" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ history and search

function HistoryTab({ onOpenTrack }: { onOpenTrack: (t: TrackInfo) => void }) {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.history().then(setItems).catch(setError);
  }, []);
  if (error) return <p className="panel-empty">{errorText(error)}</p>;
  if (!items) return <p className="panel-empty">{t('common.loading')}</p>;
  if (items.length === 0) return <p className="panel-empty">{t('library.historyEmpty')}</p>;
  return (
    <div className="track-list">
      {items.map((e) => (
        <TrackRow key={e.track.key} track={e.track} meta={fmt.relative(e.at)} fav={e.isFavorite} onOpen={() => onOpenTrack(e.track)} />
      ))}
      <button
        className="btn ghost small"
        onClick={() => {
          void api.clearHistory().then(() => setItems([]));
        }}
      >
        {t('library.clearHistory')}
      </button>
    </div>
  );
}

function SearchTab({ onOpenTrack }: { onOpenTrack: (t: TrackInfo) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<SearchPage | null>(null);
  const [items, setItems] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastQ = useRef('');

  const run = async (query: string, offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.search(query, offset);
      setPage(p);
      setItems((prev) => (offset === 0 ? p.items : [...prev, ...p.items]));
    } catch (e) {
      setError(errorText(e, 'library.searchFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const query = q.trim();
          if (!query) return;
          lastQ.current = query;
          void run(query, 0);
        }}
      >
        <Search size={15} strokeWidth={1.5} aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder={t('library.searchPlaceholder')} aria-label={t('library.searchLabel')} />
      </form>
      {error && <p className="panel-empty">{error}</p>}
      <div className="track-list">
        {items.map((tr) => (
          <TrackRow key={tr.key} track={tr} meta={formatTime(tr.durationMs)} onOpen={() => onOpenTrack(tr)} />
        ))}
      </div>
      {page && page.items.length === 0 && items.length === 0 && <p className="panel-empty">{t('library.noResults')}</p>}
      {page?.hasMore && (
        <button className="btn ghost small" disabled={loading} onClick={() => void run(lastQ.current, page.offset + page.limit)}>
          {loading ? t('common.loading') : t('library.moreResults')}
        </button>
      )}
      {loading && !page && <p className="panel-empty">{t('library.searching')}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ settings

export function SettingsPanel({
  settings,
  update,
  meta,
  connected,
  onLogout,
  onClose,
  visual,
  updateVisual,
  onTutorial,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  meta: AppMeta | null;
  connected: boolean;
  onLogout: () => void;
  onClose: () => void;
  visual: VisualPrefs;
  updateVisual: (p: Partial<VisualPrefs>) => void;
  onTutorial: () => void;
}) {
  const { t, fmt } = useI18n();
  return (
    <Drawer title={t('settings.title')} onClose={onClose}>
      <section className="setting-group">
        <h3>{t('settings.language')}</h3>
        <div className="setting-row">
          <span>
            {t('settings.languageLabel')}
            <small>{t('settings.languageHint')}</small>
          </span>
          <LanguagePicker />
        </div>
      </section>

      {connected ? (
        <>
          <section className="setting-group">
            <h3>{t('settings.lyrics')}</h3>
            <label className="toggle">
              <span>
                {t('settings.showTranslation')}
                <small>{t('settings.showTranslationHint')}</small>
              </span>
              <input type="checkbox" checked={settings.showTranslation} onChange={(e) => update({ showTranslation: e.currentTarget.checked })} />
            </label>
            <label className="slider">
              <span>
                {t('settings.fontSize')} <output>{fmt.number(settings.fontScale, { style: 'percent' })}</output>
              </span>
              <input type="range" className="range" min={0.8} max={1.6} step={0.05} value={settings.fontScale} onChange={(e) => update({ fontScale: Number(e.currentTarget.value) })} />
            </label>
          </section>

          <section className="setting-group">
            <h3>{t('settings.unsynced')}</h3>
            <label className="toggle">
              <span>
                {t('settings.autoScroll')}
                <small>{t('settings.autoScrollHint')}</small>
              </span>
              <input type="checkbox" checked={settings.unsyncedAutoScroll} onChange={(e) => update({ unsyncedAutoScroll: e.currentTarget.checked })} />
            </label>
            <label className="slider">
              <span>
                {t('settings.scrollSpeed')} <output>{fmt.number(settings.unsyncedScrollSpeed, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×</output>
              </span>
              <input
                type="range"
                className="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={settings.unsyncedScrollSpeed}
                disabled={!settings.unsyncedAutoScroll}
                onChange={(e) => update({ unsyncedScrollSpeed: Number(e.currentTarget.value) })}
              />
            </label>
          </section>

          <section className="setting-group">
            <h3>{t('settings.sync')}</h3>
            <label className="slider">
              <span>
                {t('settings.defaultOffset')} <output>{fmt.offset(settings.defaultOffsetMs)}</output>
                <small>{t('settings.defaultOffsetHint')}</small>
              </span>
              <input
                type="range"
                className="range"
                min={-OFFSET_LIMIT_MS}
                max={OFFSET_LIMIT_MS}
                step={100}
                value={settings.defaultOffsetMs}
                onChange={(e) => update({ defaultOffsetMs: Number(e.currentTarget.value) })}
              />
            </label>
          </section>
        </>
      ) : (
        <p className="panel-empty">{t('settings.connectFirst')}</p>
      )}

      <section className="setting-group">
        <h3>{t('vis.settings.title')}</h3>
        <div className="setting-row">
          <span>
            {t('vis.settings.source')}
            <small>{t('vis.settings.sourceHint')}</small>
          </span>
          <AudioControl />
        </div>
        <label className="select-row">
          <span>{t('vis.settings.style')}</span>
          <select value={visual.scene} onChange={(e) => updateVisual({ scene: e.currentTarget.value as SceneId })}>
            {SCENES.map((d, i) => (
              <option key={d.id} value={d.id}>
                {String(i + 1).padStart(2, '0')} · {t(`vis.scene.${d.id}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <span>
            {t('vis.settings.ambient')}
            <small>{t('vis.settings.ambientHint')}</small>
          </span>
          <input type="checkbox" checked={visual.ambient} onChange={(e) => updateVisual({ ambient: e.currentTarget.checked })} />
        </label>
        <label className="toggle">
          <span>
            {t('vis.settings.captions')}
            <small>{t('vis.settings.captionsHint')}</small>
          </span>
          <input type="checkbox" checked={visual.captions} onChange={(e) => updateVisual({ captions: e.currentTarget.checked })} />
        </label>
        <label className="slider">
          <span>
            {t('vis.settings.gain')} <output>{fmt.number(visual.gain, { style: 'percent' })}</output>
            <small>{t('vis.settings.gainHint')}</small>
          </span>
          <input type="range" className="range" min={0.5} max={2} step={0.05} value={visual.gain} onChange={(e) => updateVisual({ gain: Number(e.currentTarget.value) })} />
        </label>
      </section>

      <section className="setting-group">
        <h3>{t('settings.sources')}</h3>
        <dl className="facts">
          <dt>{t('settings.lyricsSource')}</dt>
          <dd>{meta?.lyricsProviders.map((p) => (p === 'lrclib' ? 'LRCLIB' : 'Musixmatch')).join(', ') ?? '—'}</dd>
          <dt>{t('settings.translationSource')}</dt>
          <dd>{meta?.translation ? `${meta.translation.provider} · ${meta.translation.model}` : t('settings.translationOff')}</dd>
        </dl>
      </section>

      <section className="setting-group">
        <h3>{t('settings.help')}</h3>
        <button
          className="link-arrow"
          onClick={() => {
            onClose();
            onTutorial();
          }}
        >
          {t('onb.reopen')} <span className="arr" aria-hidden>→</span>
        </button>
      </section>

      {connected && (
        <section className="setting-group">
          <h3>{t('settings.account')}</h3>
          <button className="btn ghost danger" onClick={onLogout}>
            {t('conn.logout')}
          </button>
          <small className="hint">{t('conn.logoutHint')}</small>
        </section>
      )}

      <a className="made-by" href="https://www.mercurydev.com.br/" target="_blank" rel="noopener">
        {t('app.madeBy')}
        <span className="arr" aria-hidden>
          →
        </span>
      </a>
    </Drawer>
  );
}

// ------------------------------------------------------------------ "wrong lyrics?"

export function CandidatesDialog({
  track,
  currentSourceId,
  userChosen,
  onPick,
  onClose,
}: {
  track: TrackInfo;
  currentSourceId: string | null;
  userChosen: boolean;
  onPick: (id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<LyricsCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .candidates(track.key)
      .then(setItems)
      .catch((e: unknown) => setError(errorText(e)));
  }, [track.key]);

  const pick = async (id: string | null) => {
    setBusy(id ?? 'auto');
    try {
      await onPick(id);
      onClose();
    } catch (e) {
      setError(errorText(e, 'cand.pickFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer title={t('cand.title')} onClose={onClose} wide>
      <p className="panel-note top">{t('cand.intro', { title: track.name, artist: formatArtists(track.artists), duration: formatTime(track.durationMs) })}</p>
      {userChosen && (
        <button className="btn ghost small" disabled={busy !== null} onClick={() => void pick(null)}>
          {t('cand.backToAuto')}
        </button>
      )}
      {error && <p className="panel-empty">{error}</p>}
      {!items && !error && <p className="panel-empty">{t('cand.loading')}</p>}
      {items && items.length === 0 && <p className="panel-empty">{t('cand.none')}</p>}
      <div className="cand-list">
        {items?.map((c) => {
          const durationOk = c.durationDeltaSec !== null && c.durationDeltaSec <= 2;
          const current = c.id === currentSourceId;
          return (
            <button key={c.id} className={`cand${current ? ' current' : ''}`} disabled={busy !== null || current} onClick={() => void pick(c.id)}>
              <span className="cand-main">
                <span className="t">{c.trackName}</span>
                <span className="a">
                  {c.artistName}
                  {c.albumName ? ` · ${c.albumName}` : ''}
                </span>
              </span>
              <span className="cand-tags">
                {current && <span className="tag">{t('cand.tag.current')}</span>}
                {c.instrumental ? (
                  <span className="tag">{t('cand.tag.instrumental')}</span>
                ) : c.hasSynced ? (
                  <span className={`tag ${durationOk ? 'good' : 'warn'}`}>{durationOk ? t('cand.tag.synced') : t('cand.tag.syncedMismatch')}</span>
                ) : (
                  <span className="tag">{t('cand.tag.plain')}</span>
                )}
                {c.durationSec !== null && (
                  <span className="tag dim">
                    {formatTime(c.durationSec * 1000)}
                    {c.durationDeltaSec !== null && c.durationDeltaSec > 0 ? ` (Δ ${fmt.seconds(c.durationDeltaSec)})` : ''}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Drawer>
  );
}
