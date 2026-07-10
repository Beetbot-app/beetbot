import { useCallback, useEffect, useRef, useState } from 'react';
import { HomeScreen, type HomeDrillSnapshot } from '@shared/components/HomeScreen';
import { setApiBase, type PlaylistRow, type SearchTrackResult } from '@shared/api';
import { useProfileStore } from '@/lib/profile';
import { useNavStore } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { ipc } from '@/lib/tauri';
import { playOnDesktop, queueCatalogTrack, likeCatalogTrack } from '@/pages/Search';
import { usePlayerStore, currentTrack } from '@/lib/store';

// Point the shared api.ts at the loopback streaming server (the Tauri
// webview origin isn't a valid fetch scheme). Idempotent with Search's /
// Browse's calls; safe to repeat. Home is the default view, so this also
// guarantees the base is set before the first `/api/*` fetch.
setApiBase('http://127.0.0.1:47823');

/**
 * Desktop wrapper around the shared `HomeScreen`. Same shape as
 * `BrowsePage`: bootstrap a session token from the loopback server, then
 * hand the shared component the desktop-flavoured callbacks:
 *
 *  - play  → `playOnDesktop` (resolves the local file + seeds the queue)
 *  - playlist → caller's `onOpenPlaylist` (full PlaylistPage)
 *  - browse → caller's `onOpenBrowse` (the Discover tab)
 *  - artist / album → the nav bus, so they open as full pages (like the
 *    rest of the desktop) instead of the phone's bottom-sheet modals.
 */
export function HomePage({
  onOpenPlaylist,
  onOpenBrowse,
  onWinBack,
  onMixPush,
  mixRestore,
  onMixBack,
}: {
  onOpenPlaylist: (id: number) => void;
  onOpenBrowse: () => void;
  onWinBack?: (v: boolean) => void;
  onMixPush?: (snap: HomeDrillSnapshot) => void;
  mixRestore?: { signal: number; snapshot: HomeDrillSnapshot | null };
  onMixBack?: () => void;
}) {
  // One shared session token, fetched once per app launch (not per navigation).
  const { token, error } = useSession();
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const openArtist = useNavStore((s) => s.openArtist);
  const openAlbum = useNavStore((s) => s.openAlbum);
  // Now-playing state for the Spotify-style card play/pause on Home.
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const nowPlayingKey = usePlayerStore((s) => s.nowPlayingKey);
  const curTrack = usePlayerStore(currentTrack);
  const nowPlayingTrackId = curTrack?.id ?? null;
  // "Is this row the current playback track?" for the mix drill-in's highlight /
  // equalizer / ⏸ hero. A mix's rows are CATALOG results whose `local_track_id`
  // often differs from the resolved id we actually play, so match on id OR
  // title+artist (mirrors the search/library matcher).
  const isTrackCurrent = useCallback(
    (t: SearchTrackResult) => {
      const cur = curTrack;
      if (!cur) return false;
      if (t.local_track_id != null && t.local_track_id === cur.id) return true;
      if (t.isrc && cur.isrc && t.isrc === cur.isrc) return true;
      const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
      return (
        !!cur.title &&
        norm(t.title) === norm(cur.title) &&
        (!t.artists[0] ||
          !cur.artists[0] ||
          norm(t.artists[0]) === norm(cur.artists[0]))
      );
    },
    [curTrack],
  );
  // Minimal shape for the live "Recently played" prepend. Sourced from the LAST
  // LOGGED play (the track that crossed the ~20s "counts as a play" threshold),
  // NOT the currently-playing track — so the optimistic shelf only shows songs
  // the server will actually keep. A sub-20s play prepended at track-start would
  // vanish on the next feed fetch (it was never recorded in play_events).
  const logged = usePlayerStore((s) => s.lastLoggedTrack);
  const nowPlayingTrack = logged
    ? {
        id: logged.id,
        title: logged.title,
        artists: logged.artists,
        album: logged.album,
        album_art_url: logged.album_art_url,
        duration_ms: logged.duration_ms,
        has_audio: logged.local_path != null || logged.status === 'downloaded',
      }
    : null;
  const togglePlay = usePlayerStore((s) => s.playPause);
  const setNowPlayingKey = usePlayerStore((s) => s.setNowPlayingKey);

  // N7: refresh triggers for the long-lived desktop window. A desktop tab tends
  // to stay open for hours/days, so refetch when the window regains focus after
  // a while, or once the local day rolls over (the server rebuilds discovery per
  // calendar day). Bumping refreshKey re-mints HomeScreen's visit nonce → a
  // genuinely fresh per-visit slice. Guarded by a staleness window + day check
  // so flipping back to the app doesn't reshuffle the feed on every focus.
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const lastRefreshAt = useRef(Date.now());
  const lastRefreshDay = useRef(new Date().toDateString());
  useEffect(() => {
    const STALE_MS = 30 * 60 * 1000;
    const maybeRefresh = () => {
      if (document.hidden) return;
      const now = Date.now();
      const today = new Date().toDateString();
      const dayRolled = today !== lastRefreshDay.current;
      if (dayRolled || now - lastRefreshAt.current >= STALE_MS) {
        lastRefreshAt.current = now;
        lastRefreshDay.current = today;
        setHomeRefreshKey((k) => k + 1);
      }
    };
    // Both events: visibilitychange covers tab hide/show; window focus is more
    // reliable in the Tauri webview. The staleness guard dedupes double-fires.
    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, []);

  // Load the quick-access playlists straight from the DB over IPC, not the
  // loopback HTTP server, so a momentary server blip never blanks Home (the
  // sidebar reads the same source). Memoised so HomeScreen's effect is stable.
  const loadPlaylists = useCallback(
    (): Promise<PlaylistRow[]> =>
      ipc.listPlaylists(activeProfileId ?? 1).then((rows) =>
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          track_count: p.track_count,
          cover_url: p.cover_url,
          source: p.source as PlaylistRow['source'],
          owner: p.owner,
        })),
      ),
    [activeProfileId],
  );

  if (error) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div>
          <h2 className="text-lg font-semibold mb-2">Home unavailable</h2>
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
    <div
      className="h-full overflow-y-auto"
      style={{
        // Daft-style: let the window's warm ambient wash show through the top of
        // the card (a colored "hero atmosphere"), fading to solid black below so
        // the content stays readable. The card now sits below the transparent
        // header, so the wash reads as the card's own top-lit atmosphere.
        background:
          'linear-gradient(to bottom, transparent 0, rgba(10,10,11,0.86) 150px, #0a0a0b 320px)',
      }}
    >
      <HomeScreen
        token={token}
        activeProfileId={activeProfileId}
        refreshKey={homeRefreshKey}
        loadPlaylists={loadPlaylists}
        onPlayTrack={playOnDesktop}
        nowPlayingKey={nowPlayingKey}
        nowPlayingTrackId={nowPlayingTrackId}
        nowPlayingTrack={nowPlayingTrack}
        isPlaying={isPlaying}
        onTogglePlay={togglePlay}
        isTrackCurrent={isTrackCurrent}
        // Enable the mix ⋯ menu's "Add to Favorites" / "Add to queue" (they
        // resolve the catalog row to a library id first), matching the catalog
        // playlist page's menu.
        onAlbumAddToQueue={(t) => void queueCatalogTrack(t, token)}
        onAlbumSaveToLiked={(t) => void likeCatalogTrack(t, token, activeProfileId ?? null)}
        onPlayedFrom={setNowPlayingKey}
        onOpenPlaylist={onOpenPlaylist}
        onOpenBrowse={onOpenBrowse}
        onOpenArtist={(name) => openArtist(name)}
        onOpenAlbum={(name, artist) => openAlbum(name, artist)}
        onWinBack={onWinBack}
        onMixPush={onMixPush}
        mixRestore={mixRestore}
        onMixBack={onMixBack}
      />
    </div>
  );
}
