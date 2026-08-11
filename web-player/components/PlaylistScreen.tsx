import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  cacheTrack,
  canLiveStream,
  canPlayNow,
  deletePlaylist,
  evictTrack,
  friendlyError,
  getCachedTrackIds,
  getOfflinePlaylistIds,
  getPlaylist,
  markPlaylistPlayed,
  offlineCacheAvailable,
  playlistArtUrl,
  renamePlaylist,
  setOfflinePlaylistIds,
  setTrackLiked,
  streamUrl,
  trackArtUrl,
  type PlaylistDetail,
  type StreamTrack,
} from '@shared/api';
import { useHubReachable } from '@shared/useHubReachable';
import { useToast } from '@shared/useToast';
import {
  cn,
  SCRIM,
  BOTTOM_SHEET,
  BTN_PRIMARY,
  BTN_DANGER,
  BTN_GHOST,
  INPUT,
  CALLOUT_INFO,
  CALLOUT_ERROR,
  EYEBROW_ON_ART,
} from '@shared/ui';
import { SwipeRow } from '@shared/components/SwipeRow';
import { Toast } from '@shared/components/Toast';
import { HeroWash } from '@shared/components/HeroWash';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { useCondensedHeader } from '@shared/components/StickyHeader';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { canStream, currentTrack, usePlayerStore, useCatalogNav } from '../store';
import { TrackActionSheet } from './TrackActionSheet';
import { streamToSearchResult } from '@shared/trackAdapter';
import { notifyLibraryChanged } from '@shared/libraryChanged';

interface Props {
  token: string;
  playlistId: number;
  profileId: number | null;
  onBack: () => void;
}

type OfflineProgress =
  | { state: 'idle' }
  | {
      state: 'caching';
      done: number;
      total: number;
      failed: number;
      bytes: number;
      lastError: string | null;
    }
  | { state: 'evicting' }
  | {
      state: 'done';
      cached: number;
      failed: number;
      bytes: number;
      lastError: string | null;
    };

export function PlaylistScreen({ token, playlistId, profileId, onBack }: Props) {
  // Re-render the rows when hub reachability changes so a non-downloaded
  // track's Play button dims the moment the hub drops (canPlayNow below); the
  // returned flag also gates the hub-write controls (rename / delete / save).
  const hubUp = useHubReachable();
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  // Spotify-style condensed header: the title + a play button fade into the
  // sticky bar once the hero title scrolls past.
  const [condensed, heroSentinelRef] = useCondensedHeader();
  const [error, setError] = useState<string | null>(null);
  const [cachedIds, setCachedIds] = useState<Set<number>>(new Set());
  // Transient confirmation for swipe gestures.
  const { toast, showToast } = useToast();
  const enqueue = usePlayerStore((s) => s.enqueue);
  // Per-track "⋯" action sheet (Apple Music-style) + its add-to-playlist modal.
  const [sheetTrack, setSheetTrack] = useState<StreamTrack | null>(null);
  const [addTrack, setAddTrack] = useState<StreamTrack | null>(null);
  const openArtistNav = useCatalogNav((s) => s.openArtist);
  const openAlbumNav = useCatalogNav((s) => s.openAlbum);
  const onSwipeQueue = useCallback(
    (t: StreamTrack) => {
      if (!canStream(t)) {
        showToast('Not available yet');
        return;
      }
      enqueue(t);
      // canStream is a static capability check (it ignores hub reachability) so
      // a transient hub blip never refuses the add. Say so when the hub is down —
      // otherwise a dimmed "needs your computer" row silently queueing reads as
      // a bug rather than the deliberate queue-for-later it is.
      showToast(
        canPlayNow(t)
          ? 'Added to queue'
          : "Queued — plays when your computer's back",
      );
    },
    [enqueue, showToast],
  );
  const onSwipeSave = useCallback(
    (t: StreamTrack) => {
      void setTrackLiked(token, t.id, true, profileId)
        .then(() => {
          showToast('Added to Favorites');
          // So the now-playing star (if this is the current track), the Home
          // Favorites shelf, and the Library counts refresh live.
          notifyLibraryChanged();
        })
        .catch(() => showToast("Couldn't save"));
    },
    [token, profileId, showToast],
  );
  // Per-track offline: cache/evict a single song. Only downloaded-on-hub
  // (has_audio) tracks can be cached — cacheTrack fetches /stream/{id}, not
  // /live — so the action is gated to those in the sheet below. Evicting is
  // local, so it stays available even when the hub is unreachable.
  const onToggleDownload = useCallback(
    async (t: StreamTrack) => {
      const wasCached = cachedIds.has(t.id);
      try {
        if (wasCached) {
          await evictTrack(t.id);
          setCachedIds((prev) => {
            const next = new Set(prev);
            next.delete(t.id);
            return next;
          });
          showToast('Removed download');
        } else {
          await cacheTrack(t.id, token);
          setCachedIds((prev) => new Set(prev).add(t.id));
          showToast('Downloaded');
        }
      } catch (e) {
        showToast(friendlyError(e));
      }
    },
    [cachedIds, token, showToast],
  );
  const [offlineMode, setOfflineMode] = useState<boolean>(false);
  const [progress, setProgress] = useState<OfflineProgress>({ state: 'idle' });
  // Delete-confirmation modal state. `'pending'` = confirm dialog open;
  // `'deleting'` = HTTP DELETE in flight; the `null` default = no modal.
  const [deleteState, setDeleteState] = useState<
    null | 'pending' | 'deleting'
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Rename modal state, mirroring delete. `'pending'` = dialog open;
  // `'saving'` = PATCH in flight.
  const [renameState, setRenameState] = useState<null | 'pending' | 'saving'>(
    null,
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const playing = usePlayerStore(currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playPause = usePlayerStore((s) => s.playPause);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  // Mark the playlist as opened-just-now so the Library grid can
  // sort by recency on next visit. Spotify-style: opening a playlist
  // counts as a "play" — what users intuitively expect from "Recently
  // played" ordering. Fires once per mount even if the API fetch
  // below later fails (offline / 404), since the user's intent to
  // visit it is what we're tracking.
  useEffect(() => {
    markPlaylistPlayed(playlistId);
  }, [playlistId]);

  useEffect(() => {
    let cancelled = false;
    const prefetchCtrl = new AbortController();
    (async () => {
      try {
        const d = await getPlaylist(playlistId, token);
        if (cancelled) return;
        setDetail(d);
        setOfflineMode(getOfflinePlaylistIds().has(playlistId));
        const cached = await getCachedTrackIds();
        setCachedIds(cached);
        // Prefetch the first playable track that isn't already in
        // the offline cache. The user has navigated INTO the
        // playlist — they're highly likely to tap Play in the next
        // few seconds, and pre-warming the browser HTTP cache for
        // that track cuts the cellular tap-to-play delay from
        // 1-3 seconds to ~instant. Fire-and-forget; aborted on
        // unmount so we don't waste bandwidth if the user backs
        // out before tapping.
        if (!cancelled && navigator.onLine) {
          const first = d.tracks.find(
            (t) => t.has_audio && !cached.has(t.id),
          );
          if (first) {
            fetch(streamUrl(first.id, token), { signal: prefetchCtrl.signal })
              .then((r) => r.blob())
              .catch(() => {});
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      prefetchCtrl.abort();
    };
  }, [token, playlistId]);

  const refreshCachedIds = useCallback(async () => {
    setCachedIds(await getCachedTrackIds());
  }, []);

  const handleEnableOffline = useCallback(async () => {
    if (!detail) return;
    const targets = detail.tracks.filter((t) => t.has_audio);
    if (targets.length === 0) {
      setProgress({
        state: 'done',
        cached: 0,
        failed: 0,
        bytes: 0,
        lastError: 'No downloaded tracks to cache.',
      });
      return;
    }
    // Persist the toggle now so a mid-flow refresh still shows the intent.
    const ids = getOfflinePlaylistIds();
    ids.add(playlistId);
    setOfflinePlaylistIds(ids);
    setOfflineMode(true);

    setProgress({
      state: 'caching',
      done: 0,
      total: targets.length,
      failed: 0,
      bytes: 0,
      lastError: null,
    });
    let done = 0;
    let failed = 0;
    let bytes = 0;
    let lastError: string | null = null;
    for (const t of targets) {
      try {
        bytes += await cacheTrack(t.id, token);
      } catch (e) {
        // Track-level failures don't abort the whole batch -- mobile
        // networks blip. We keep counting and surface the final tally.
        failed += 1;
        lastError = friendlyError(e);
      }
      done += 1;
      setProgress({
        state: 'caching',
        done,
        total: targets.length,
        failed,
        bytes,
        lastError,
      });
      // Refresh the cache view incrementally so the user sees progress.
      if (done % 3 === 0 || done === targets.length) {
        await refreshCachedIds();
      }
    }
    await refreshCachedIds();
    setProgress({
      state: 'done',
      cached: done - failed,
      failed,
      bytes,
      lastError,
    });
  }, [detail, playlistId, token, refreshCachedIds]);

  const handleDisableOffline = useCallback(async () => {
    if (!detail) return;
    setProgress({ state: 'evicting' });
    const ids = getOfflinePlaylistIds();
    ids.delete(playlistId);
    setOfflinePlaylistIds(ids);
    setOfflineMode(false);
    for (const t of detail.tracks) {
      try {
        await evictTrack(t.id);
      } catch {
        // Eviction errors are not fatal -- the cache entry was probably
        // already gone.
      }
    }
    await refreshCachedIds();
    setProgress({ state: 'idle' });
  }, [detail, playlistId, refreshCachedIds]);

  const playFrom = (track: StreamTrack) => {
    if (!detail) return;
    const idx = detail.tracks.findIndex((t) => t.id === track.id);
    setQueue(detail.tracks, Math.max(0, idx));
  };

  const playAll = () => {
    if (!detail) return;
    setQueue(detail.tracks, 0);
  };

  // Shuffle: turn shuffle on (if off) and start from a random playable track
  // (one with an imported audio file).
  const handleShuffle = () => {
    if (!detail) return;
    if (!usePlayerStore.getState().shuffle) toggleShuffle();
    const idxs = detail.tracks
      .map((t, i) => (canStream(t) ? i : -1))
      .filter((i) => i >= 0);
    const start = idxs.length ? idxs[Math.floor(Math.random() * idxs.length)] : 0;
    setQueue(detail.tracks, start);
  };

  if (error) {
    // The SW serves Response.error() (which Safari renders as
    // "TypeError: Response served by service worker is an error")
    // when the playlist isn't cached AND there's no network. Turn
    // that into a useful explanation instead of a stack-trace dump.
    const looksLikeOffline =
      !navigator.onLine ||
      /service worker is an error|Failed to fetch|Load failed|NetworkError/i.test(
        error,
      );
    return (
      <div className="p-4">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-white/10 active:text-neutral-100"
          aria-label="Back to Library"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className={cn(CALLOUT_INFO, 'text-xs')}>
          {looksLikeOffline ? (
            <>
              <div className="font-medium text-neutral-100 mb-1">
                This playlist isn’t cached for offline yet.
              </div>
              <div className="text-neutral-400">
                Reconnect to the network and open it once — the app will
                remember it the next time you’re offline.
              </div>
            </>
          ) : (
            <div className="text-red-200">{friendlyError(error)}</div>
          )}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="p-4">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-white/10 active:text-neutral-100"
          aria-label="Back to Library"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div aria-hidden>
          {/* Pulsing hero + rows (matches Home's skeleton pattern). */}
          <div className="flex items-center gap-4 mb-6 animate-pulse">
            <div className="h-28 w-28 rounded-xl bg-neutral-800/80 shrink-0" />
            <div className="flex-1">
              <div className="h-5 w-2/3 rounded bg-neutral-800/80" />
              <div className="mt-2 h-3.5 w-1/3 rounded bg-neutral-800/80" />
            </div>
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2.5 animate-pulse">
              <div className="h-10 w-10 rounded-lg bg-neutral-800/80 shrink-0" />
              <div className="flex-1">
                <div className="h-3.5 w-1/2 rounded bg-neutral-800/80" />
                <div className="mt-1.5 h-3 w-1/3 rounded bg-neutral-800/80" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Play/Shuffle enable whenever a track is playable (local file or live).
  const streamableCount = detail.tracks.filter(canStream).length;
  // Tracks whose audio actually sits on the hub. NOT a canStream filter: it is a
  // *capability* check (a local file OR this build's ability to live-stream
  // anything), so on the full build every track passes it and a "downloaded"
  // count taken from it always reads n of n — including for a playlist with
  // zero files. `has_audio` is the server's `local_path IS NOT NULL`, which is
  // the question both the header and the offline toggle are actually asking.
  const downloaded = detail.tracks.filter((t) => t.has_audio);
  // Whether THIS playlist is the current playback source — so the hero + sticky
  // play buttons reflect ⏸ while it plays and toggle play/pause (instead of
  // always restarting). When a track from another source is current, the button
  // plays this playlist from the top.
  const playlistActive = !!playing && detail.tracks.some((t) => t.id === playing.id);
  const playlistPlaying = playlistActive && isPlaying;
  const togglePlay = () => (playlistActive ? playPause() : playAll());
  const cachedInPlaylist = downloaded.filter((t) => cachedIds.has(t.id)).length;
  // A saved album is stored as a playlist but is really an *album* — the page's
  // copy (delete / rename / offline tooltips) calls it that, not "playlist".
  const isAlbum = detail.source === 'album';

  const handleConfirmDelete = async () => {
    setDeleteState('deleting');
    setDeleteError(null);
    try {
      await deletePlaylist(playlistId, token);
      // Refetching is not enough on its own: `/api/playlists` is served
      // stale-while-revalidate, so the library's next read still contains the
      // playlist we just deleted. notifyLibraryChanged evicts it first.
      notifyLibraryChanged();
      onBack();
    } catch (e) {
      setDeleteError(friendlyError(e));
      setDeleteState('pending');
    }
  };

  const handleConfirmRename = async (name: string, description: string) => {
    setRenameState('saving');
    setRenameError(null);
    try {
      await renamePlaylist(playlistId, name, token, description);
      // The Library grid refetches on its next mount, but that read comes from
      // the service worker's cache — so evict it, or it shows the old name.
      notifyLibraryChanged();
      // Reflect the edit in this header immediately too.
      setDetail((prev) =>
        prev ? { ...prev, name, description: description.trim() || null } : prev,
      );
      setRenameState(null);
    } catch (e) {
      setRenameError(friendlyError(e));
      setRenameState('pending');
    }
  };

  return (
    <div className="pb-2">
      {/* Floating top bar: a legibility gradient over the full-bleed hero at
          rest (just the controls), frosting into the app's chrome + revealing
          the condensed title/play once the hero scrolls past — the same pattern
          the catalog detail pages use, so library + catalog read identically. */}
      <div
        className={`sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-2 transition-colors duration-200 ${
          condensed
            ? 'bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/5'
            : 'bg-gradient-to-b from-black/50 to-transparent'
        }`}
      >
        <button
          type="button"
          onClick={onBack}
          className="h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-white/10 active:text-neutral-100"
          aria-label="Back to Library"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        {/* Title + play fade into the bar once the hero scrolls past. */}
        <span
          className={`min-w-0 flex-1 truncate text-sm font-semibold transition-opacity duration-200 ${
            condensed ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {detail.name}
        </span>
        <button
          type="button"
          disabled={streamableCount === 0}
          onClick={togglePlay}
          aria-label={playlistPlaying ? 'Pause' : `Play ${detail.name}`}
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-neutral-950 transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500 ${
            condensed ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {playlistPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M7 4.5v15l12-7.5z" />
            </svg>
          )}
        </button>
        {/* Rename lives on the title tap and Delete lives in the action row
            below (Spotify-style, same as desktop) — so the sticky bar stays
            back + condensed title + play, never a row of edit/delete icons. */}
      </div>

      {/* -mt-14 lifts the hero up behind the floating top bar so the wash runs
          edge-to-edge to the top (no black band); pt-16 below clears the bar. */}
      <div className="relative -mt-14">
        {/* One shared ambient hero wash — the page's own art color, matching
            Home + the app so navigation feels like one lit space. Always uses
            the same-origin proxied art URL (which composes a mosaic for
            cover-less playlists), so even collage playlists get a tinted hero
            instead of a flat one — and it's not CORS-blocked. */}
        <HeroWash coverUrl={playlistArtUrl(playlistId, token)} />
        {/* Apple-Music/Spotify-style hero: one large centered cover floating
            on the artwork wash, title + meta centered beneath it, actions as a
            centered row of frosted circles. */}
        <div className="relative px-4 pt-20 pb-5 flex flex-col items-center text-center">
        <div className="h-52 w-52 rounded-2xl overflow-hidden bg-neutral-800 shadow-2xl shadow-black/60 ring-1 ring-white/10 grid place-items-center">
          {detail.cover_url ? (
            <img
              src={playlistArtUrl(playlistId, token)}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-5xl text-neutral-600">♪</span>
          )}
        </div>
        <div className="mt-4 w-full min-w-0 flex flex-col items-center">
          {/* Kind eyebrow — matches the catalog album / playlist heroes. */}
          <p className={cn(EYEBROW_ON_ART, 'mb-1')}>{isAlbum ? 'Album' : 'Playlist'}</p>
          {/* Tap the title to rename (Spotify-style, same as desktop). Gated
              on reachability — renaming is a hub write; when the desktop is
              unreachable the title stays readable but isn't a rename trigger. */}
          {/* max-w-full is load-bearing: in this centered flex column the h1
              would otherwise size to the nowrap text's full width and spill
              off both screen edges — the button's truncate only engages when
              the h1 itself is clamped to the wrapper. */}
          <h1 className="text-2xl font-bold tracking-tight mb-1 min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => {
                if (!hubUp) return;
                setRenameError(null);
                setRenameState('pending');
              }}
              title={hubUp ? 'Edit details' : undefined}
              className={`block max-w-full truncate ${
                hubUp ? 'active:opacity-70' : ''
              }`}
            >
              {detail.name}
            </button>
          </h1>
          {/* Sentinel: once this scrolls above the top, the sticky bar condenses. */}
          <div ref={heroSentinelRef} className="h-px w-px" aria-hidden />
          {/* h1 above is the sentinel anchor; keep the meta line below it. */}
          <p className="mt-1 text-xs text-neutral-400">
            {detail.tracks.length} songs · {downloaded.length} downloaded
            {cachedInPlaylist > 0 ? (
              <>
                {' '}· {cachedInPlaylist} offline
              </>
            ) : null}
          </p>
          {detail.description && (
            <p className="mt-1.5 max-w-md text-sm text-neutral-300 whitespace-pre-wrap">
              {detail.description}
            </p>
          )}
          <div className="mt-4 flex items-center justify-center gap-4">
            {/* Apple-style order: shuffle · Play (dominant) · offline · delete. */}
            <button
              type="button"
              disabled={streamableCount === 0}
              onClick={handleShuffle}
              aria-label="Shuffle play"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40 disabled:text-neutral-600"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M16 3h5v5" />
                <path d="M4 20 21 3" />
                <path d="M21 16v5h-5" />
                <path d="m15 15 6 6" />
                <path d="M4 4l5 5" />
              </svg>
            </button>
            {/* Canonical white play circle — identical to the catalog album /
                playlist detail pages and the desktop hero. */}
            <button
              type="button"
              disabled={streamableCount === 0}
              onClick={togglePlay}
              aria-label={playlistPlaying ? 'Pause' : `Play ${detail.name}`}
              className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {playlistPlaying ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            {offlineCacheAvailable() && (
              <OfflineToggle
                offlineMode={offlineMode}
                progress={progress}
                cachedInPlaylist={cachedInPlaylist}
                total={downloaded.length}
                isAlbum={isAlbum}
                onEnable={handleEnableOffline}
                onDisable={handleDisableOffline}
              />
            )}
            {/* Delete lives in the action row (same as desktop), not the top
                bar. Gated on reachability like the other hub-write controls. */}
            <button
              type="button"
              onClick={() => setDeleteState('pending')}
              disabled={!hubUp}
              aria-label={isAlbum ? 'Delete album' : 'Delete playlist'}
              title={
                hubUp
                  ? isAlbum
                    ? 'Delete album'
                    : 'Delete playlist'
                  : 'Needs your computer'
              }
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-300 active:text-red-400 disabled:opacity-40 disabled:pointer-events-none"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      </div>

      <OfflineProgressBanner progress={progress} />
      {!offlineCacheAvailable() && (
        <div className={cn(CALLOUT_INFO, 'mx-4 mb-3 text-xs')}>
          Offline caching isn&apos;t available on this URL — your browser
          requires HTTPS for the Cache API. Streaming over Wi-Fi still works.
        </div>
      )}

      <ul>
        {detail.tracks.map((t, i) => {
          const isCurrent = playing?.id === t.id;
          // A saved *album* (isAlbum, above) shares one cover across every
          // track, so a per-track thumbnail would just repeat the hero art.
          // Show a track-number gutter instead (Apple Music / Spotify album
          // style); real playlists keep the per-track cover.
          // Playable-now iff the hub has the file, or (full build) it's matched,
          // can be live-streamed, AND the hub is currently reachable. A hub
          // outage dims a non-downloaded row instead of failing on tap.
          const playable = canPlayNow(t);
          const isCached = cachedIds.has(t.id);
          // Two different reasons a row can't play *right now*, with different
          // fixes: the open build can't stream at all, so the file must be
          // downloaded on the hub ("add on desktop"); the full build just can't
          // reach the hub this moment ("needs your computer" — it streams again
          // once the desktop is back). Pre-`/live`, this always said "add on
          // desktop", which was wrong for a matched track during a hub outage.
          const blockedReason = playable
            ? null
            : canLiveStream()
              ? 'needs your computer'
              : 'no audio file — add on desktop';
          return (
            <li key={t.id}>
              <SwipeRow
                onSwipeRight={() => onSwipeQueue(t)}
                onSwipeLeft={() => onSwipeSave(t)}
                rightAction={{ label: 'Queue', bg: 'bg-neutral-800' }}
                leftAction={{ label: 'Save', bg: 'bg-neutral-100 text-neutral-950' }}
              >
              <div className="w-full px-4 py-2.5 flex items-center gap-3 active:bg-neutral-900">
                <button
                  type="button"
                  disabled={!playable}
                  onClick={() => playable && playFrom(t)}
                  className={`flex items-center gap-3 flex-1 min-w-0 text-left ${
                    playable ? '' : 'opacity-60'
                  }`}
                >
                  {isAlbum ? (
                    // Album: a number gutter. The current row swaps the number
                    // for the equalizer while playing (a static ♪ when paused) —
                    // matching the catalog album gutter and the playlist covers.
                    <div className="w-7 shrink-0 grid place-items-center text-sm tabular-nums text-neutral-500">
                      {isCurrent ? (
                        <span className="text-accent" aria-hidden>
                          {isPlaying ? <EqualizerBars className="text-accent" /> : '♪'}
                        </span>
                      ) : (
                        i + 1
                      )}
                    </div>
                  ) : (
                    <div className="relative h-10 w-10 shrink-0 rounded-lg bg-neutral-800 overflow-hidden">
                      {t.album_art_url ? (
                        <img
                          // Same-origin proxy so the SW can cache the
                          // bytes for offline display.
                          src={trackArtUrl(t.id, token)}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                          loading="lazy"
                        />
                      ) : null}
                      {/* Now-playing marker on the cover: the moving equalizer
                          bars while it's actually playing (matching the genre
                          rows), falling back to a static ♪ when paused — an
                          accent-independent signal that always reads (the title's
                          text-accent tint can resolve to plain white). */}
                      {isCurrent && (
                        <div
                          className="absolute inset-0 grid place-items-center bg-black/55 text-sm text-white"
                          aria-hidden
                        >
                          {isPlaying ? <EqualizerBars className="text-white" /> : '♪'}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-sm font-medium truncate ${isCurrent ? 'text-accent' : 'text-neutral-300'}`}
                    >
                      {t.title}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {t.artists.join(', ')}
                      {blockedReason ? ` · ${blockedReason}` : ''}
                    </div>
                  </div>
                </button>
                {t.has_audio && <CacheBadge cached={isCached} />}
                <button
                  type="button"
                  aria-label={`More options for ${t.title}`}
                  onClick={() => setSheetTrack(t)}
                  className="h-11 w-9 -my-2 -mr-2 grid place-items-center text-neutral-500 active:text-neutral-200 shrink-0"
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <circle cx="5" cy="12" r="1.7" />
                    <circle cx="12" cy="12" r="1.7" />
                    <circle cx="19" cy="12" r="1.7" />
                  </svg>
                </button>
              </div>
              </SwipeRow>
            </li>
          );
        })}
      </ul>

      {deleteState !== null && (
        <DeleteConfirmModal
          playlistName={detail.name}
          isAlbum={detail.source === 'album'}
          isDeleting={deleteState === 'deleting'}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setDeleteState(null);
            setDeleteError(null);
          }}
        />
      )}
      {renameState !== null && (
        <RenameModal
          currentName={detail.name}
          currentDescription={detail.description ?? ''}
          source={detail.source}
          isSaving={renameState === 'saving'}
          error={renameError}
          onSubmit={handleConfirmRename}
          onCancel={() => {
            setRenameState(null);
            setRenameError(null);
          }}
        />
      )}
      {sheetTrack && (
        <TrackActionSheet
          onClose={() => setSheetTrack(null)}
          quick={[
            {
              key: 'favorite',
              label: 'Favorite',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
                </svg>
              ),
              onClick: () => onSwipeSave(sheetTrack),
            },
            {
              key: 'add',
              label: 'Add',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 7h10M4 12h6M4 17h6" />
                  <path d="M16 14v7M12.5 17.5h7" />
                </svg>
              ),
              onClick: () => setAddTrack(sheetTrack),
            },
          ]}
          items={[
            ...(offlineCacheAvailable() &&
            (cachedIds.has(sheetTrack.id) || (sheetTrack.has_audio && hubUp))
              ? [
                  {
                    key: 'download',
                    label: cachedIds.has(sheetTrack.id)
                      ? 'Remove download'
                      : 'Download',
                    icon: cachedIds.has(sheetTrack.id) ? (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <path d="m8.5 12 2.5 2.5 4.5-5" />
                      </svg>
                    ) : (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 4v11" />
                        <path d="M7 11l5 5 5-5" />
                        <path d="M5 20h14" />
                      </svg>
                    ),
                    onClick: () => onToggleDownload(sheetTrack),
                  },
                ]
              : []),
            ...(sheetTrack.artists[0]
              ? [
                  {
                    key: 'artist',
                    label: 'Go to Artist',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="8" r="4" />
                        <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
                      </svg>
                    ),
                    onClick: () => openArtistNav(sheetTrack.artists[0]),
                  },
                ]
              : []),
            ...(sheetTrack.album
              ? [
                  {
                    key: 'album',
                    label: 'Go to Album',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="2.4" />
                      </svg>
                    ),
                    onClick: () =>
                      openAlbumNav(sheetTrack.album!, sheetTrack.artists[0] ?? null),
                  },
                ]
              : []),
          ]}
        />
      )}
      {addTrack &&
        createPortal(
          <AddToPlaylistModal
            token={token}
            activeProfileId={profileId}
            track={streamToSearchResult(addTrack)}
            onClose={() => setAddTrack(null)}
          />,
          document.body,
        )}
      {toast && <Toast message={toast} />}
    </div>
  );
}

function DeleteConfirmModal({
  playlistName,
  isAlbum,
  isDeleting,
  error,
  onConfirm,
  onCancel,
}: {
  playlistName: string;
  // A saved album is stored as a playlist but is really an *album*, so the
  // copy calls it that ("Delete album?") instead of "Delete playlist?".
  isAlbum: boolean;
  isDeleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDeleting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, isDeleting]);
  // Lock body scroll while modal is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className={cn(SCRIM, 'z-50 flex items-end sm:items-center justify-center')}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!isDeleting) onCancel();
      }}
    >
      <div
        className={cn(BOTTOM_SHEET, 'w-full sm:max-w-md')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-base font-semibold">
            {isAlbum ? 'Delete album?' : 'Delete playlist?'}
          </h2>
          <p className="text-sm text-neutral-400 mt-2 break-words">
            <span className="text-neutral-200">{playlistName}</span> will
            be removed from your library.
          </p>
          <p className="text-xs text-neutral-500 mt-3">
            Songs in the {isAlbum ? 'album' : 'playlist'} stay in your library
            and on disk — only this collection goes away.
          </p>
          {error && (
            <div className={cn(CALLOUT_ERROR, 'mt-3 text-xs break-words')}>
              {error}
            </div>
          )}
        </div>
        <div className="px-5 pb-5 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className={cn(BTN_GHOST, 'disabled:opacity-50')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className={cn(BTN_DANGER, 'disabled:opacity-60')}
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameModal({
  currentName,
  currentDescription,
  source,
  isSaving,
  error,
  onSubmit,
  onCancel,
}: {
  currentName: string;
  currentDescription: string;
  source: string;
  isSaving: boolean;
  error: string | null;
  onSubmit: (name: string, description: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  // A saved album (source 'album') is really an album — label it as such.
  // Albums keep the name-only flow (no editable description, matching desktop).
  const isAlbum = source === 'album';
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, isSaving]);
  // Lock body scroll while modal is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  // Autofocus + select the current name so a quick retype overwrites it.
  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(id);
  }, []);

  const trimmed = name.trim();
  const nameChanged = trimmed !== currentName.trim();
  const descChanged = description.trim() !== currentDescription.trim();
  const canSave =
    !isSaving && trimmed.length > 0 && (nameChanged || descChanged);
  const submit = () => {
    if (canSave) onSubmit(trimmed, description);
  };

  return (
    <div
      className={cn(SCRIM, 'z-50 flex items-end sm:items-center justify-center')}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!isSaving) onCancel();
      }}
    >
      <div
        className={cn(BOTTOM_SHEET, 'w-full sm:max-w-md')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="px-5 pt-5 pb-5"
        >
          <h2 className="text-base font-semibold mb-3">
            {isAlbum ? 'Rename album' : 'Edit details'}
          </h2>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder={isAlbum ? 'Album name' : 'Playlist name'}
            className={cn(INPUT, 'w-full text-base')}
            disabled={isSaving}
            autoCapitalize="words"
            autoCorrect="off"
            enterKeyHint="done"
          />
          {!isAlbum && (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              rows={3}
              placeholder="Add an optional description"
              className={cn(INPUT, 'mt-3 w-full resize-none text-sm')}
              disabled={isSaving}
            />
          )}
          {error && (
            <div className={cn(CALLOUT_ERROR, 'mt-3 text-xs break-words')}>
              {error}
            </div>
          )}
          <div className="mt-4 flex gap-2 justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSaving}
              className={cn(BTN_GHOST, 'active:bg-white/5 disabled:opacity-50')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className={BTN_PRIMARY}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CacheBadge({ cached }: { cached: boolean }) {
  return (
    <span
      className={`shrink-0 ${cached ? 'text-neutral-400' : 'text-neutral-700'}`}
      title={cached ? 'Cached for offline' : 'Streams from server'}
    >
      {cached ? (
        // Download / cached glyph
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 4v11" />
          <path d="M7 11l5 5 5-5" />
          <path d="M5 20h14" />
        </svg>
      ) : (
        // Not-cached / streams glyph
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="7" />
        </svg>
      )}
    </span>
  );
}

function OfflineToggle({
  offlineMode,
  progress,
  cachedInPlaylist,
  total,
  isAlbum,
  onEnable,
  onDisable,
}: {
  offlineMode: boolean;
  progress: OfflineProgress;
  cachedInPlaylist: number;
  total: number;
  isAlbum: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  // Caching pulls each track's /stream from the hub, so "Make offline" needs a
  // reachable desktop. Removing from cache is local (evict) — never gated.
  const hubUp = useHubReachable();
  const busy = progress.state === 'caching' || progress.state === 'evicting';
  // Icon circle (Apple/Spotify-style) — the "Caching n/m…" detail lives in the
  // OfflineProgressBanner below the hero, so the control itself stays compact.
  if (offlineMode && cachedInPlaylist > 0) {
    return (
      <button
        type="button"
        onClick={onDisable}
        disabled={busy}
        aria-label="Remove from offline"
        title={`Remove this ${isAlbum ? 'album' : 'playlist'} from offline cache`}
        className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-[#37C871] active:opacity-60 disabled:opacity-50"
      >
        {busy ? (
          // Spin through BOTH busy states: partway through a caching run this
          // branch takes over (offlineMode flips true early), and a green
          // "done" check mid-run would lie.
          <SpinnerGlyph />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onEnable}
      disabled={busy || total === 0 || !hubUp}
      aria-label="Make offline"
      title={
        hubUp
          ? `Cache this ${isAlbum ? 'album' : 'playlist'} for offline playback`
          : 'Needs your computer'
      }
      className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40"
    >
      {busy ? (
        // `busy` (not just 'caching'): eviction flips offlineMode false before
        // its loop runs, so THIS branch renders during evicting — the spinner
        // must cover it or removal shows a contradictory idle down-arrow.
        <SpinnerGlyph />
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 4v11" />
          <path d="M7 11l5 5 5-5" />
          <path d="M5 20h14" />
        </svg>
      )}
    </button>
  );
}

/** Small spinning arc for the offline toggle's busy states. */
function SpinnerGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
    </svg>
  );
}

function OfflineProgressBanner({ progress }: { progress: OfflineProgress }) {
  if (progress.state === 'idle' || progress.state === 'evicting') return null;
  if (progress.state === 'done') {
    const noun = progress.cached === 1 ? 'song' : 'songs';
    const palette =
      progress.failed > 0
        ? 'rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-amber-200'
        : cn(CALLOUT_INFO);
    return (
      <div className={cn(palette, 'mx-4 mb-3 text-xs')}>
        Cached {progress.cached} {noun} ({formatBytes(progress.bytes)}) for offline.
        {progress.failed > 0 ? ` ${progress.failed} failed.` : ''}
        {progress.lastError ? (
          <div className="text-[11px] text-neutral-400 mt-0.5 break-words">
            {progress.lastError}
          </div>
        ) : null}
      </div>
    );
  }
  // state === 'caching'
  const pct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="mx-4 mb-3">
      <div className="text-xs text-neutral-400 mb-1 flex justify-between">
        <span>
          Caching · {progress.done} / {progress.total} · {formatBytes(progress.bytes)}
        </span>
        {progress.failed > 0 ? (
          <span className="text-amber-300">{progress.failed} failed</span>
        ) : null}
      </div>
      <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
        <div
          className="h-full bg-white/85 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.lastError ? (
        <div className="text-[11px] text-amber-300 mt-1 break-words">
          {progress.lastError}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
