import { useEffect, useState, type ReactNode } from 'react';
import { cn, CALLOUT_ERROR, EYEBROW, EYEBROW_ON_ART } from '../../ui';
import { coverSrc, getAlbumTracks, getArtistAlbums, searchCatalog, importAlbum, deletePlaylist, friendlyError, canPlayNow, isPlayable, type SearchAlbumResult, type SearchTrackResult } from '../../api';
import { useHubReachable } from '../../useHubReachable';
import { useToast } from '../../useToast';
import { useLibraryChangeTick } from '../../useLibraryChange';
import { formatDuration } from '../../format';
import { CondensedHeaderBar, useCondensedHeader } from '../StickyHeader';
import { HeroWash } from '../HeroWash';
import { CollageCover } from '../CollageCover';
import { EqualizerBars } from '../EqualizerBars';
import { NowPlayingCover } from '../NowPlayingCover';
import { Toast } from '../Toast';
import { ModalShell } from './ModalShell';
import { AlbumGrid, playAlbumCard, PreviewRing, ExplicitBadge, AlbumDownloadedBadge, MaybeSwipe, albumTypeLabel, albumDurationLabel, formatReleaseDate, type SidebarPinController } from '../searchPrimitives';
import { notifyLibraryChanged } from '../../libraryChanged';

/**
 * Modal that loads a search-result album's tracks. Two add modes:
 *   - Per-track "+" → opens the playlist picker for that single track.
 *   - "Add album to library" button at the top → one tap creates a new
 *     local playlist named after the album and adds every track.
 */
export function AlbumDetailModal({
  token,
  album,
  onClose,
  onPickTrack,
  onPlay,
  onPickAlbum,
  playingPreviewUrl,
  onTogglePreview,
  inline,
  activeProfileId,
  pin,
  presetTracks,
  savedPlaylistId,
  onRemoveFromLibrary,
  onShowTrackMenu,
  onShowTrackSheet,
  onQueueTrack,
  onSaveTrack,
  kindLabel,
  importLabel,
  onImport,
  savedCopyId,
  disableFetch,
  onGoToArtist,
  onGoToAlbum,
  coverUrls,
  playlistStyle,
  hideImport,
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
}: {
  token: string;
  album: SearchAlbumResult;
  pin?: SidebarPinController;
  onClose: () => void;
  onPickTrack: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  /** Open another album from the "More by {artist}" shelf. */
  onPickAlbum?: (a: SearchAlbumResult) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** Desktop: render as a full page instead of a modal overlay. */
  inline?: boolean;
  /** Active profile the imported album should belong to. */
  activeProfileId?: number | null;
  /** Render an already-loaded tracklist instead of fetching from the catalog.
   *  Used when the library album page reuses this component for a saved album
   *  (so browse and library albums are the SAME page). */
  presetTracks?: SearchTrackResult[];
  /** Set when this is a saved library album: the +/✓ shows a clickable green
   *  ✓ that calls `onRemoveFromLibrary` (Spotify-style) instead of "add". */
  savedPlaylistId?: number;
  onRemoveFromLibrary?: () => void;
  /** Desktop: open the per-song "⋯" overflow menu at a screen point (also
   *  right-click). The host owns the menu; when absent, no ⋯ is shown. */
  onShowTrackMenu?: (t: SearchTrackResult, x: number, y: number) => void;
  /** Phone: open the per-song "⋯" bottom sheet (Favorite · Add · Go to artist),
   *  matching the library album/playlist page. The host (web-player) owns the
   *  sheet; when set, each row shows a touch-visible ⋯ and folds the per-track
   *  add control into it. Absent on desktop (uses `onShowTrackMenu` instead). */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /** Phone: swipe a track row → right adds it to the queue. Mirrors the library
   *  playlist page's swipe-to-queue. The host owns the enqueue (resolving the
   *  catalog row to a playable id first); swipe is only wired when this AND
   *  `onShowTrackSheet` are set, so desktop never swipes. */
  onQueueTrack?: (t: SearchTrackResult) => void;
  /** Phone: swipe a track row → left saves it to Favorites. Host-owned
   *  (resolves the catalog row, then likes). Pairs with `onQueueTrack`. */
  onSaveTrack?: (t: SearchTrackResult) => void;
  /** Override the hero's kind label (e.g. "Playlist"). Defaults to the album
   *  type ("Album"/"Single"/…). Lets the catalog-playlist wrapper reuse this
   *  same page while reading as a playlist. */
  kindLabel?: string;
  /** Override the add-to-library button's aria/title (e.g. "Add all to
   *  library"). Defaults to "Add album to library". */
  importLabel?: string;
  /** Replace the album-import action with a custom importer (the catalog
   *  playlist wrapper imports as a *playlist*). Its presence also switches the
   *  +/✓ to one-shot semantics: ✓ shows only after a successful import, not
   *  merely because every track already happens to be in the library (importing
   *  still creates a new named playlist). */
  onImport?: () => Promise<void>;
  /** Catalog-playlist mode only: the id of an EXISTING library playlist this
   *  catalog playlist already maps to (matched by name). When set, the +/✓
   *  control shows a static "In your library" ✓ instead of the "+" importer —
   *  so a playlist you've already added doesn't read as "not in library" or
   *  invite a duplicate import. Null/undefined ⇒ show the normal importer. */
  savedCopyId?: number | null;
  /** Never fetch the catalog tracklist — the host fully owns `presetTracks`
   *  (which may be momentarily undefined while it loads → shows "Loading…"). */
  disableFetch?: boolean;
  /** Make a track row's artist name(s) clickable → navigate to the artist page
   *  (by name; the host resolves it). When absent, artist names are plain text. */
  onGoToArtist?: (name: string) => void;
  /** Make a playlist row's Album name clickable → open that album. When absent,
   *  the album name is plain text. */
  onGoToAlbum?: (name: string, artist: string | null) => void;
  /** Render a 2×2 collage hero cover from these artworks instead of the single
   *  `album.cover_url` — used by the mix page, whose tracks span many albums. */
  coverUrls?: string[];
  /** Force the playlist-style tracklist (per-track cover + Album column) without
   *  wiring an importer — right for a multi-album mix. Folds into the same
   *  `isCatalogPlaylist` path as a catalog playlist. */
  playlistStyle?: boolean;
  /** Suppress the +/✓ add-to-library control entirely — a mix has no album
   *  identity to add or remove. */
  hideImport?: boolean;
  /** Now-playing awareness (Spotify-style), so the album/playlist page mirrors
   *  the library playlist page: the host tells us which row is the current
   *  playback track, whether audio is running, and how to toggle pause/resume.
   *  When `isTrackCurrent` is absent the page is play-state-agnostic (the old
   *  behavior) — every host that doesn't wire it in is unaffected. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  /** True when audio is actually running (vs. current-but-paused) — drives the
   *  bouncing equalizer bars and the ⏸/▶ state on the hero + sticky bar. */
  isPlaying?: boolean;
  /** Pause/resume the current playback context. Used by the hero + sticky Play
   *  button when this album/playlist IS the active context (else it starts it). */
  onTogglePlay?: () => void;
}) {
  // Re-render when hub reachability changes so canPlayNow gating stays live;
  // the flag also gates the hub-write "Add album to library" button below.
  const hubUp = useHubReachable();

  // Phone swipe feedback — a transient toast, mirroring the library playlist
  // page ("Added to queue" / "Added to Favorites" / "Not available yet"), so
  // a swipe on a catalog row confirms itself the same way a library row does.
  const { toast: swipeToast, showToast: showSwipeToast } = useToast();
  // Swipe is phone-only: `onShowTrackSheet` is the established phone signal
  // (desktop passes `onShowTrackMenu` instead), and both action handlers must
  // be wired. Gating on all three keeps desktop rows (and any host that opts
  // out) free of pointer-drag actions.
  const swipeEnabled = !!onShowTrackSheet && !!onQueueTrack && !!onSaveTrack;
  const [tracks, setTracks] = useState<SearchTrackResult[] | null>(
    presetTracks ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Spotify-style condensed header: a 1px sentinel under the hero title flips
  // `condensed` true as the title scrolls past the top bar.
  const [condensed, heroSentinelRef] = useCondensedHeader();
  // "More by {artist}" — the album's primary artist's other releases.
  const [moreBy, setMoreBy] = useState<SearchAlbumResult[] | null>(null);
  // 'idle' = button visible; 'importing' = spinner; 'done' = green
  // success state so the user sees what happened before the modal
  // auto-closes a moment later.
  const [importState, setImportState] = useState<'idle' | 'importing' | 'done'>(
    'idle',
  );

  // Re-fetch the tracklist when the library changes elsewhere (a track added to
  // or removed from a playlist via the ⋯ picker), so each row's "in a playlist"
  // ✓ reflects reality instead of the membership captured when the page opened —
  // otherwise removing a song from its last playlist leaves a stale ✓ until you
  // navigate away and back. `libTick` is in the fetch effect's deps below.
  const libTick = useLibraryChangeTick();

  useEffect(() => {
    // Host fully owns the tracklist (catalog-playlist wrapper): never fetch.
    // `presetTracks` may be momentarily undefined while it loads → null shows
    // the "Loading tracks…" state; the array swaps in when ready.
    if (disableFetch) {
      setTracks(presetTracks ?? null);
      return;
    }
    // Saved-album reuse: the host already handed us the tracklist — show it
    // and skip the catalog fetch entirely.
    if (presetTracks) {
      setTracks(presetTracks);
      return;
    }
    let cancelled = false;
    getAlbumTracks(album.source_id, token)
      .then((rows) => {
        if (cancelled) return;
        // Backfill album metadata onto each row so when the user adds one,
        // the track row gets the same cover art we showed on the album card.
        setTracks(
          rows.map((r) => ({
            ...r,
            album: album.name,
            album_art_url: album.cover_url,
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [album.source_id, album.name, album.cover_url, token, presetTracks, disableFetch, libTick]);

  // "More by {artist}" — resolve the primary artist by name (the album only
  // carries artist names, not ids), then fetch their other releases. Best-
  // effort: any failure just hides the shelf. Skipped if we can't open albums.
  useEffect(() => {
    if (!onPickAlbum) return;
    const artistName = album.artists[0]?.trim();
    if (!artistName) return;
    let cancelled = false;
    setMoreBy(null);
    (async () => {
      try {
        const res = await searchCatalog(artistName, token, 'artist', 5);
        // Prefer an exact name match over the raw top hit, so a common name
        // doesn't pull a tribute act's discography.
        const want = artistName.toLowerCase();
        const artist =
          res.artists.find((a) => a.name.trim().toLowerCase() === want) ??
          res.artists[0];
        if (!artist || cancelled) return;
        const albums = await getArtistAlbums(artist.source_id, token);
        if (cancelled) return;
        const others = albums
          .filter((a) => a.source_id !== album.source_id)
          .slice(0, 8);
        setMoreBy(others);
      } catch {
        /* best-effort; leave the shelf hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Depend on the primitive artist name (not the array reference, which a
    // re-deserialized album prop would change) to avoid spurious refetches.
  }, [album.artists[0], album.source_id, token, onPickAlbum]);

  // Escape to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleImport = async () => {
    if (!tracks || tracks.length === 0) return;
    setImportState('importing');
    setRemovedLocally(false);
    setError(null);
    try {
      // The catalog-playlist wrapper supplies its own importer (imports as a
      // playlist); everything else imports as an album.
      if (onImport) {
        await onImport();
      } else {
        const r = await importAlbum(
          album.name,
          tracks,
          token,
          album.artists.join(', ') || null,
          activeProfileId,
        );
        // Capture the new saved-album row so the ✓ can remove it IMMEDIATELY,
        // before a remount refetches the tracks' saved-album ids. (The catalog-
        // playlist wrapper does the equivalent via `savedCopyId`.)
        setImportedRowId(r.playlist_id);
      }
      setImportState('done');
      // Refresh the app's sidebar/playlist list (the new copy should appear).
      if (typeof window !== 'undefined')
        notifyLibraryChanged();
      // Stay on the page; the action shifts to a green ✓ "in your library" in
      // place, mirroring Spotify (no auto-close).
    } catch (e) {
      setError(friendlyError(e));
      setImportState('idle');
    }
  };

  const albumSongCount = tracks?.length ?? album.total_tracks ?? null;
  const albumTotalMs = tracks
    ? tracks.reduce((s, t) => s + t.duration_ms, 0)
    : 0;
  // Is this whole album already saved to the library? Answered by the tracks'
  // saved-album membership, NOT `local_track_id` — the latter is set merely by
  // playing/streaming a track, so an album you'd only *listened* to used to
  // read as "saved". The album is saved iff every track shares a common saved-
  // album playlist (their `in_saved_album_ids` intersect). Robust against a
  // stray track that happens to sit in some other saved album.
  // The saved-album playlist id every track shares (saved albums are stored as
  // source='album' playlists), or null. Exposed so the "in your library" ✓ can
  // toggle OFF by deleting that row — same mechanism as an imported playlist.
  const savedAlbumId =
    tracks && tracks.length > 0
      ? ([
          ...tracks
            .map((t) => new Set(t.in_saved_album_ids ?? []))
            .reduce((acc, ids) => new Set([...acc].filter((id) => ids.has(id)))),
        ][0] ?? null)
      : null;
  const albumSavedInLibrary = savedAlbumId != null;
  // A saved library album reusing this page — its +/✓ is a clickable green ✓
  // that removes (vs. a catalog album, whose ✓ is just an "added" indicator).
  const albumSaved = savedPlaylistId != null;
  // Optimistic removal: clicking the "in your library" ✓ deletes the backing
  // row (imported playlist OR saved album) and flips the control back to "+".
  const [removedLocally, setRemovedLocally] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The library row a plain-album import just created (see handleImport).
  const [importedRowId, setImportedRowId] = useState<number | null>(null);
  // The library row a case-2 ✓ can remove: the imported-playlist copy wins
  // (explicit), else the shared saved-album id. Null ⇒ nothing to toggle off
  // (e.g. a not-yet-saved catalog item), so the ✓ stays a static indicator.
  const catalogRemoveId = savedCopyId ?? importedRowId ?? savedAlbumId;
  const handleCatalogRemove = async () => {
    if (catalogRemoveId == null || removing) return;
    setRemoving(true);
    setError(null);
    try {
      await deletePlaylist(catalogRemoveId, token);
      // Flip the control back to "+" in place. A remount (navigate away/back)
      // re-derives library state from a fresh fetch, so this stays honest.
      setRemovedLocally(true);
      // Reset the import state so the "+" is enabled again — otherwise removing
      // a playlist imported THIS session leaves importState='done', which the
      // "+" button treats as "busy" (disabled/greyed) and you can't re-add it.
      setImportState('idle');
      setImportedRowId(null);
      // Tell the app the library changed so the sidebar/playlist list refreshes
      // — otherwise the removed playlist lingers there and the remove reads as a
      // no-op even though it worked.
      if (typeof window !== 'undefined')
        notifyLibraryChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setRemoving(false);
    }
  };
  // Case-2 ✓ is a clickable REMOVE toggle whenever we have a concrete library
  // row to delete (`catalogRemoveId`): either detected on load, or — after an
  // import this session — the id the importer just returned (the wrapper feeds
  // it back into `savedCopyId`). Not shown once already removed this session.
  const canRemoveFromLibrary =
    !removedLocally &&
    catalogRemoveId != null &&
    (savedCopyId != null || importedRowId != null || albumSavedInLibrary);
  // Drives the +/✓ library toggle: green ✓ once it's saved / the album is
  // already in the library (or we just imported it), + to add otherwise. In
  // playlist mode (`onImport`) "already present" does NOT count — importing
  // still creates a new named playlist — so ✓ only appears after a real import.
  const albumInLibrary =
    !removedLocally &&
    (albumSaved ||
      importState === 'done' ||
      // A catalog playlist we've already imported (matched by name) — so its
      // control reads "In your library" instead of offering a duplicate import.
      savedCopyId != null ||
      (!onImport && albumSavedInLibrary));
  // Now-playing awareness: is any track on this page the current playback? That
  // makes THIS album/playlist the active context, so the hero + sticky Play
  // button mirror the now-playing bar (⏸ while it's playing) and toggle instead
  // of restarting. Absent `isTrackCurrent` → agnostic (old always-play behavior).
  const contextActive =
    !!isTrackCurrent && !!tracks && tracks.some((t) => isTrackCurrent(t));
  const contextPlaying = contextActive && !!isPlaying;
  // The hero / sticky / phone-header Play action: resume-or-pause when this page
  // is the active context; otherwise start it from the top.
  const headerPlay = () => {
    if (contextActive && onTogglePlay) onTogglePlay();
    else if (tracks && tracks.length > 0) onPlay(tracks[0], tracks, 0);
  };

  // Shuffle the album: play a shuffled copy from the top.
  const playShuffled = () => {
    if (!tracks || tracks.length === 0) return;
    const arr = tracks.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    onPlay(arr[0], arr, 0);
  };

  // A catalog (Deezer) playlist reusing this page (the wrapper passes its own
  // importer), OR a multi-album mix (playlistStyle). Drives the Deezer-wordmark
  // cover badge + the playlist-style track grid (per-track cover + Album column),
  // so it reads like a real playlist rather than a single-artwork album.
  const isCatalogPlaylist = !!onImport || !!playlistStyle;

  // The "in a playlist" ✓ column now shows on desktop CATALOG PLAYLISTS too (not
  // just albums) — a dedicated column, like the album page, indicating a song is
  // in one of your OTHER playlists (see `renderAddToLibrary`). Phone folds it
  // into the ⋯ sheet (onShowTrackSheet), so it's desktop-only either way.
  const showInPlaylistColumn = !onShowTrackSheet;

  // Track-list grid. Albums: # · Title · File · [✓] · Time (+ a trailing ⋯ column
  // on desktop). Catalog playlists instead mirror the library playlist page
  // EXACTLY: # · cover · Title · Album · File · Time, with the add-to-library
  // +/✓ folded INTO the File column.
  const trackGrid = isCatalogPlaylist
    ? onShowTrackMenu
      // Desktop catalog playlist WITH ⋯ menu: # · cover · Title · Album · File · [✓] · Time · ⋯.
      // The 2rem ✓ slot mirrors the album page's "in a playlist" column.
      ? 'grid-cols-[2rem_2.25rem_1fr_2.5rem_2.75rem_2rem] sm:grid-cols-[2.5rem_3rem_minmax(0,1fr)_minmax(0,1fr)_5rem_2rem_5rem_2.5rem]'
      : onShowTrackSheet
        // Phone catalog (⋯ sheet): the ✓ folds into the sheet, so no ✓ column.
        ? 'grid-cols-[2rem_2.25rem_1fr_2.5rem_2.75rem] sm:grid-cols-[2.5rem_3rem_minmax(0,1fr)_minmax(0,1fr)_5rem_5rem]'
        // Desktop catalog WITHOUT a ⋯ menu (e.g. a Mix): still renders the ✓ cell
        // (showInPlaylistColumn), so the grid needs the 2rem slot — otherwise the
        // extra cell overflows and Time wraps to a second line.
        : 'grid-cols-[2rem_2.25rem_1fr_2.5rem_2.75rem] sm:grid-cols-[2.5rem_3rem_minmax(0,1fr)_minmax(0,1fr)_5rem_2rem_5rem]'
    : onShowTrackSheet
      ? 'grid-cols-[2rem_1fr_2.5rem_2.75rem] sm:grid-cols-[2.5rem_1fr_5rem_5rem]'
      : onShowTrackMenu
        ? 'grid-cols-[2rem_1fr_2.5rem_2rem_2.75rem_2rem] sm:grid-cols-[2.5rem_1fr_5rem_2.5rem_5rem_2.5rem]'
        : 'grid-cols-[2rem_1fr_2.5rem_2rem_2.75rem] sm:grid-cols-[2.5rem_1fr_5rem_2.5rem_5rem]';

  // Desktop full page (album OR catalog playlist): pad the tracklist to px-4 so
  // its columns line up with the library playlist page (PlaylistPage uses px-4).
  // The phone modal keeps the tighter px-1.
  // px-4 on both platforms so a catalog / mix / playlist row's content lines up
  // exactly with the library playlist rows (was px-1 on phone, which made the
  // songs sit 12px further left than the playlist page).
  const listPadX = 'px-4';
  // Desktop catalog-playlist page: also adopt the library playlist row metrics
  // (roomier h-14 rows, text-base title, text-sm artist/album/time) so it reads
  // as the same page. Albums and the phone modal keep their compact rows.
  const catalogInline = isCatalogPlaylist && inline;
  // Desktop full page adopts the roomier library-playlist row metrics on ALBUMS
  // too (bigger title/artist/time, taller rows) so the album page matches the
  // playlist page the user prefers. Phone (inline false) stays compact.
  const roomy = inline;

  // Artist name(s) for a track row. When the host wires `onGoToArtist`, each
  // name becomes a clickable link (hover-highlight → navigate to that artist's
  // page); `stopPropagation` so it doesn't also trigger the row's play/preview.
  // A plain string otherwise (phone / no nav host).
  const renderArtists = (names: string[]): ReactNode => {
    if (!onGoToArtist) return names.join(', ');
    return names.map((name, idx) => (
      <span key={idx}>
        {idx > 0 ? ', ' : ''}
        <span
          role="link"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const n = name.trim();
            if (n) onGoToArtist(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              const n = name.trim();
              if (n) onGoToArtist(n);
            }
          }}
          className="cursor-pointer hover:text-neutral-100 hover:underline"
        >
          {name}
        </span>
      </span>
    ));
  };

  // Add-to-library control (the +/✓). Catalog playlists fold this into the File
  // column; albums keep it as a separate Add column. Identical button either way.
  // Spotify-style "in a playlist" indicator: a small white ✓ shown ONLY for a
  // track that's already in ≥1 playlist — click it to manage (opens the add-to-
  // playlist picker, pre-checked). Blank otherwise; the "add" action lives in
  // the ⋯ menu, so there's no hover-revealed + cluttering every row.
  //
  // On a catalog PLAYLIST page, membership in THIS playlist's own imported copy
  // (`savedCopyId`) doesn't count — otherwise every row would show ✓ trivially.
  // So the ✓ means "also in one of your OTHER playlists". For albums savedCopyId
  // is undefined, so the filter is a no-op and it stays "in ≥1 playlist".
  const renderAddToLibrary = (t: SearchTrackResult) => {
    const otherIds = t.in_playlist_ids.filter((id) => id !== savedCopyId);
    return otherIds.length === 0 ? null : (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onPickTrack(t);
      }}
      aria-label="Manage playlists for this track"
      title={`In ${otherIds.length} ${
        otherIds.length === 1 ? 'playlist' : 'playlists'
      } — click to manage`}
      className="grid h-6 w-6 place-items-center rounded-full bg-white text-neutral-950 hover:bg-neutral-200 leading-none transition active:scale-95"
    >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m5 12 5 5 9-11" />
        </svg>
    </button>
    );
  };

  return (
    <>
    <ModalShell
      title={album.name}
      subtitle={album.artists.join(', ')}
      onClose={onClose}
      inline={inline}
      wide
      // Desktop uses the inline CondensedHeaderBar; the phone uses ModalShell's
      // own unified bar (condensed + onHeaderPlay), so both platforms condense
      // but the phone matches the library playlist page.
      condensed={condensed}
      onHeaderPlay={headerPlay}
      headerPlaying={contextPlaying}
      stickyBar={
        <CondensedHeaderBar
          condensed={condensed}
          title={album.name}
          playing={contextPlaying}
          onPlay={headerPlay}
        />
      }
      hero={
        inline ? (
        // DESKTOP: the library-album header — side-by-side cover + text column,
        // "Album" label, title, "Artist · N songs · duration", and the
        // Play · Shuffle · Pin · +/✓ action row. (Phone uses the centered
        // Apple/Spotify hero in the else branch, matching the library playlist.)
        <div className="relative overflow-hidden">
          <HeroWash coverUrl={coverUrls?.[0] ?? coverSrc(album.cover_url)} />
          {/* Card sits below the header now → normal top inset (was pt-20 to
              clear the old overlapping header). */}
          <div className="relative px-8 pt-6 pb-4">
            <div className="flex gap-6 items-end">
              <div className="relative h-44 w-44 shrink-0 rounded-xl overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
                {coverUrls && coverUrls.length >= 2 ? (
                  <CollageCover urls={coverUrls} className="h-full w-full" />
                ) : album.cover_url ? (
                  <img
                    src={coverSrc(album.cover_url)}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span className="text-5xl text-neutral-600">♪</span>
                )}
              </div>
              <div className="min-w-0">
                <p className={cn(EYEBROW_ON_ART, 'mb-1')}>
                  {kindLabel ?? (albumTypeLabel(album.album_type) || 'Album')}
                </p>
                <h1 className="text-4xl font-bold tracking-tight mb-2">
                  {album.name}
                </h1>
                {/* Condensed-header trigger: once this scrolls under the top
                    bar, the compact sticky bar fades in. */}
                <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
                <p className="text-sm text-neutral-500">
                  {album.artists.length > 0 && (
                    <span>
                      {/* Album artist → their page (hover-highlight). For a
                          catalog playlist the "artist" is the creator, not a
                          real artist, so it stays plain text. */}
                      {isCatalogPlaylist
                        ? album.artists.join(', ')
                        : renderArtists(album.artists)}{' '}
                      ·{' '}
                    </span>
                  )}
                  {albumSongCount != null
                    ? `${albumSongCount} ${albumSongCount === 1 ? 'song' : 'songs'}`
                    : ''}
                  {tracks && tracks.length > 0
                    ? ` · ${albumDurationLabel(albumTotalMs)}`
                    : ''}
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={headerPlay}
                    disabled={!tracks || tracks.length === 0}
                    aria-label={contextPlaying ? 'Pause' : 'Play album'}
                    className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition hover:bg-white hover:scale-105 active:scale-95 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:hover:scale-100"
                    title={contextPlaying ? 'Pause' : 'Play album'}
                  >
                    {contextPlaying ? (
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
                    onClick={playShuffled}
                    disabled={!tracks || tracks.length === 0}
                    aria-label="Shuffle play"
                    title="Shuffle play"
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
                  {pin ? (
                    <button
                      type="button"
                      onClick={() =>
                        pin.toggleAlbum({
                          album: album.name,
                          artist: album.artists[0] ?? null,
                          art: album.cover_url ?? null,
                        })
                      }
                      title={
                        pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                          ? 'Unpin from sidebar'
                          : 'Pin to sidebar'
                      }
                      aria-label={
                        pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                          ? 'Unpin from sidebar'
                          : 'Pin to sidebar'
                      }
                      aria-pressed={pin.isAlbumPinned(
                        album.name,
                        album.artists[0] ?? null,
                      )}
                      className={`grid h-10 w-10 place-items-center rounded-full transition hover:bg-white/10 ${
                        pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                          ? 'text-white'
                          : 'text-neutral-400 hover:text-neutral-100'
                      }`}
                    >
                      {/* Pin icon — filled when pinned (matches the library
                          album page exactly). */}
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill={
                          pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                            ? 'currentColor'
                            : 'none'
                        }
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
                  ) : null}
                  {albumSaved ? (
                    <button
                      type="button"
                      onClick={onRemoveFromLibrary}
                      title="In your library — click to remove"
                      aria-label="Remove album from library"
                      className="group/rm grid place-items-center h-9 w-9 rounded-full bg-white hover:bg-neutral-200 text-neutral-950 transition"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        {/* ✓ normally; a − on hover to signal "click to remove" */}
                        <path className="group-hover/rm:hidden" d="M20 6 9 17l-5-5" />
                        <path className="hidden group-hover/rm:block" d="M5 12h14" />
                      </svg>
                    </button>
                  ) : albumInLibrary ? (
                    canRemoveFromLibrary ? (
                      <button
                        type="button"
                        onClick={handleCatalogRemove}
                        disabled={removing}
                        title="In your library — click to remove"
                        aria-label="Remove from library"
                        className="group/rm grid place-items-center h-9 w-9 rounded-full bg-white hover:bg-neutral-200 text-neutral-950 transition disabled:opacity-50"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          {/* ✓ normally; a − on hover to signal "click to remove" */}
                          <path className="group-hover/rm:hidden" d="M20 6 9 17l-5-5" />
                          <path className="hidden group-hover/rm:block" d="M5 12h14" />
                        </svg>
                      </button>
                    ) : (
                      <span
                        aria-label="In your library"
                        title="In your library"
                        className="grid place-items-center h-9 w-9 rounded-full bg-white text-neutral-950"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    )
                  ) : hideImport ? null : (
                    <button
                      type="button"
                      onClick={handleImport}
                      disabled={
                        !tracks ||
                        tracks.length === 0 ||
                        importState !== 'idle' ||
                        !hubUp
                      }
                      aria-label={importLabel ?? 'Add album to library'}
                      title={
                        hubUp
                          ? (importLabel ?? 'Add album to library')
                          : 'Needs your computer'
                      }
                      className="grid place-items-center h-9 w-9 rounded-full border-2 border-neutral-400 text-neutral-200 hover:border-white hover:text-white disabled:opacity-40 transition"
                    >
                      {importState === 'importing' ? (
                        <svg
                          className="animate-spin"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          aria-hidden
                        >
                          <path
                            d="M21 12a9 9 0 1 1-6.219-8.56"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : (
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          aria-hidden
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        ) : (
        // PHONE: Apple-Music/Spotify-style — large centered cover on the wash,
        // centered label/title/meta, actions as a centered row of frosted
        // circles (shuffle · play · pin? · add/import). Mirrors the library
        // playlist hero so library + catalog read as one system.
        <div className="relative overflow-hidden">
          <HeroWash coverUrl={coverUrls?.[0] ?? coverSrc(album.cover_url)} />
          <div className="relative px-4 pt-20 pb-5 flex flex-col items-center text-center">
            <div className="relative h-52 w-52 rounded-2xl overflow-hidden bg-neutral-800 shadow-2xl shadow-black/60 ring-1 ring-white/10 grid place-items-center">
              {coverUrls && coverUrls.length >= 2 ? (
                <CollageCover urls={coverUrls} className="h-full w-full" />
              ) : album.cover_url ? (
                <img src={coverSrc(album.cover_url)} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <span className="text-5xl text-neutral-600">♪</span>
              )}
            </div>
            <div className="mt-4 w-full min-w-0 flex flex-col items-center">
              <p className={cn(EYEBROW_ON_ART, 'mb-1')}>
                {kindLabel ?? (albumTypeLabel(album.album_type) || 'Album')}
              </p>
              <h1 className="text-2xl font-bold tracking-tight mb-1 min-w-0 max-w-full">
                <span className="block max-w-full truncate">{album.name}</span>
              </h1>
              <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
              <p className="mt-1 text-xs text-neutral-400">
                {album.artists.length > 0 && (
                  <span>
                    {isCatalogPlaylist
                      ? album.artists.join(', ')
                      : renderArtists(album.artists)}{' '}
                    ·{' '}
                  </span>
                )}
                {albumSongCount != null
                  ? `${albumSongCount} ${albumSongCount === 1 ? 'song' : 'songs'}`
                  : ''}
                {tracks && tracks.length > 0
                  ? ` · ${albumDurationLabel(albumTotalMs)}`
                  : ''}
              </p>
              <div className="mt-4 flex items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={playShuffled}
                  disabled={!tracks || tracks.length === 0}
                  aria-label="Shuffle play"
                  title="Shuffle play"
                  className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40 disabled:text-neutral-600"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M16 3h5v5" />
                    <path d="M4 20 21 3" />
                    <path d="M21 16v5h-5" />
                    <path d="m15 15 6 6" />
                    <path d="M4 4l5 5" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={headerPlay}
                  disabled={!tracks || tracks.length === 0}
                  aria-label={contextPlaying ? 'Pause' : 'Play album'}
                  className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500"
                >
                  {contextPlaying ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
                    </svg>
                  )}
                </button>
                {pin ? (
                  <button
                    type="button"
                    onClick={() =>
                      pin.toggleAlbum({
                        album: album.name,
                        artist: album.artists[0] ?? null,
                        art: album.cover_url ?? null,
                      })
                    }
                    aria-label={
                      pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                        ? 'Unpin from sidebar'
                        : 'Pin to sidebar'
                    }
                    aria-pressed={pin.isAlbumPinned(album.name, album.artists[0] ?? null)}
                    className={`grid h-10 w-10 place-items-center rounded-full bg-white/10 active:bg-white/20 ${
                      pin.isAlbumPinned(album.name, album.artists[0] ?? null)
                        ? 'text-white'
                        : 'text-neutral-300'
                    }`}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill={pin.isAlbumPinned(album.name, album.artists[0] ?? null) ? 'currentColor' : 'none'}
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
                ) : null}
                {albumSaved ? (
                  <button
                    type="button"
                    onClick={onRemoveFromLibrary}
                    aria-label="Remove album from library"
                    title="In your library — tap to remove"
                    className="grid h-10 w-10 place-items-center rounded-full bg-white text-neutral-950 active:opacity-80"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </button>
                ) : albumInLibrary ? (
                  canRemoveFromLibrary ? (
                    <button
                      type="button"
                      onClick={handleCatalogRemove}
                      disabled={removing}
                      aria-label="Remove from library"
                      title="In your library — tap to remove"
                      className="grid h-10 w-10 place-items-center rounded-full bg-white text-neutral-950 active:bg-neutral-200 disabled:opacity-50"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </button>
                  ) : (
                    <span
                      aria-label="In your library"
                      title="In your library"
                      className="grid h-10 w-10 place-items-center rounded-full bg-white text-neutral-950"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </span>
                  )
                ) : hideImport ? null : (
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={!tracks || tracks.length === 0 || importState !== 'idle' || !hubUp}
                    aria-label={importLabel ?? 'Add album to library'}
                    title={hubUp ? (importLabel ?? 'Add album to library') : 'Needs your computer'}
                    className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40"
                  >
                    {importState === 'importing' ? (
                      <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        )
      }
    >
      <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
        {error && (
          <div className={cn(CALLOUT_ERROR, 'text-xs')}>
            {error}
          </div>
        )}
        {!tracks && !error && (
          <div className={`text-sm text-neutral-500 ${listPadX}`}>Loading tracks…</div>
        )}
        {tracks && tracks.length === 0 && (
          <div className={`text-sm text-neutral-500 ${listPadX}`}>
            {isCatalogPlaylist ? 'No songs in this playlist.' : 'No songs on this album.'}
          </div>
        )}
        {tracks && tracks.length > 0 && (
          <div>
            {/* Column header — mirrors the library album page
                (#  TITLE … FILE  TIME), with a trailing slot for the
                hover-revealed add-to-playlist button. */}
            <div
              className={`${
                // Desktop inline page: card sits below the header, so the column
                // header pins right under the condensed bar (top-14, not top-28).
                inline ? 'sticky top-14 z-20 ' : ''
              }${
                // Phone swipe rows are flex (no grid), like the library page —
                // so drop the desktop column header entirely there (it would
                // otherwise reappear + misalign on a ≥sm landscape phone).
                swipeEnabled ? 'hidden' : 'hidden sm:grid'
              } ${trackGrid} gap-3 items-center ${listPadX} py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-white/5 ${
                // Match the library playlist page's translucent, blurred sticky
                // header on desktop; the phone (non-sticky) keeps a solid bg.
                inline ? 'bg-neutral-950/60 backdrop-blur-xl' : 'bg-neutral-950'
              }`}
            >
              <span>#</span>
              {isCatalogPlaylist ? <span /> : null}
              <span>Title</span>
              {isCatalogPlaylist ? (
                <span className="hidden sm:block">Album</span>
              ) : null}
              <span>File</span>
              {showInPlaylistColumn ? <span /> : null}
              <span className="text-right">Time</span>
              {onShowTrackMenu ? <span /> : null}
            </div>
            {/* Phone: break the tracklist out of the body's px-4 so the rows run
                edge-to-edge (their own px-4 keeps the content aligned with the
                playlist / genre lists). Desktop keeps the inset. */}
            <ul className="-mx-4 md:mx-0">
              {tracks.map((t, i) => {
                const previewing =
                  !!t.preview_url && playingPreviewUrl === t.preview_url;
                // Playable in full only when the track has a local file (has_audio),
                // or a non-downloaded track while live streaming AND the hub is
                // reachable; otherwise fall back to the 30s Deezer preview.
                const playable = canPlayNow(t);
                const canPreview = !isPlayable(t) && !!t.preview_url;
                const interactive = playable || canPreview;
                const InfoArea: React.ElementType = interactive
                  ? 'button'
                  : 'div';
                // Is this row the current playback track? Drives the Spotify-style
                // row highlight + the bouncing equalizer bars in the # gutter, so
                // the album/playlist page mirrors the library playlist page.
                const current = !!isTrackCurrent && isTrackCurrent(t);
                // Phone: a simple flex row (art · title · download) that matches
                // the library playlist page — the base grid-cols in trackGrid go
                // inert under flex, and sm:grid restores the desktop
                // #/Album/File/Time columns. A swipe row is phone-only (no
                // sm:grid needed) and adds a tap-feedback bg like the library.
                const rowInnerClass = `group flex ${
                  swipeEnabled
                    ? 'active:bg-neutral-900 '
                    : `sm:grid ${trackGrid} hover:bg-neutral-900/40 `
                }gap-3 items-center ${listPadX} ${
                  roomy ? 'h-14' : 'py-2.5'
                } min-w-0 ${
                  interactive ? '' : 'opacity-60'
                } transition-colors`;
                return (
                  <li
                    key={`${t.source}:${t.source_id}`}
                    onContextMenu={
                      onShowTrackMenu
                        ? (e) => {
                            e.preventDefault();
                            onShowTrackMenu(t, e.clientX, e.clientY);
                          }
                        : undefined
                    }
                  >
                    <MaybeSwipe
                      enabled={swipeEnabled}
                      onQueue={() => {
                        // Mirror the library page: only queue a track that can
                        // ever stream (downloaded, or live on a full build);
                        // otherwise say so instead of silently no-op'ing.
                        if (!isPlayable(t)) {
                          showSwipeToast('Not available yet');
                          return;
                        }
                        onQueueTrack?.(t);
                        showSwipeToast('Added to queue');
                      }}
                      onSave={() => {
                        onSaveTrack?.(t);
                        showSwipeToast('Added to Favorites');
                      }}
                    >
                    <div
                      className={`${rowInnerClass}${
                        interactive && !swipeEnabled ? ' cursor-pointer' : ''
                      }`}
                      // Click ANYWHERE in the row to play (Spotify-style), same
                      // as the library playlist. The title button, the in-playlist
                      // ✓, the ⋯ menu, and the artist/album links all
                      // stopPropagation so they keep their own action. Desktop
                      // only — phone rows use tap/swipe (MaybeSwipe).
                      onClick={
                        interactive && !swipeEnabled
                          ? () =>
                              playable
                                ? onPlay(t, tracks, i)
                                : onTogglePreview(t.preview_url as string)
                          : undefined
                      }>
                    {/* Track number — or, on an album row while this track's
                        preview plays, a mini depleting ring + pause glyph.
                        Playlist rows show the preview state on the cover (below)
                        instead, so here they always show the number. */}
                    <div
                      // ALBUM rows show the number gutter on every platform (all
                      // tracks share the one album cover, so a per-track cover
                      // would just repeat it — Apple Music / Spotify show numbers
                      // instead). PLAYLIST rows hide it on phone (the per-track
                      // cover below takes the leading slot) and show it on desktop.
                      className={`relative ${
                        isCatalogPlaylist ? 'hidden sm:grid' : 'grid'
                      } h-6 w-6 place-items-center ${
                        roomy ? 'text-sm' : 'text-xs'
                      } ${
                        current ? 'text-neutral-100' : 'text-neutral-600'
                      } tabular-nums`}
                    >
                      {previewing && !isCatalogPlaylist ? (
                        // 30s Deezer preview auditioning (fileless track): ring + pause.
                        <>
                          <PreviewRing size={22} strokeWidth={2.5} />
                          <svg
                            width="9"
                            height="9"
                            viewBox="0 0 24 24"
                            fill="#34d399"
                            aria-hidden
                          >
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        </>
                      ) : current && isPlaying ? (
                        // Now playing (audible): bouncing equalizer bars, Spotify-
                        // style — replacing the track number for the active row.
                        <EqualizerBars className="text-neutral-100" />
                      ) : (
                        // Number, swapping to a ▶ hint on hover for a playable row
                        // that isn't the current track (the row/title click plays).
                        <>
                          <span
                            className={
                              playable && !current ? 'group-hover:opacity-0' : ''
                            }
                          >
                            {i + 1}
                          </span>
                          {playable && !current ? (
                            <span className="pointer-events-none absolute inset-0 grid place-items-center text-neutral-100 opacity-0 group-hover:opacity-100">
                              <svg
                                className="h-4 w-4 translate-x-[1px]"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden
                              >
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                    {/* PLAYLIST rows only: a per-track cover (tracks span many
                        albums, each with its own art), with the preview ring/pause
                        overlaid — matches the library playlist page. ALBUM rows
                        deliberately omit it (one shared album cover, shown in the
                        hero) and use the number gutter above instead. */}
                    {isCatalogPlaylist ? (
                      <div
                        className={`relative ${
                          catalogInline ? 'h-10 w-10' : 'h-10 w-10'
                        } shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center`}
                      >
                        {t.album_art_url ? (
                          <img
                            src={t.album_art_url}
                            alt=""
                            className="h-full w-full object-cover"
                            draggable={false}
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-neutral-600 text-sm">♪</span>
                        )}
                        {/* Now-playing marker on the cover — phone only. The
                            number gutter above is `hidden sm:grid`, so on the
                            phone this overlay is the row's ONLY indicator; at
                            sm+ the gutter's equalizer takes over and this must
                            hide (sm:hidden) or the row shows two. Suppressed
                            while auditioning a 30s preview (that overlay wins). */}
                        {!previewing ? (
                          <NowPlayingCover
                            current={current}
                            playing={!!isPlaying}
                            className="sm:hidden"
                          />
                        ) : null}
                        {previewing ? (
                          <div className="absolute inset-0 grid place-items-center bg-black/50">
                            <PreviewRing size={24} strokeWidth={2.5} />
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 24 24"
                              fill="#34d399"
                              aria-hidden
                              className="absolute"
                            >
                              <rect x="6" y="5" width="4" height="14" rx="1" />
                              <rect x="14" y="5" width="4" height="14" rx="1" />
                            </svg>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <InfoArea
                      {...(interactive
                        ? {
                            type: 'button' as const,
                            onClick: (e: React.MouseEvent) => {
                              e.stopPropagation();
                              if (playable) onPlay(t, tracks, i);
                              else onTogglePreview(t.preview_url as string);
                            },
                            'aria-label': playable
                              ? `Play ${t.title}`
                              : previewing
                                ? `Stop preview of ${t.title}`
                                : `Preview ${t.title}`,
                          }
                        : {})}
                      className="min-w-0 flex-1 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
                    >
                      <div
                        className={`${
                          roomy ? 'text-base' : 'text-sm'
                        } font-medium truncate ${
                          current ? 'text-accent' : 'text-neutral-300'
                        }`}
                      >
                        {t.title}
                      </div>
                      <div
                        className={`${
                          roomy ? 'text-sm' : 'text-xs'
                        } text-neutral-500 truncate flex items-center gap-1.5`}
                      >
                        {t.explicit && <ExplicitBadge />}
                        <span className="truncate">{renderArtists(t.artists)}</span>
                      </div>
                    </InfoArea>
                    {/* ALBUM — playlist rows only (desktop); the album each track
                        comes from, clickable to open it. Hidden on phone to keep
                        the row compact (column counts stay in sync with the grid). */}
                    {isCatalogPlaylist ? (
                      <div
                        className={`hidden sm:block min-w-0 truncate ${
                          catalogInline
                            ? 'text-sm text-neutral-400'
                            : 'text-xs text-neutral-500'
                        }`}
                      >
                        {t.album ? (
                          onGoToAlbum ? (
                            <span
                              role="link"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onGoToAlbum(t.album!, t.artists[0] ?? null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  onGoToAlbum(t.album!, t.artists[0] ?? null);
                                }
                              }}
                              className="cursor-pointer hover:text-neutral-100 hover:underline"
                            >
                              {t.album}
                            </span>
                          ) : (
                            t.album
                          )
                        ) : (
                          ''
                        )}
                      </div>
                    ) : null}
                    {/* FILE — the green "downloaded" seal. The "in a playlist" ✓
                        is now its OWN column (below), on catalog playlists too, so
                        this cell shows download state only. Desktop always renders
                        the box (a real grid column); phone (onShowTrackSheet) only
                        when there's a seal, so an undownloaded row doesn't push the
                        ⋯ off-align from the saved-library rows. */}
                    {t.has_audio || !onShowTrackSheet ? (
                      <div className="shrink-0 grid place-items-start">
                        <span className="grid h-7 w-7 place-items-center">
                          {t.has_audio ? <AlbumDownloadedBadge /> : null}
                        </span>
                      </div>
                    ) : null}
                    {/* "In a playlist" ✓ — its own column on desktop albums AND
                        catalog playlists (phone folds it into the ⋯ sheet). On a
                        catalog playlist it's hidden below sm since those rows are
                        flex on phone; albums keep their existing all-width cell. */}
                    {showInPlaylistColumn ? (
                      <div
                        className={`shrink-0 place-items-center ${
                          isCatalogPlaylist ? 'hidden sm:grid' : 'grid'
                        }`}
                      >
                        {renderAddToLibrary(t)}
                      </div>
                    ) : null}
                    <div
                      className={`hidden sm:block tabular-nums text-right ${
                        roomy
                          ? 'text-sm text-neutral-500'
                          : 'text-[11px] text-neutral-600'
                      }`}
                    >
                      {formatDuration(t.duration_ms)}
                    </div>
                    {onShowTrackMenu ? (
                      <div className="grid place-items-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowTrackMenu(t, e.clientX, e.clientY);
                          }}
                          className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 group-hover:opacity-100 focus-visible:opacity-100"
                          title="More options"
                          aria-label={`More options for ${t.title}`}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <circle cx="5" cy="12" r="1.6" />
                            <circle cx="12" cy="12" r="1.6" />
                            <circle cx="19" cy="12" r="1.6" />
                          </svg>
                        </button>
                      </div>
                    ) : null}
                    {/* Phone: a touch-visible ⋯ that opens the same bottom sheet
                        as the library album/playlist rows (Favorite · Add · Go to
                        artist). Only set on phone, so it never renders on desktop
                        (which uses the hover ⋯ above). */}
                    {onShowTrackSheet ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onShowTrackSheet(t);
                        }}
                        className="h-11 w-9 -my-2 -mr-2 shrink-0 grid place-items-center text-neutral-500 active:text-neutral-200"
                        aria-label={`More options for ${t.title}`}
                      >
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <circle cx="5" cy="12" r="1.7" />
                          <circle cx="12" cy="12" r="1.7" />
                          <circle cx="19" cy="12" r="1.7" />
                        </svg>
                      </button>
                    ) : null}
                    </div>
                    </MaybeSwipe>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {/* Full release date — Spotify shows this under the album tracklist. */}
        {formatReleaseDate(album.release_date) ? (
          <div className="px-1 pt-1 text-xs text-neutral-500">
            {formatReleaseDate(album.release_date)}
          </div>
        ) : null}
        {/* "More by {artist}" — the primary artist's other releases. */}
        {onPickAlbum && moreBy && moreBy.length > 0 ? (
          <div className="pt-5">
            <div className={cn(EYEBROW, 'px-1 mb-2')}>
              More by {album.artists[0]}
            </div>
            <AlbumGrid
              albums={moreBy}
              onOpen={onPickAlbum}
              onPlay={(a) => playAlbumCard(a, token, onPlay)}
              subtitleMode="discography"
            />
          </div>
        ) : null}
      </div>
    </ModalShell>
    {/* Phone swipe feedback — same transient pill the library playlist page
        uses, positioned above the mini-player + nav via --overlay-bottom. */}
    {swipeToast ? <Toast message={swipeToast} /> : null}
    </>
  );
}
