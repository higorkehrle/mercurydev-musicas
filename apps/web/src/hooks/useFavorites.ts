import { useCallback, useEffect, useState } from 'react';
import type { LibraryEntry, TrackInfo } from '@lyricsync/shared';
import { api } from '../lib/api.ts';

/**
 * Favorites.
 *
 * The source of truth is the server (SQLite, `favorites` table, per Spotify account):
 * it syncs across devices. This hook also keeps a
 * minimal local copy (localStorage, versioned key) only to show the list when the
 * user is disconnected. Playing or opening the lyrics still requires Spotify.
 */

export interface FavoriteItem {
  key: string;
  id: string | null;
  uri: string | null;
  name: string;
  artists: string[];
  album: string;
  coverUrl: string | null;
  durationMs: number;
  /** When it was favorited (ms). */
  at: number;
}

interface Mirror {
  v: 1;
  userId: string;
  displayName: string;
  items: FavoriteItem[];
}

export const FAVORITES_STORAGE_KEY = 'mercurydev-musicas:favorites:v1';

function readMirror(): Mirror | null {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<Mirror>;
    // Unknown version: discard it (the server still has the data).
    if (m.v !== 1 || !Array.isArray(m.items) || typeof m.userId !== 'string') return null;
    return m as Mirror;
  } catch {
    return null;
  }
}

function writeMirror(m: Mirror) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* storage full or blocked: the list lives on the server only */
  }
}

const toItem = (e: LibraryEntry): FavoriteItem => ({
  key: e.track.key,
  id: e.track.id,
  uri: e.track.uri,
  name: e.track.name,
  artists: e.track.artists,
  album: e.track.album,
  coverUrl: e.track.coverUrl,
  durationMs: e.track.durationMs,
  at: e.at,
});

export const itemToTrack = (f: FavoriteItem): TrackInfo => ({
  key: f.key,
  id: f.id,
  uri: f.uri,
  isLocal: f.key.startsWith('local:'),
  name: f.name,
  artists: f.artists,
  album: f.album,
  coverUrl: f.coverUrl,
  durationMs: f.durationMs,
  isrc: null,
});

export type FavoritesSource = 'server' | 'local';

export function useFavorites(connected: boolean, user: { id: string; displayName: string } | null) {
  const [items, setItems] = useState<FavoriteItem[] | null>(() => readMirror()?.items ?? null);
  const [source, setSource] = useState<FavoritesSource>('local');
  const [owner, setOwner] = useState<string | null>(() => readMirror()?.displayName ?? null);
  const [error, setError] = useState<unknown>(null);
  const userId = user?.id ?? null;
  const displayName = user?.displayName ?? '';

  const persist = useCallback(
    (list: FavoriteItem[]) => {
      if (userId) writeMirror({ v: 1, userId, displayName, items: list });
    },
    [userId, displayName],
  );

  const refresh = useCallback(async () => {
    if (!connected || !userId) return;
    try {
      const list = (await api.favorites()).map(toItem);
      setItems(list);
      setSource('server');
      setOwner(displayName);
      setError(null);
      persist(list);
    } catch (e) {
      setError(e);
    }
  }, [connected, userId, displayName, persist]);

  useEffect(() => {
    if (connected && userId) {
      // Another account: do not show the previous account's local copy while loading.
      const m = readMirror();
      if (m && m.userId !== userId) setItems(null);
      void refresh();
    } else {
      const m = readMirror();
      setItems(m?.items ?? []);
      setOwner(m?.displayName ?? null);
      setSource('local');
    }
  }, [connected, userId, refresh]);

  /** Favorite/unfavorite with an optimistic update; reverts if the server refuses. */
  const setFavorite = useCallback(
    async (track: TrackInfo, fav: boolean) => {
      const before = items ?? [];
      const next = fav
        ? [{ ...toItem({ track, at: Date.now(), isFavorite: true }) }, ...before.filter((f) => f.key !== track.key)]
        : before.filter((f) => f.key !== track.key);
      setItems(next);
      try {
        await api.setFavorite(track.key, fav);
        persist(next);
      } catch (e) {
        setItems(before);
        throw e;
      }
    },
    [items, persist],
  );

  return { items, source, owner, error, refresh, setFavorite, isFavorite: (key: string) => Boolean(items?.some((f) => f.key === key)) };
}

export type FavoritesStore = ReturnType<typeof useFavorites>;
