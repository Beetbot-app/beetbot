import { useCallback, useMemo } from 'react';
import {
  SearchScreen,
  type OverlaySnapshot,
  type SidebarPinController,
} from '@shared/components/SearchScreen';
import { isPinned, usePinStore } from '@/lib/pins';
import {
  ensureSession,
  resolveCatalogTrack,
  resolveCatalogTracks,
  setApiBase,
  setTrackLiked,
  type ResolvedTrack,
  type SearchTrackResult,
} from '@shared/api';
import { usePlayerStore, currentTrack } from '@/lib/store';
import { useNavStore } from '@/lib/nav';
import { useProfileStore } from '@/lib/profile';
import { useSession } from '@/lib/session';
import { ipc, type PlaylistTrack } from '@/lib/tauri';

// Point the shared api.ts at the local streaming server. Without
// this, fetches use relative paths like `/api/search` which resolve
// against the Tauri webview origin (`tauri://localhost`) — WebKit
// then rejects the fetch with "The string did not match the expected
// pattern" because tauri: isn't a valid fetch scheme.
//
// Done at module load so it's set before SearchScreen ever runs a
// fetch. Idempotent — phone bundle never imports this module.
setApiBase('http://127.0.0.1:47823');

/**
 * Desktop wrapper around the shared `SearchScreen`.
 *
 * Two responsibilities the shared component can't handle itself:
 *
 * 1. **Session bootstrap.** The shared component talks to the
 *    streaming server's `/api/*` HTTP endpoints, which require a
 *    session token. The desktop is loopback-only, and the server now
 *    skips the pairing gate for loopback peers (see
 *    `session_handler` in src-tauri/src/server/mod.rs), so we just
 *    fetch `/api/session` at mount and stash the token in state.
 *
 * 2. **Play handler.** The phone bundle seeds its `StreamTrack`-shaped
 *    queue; the desktop seeds a `PlaylistTrack`-shaped one. We fetch
 *    the full track row from IPC (so the player's <audio> tag can
 *    hit the local_path directly via Tauri's asset:// protocol
 *    instead of streaming over HTTP) and call setQueue.
 */
export function SearchOverlay({
  barSlot,
  restore,
  onOverlayPush,
  onOverlayBack,
  onSearchFocus,
  onOpenBrowse,
}: {
  /** Portal target (in the top bar) for the search input + dropdown. */
  barSlot: HTMLElement | null;
  /** Resets the overlay to a snapshot (or clears it) on each signal bump —
   *  drives both navigation-clear and Back/Forward replay of search pages. */
  restore: { signal: number; snapshot: OverlaySnapshot | null };
  /** Pushes a view-history entry when the user drills to a new search page. */
  onOverlayPush: (snapshot: OverlaySnapshot) => void;
  /** Steps back one history entry — closing a detail (Escape / ✕) routes here. */
  onOverlayBack: () => void;
  /** Focusing the idle search box → host opens Discover (Spotify-style). */
  onSearchFocus: () => void;
  /** In-field Browse button (always visible) → host opens Discover. */
  onOpenBrowse: () => void;
}) {
  // One shared session token, fetched once per app launch (not per navigation).
  const { token } = useSession();
  // Pending "open artist/album page" request from Home / the now-playing bar.
  const navRequest = useNavStore((s) => s.request);
  const clearNav = useNavStore((s) => s.clear);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);

  // Now-playing awareness for the opened album page (Spotify-style row highlight
  // + equalizer bars + ⏸/▶ hero). A catalog album row may not carry a library id
  // until it's been played, so match by id, then ISRC, then title+artist — that
  // lights up the current row even for a not-yet-resolved catalog track.
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

  // Bridge the desktop sidebar-pin store into the shared artist/album pages so
  // they can show a "Pin to sidebar" button (the phone passes no controller).
  const pins = usePinStore((s) => s.pins);
  const togglePin = usePinStore((s) => s.toggle);
  const pinController = useMemo<SidebarPinController>(
    () => ({
      isArtistPinned: (name) =>
        isPinned(pins, { kind: 'artist', key: name, name, art: null }),
      toggleArtist: (a) => togglePin({ kind: 'artist', ...a }),
      isAlbumPinned: (album, artist) =>
        isPinned(pins, { kind: 'album', album, artist, art: null }),
      toggleAlbum: (a) => togglePin({ kind: 'album', ...a }),
    }),
    [pins, togglePin],
  );

  // Search is silently unavailable until the loopback session is ready (the rest
  // of the app still works). SearchScreen positions itself — an absolute overlay
  // when active, nothing when idle — so the underlying view shows through.
  if (!token) return null;

  return (
    <SearchScreen
      token={token}
      onPlayTrack={playOnDesktop}
      pageMode
      desktop
      overlayMode
      barSlot={barSlot}
      restore={restore}
      onOverlayPush={onOverlayPush}
      onOverlayBack={onOverlayBack}
      onSearchFocus={onSearchFocus}
      onOpenBrowse={onOpenBrowse}
      openRequest={navRequest}
      onRequestHandled={clearNav}
      activeProfileId={activeProfileId}
      pin={pinController}
      // Browse-album "⋯" menu (parity with library albums). These act on a
      // catalog row, which has no library track until resolved — so each
      // handler imports the track first, then queues / likes it.
      onAlbumGoToArtist={(name) => useNavStore.getState().openArtist(name)}
      onAlbumGoToAlbum={(name, artist) =>
        useNavStore.getState().openAlbum(name, artist)
      }
      onAlbumAddToQueue={(t) => void queueCatalogTrack(t, token)}
      onAlbumSaveToLiked={(t) => void likeCatalogTrack(t, token, activeProfileId)}
      isTrackCurrent={isTrackCurrent}
      isNowPlaying={isNowPlaying}
      onTogglePlay={() => usePlayerStore.getState().playPause()}
    />
  );
}

/**
 * Resolve a catalog result to its (created-on-demand) library id. Mirrors the
 * single-track path in `playOnDesktop`: a row may already carry the id, else we
 * import it ISRC-deduped. Returns null if resolution fails.
 */
async function resolveTrackId(
  t: SearchTrackResult,
  token: string,
): Promise<number | null> {
  try {
    if (t.local_track_id != null) return t.local_track_id;
    return (await resolveCatalogTrack(t, token)).track_id;
  } catch (e) {
    console.warn('[beetbot] resolve-for-menu failed', e);
    return null;
  }
}

/** "Add to queue" for a browse-album row: resolve, load the real row, append. */
export async function queueCatalogTrack(
  t: SearchTrackResult,
  token: string,
): Promise<void> {
  const id = await resolveTrackId(t, token);
  if (id == null) return;
  const track = await ipc.getTrack(id);
  if (track) usePlayerStore.getState().appendToQueue([track]);
}

/** "Add to Favorites" for a browse-album row: resolve, then like. */
export async function likeCatalogTrack(
  t: SearchTrackResult,
  token: string,
  profileId: number | null,
): Promise<void> {
  const id = await resolveTrackId(t, token);
  if (id != null) await setTrackLiked(token, id, true, profileId);
}

/**
 * Convert a catalog result into a `PlaylistTrack` and start playback.
 *
 * The result carries the local track id but not the filesystem path the
 * desktop's <audio> needs, so we resolve the row by id via `get_track`.
 * This works regardless of playlist context — Search/Browse results and
 * Home's "On repeat" (which has no playlist) all play the same way.
 */
export async function playOnDesktop(
  t: SearchTrackResult,
  list?: SearchTrackResult[],
  index?: number,
): Promise<void> {
  try {
    const token = await ensureSession();
    // Played from a list (a chart, an album, an artist's top tracks) → seed the
    // WHOLE list as the queue starting at the tapped row, so playback continues
    // down the list. One batch upsert maps every catalog row to a library id;
    // each track plays from its local file when it becomes current.
    if (list && list.length > 1 && index != null) {
      const resolved = await resolveCatalogTracks(list, token);
      const queue = list.map((ct, i) =>
        catalogToPlaylistTrack(ct, resolved[i], i),
      );
      usePlayerStore.getState().setQueue(queue, index);
      return;
    }
    // Single track (federated/top-result/recents/dropdown). A catalog result has
    // no library row yet — create one (ISRC-deduped) to stream by; load the real
    // row so a downloaded track plays its local file via asset://.
    let trackId = t.local_track_id;
    if (trackId == null) {
      trackId = (await resolveCatalogTrack(t, token)).track_id;
    }
    const track = await ipc.getTrack(trackId);
    if (!track) return;
    usePlayerStore.getState().setQueue([track]);
  } catch (e) {
    // Failure to enqueue from a tap shouldn't crash the page; the
    // picker / +/✓ buttons still work.
    console.warn('[beetbot] desktop play-from-search failed', e);
  }
}

/**
 * Build a queue-ready `PlaylistTrack` from a catalog result + its resolved
 * library id, without a per-track `get_track` round-trip. A track is playable
 * only if it has an imported audio file: a `has_audio` row → status
 * 'downloaded' (the hub streams its file by id via /stream/{id}); everything
 * else gets a falsy status so `setQueue`'s `canStream` filter drops it (only
 * tracks with a local file are playable). Rows that failed to resolve get id 0 too.
 */
function catalogToPlaylistTrack(
  ct: SearchTrackResult,
  resolved: ResolvedTrack | undefined,
  i: number,
): PlaylistTrack {
  return {
    id: resolved?.track_id ?? 0,
    spotify_id: `${ct.source}:${ct.source_id}`,
    title: ct.title,
    artists: ct.artists,
    album: ct.album,
    album_art_url: ct.album_art_url,
    duration_ms: ct.duration_ms,
    isrc: ct.isrc,
    status: resolved?.track_id && ct.has_audio ? 'downloaded' : '',
    failure_reason: null,
    local_path: null,
    position: i,
    added_at: null,
  };
}
