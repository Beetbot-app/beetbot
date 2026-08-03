import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import {
  ensureSession,
  resolveCatalogTrack,
  type SearchTrackResult,
} from '@shared/api';
import { ipc } from './tauri';
import { notifyLibraryChanged } from '@shared/libraryChanged';

/**
 * Download orchestration for the FULL build (gated by `canDownload`; the
 * open-core build never imports the calling UI). Tracks per-track progress so
 * rows can show a spinner, and dispatches `beetbot:library-changed` when a
 * download lands so the "downloaded" badge appears without a manual reload.
 *
 * The engine emits live `track-status` / `download-progress` events, but the
 * flow does NOT depend on them for correctness: `download_track` resolves only
 * when the file has landed, so the await path alone drives the spinner + refresh
 * (events just add a live percentage on top).
 */
export type DownloadPhase = 'matching' | 'downloading' | 'failed';

export interface TrackDownload {
  phase: DownloadPhase;
  /** 0–100 while downloading, when the engine reports it. */
  percent?: number;
  /** Set on `failed`. */
  reason?: string;
}

interface DownloadsState {
  byTrack: Record<number, TrackDownload>;
  /** Saved/removed state set by this session's own save or remove. The
   *  queue-backed surfaces (Now Playing, the player bar) render a track object
   *  captured when it was queued, so they can't see a fresh save; this override
   *  lets their menus flip immediately. Surfaces that refetch on
   *  `beetbot:library-changed` don't need it. */
  savedOverride: Record<number, boolean>;
  download: (trackId: number, profileId: number) => Promise<void>;
  /** Save a track that isn't in the library yet: resolve the catalog result to a
   *  real track id first, then download it. */
  downloadCatalog: (t: SearchTrackResult, profileId: number) => Promise<void>;
  downloadPlaylist: (playlistId: number, profileId: number) => Promise<void>;
  remove: (trackId: number, profileId: number) => Promise<void>;
}

function refreshLibrary(): void {
  try {
    notifyLibraryChanged();
  } catch {
    /* non-DOM context — nothing to refresh */
  }
}

// Wire the engine's live events ONCE, the first time the store is created.
// Guarded so a non-Tauri context (or a build without the engine) is a silent
// no-op rather than an unhandled rejection.
let wired = false;
function wireEvents(
  set: (fn: (s: DownloadsState) => Partial<DownloadsState>) => void,
): void {
  if (wired) return;
  wired = true;
  listen<{ track_id: number; status: string; failure_reason?: string | null }>(
    'track-status',
    (e) => {
      const { track_id, status, failure_reason } = e.payload;
      if (status === 'downloaded') {
        set((s) => {
          const next = { ...s.byTrack };
          delete next[track_id];
          return { byTrack: next };
        });
        refreshLibrary();
      } else if (status === 'failed') {
        set((s) => ({
          byTrack: {
            ...s.byTrack,
            [track_id]: { phase: 'failed', reason: failure_reason ?? undefined },
          },
        }));
      } else if (status === 'matching' || status === 'downloading') {
        set((s) => ({
          byTrack: {
            ...s.byTrack,
            [track_id]: { ...s.byTrack[track_id], phase: status },
          },
        }));
      }
    },
  ).catch(() => {});
  listen<{ track_id: number; percent: number }>('download-progress', (e) => {
    const { track_id, percent } = e.payload;
    set((s) => ({
      byTrack: {
        ...s.byTrack,
        [track_id]: { phase: 'downloading', percent, reason: s.byTrack[track_id]?.reason },
      },
    }));
  }).catch(() => {});
}

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  wireEvents(set);
  return {
    byTrack: {},
    savedOverride: {},
    download: async (trackId, profileId) => {
      set((s) => ({
        byTrack: {
          ...s.byTrack,
          [trackId]: { phase: 'downloading', percent: s.byTrack[trackId]?.percent },
        },
      }));
      try {
        await ipc.downloadTrack(trackId);
        // Attribute it to the profile that downloaded it (per-profile ownership).
        await ipc.markDownload(profileId, trackId);
        set((s) => {
          const next = { ...s.byTrack };
          delete next[trackId];
          return {
            byTrack: next,
            savedOverride: { ...s.savedOverride, [trackId]: true },
          };
        });
        refreshLibrary();
      } catch (e) {
        set((s) => ({
          byTrack: {
            ...s.byTrack,
            [trackId]: { phase: 'failed', reason: e instanceof Error ? e.message : String(e) },
          },
        }));
      }
    },
    downloadCatalog: async (t, profileId) => {
      try {
        const token = await ensureSession();
        const id =
          t.local_track_id ?? (await resolveCatalogTrack(t, token)).track_id;
        await get().download(id, profileId);
      } catch {
        /* resolve failed — there is nothing to download */
      }
    },
    downloadPlaylist: async (playlistId, profileId) => {
      try {
        await ipc.downloadPlaylist(playlistId);
        await ipc.markPlaylistDownloads(profileId, playlistId);
      } finally {
        refreshLibrary();
      }
    },
    remove: async (trackId, profileId) => {
      await ipc.removeDownload(profileId, trackId);
      set((s) => ({
        savedOverride: { ...s.savedOverride, [trackId]: false },
      }));
      refreshLibrary();
    },
  };
});

/** Per-track download progress, or undefined when it isn't downloading. */
export function useTrackDownload(trackId: number): TrackDownload | undefined {
  return useDownloadsStore((s) => s.byTrack[trackId]);
}

/** Whether a track should read as "has a local file" for the file menu. A
 *  save/remove run in this session wins over the possibly-stale queue fields. */
export function trackHasFile(t: {
  id: number;
  local_path: string | null;
  status?: string;
}): boolean {
  const ov = useDownloadsStore.getState().savedOverride[t.id];
  if (ov !== undefined) return ov;
  return t.local_path != null || t.status === 'downloaded';
}
