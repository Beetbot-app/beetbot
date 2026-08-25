import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CandidatesModal } from '@/components/CandidatesModal';
import { TrackRow } from '@/components/TrackRow';
import { formatTotalDuration } from '@/lib/format';
import { canStream, currentTrack, usePlayerStore } from '@/lib/store';
import { isPinned, usePinStore, type Pin } from '@/lib/pins';
import { useProfileStore } from '@/lib/profile';
import { useSession } from '@/lib/session';
import { useNavStore } from '@/lib/nav';
import { useScrollMemory } from '@shared/useScrollMemory';
import { useLibraryChangeTick } from '@shared/useLibraryChange';
import {
  ipc,
  type PlaylistDetail,
  type PlaylistTrack,
} from '@/lib/tauri';
import { useCanDownload } from '@/lib/capabilities';
import { useDownloadsStore } from '@/lib/downloads';
import {
  friendlyError,
  markPlaylistPlayed,
  patchTrackPlaylists,
  resolveTrackPreview,
  setTrackLiked,
  type SearchAlbumResult,
  type SearchTrackResult,
} from '@shared/api';
import {
  cn,
  BTN_DANGER,
  CALLOUT_ERROR,
  EYEBROW_ON_ART,
  SCRIM,
  SHEET,
} from '@shared/ui';
import { HeroWash } from '@shared/components/HeroWash';
import {
  ContextMenu,
  MenuGlyphs,
  type MenuItem,
  type MenuState,
} from '@shared/components/ContextMenu';
import {
  AlbumDetailModal,
  usePreviewPlayer,
  type SidebarPinController,
} from '@shared/components/SearchScreen';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { buildSearchTrackResult } from '@shared/trackAdapter';
import { notifyLibraryChanged } from '@shared/libraryChanged';
import {
  CondensedHeaderBar,
  useCondensedHeader,
} from '@shared/components/StickyHeader';

interface Props {
  playlistId: number;
  onBack: () => void;
  /** Called after an in-place edit (rename) so the parent can refresh the
   *  sidebar/library lists that also hold this playlist's name. */
  onChanged?: () => void;
}

const ROW_HEIGHT = 56;

/** Map a saved library track into the catalog search-result shape that the
 *  shared modals (add-to-playlist, album page) and `patchTrackPlaylists`
 *  consume. The library id is the source of truth (`local_track_id`). */
function playlistTrackToSearch(
  t: PlaylistTrack,
  playlistId: number,
  opts?: { albumContext?: boolean },
): SearchTrackResult {
  return buildSearchTrackResult({
    source: 'library',
    id: t.id,
    title: t.title,
    artists: t.artists,
    album: t.album,
    album_art_url: t.album_art_url,
    duration_ms: t.duration_ms,
    isrc: t.isrc,
    // A saved album is NOT a playlist: on the album page we DON'T mark its
    // tracks as "in a playlist" (no per-song ✓ — the album-level save indicator
    // at the top already says it's saved). In a real playlist, the membership is
    // genuine, so we keep it (pre-checks this playlist in the add picker).
    in_playlist_ids: opts?.albumContext ? [] : [playlistId],
    has_audio: t.local_path != null || t.status === 'downloaded',
  });
}

export function PlaylistPage({ playlistId, onBack, onChanged }: Props) {
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [candidatesTrack, setCandidatesTrack] = useState<PlaylistTrack | null>(null);
  // Delete-confirmation modal state. `null` = no modal; `'pending'` =
  // confirm dialog open; `'deleting'` = IPC call in flight.
  const [deleteState, setDeleteState] = useState<
    null | 'pending' | 'deleting'
  >(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameState, setRenameState] = useState<null | 'pending' | 'saving'>(
    null,
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  // Remember scroll per playlist so Back (e.g. from a track's album) lands
  // where you were. Merged onto parentRef — the same element the virtualizer
  // scrolls — so both share one node.
  const rememberScroll = useScrollMemory(`playlist:${playlistId}`);
  const setScrollEl = useCallback(
    (node: HTMLDivElement | null) => {
      parentRef.current = node;
      rememberScroll(node);
    },
    [rememberScroll],
  );
  // Spotify-style condensed header: the whole page scrolls in one container
  // (parentRef); a sentinel under the hero title flips `condensed` true as the
  // title scrolls past the top bar. The virtualized list sits below the hero,
  // so the virtualizer needs `scrollMargin` = the list's offset from the top.
  const [condensed, heroSentinelRef] = useCondensedHeader();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const setPlayerQueue = usePlayerStore((s) => s.setQueue);
  const nowPlaying = usePlayerStore(currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const pins = usePinStore((s) => s.pins);
  const togglePin = usePinStore((s) => s.toggle);
  const openAlbum = useNavStore((s) => s.openAlbum);
  const openArtist = useNavStore((s) => s.openArtist);
  const appendToQueue = usePlayerStore((s) => s.appendToQueue);
  // Pins are identified by id, so the membership check needs only playlistId.
  const pinned = isPinned(pins, {
    kind: 'playlist',
    id: playlistId,
    name: '',
    art: null,
  });
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  // Album pages reuse the shared AlbumDetailModal, which wants a pin controller
  // and a per-track add-to-playlist picker — build them once here.
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
  const [pickerTrack, setPickerTrack] = useState<SearchTrackResult | null>(null);
  // Per-song "⋯" overflow menu (Spotify-style); null = closed.
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Download affordances (full build only — false on the open-core/OSS build).
  const canDownload = useCanDownload();
  const startDownload = useDownloadsStore((s) => s.download);
  const removeDownload = useDownloadsStore((s) => s.remove);
  const downloadWholePlaylist = useDownloadsStore((s) => s.downloadPlaylist);

  // 30s preview auditioning for not-yet-downloaded tracks needs a session token
  // to hit the catalog search. Shared token, fetched once per app launch.
  const { token: sessionToken } = useSession();
  const {
    playingUrl: previewUrl,
    toggle: togglePreview,
    stop: stopPreview,
  } = usePreviewPlayer();
  const [previewTrackId, setPreviewTrackId] = useState<number | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<number | null>(null);
  // When a clip ends (or is stopped), the hook clears its URL — drop the
  // "which track" marker too so no row is left showing a stale preview state.
  useEffect(() => {
    if (previewUrl === null) setPreviewTrackId(null);
  }, [previewUrl]);

  const handlePreview = useCallback(
    async (track: PlaylistTrack) => {
      // Tapping the track that's already previewing stops it.
      if (previewTrackId === track.id && previewUrl) {
        stopPreview();
        return;
      }
      if (!sessionToken) return;
      setPreviewLoadingId(track.id);
      try {
        const url = await resolveTrackPreview(
          { title: track.title, artists: track.artists, isrc: track.isrc },
          sessionToken,
        );
        if (url) {
          setPreviewTrackId(track.id);
          togglePreview(url);
        }
      } finally {
        setPreviewLoadingId(null);
      }
    },
    [previewTrackId, previewUrl, stopPreview, sessionToken, togglePreview],
  );

  const handlePlayTrack = useCallback(
    (track: PlaylistTrack) => {
      const idx = tracks.findIndex((t) => t.id === track.id);
      setPlayerQueue(tracks, idx === -1 ? 0 : idx);
    },
    [tracks, setPlayerQueue],
  );

  // A track is playable only if it has a local file. TrackRow only invokes this
  // for such tracks; the row-click is otherwise inert (no file → not playable).
  const handleRowClick = useCallback(
    (track: PlaylistTrack) => {
      if (canStream(track)) handlePlayTrack(track);
    },
    [handlePlayTrack],
  );

  // Is the current playback coming from this playlist? (the playing track is
  // one of ours). Drives the header Play/Pause button so it mirrors the
  // now-playing bar — ⏸ when this playlist is playing, ▶ otherwise.
  const playlistIsActive =
    nowPlaying != null && tracks.some((t) => t.id === nowPlaying.id);
  const playlistPlaying = isPlaying && playlistIsActive;
  // Resume/pause when this playlist is the active context; otherwise start it.
  const handleHeaderPlayToggle = useCallback(() => {
    if (nowPlaying != null && tracks.some((t) => t.id === nowPlaying.id)) {
      usePlayerStore.getState().playPause();
    } else {
      setPlayerQueue(tracks, 0);
    }
  }, [nowPlaying, tracks, setPlayerQueue]);

  // Shuffle: turn shuffle on (if off) and start from a random playable track
  // (one with a local file).
  const handleShuffle = useCallback(() => {
    if (!usePlayerStore.getState().shuffle) toggleShuffle();
    const playableIdx = tracks
      .map((t, i) => (canStream(t) ? i : -1))
      .filter((i) => i >= 0);
    const start = playableIdx.length
      ? playableIdx[Math.floor(Math.random() * playableIdx.length)]
      : 0;
    setPlayerQueue(tracks, start);
  }, [toggleShuffle, tracks, setPlayerQueue]);

  const playable = tracks.some(canStream);

  const loadTracks = useCallback(async () => {
    const [d, t] = await Promise.all([
      ipc.getPlaylist(playlistId),
      ipc.listTracks(playlistId),
    ]);
    setDetail(d);
    setTracks(t);
  }, [playlistId]);

  // Mark the playlist as opened-just-now so the Library grid can
  // sort by recency. Spotify-style — opening counts as a "play",
  // which is what users expect from "Recently played" ordering.
  useEffect(() => {
    markPlaylistPlayed(playlistId);
  }, [playlistId]);

  // Re-run when the library changes elsewhere (a track added to THIS playlist
  // from the floating search/album overlay, or the star toggling Liked Songs
  // while this Favorites page is open) — the overlay sits over this still-mounted
  // page, so without this the new/removed row wouldn't show until nav away/back.
  const libTick = useLibraryChangeTick();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadTracks();
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTracks, libTick]);


  const handleConfirmDelete = useCallback(async () => {
    setDeleteState('deleting');
    setDeleteError(null);
    try {
      await ipc.deletePlaylist(playlistId);
      // Announce it so the persistent sidebar drops the row (it doesn't remount
      // on the back-navigation the way the LibraryPage grid does, so without
      // this the just-deleted playlist lingers in the sidebar).
      notifyLibraryChanged();
      // Pop back to the library; the LibraryPage refetches on mount so
      // the deleted playlist disappears from the grid.
      onBack();
    } catch (e) {
      setDeleteError(friendlyError(e));
      setDeleteState('pending');
    }
  }, [playlistId, onBack]);

  const handleConfirmRename = useCallback(
    async (name: string, description: string) => {
      setRenameState('saving');
      setRenameError(null);
      try {
        const ok = await ipc.renamePlaylist(playlistId, name, description);
        // false = no row matched (e.g. the playlist was deleted out from under
        // us). Match the phone/HTTP behavior, which surfaces an error.
        if (!ok) throw new Error('Playlist no longer exists');
        // Reflect immediately in the header, then nudge the parent so the
        // sidebar list refetches with the new name.
        setDetail((prev) =>
          prev ? { ...prev, name, description: description.trim() || null } : prev,
        );
        onChanged?.();
        setRenameState(null);
      } catch (e) {
        setRenameError(friendlyError(e));
        setRenameState('pending');
      }
    },
    [playlistId, onChanged],
  );

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
  });

  // Measure how far the virtualized list sits below the top of the scroll
  // container (hero + column header) so the virtualizer positions rows right.
  // Re-measure when the header content (detail) or row count changes.
  useLayoutEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [detail, tracks.length]);

  // Remove a song from this playlist (or unlike it, for Liked Songs), then
  // refetch so the row disappears and the count updates.
  const removeFromPlaylist = async (track: PlaylistTrack) => {
    if (!sessionToken) return;
    try {
      if (detail?.source === 'liked') {
        await setTrackLiked(sessionToken, track.id, false, activeProfileId);
      } else {
        await patchTrackPlaylists(
          playlistTrackToSearch(track, playlistId),
          [],
          [playlistId],
          sessionToken,
        );
      }
      await loadTracks();
      onChanged?.();
      // Let the rest of the app react: the sidebar refetches its playlist
      // list/counts, and the player-bar / Now Playing star re-derives its
      // liked state — so removing the current track from Favorites clears its
      // star live instead of leaving a stale filled star.
      notifyLibraryChanged();
    } catch (e) {
      console.warn('[beetbot] remove from playlist failed', e);
    }
  };

  // Build + open the per-song "⋯" menu (Spotify-style). Items that don't map
  // to this app (taste profile, sleep timer, song radio, credits, share) are
  // dropped; the rest reuse existing handlers.
  const showTrackMenu = (track: PlaylistTrack, x: number, y: number) => {
    const artist = track.artists[0]?.trim() ?? '';
    const pid = activeProfileId; // captured for the download actions' closures
    const items: MenuItem[] = [
      {
        label: 'Add to playlist',
        icon: MenuGlyphs.addToPlaylist,
        onClick: () => setPickerTrack(playlistTrackToSearch(track, playlistId)),
      },
      {
        label: 'Add to queue',
        icon: MenuGlyphs.queue,
        disabled: !canStream(track),
        onClick: () => {
          appendToQueue([track]);
        },
      },
      // Download / Remove download — full build only, one or the other by state.
      ...(canDownload && pid != null && !(track.local_path != null || track.status === 'downloaded')
        ? [
            {
              label: 'Download',
              icon: MenuGlyphs.download,
              onClick: () => {
                void startDownload(track.id, pid);
              },
            },
          ]
        : []),
      ...(canDownload && pid != null && (track.local_path != null || track.status === 'downloaded')
        ? [
            {
              label: 'Remove download',
              icon: MenuGlyphs.download,
              onClick: () => {
                void removeDownload(track.id, pid);
              },
            },
          ]
        : []),
      ...(track.local_path
        ? [
            {
              label: 'Show in Finder',
              icon: MenuGlyphs.folder,
              onClick: () => {
                void ipc.revealInFinder(track.local_path!).catch(() => {});
              },
            },
          ]
        : []),
      {
        label:
          detail?.source === 'liked'
            ? 'Remove from Favorites'
            : 'Remove from this playlist',
        icon: MenuGlyphs.trash,
        separator: true,
        danger: true,
        onClick: () => {
          void removeFromPlaylist(track);
        },
      },
      {
        label: 'Go to artist',
        icon: MenuGlyphs.artist,
        disabled: !artist,
        onClick: () => openArtist(artist),
      },
      {
        label: 'Go to album',
        icon: MenuGlyphs.album,
        disabled: !track.album,
        onClick: () => openAlbum(track.album ?? '', artist || null),
      },
    ];
    setMenu({ x, y, items });
  };

  if (error) {
    return (
      <div className="h-full p-8">
        <div className={CALLOUT_ERROR}>
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="h-full p-8 text-neutral-500 text-sm">Loading playlist…</div>
    );
  }

  // Saved albums render the SAME component as the browse/artist album page —
  // one album page, not two. Map the library tracks into the search-result
  // shape that page consumes, and hand the saved tracklist over as presets.
  if (detail.source === 'album') {
    const albumArtist = detail.owner ?? tracks[0]?.artists[0] ?? null;
    const syntheticAlbum: SearchAlbumResult = {
      source: 'library',
      source_id: String(playlistId),
      name: detail.name,
      artists: albumArtist ? [albumArtist] : [],
      cover_url: detail.cover_url,
      album_type: 'album',
      release_date: null,
      total_tracks: detail.track_count,
    };
    const presetTracks: SearchTrackResult[] = tracks.map((t) =>
      playlistTrackToSearch(t, playlistId, { albumContext: true }),
    );
    const byTrackId = new Map(tracks.map((t) => [t.id, t]));
    // AlbumDetailModal plays via search-result rows; map them back to the
    // library tracks so the player queues real files (preserves shuffle order).
    const playFromAlbum = (
      t: SearchTrackResult,
      list?: SearchTrackResult[],
      index?: number,
    ) => {
      const src = list ?? [t];
      const queue = src
        .map((sr) =>
          sr.local_track_id != null ? byTrackId.get(sr.local_track_id) : undefined,
        )
        .filter((x): x is PlaylistTrack => x != null);
      if (queue.length) setPlayerQueue(queue, index ?? 0);
    };
    // Per-song "⋯" menu for album rows. Albums are canonical, so no "remove
    // from playlist"/"go to album"; otherwise it mirrors the playlist menu.
    const showAlbumTrackMenu = (t: SearchTrackResult, x: number, y: number) => {
      const artist = t.artists[0]?.trim() ?? '';
      const items: MenuItem[] = [
        {
          label: 'Add to playlist',
          icon: MenuGlyphs.addToPlaylist,
          onClick: () => setPickerTrack(t),
        },
        {
          label: 'Add to Favorites',
          icon: MenuGlyphs.star,
          disabled: t.local_track_id == null || !sessionToken,
          onClick: () => {
            if (t.local_track_id != null && sessionToken) {
              void setTrackLiked(sessionToken, t.local_track_id, true, activeProfileId);
            }
          },
        },
        {
          label: 'Add to queue',
          icon: MenuGlyphs.queue,
          onClick: () => {
            const pt =
              t.local_track_id != null ? byTrackId.get(t.local_track_id) : undefined;
            if (pt) appendToQueue([pt]);
          },
        },
        {
          label: 'Go to artist',
          icon: MenuGlyphs.artist,
          disabled: !artist,
          onClick: () => openArtist(artist),
        },
      ];
      setMenu({ x, y, items });
    };
    return (
      <div className="h-full overflow-y-auto overflow-x-hidden pb-6">
        <AlbumDetailModal
          inline
          token={sessionToken ?? ''}
          album={syntheticAlbum}
          presetTracks={presetTracks}
          savedPlaylistId={playlistId}
          // Un-saving an album is a light action (it removes the saved copy, not
          // your own content) → do it instantly, no confirm dialog. Deleting a
          // playlist you MADE still confirms (that's the trash button below).
          // The confirm modal stays as the error fallback (handleConfirmDelete
          // re-opens it if the delete fails).
          onRemoveFromLibrary={handleConfirmDelete}
          onClose={onBack}
          onPlay={playFromAlbum}
          // Now-playing awareness → Spotify-style row highlight + equalizer bars
          // on the current track, and a ⏸/▶ hero + sticky Play button, matching
          // the library playlist page. A row is current when its library id is
          // the now-playing track's id.
          isTrackCurrent={(t) =>
            nowPlaying != null &&
            t.local_track_id != null &&
            t.local_track_id === nowPlaying.id
          }
          isPlaying={isPlaying}
          onTogglePlay={() => usePlayerStore.getState().playPause()}
          onPickTrack={(t) => setPickerTrack(t)}
          onPickAlbum={(a) => openAlbum(a.name, a.artists[0] ?? null)}
          onShowTrackMenu={showAlbumTrackMenu}
          // Clickable artist names in track rows → that artist's page.
          onGoToArtist={(name) => openArtist(name)}
          onGoToAlbum={(name, artist) => openAlbum(name, artist)}
          playingPreviewUrl={previewUrl}
          onTogglePreview={togglePreview}
          activeProfileId={activeProfileId}
          pin={pinController}
        />
        {pickerTrack && (
          <AddToPlaylistModal
            token={sessionToken ?? ''}
            track={pickerTrack}
            activeProfileId={activeProfileId}
            onClose={() => setPickerTrack(null)}
          />
        )}
        {deleteState !== null && (
          <DeleteConfirmModal
            playlistName={detail.name}
            isAlbum
            isDeleting={deleteState === 'deleting'}
            error={deleteError}
            onConfirm={handleConfirmDelete}
            onCancel={() => {
              setDeleteState(null);
              setDeleteError(null);
            }}
          />
        )}
        {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      </div>
    );
  }

  return (
    <>
      <div
        ref={setScrollEl}
        className="relative h-full overflow-y-auto overflow-x-hidden"
      >
        {/* Condensed bar — small Play + name, pinned under the top bar once the
            hero scrolls away (Spotify-style). */}
        <CondensedHeaderBar
          condensed={condensed}
          title={detail.name}
          playing={playlistPlaying}
          onPlay={handleHeaderPlayToggle}
        />
        {/* overflow-hidden clips the scale-125 blurred wash so it can't push the
            page wider than the viewport (it sits inside the scroll container). */}
        <div className="relative overflow-hidden">
        {/* One shared ambient hero wash — the page's own art color, matching
            Home + the app window so navigation feels like one lit space. */}
        <HeroWash coverUrl={detail.cover_url} />
        {/* Card sits below the header now → normal top inset (was pt-20). */}
        <div className="relative px-8 pt-6 pb-4">
        <div className="flex gap-6 items-end">
          {/* Cover + title both open "Edit details" (Spotify-style), instead
              of an always-shown pencil. Albums never reach this render (handled
              by the album branch), so every playlist here is editable. */}
          <button
            type="button"
            onClick={() => {
              setRenameError(null);
              setRenameState('pending');
            }}
            title="Edit details"
            aria-label="Edit details"
            className="group/cover relative h-44 w-44 shrink-0 rounded-xl overflow-hidden bg-neutral-800 grid place-items-center shadow-lg"
          >
            {detail.cover_url ? (
              <img
                src={detail.cover_url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-5xl text-neutral-600">
                {detail.source === 'liked' ? '★' : '♪'}
              </span>
            )}
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 opacity-0 transition group-hover/cover:opacity-100">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              <span className="text-xs font-medium">Edit details</span>
            </span>
          </button>
          <div className="min-w-0">
            {/* Shared eyebrow recipe — album/artist/genre/phone all use it;
                this page had a hand-rolled variant that drifted. */}
            {/* Favorites carries no kind label — it is the star button's
                anchor, not a playlist among playlists (same rule as the
                phone's PlaylistScreen). */}
            {detail.source !== 'liked' && (
              <p className={cn(EYEBROW_ON_ART, 'mb-1')}>Playlist</p>
            )}
            <h1 className="mb-2">
              <button
                type="button"
                onClick={() => {
                  setRenameError(null);
                  setRenameState('pending');
                }}
                title="Edit details"
                className="text-left text-4xl font-bold tracking-tight hover:underline decoration-2 underline-offset-4"
              >
                {detail.name}
              </button>
            </h1>
            {/* Condensed-header trigger. */}
            <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
            {detail.description && (
              <p className="text-sm text-neutral-400 mb-2 line-clamp-2">
                {detail.description}
              </p>
            )}
            <p className="text-sm text-neutral-500">
              {detail.owner && <span>{detail.owner} · </span>}
              {detail.track_count} {detail.track_count === 1 ? 'song' : 'songs'}
              {detail.total_duration_ms > 0 &&
                ` · ${formatTotalDuration(detail.total_duration_ms)}`}
            </p>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={handleHeaderPlayToggle}
                disabled={!playable}
                aria-label={playlistPlaying ? 'Pause' : 'Play this playlist'}
                className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition hover:bg-white hover:scale-105 active:scale-95 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:hover:scale-100"
                title={
                  playable
                    ? playlistPlaying
                      ? 'Pause'
                      : 'Play this playlist'
                    : 'No songs with audio files yet'
                }
              >
                {playlistPlaying ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={handleShuffle}
                disabled={!playable}
                aria-label="Shuffle play"
                title={playable ? 'Shuffle play' : 'No songs with audio files yet'}
                className="grid h-10 w-10 place-items-center rounded-full text-neutral-300 hover:text-neutral-100 hover:bg-white/10 disabled:text-neutral-600 disabled:hover:bg-transparent transition"
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
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="m15 15 6 6" />
                  <path d="M4 4l5 5" />
                </svg>
              </button>
              {canDownload && (
                <button
                  type="button"
                  onClick={() => {
                    if (activeProfileId != null)
                      void downloadWholePlaylist(playlistId, activeProfileId);
                  }}
                  disabled={!playable || activeProfileId == null}
                  aria-label="Download all songs"
                  title={playable ? 'Download all songs' : 'No songs to download yet'}
                  className="grid h-10 w-10 place-items-center rounded-full text-neutral-300 hover:text-neutral-100 hover:bg-white/10 disabled:text-neutral-600 disabled:hover:bg-transparent transition"
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
                    <path d="M12 4v10M8 11l4 4 4-4" />
                    <path d="M5 19h14" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const pin: Pin = {
                    kind: 'playlist',
                    id: playlistId,
                    name: detail.name,
                    art: detail.cover_url,
                    source: detail.source,
                  };
                  togglePin(pin);
                }}
                title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                aria-label={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                aria-pressed={pinned}
                className={`grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10 ${
                  pinned ? 'text-white' : 'text-neutral-400 hover:text-neutral-100'
                }`}
              >
                {/* Pin icon — filled when pinned to the sidebar. */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill={pinned ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="12" y1="17" x2="12" y2="22" />
                  <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                </svg>
              </button>
              {/* Rename/edit lives on the cover + title click now (Spotify-
                  style), so no always-shown pencil here. */}
              {/* Favorites is the star button's one destination, not an
                  ordinary playlist — Spotify and Apple both refuse to delete
                  their equivalent. The server refuses it regardless
                  (`delete_playlist_row` guards the anchor), so without this the
                  button would sit here doing nothing. */}
              {detail.source !== 'liked' && (
              <button
                type="button"
                onClick={() => setDeleteState('pending')}
                title="Delete this playlist (songs stay in your library)"
                className="grid h-10 w-10 place-items-center rounded-full text-neutral-400 hover:text-red-400 hover:bg-white/10 transition"
                aria-label="Delete playlist"
              >
                {/* Inline trash icon for visual consistency with the
                    phone player. Stroke uses currentColor so the hover
                    state's red text colour applies. */}
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
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      <div className="border-t border-white/5">
        <div className="grid grid-cols-[2.5rem_3rem_1fr_1fr_5rem_5rem_2.5rem] gap-3 items-center px-4 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-white/5 sticky top-14 bg-neutral-950/60 backdrop-blur-xl z-20">
          {/* Center the "#" so it lines up with the centered row numbers. */}
          <span className="text-center">#</span>
          <span></span>
          <span>Title</span>
          <span>Album</span>
          <span>File</span>
          <span className="text-right">Time</span>
          <span></span>
        </div>
        {tracks.length === 0 ? (
          <div className="p-8 text-center text-neutral-500 text-sm">
            No songs in this playlist.
          </div>
        ) : (
          <div
            ref={listRef}
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const t = tracks[vi.index];
              return (
                <div
                  key={t.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vi.size,
                    transform: `translateY(${vi.start - scrollMargin}px)`,
                  }}
                >
                  <TrackRow
                    track={t}
                    index={vi.index}
                    isAlbum={false}
                    onAddAudio={setCandidatesTrack}
                    onPlay={handleRowClick}
                    onShowMenu={showTrackMenu}
                    onGoToArtist={(name) => openArtist(name)}
                    onGoToAlbum={(name, artist) => openAlbum(name, artist)}
                    isPlaying={nowPlaying?.id === t.id}
                    onPreview={handlePreview}
                    previewing={previewTrackId === t.id && previewUrl != null}
                    previewLoading={previewLoadingId === t.id}
                  />
                </div>
              );
            })}
          </div>
        )}
        </div>
      </div>
      {candidatesTrack && (
        <CandidatesModal
          track={candidatesTrack}
          onClose={() => setCandidatesTrack(null)}
          onResolved={loadTracks}
        />
      )}
      {deleteState !== null && detail && (
        <DeleteConfirmModal
          playlistName={detail.name}
          isDeleting={deleteState === 'deleting'}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setDeleteState(null);
            setDeleteError(null);
          }}
        />
      )}
      {renameState !== null && detail && (
        <EditDetailsModal
          currentName={detail.name}
          currentDescription={detail.description ?? ''}
          coverUrl={detail.cover_url}
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
      {pickerTrack && (
        <AddToPlaylistModal
          token={sessionToken ?? ''}
          track={pickerTrack}
          activeProfileId={activeProfileId}
          onClose={() => setPickerTrack(null)}
        />
      )}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </>
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
  isAlbum?: boolean;
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

  return (
    <div
      className={cn(SCRIM, 'z-50 flex items-center justify-center')}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!isDeleting) onCancel();
      }}
    >
      <div
        className={cn(SHEET, 'w-full max-w-md mx-4')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-base font-semibold">
            {isAlbum ? 'Remove from library?' : 'Delete playlist?'}
          </h2>
          <p className="text-sm text-neutral-400 mt-2 break-words">
            <span className="text-neutral-200">{playlistName}</span> will
            be removed from your library.
          </p>
          <p className="text-xs text-neutral-500 mt-3">
            {isAlbum
              ? 'The songs stay in your library and on disk — only the album goes away. You can add it again any time.'
              : 'Songs in the playlist stay in your library and on disk — only this collection goes away.'}
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
            className="px-4 py-2 rounded-lg text-sm text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className={cn(BTN_DANGER, 'disabled:opacity-60')}
          >
            {isDeleting
              ? isAlbum
                ? 'Removing…'
                : 'Deleting…'
              : isAlbum
                ? 'Remove'
                : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditDetailsModal({
  currentName,
  currentDescription,
  coverUrl,
  source,
  isSaving,
  error,
  onSubmit,
  onCancel,
}: {
  currentName: string;
  currentDescription: string;
  coverUrl: string | null;
  source: string;
  isSaving: boolean;
  error: string | null;
  onSubmit: (name: string, description: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, isSaving]);
  // Focus + select the current name so a quick retype overwrites it.
  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
    return () => window.clearTimeout(id);
  }, []);

  const trimmed = name.trim();
  const changed =
    trimmed !== currentName.trim() ||
    description.trim() !== currentDescription.trim();
  const canSave = !isSaving && trimmed.length > 0 && changed;

  return (
    <div
      className={cn(SCRIM, 'z-50 flex items-center justify-center')}
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!isSaving) onCancel();
      }}
    >
      <div
        className={cn(SHEET, 'w-full max-w-lg mx-4')}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) onSubmit(trimmed, description);
          }}
          className="p-6"
        >
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight">Edit details</h2>
            <button
              type="button"
              onClick={onCancel}
              disabled={isSaving}
              aria-label="Close"
              className="rounded-full p-1 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 disabled:opacity-50"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="flex gap-4">
            {/* Cover preview — read-only (covers are auto-generated mosaics). */}
            <div className="h-36 w-36 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
              {coverUrl ? (
                <img src={coverUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-4xl text-neutral-600">
                  {source === 'liked' ? '★' : '♪'}
                </span>
              )}
            </div>
            <div className="flex flex-1 min-w-0 flex-col gap-3">
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder="Name"
                className="w-full rounded-lg bg-neutral-800 border border-transparent px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-neutral-500"
                disabled={isSaving}
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={300}
                placeholder="Add an optional description"
                rows={4}
                className="w-full flex-1 resize-none rounded-lg bg-neutral-800 border border-transparent px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-neutral-500"
                disabled={isSaving}
              />
            </div>
          </div>
          {error && (
            <div className={cn(CALLOUT_ERROR, 'mt-3 text-xs break-words')}>
              {error}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-full bg-neutral-100 px-8 py-2.5 text-sm font-bold text-neutral-950 transition hover:bg-white hover:scale-[1.02] disabled:bg-neutral-700 disabled:text-neutral-400 disabled:hover:scale-100"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
