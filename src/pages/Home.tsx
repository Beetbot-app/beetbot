import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HomeScreen,
  clearHomeFeedCache,
  type HomeDrillSnapshot,
} from '@shared/components/HomeScreen';
import { setApiBase, type PlaylistRow, type SearchTrackResult } from '@shared/api';
import { useProfileStore } from '@/lib/profile';
import {
  useSidebarPinController,
  useSavedArtistController,
} from '@/lib/detailControllers';
import { useNavStore } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { ipc } from '@/lib/tauri';
import { playOnDesktop, queueCatalogTrack, likeCatalogTrack } from '@/pages/Search';
import { usePlayerStore, currentTrack } from '@/lib/store';
import { useScrollMemory } from '@shared/useScrollMemory';

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
  homeReset = 0,
}: {
  onOpenPlaylist: (id: number) => void;
  onOpenBrowse: () => void;
  onWinBack?: (v: boolean) => void;
  onMixPush?: (snap: HomeDrillSnapshot) => void;
  mixRestore?: { signal: number; snapshot: HomeDrillSnapshot | null };
  onMixBack?: () => void;
  /** Bumped when the top bar's Home button is pressed. That's an explicit "take
   *  me home", not a Back — so the feed jumps to the top rather than resuming
   *  where you last were (Spotify's behaviour). */
  homeReset?: number;
}) {
  // One shared session token, fetched once per app launch (not per navigation).
  const { token, error } = useSession();
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const pinController = useSidebarPinController();
  const saveController = useSavedArtistController();
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

  // Explicit, un-guarded refetch: the onboarding wizard fires this on finish
  // (after it has written the user's picks and warmed the server feed) so the
  // user is dropped straight onto a filled, picks-seeded Home instead of the
  // empty page cached at first launch. Bumping the key re-mints the visit nonce
  // → a fresh getHome, which the just-warmed server cache answers immediately.
  useEffect(() => {
    const onRefresh = () => {
      clearHomeFeedCache(activeProfileId);
      setHomeRefreshKey((k) => k + 1);
    };
    window.addEventListener('beetbot:home-refresh', onRefresh);
    return () => window.removeEventListener('beetbot:home-refresh', onRefresh);
  }, [activeProfileId]);

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

  // Remember Home's scroll so returning to it (Back, or the Home button) lands
  // where you were instead of at the top of the feed. Just one key: a drill-in
  // no longer shares this container (see `drillHost` below), so nothing else
  // can write to it.
  const rememberScroll = useScrollMemory('home');
  // Keep our own handle on the same node so the Home button can jump it to the
  // top (the hook only owns save/restore).
  const feedElRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      feedElRef.current = node;
      rememberScroll(node);
    },
    [rememberScroll],
  );
  // Home button: land at the top of the feed. Covers the case where Home is
  // already the current view (so it never remounts and nothing would otherwise
  // move); arriving from another view is handled by the host clearing the saved
  // position before it navigates.
  useEffect(() => {
    if (homeReset > 0) feedElRef.current?.scrollTo({ top: 0 });
  }, [homeReset]);

  // Desktop drill-ins (station/mix, editorial playlist, show-all grid) render
  // into THIS overlay — a sibling of the feed's scroll container, not a child.
  // The feed is therefore never unmounted or scrolled when you open one, so
  // coming back reveals it exactly where you left it, with no restoration step
  // at all (the iOS navigation-stack model). Doing it in-flow used to rebuild
  // the feed on Back — and a cold feed is still assembling shelves for several
  // seconds, so the old position no longer meant anything and you landed on top.
  const [drillKey, setDrillKey] = useState<string | null>(null);
  const [drillHost, setDrillHost] = useState<HTMLDivElement | null>(null);
  // A different drill (or a re-open) starts at its own top, like a fresh page.
  useEffect(() => {
    if (drillHost) drillHost.scrollTop = 0;
  }, [drillKey, drillHost]);

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
    <div className="relative h-full">
      <div
        ref={scrollRef}
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
        // The welcome card's "find something to play". The desktop has no Search
        // tab — the search field lives in the top bar permanently, and focusing
        // it just surfaces Browse — so Browse IS this platform's route to the
        // same genre grid the phone's Search tab opens on.
        onOpenSearch={onOpenBrowse}
        onOpenArtist={(name) => openArtist(name)}
        onOpenAlbum={(name, artist) => openAlbum(name, artist)}
        onWinBack={onWinBack}
        onMixPush={onMixPush}
        mixRestore={mixRestore}
        onMixBack={onMixBack}
        onDrillKeyChange={setDrillKey}
        drillPortal={drillHost}
        pin={pinController}
        save={saveController}
      />
      </div>
      {/* The drill-in overlay's own scroll container. Always mounted (HomeScreen
          portals into it), hidden while no drill is open so it can't cover the
          feed. `overscroll-contain` keeps a bounce here from scrolling the feed
          underneath. */}
      <div
        ref={setDrillHost}
        className={`absolute inset-0 z-10 overflow-y-auto overscroll-contain bg-neutral-950 ${
          drillKey ? '' : 'hidden'
        }`}
      />
    </div>
  );
}
