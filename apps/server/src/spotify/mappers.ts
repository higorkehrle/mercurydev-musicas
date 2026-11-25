import type { ControlAction, DeviceInfo, PlaybackItemKind, PlaybackSnapshot, TrackInfo } from '@lyricsync/shared';
import { sha256 } from '../lib/crypto.ts';

// (Partial) Spotify Web API shapes that we use.
export interface SpImage { url: string; width: number | null; height: number | null }
export interface SpTrack {
  id: string | null;
  uri: string;
  name: string;
  type: 'track';
  is_local?: boolean;
  duration_ms: number;
  artists: { name: string }[];
  album?: { name: string; images?: SpImage[] };
  external_ids?: { isrc?: string };
}
export interface SpEpisode { type: 'episode'; name: string; duration_ms: number; images?: SpImage[]; show?: { name: string } }
export interface SpDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}
export interface SpCurrentlyPlaying {
  progress_ms: number | null;
  is_playing: boolean;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
  item: SpTrack | SpEpisode | null;
  actions?: { disallows?: Record<string, boolean> };
  device?: SpDevice;
}

function pickCover(images: SpImage[] | undefined): string | null {
  if (!images?.length) return null;
  // Largest image up to ~640px (good for the background and the large cover).
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) <= 640) ?? sorted[0])!.url;
}

export function mapTrack(t: SpTrack): TrackInfo {
  const isLocal = Boolean(t.is_local) || t.id === null;
  const artists = t.artists.map((a) => a.name).filter(Boolean);
  const key = isLocal ? `local:${sha256(`${t.name}|${artists.join(',')}|${t.album?.name ?? ''}|${t.duration_ms}`).slice(0, 24)}` : t.id!;
  return {
    key,
    id: isLocal ? null : t.id,
    uri: isLocal ? null : t.uri,
    isLocal,
    name: t.name,
    artists,
    album: t.album?.name ?? '',
    coverUrl: pickCover(t.album?.images),
    durationMs: t.duration_ms,
    isrc: t.external_ids?.isrc ?? null,
  };
}

const DISALLOW_MAP: Record<string, ControlAction> = {
  pausing: 'pause',
  resuming: 'play',
  seeking: 'seek',
  skipping_next: 'next',
  skipping_prev: 'previous',
};

export function mapDisallows(d: Record<string, boolean> | undefined): ControlAction[] {
  if (!d) return [];
  return Object.entries(d)
    .filter(([, v]) => v)
    .map(([k]) => DISALLOW_MAP[k])
    .filter((x): x is ControlAction => x !== undefined);
}

export function mapDevice(d: SpDevice | undefined | null): DeviceInfo | null {
  if (!d) return null;
  return {
    name: d.name,
    type: d.type,
    volumePercent: d.volume_percent,
    supportsVolume: d.supports_volume ?? d.volume_percent !== null,
    isRestricted: d.is_restricted,
    isPrivateSession: d.is_private_session,
  };
}

export function mapCurrentlyPlaying(cp: SpCurrentlyPlaying, device: DeviceInfo | null): PlaybackSnapshot {
  const kind: PlaybackItemKind = cp.currently_playing_type ?? 'unknown';
  const track = kind === 'track' && cp.item && cp.item.type === 'track' ? mapTrack(cp.item) : null;
  if (kind === 'track' && !track && device?.isPrivateSession) {
    return { status: 'private', kind: null, isPlaying: false, progressMs: 0, track: null, disallows: [], device };
  }
  return {
    status: 'active',
    kind,
    isPlaying: cp.is_playing,
    progressMs: cp.progress_ms ?? 0,
    track,
    disallows: mapDisallows(cp.actions?.disallows),
    device,
  };
}

export const IDLE_SNAPSHOT: PlaybackSnapshot = {
  status: 'idle',
  kind: null,
  isPlaying: false,
  progressMs: 0,
  track: null,
  disallows: [],
  device: null,
};
