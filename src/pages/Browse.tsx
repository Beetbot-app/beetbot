import { useCallback } from 'react';
import {
  BrowseScreen,
  type BrowseSnapshot,
} from '@shared/components/BrowseScreen';
import { setApiBase, type SearchTrackResult } from '@shared/api';
import { useProfileStore } from '@/lib/profile';
import {
  useSidebarPinController,
  useSavedArtistController,
} from '@/lib/detailControllers';
import { useNavStore } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { usePlayerStore, currentTrack } from '@/lib/store';
import { useAddAudio } from '@/lib/addAudio';
import { useDownloadsStore } from '@/lib/downloads';
import { useCanDownload } from '@/lib/capabilities';
import {
  likeCatalogTrack,
  playOnDesktop,
  queueCatalogTrack,
} from '@/pages/Search';

// Same as Search.tsx: point the shared api.ts at the loopback streaming
// server so `/api/*` fetches resolve (the Tauri webview origin isn't a
// valid fetch scheme). Idempotent with Search's call; safe to repeat.
setApiBase('http://127.0.0.1:47823');

/**
 * Desktop wrapper around the shared `BrowseScreen`. Bootstraps a session
 * token from the loopback server (loopback peers skip the pairing gate),
 * then hands play-from-Browse off to the same desktop handler the Search
 * page uses.
 */
export function BrowsePage({
  restore,
  onBrowsePush,
  onBrowseBack,
}: {
  /** Replays a Discover drill page (or clears to the grid) on Back/Forward. */
  restore: { signal: number; snapshot: BrowseSnapshot | null };
  /** Pushes a view-history entry when the user drills into a Discover page. */
  onBrowsePush: (snapshot: BrowseSnapshot) => void;
  /** Steps back one history entry — closing a drill (Escape) routes here. */
  onBrowseBack: () => void;
}) {
  // One shared session token, fetched once per app launch (not per navigation).
  const { token, error } = useSession();
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const canDownload = useCanDownload();
  const pinController = useSidebarPinController();
  const saveController = useSavedArtistController();

  // Now-playing awareness for the genre page (Spotify-style hero/sticky/row
  // highlight). A catalog row may not carry a library id until played, so match
  // by id, then ISRC, then title+artist — same as the Search overlay.
  const nowPlaying = usePlayerStore(currentTrack);
  const isNowPlaying = usePlayerStore((s) => s.isPlaying);
  const isTrackCurrent = useCallback(
    (t: SearchTrackResult) => {
      const np = nowPlaying;
      if (!np) return false;
      if (t.local_track_id != null && t.local_track_id === np.id) return true;
      if (t.isrc && np.isrc && t.isrc === np.isrc) return true;
      const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
      return (
        !!np.title &&
        norm(t.title) === norm(np.title) &&
        norm(t.artists?.[0]) === norm(np.artists?.[0])
      );
    },
    [nowPlaying],
  );

  if (error) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div>
          <h2 className="text-lg font-semibold mb-2">Discover unavailable</h2>
          <p className="text-sm text-neutral-400 break-all">{error}</p>
          <p className="text-xs text-neutral-500 mt-2">
            Streaming server may not be running.
          </p>
        </div>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="h-full grid place-items-center text-sm text-neutral-500">
        Connecting…
      </div>
    );
  }

  return (
    // Single scroll container at the top of <main> (behind the absolute top
    // bar). No top padding here — BrowseScreen adds it to the genre grid only,
    // while drill-in detail pages stay full-bleed (their hero's pt-20 clears the
    // bar), so the sticky condensed header pins flush and the hero hits the
    // window edges — matching the search overlay + library pages.
    <div className="h-full overflow-y-auto">
      <BrowseScreen
        token={token}
        onPlayTrack={playOnDesktop}
        pageMode
        desktop
        activeProfileId={activeProfileId}
        restore={restore}
        onBrowsePush={onBrowsePush}
        onBrowseBack={onBrowseBack}
        // Discover album/playlist "⋯" menu — catalog rows have no library track
        // yet, so queue/like resolve (import) it first (same as Search.tsx).
        onAlbumGoToArtist={(name) => useNavStore.getState().openArtist(name)}
        onAlbumGoToAlbum={(name, artist) =>
          useNavStore.getState().openAlbum(name, artist)
        }
        onAlbumAddToQueue={(t) => void queueCatalogTrack(t, token)}
        onAlbumSaveToLiked={(t) => void likeCatalogTrack(t, token, activeProfileId)}
        // File actions — a catalog row resolves to a library row on save; "Add
        // audio file" opens the app-level CandidatesModal (App renders it).
        canDownload={canDownload && activeProfileId != null}
        onAddAudio={(t) => void useAddAudio.getState().openForCatalog(t)}
        onDownload={(t) => {
          if (activeProfileId != null)
            void useDownloadsStore
              .getState()
              .downloadCatalog(t, activeProfileId);
        }}
        onRemoveDownload={(t) => {
          if (t.local_track_id != null && activeProfileId != null)
            void useDownloadsStore
              .getState()
              .remove(t.local_track_id, activeProfileId);
        }}
        isTrackCurrent={isTrackCurrent}
        isNowPlaying={isNowPlaying}
        onTogglePlay={() => usePlayerStore.getState().playPause()}
        currentAlbumName={nowPlaying?.album ?? null}
        pin={pinController}
        save={saveController}
      />
    </div>
  );
}
