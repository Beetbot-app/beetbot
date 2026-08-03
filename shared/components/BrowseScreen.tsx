import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  getBrowse,
  getGenres,
  profileScopedKey,
  type BrowseResults,
  type CatalogPlaylistSummary,
  type Genre,
  type SearchAlbumResult,
  type SearchArtistResult,
  type SearchTrackResult,
} from '../api';
import { AddToPlaylistModal } from './modals/AddToPlaylistModal';
import {
  AlbumDetailModal,
  AlbumGrid,
  ArtistDetailModal,
  ArtistGrid,
  PlaylistDetailModal,
  PlaylistGrid,
  type SidebarPinController,
  type SavedArtistController,
  PREVIEW_RING_KEYFRAMES,
  playAlbumCard,
  playArtistCard,
  TrackList,
  usePreviewPlayer,
} from './SearchScreen';
import {
  ContextMenu,
  MenuGlyphs,
  fileMenuItems,
  type MenuItem,
  type MenuState,
} from './ContextMenu';
import { cn, EYEBROW, EYEBROW_ON_ART } from '../ui';
import { useLibraryChangeTick } from '../useLibraryChange';
import { HeroWash } from './HeroWash';
import { CondensedHeaderBar, useCondensedHeader } from './StickyHeader';

/**
 * A restorable snapshot of a Discover drill-in page (artist / album / playlist).
 * The desktop host stores one per view-history entry so Back/Forward can replay
 * Discover pages — including across a tab change, when BrowseScreen unmounts and
 * has to re-open the drill on mount. Mirrors SearchScreen's OverlaySnapshot.
 */
export interface BrowseSnapshot {
  genre: Genre | null;
  artist: SearchArtistResult | null;
  album: SearchAlbumResult | null;
  playlist: CatalogPlaylistSummary | null;
}

/** Stable identity of a Discover page, for telling a genuine drill from a
 *  restore re-applying the same page. Includes the active genre, so a genre
 *  feed is its own Back/Forward stop (and survives a tab change). `∅` = the
 *  global grid. */
function browseKey(
  genre: Genre | null,
  artist: SearchArtistResult | null,
  album: SearchAlbumResult | null,
  playlist: CatalogPlaylistSummary | null,
): string {
  return genre || artist || album || playlist
    ? `g${genre?.id ?? ''}|${artist?.source_id ?? ''}|${album?.source_id ?? ''}|${playlist?.source_id ?? ''}`
    : '∅';
}

interface Props {
  token: string;
  /** Same play handler the SearchScreen uses — the host seeds its own player
   *  queue. With `list` + `index`, the host seeds the whole list starting at
   *  `index` so playback auto-advances down it (e.g. genre "Top songs"). */
  onPlayTrack: (
    track: SearchTrackResult,
    list?: SearchTrackResult[],
    index?: number,
  ) => void;
  /** Top-of-grid heading style. `'browse-all'` (default) is the big standalone
   *  "Browse all" title; `'eyebrow'` is the small uppercase "Browse" kicker —
   *  used when this grid is embedded as the phone search screen's empty state. */
  titleVariant?: 'browse-all' | 'eyebrow';
  /** Open straight to a genre feed on mount (skip the grid). The phone uses this
   *  to render a tapped genre as its own page. */
  initialGenre?: Genre | null;
  /** When set, tapping a genre tile in the grid calls this instead of drilling
   *  in place — so the host can navigate to a SEPARATE page (phone: the search
   *  grid hands off to a dedicated genre view rather than expanding inline). */
  onOpenGenre?: (genre: Genre) => void;
  /** When set, the phone genre page's back control calls this (e.g. return to
   *  Search) instead of clearing back to this component's own grid. */
  onExitGenre?: () => void;
  /** Desktop: render artist/album drill-ins as inline full pages instead
   *  of modal overlays (phone keeps the modals). */
  pageMode?: boolean;
  /** True in the desktop app — reworks the stale-cache banner so it doesn't
   *  tell you to "reconnect to your computer" when you're already on it. */
  desktop?: boolean;
  /** Active profile — playlists created from Browse belong to it. */
  activeProfileId?: number | null;
  /** Desktop: called when the user drills into an artist/album/playlist, so the
   *  host pushes a view-history entry for it (each Discover page is its own
   *  Back/Forward stop). */
  onBrowsePush?: (snapshot: BrowseSnapshot) => void;
  /** Desktop: replays a drill page (or clears to the grid) on each signal bump —
   *  Back/Forward, and on (re)mount when returning to a Discover page. */
  restore?: { signal: number; snapshot: BrowseSnapshot | null };
  /** Desktop: closes the current drill by stepping BACK one history entry
   *  (Escape) — wired to the host's Back, so closing is a real Back not a
   *  phantom forward push. */
  onBrowseBack?: () => void;
  /**
   * Desktop-only per-song "⋯" menu handlers for an opened Discover album or
   * playlist (same as the search-overlay browse album). "Add to playlist" is
   * handled internally (reuses the picker); these cover the actions that need a
   * host round-trip on a *catalog* track that has no library row yet (the host
   * resolves/imports it first). Omitted on the phone → no overflow column.
   */
  onAlbumGoToArtist?: (name: string) => void;
  onAlbumAddToQueue?: (t: SearchTrackResult) => void;
  onAlbumSaveToLiked?: (t: SearchTrackResult) => void;
  /** Open an album by name (clickable Album column on catalog-playlist rows). */
  onAlbumGoToAlbum?: (name: string, artist: string | null) => void;
  /** Desktop file actions for a Discover album/playlist row (the same set as
   *  every other ⋯ menu). The host binds them to its download / add-audio
   *  stores; omitted on the phone, which can't attach or download files. */
  onAddAudio?: (t: SearchTrackResult) => void;
  onDownload?: (t: SearchTrackResult) => void;
  onRemoveDownload?: (t: SearchTrackResult) => void;
  /** Whether this build can acquire — gates the save/remove pair. The host
   *  resolves it (desktop capabilities); the phone leaves it false. */
  canDownload?: boolean;
  /** Phone-only: open the per-song "⋯" bottom sheet for an opened Discover
   *  album/playlist row (same TrackActionSheet the library rows use). Its
   *  presence also arms the row's swipe-to-queue / swipe-to-save gestures. */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /**
   * Now-playing awareness (desktop), so the genre page mirrors the album /
   * playlist pages: the genre hero + sticky bar reflect ⏸/▶ and toggle, the
   * current track row highlights + shows equalizer bars, and the playing
   * album's card shows a persistent pause. Omitted on the phone.
   */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isNowPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Album name of the now-playing track (for the album cards' persistent play). */
  currentAlbumName?: string | null;
  /** Desktop-only Pin/Save controls, forwarded to the artist / album / playlist
   *  detail pages so those buttons show here too. Omitted on the phone. */
  pin?: SidebarPinController;
  save?: SavedArtistController;
}

// Discover is assembled on the desktop from several sources (Billboard,
// Last.fm, iTunes, Deezer) — none of which the phone can replicate directly
// (Billboard blocks cross-origin requests; the Last.fm key is server-only). So
// instead of a degraded live version when the computer is off, we persist the
// real feed per view and show it stale ("as of last sync") until the hub is
// reachable again. The genre tiles are persisted too so navigation still works.
const FEED_KEY_PREFIX = 'beetbot.discover.feed.';
const GENRES_KEY = 'beetbot.discover.genres';

interface PersistedFeed {
  savedAt: number;
  data: BrowseResults;
}
function feedStoreKey(genre: Genre | null): string {
  return FEED_KEY_PREFIX + (genre ? `g${genre.id}` : 'global');
}
function readFeed(key: string): PersistedFeed | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as PersistedFeed) : null;
  } catch {
    return null;
  }
}
function writeFeed(key: string, data: BrowseResults): void {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    /* private mode / quota — discovery just won't be cached offline */
  }
}
function readGenresCache(): Genre[] | null {
  try {
    const v = localStorage.getItem(GENRES_KEY);
    return v ? (JSON.parse(v) as Genre[]) : null;
  } catch {
    return null;
  }
}
function writeGenresCache(g: Genre[]): void {
  try {
    localStorage.setItem(GENRES_KEY, JSON.stringify(g));
  } catch {
    /* ignore */
  }
}
/** Coarse "x ago" for the stale-feed banner. */
function relativeAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/**
 * Discovery / home feed, Spotify-"Browse all" style. A grid of genre tiles
 * sits above the global feed (Deezer's top songs / albums / artists +
 * editorial new releases). Tapping a genre tile drills into that genre's
 * own charts. Everything reuses the search screen's track list, grids,
 * preview player, and drill-in modals.
 */
export function BrowseScreen({
  token,
  onPlayTrack,
  titleVariant = 'browse-all',
  initialGenre,
  onOpenGenre,
  onExitGenre,
  pageMode,
  desktop,
  activeProfileId,
  onBrowsePush,
  restore,
  onBrowseBack,
  onAlbumGoToArtist,
  onAlbumAddToQueue,
  onAlbumSaveToLiked,
  onAlbumGoToAlbum,
  onAddAudio,
  onDownload,
  onRemoveDownload,
  canDownload = false,
  onShowTrackSheet,
  isTrackCurrent,
  isNowPlaying,
  onTogglePlay,
  currentAlbumName,
  pin,
  save,
}: Props) {
  const [data, setData] = useState<BrowseResults | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [activeGenre, setActiveGenre] = useState<Genre | null>(
    initialGenre ?? null,
  );
  // When the live feed can't be fetched (desktop off) we fall back to the
  // persisted copy: `staleAt` = its save time (banner shown), or `offline`
  // when there's nothing cached yet for this view (clean gate message).
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [openAlbum, setOpenAlbum] = useState<SearchAlbumResult | null>(null);
  const [openArtist, setOpenArtist] = useState<SearchArtistResult | null>(null);
  const [openPlaylist, setOpenPlaylist] =
    useState<CatalogPlaylistSummary | null>(null);
  const [pickerTrack, setPickerTrack] = useState<SearchTrackResult | null>(null);
  // Desktop per-song "⋯" menu for an opened Discover album/playlist row (same
  // shape as the search-overlay browse album). Built per row, cursor-anchored.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const showTrackMenu = useCallback(
    (t: SearchTrackResult, x: number, y: number) => {
      const artist = t.artists[0]?.trim() ?? '';
      const items: MenuItem[] = [
        {
          label: 'Add to playlist',
          icon: MenuGlyphs.addToPlaylist,
          onClick: () => setPickerTrack(t),
        },
      ];
      if (onAlbumSaveToLiked)
        items.push({
          label: 'Add to Favorites',
          icon: MenuGlyphs.star,
          onClick: () => onAlbumSaveToLiked(t),
        });
      if (onAlbumAddToQueue)
        items.push({
          label: 'Add to queue',
          icon: MenuGlyphs.queue,
          onClick: () => onAlbumAddToQueue(t),
        });
      if (onAlbumGoToArtist)
        items.push({
          label: 'Go to artist',
          icon: MenuGlyphs.artist,
          disabled: !artist,
          onClick: () => onAlbumGoToArtist(artist),
        });
      // Save offline / remove / attach-a-file — the shared file actions, so a
      // Discover row matches the player and library menus. The host binds them;
      // on the phone they're absent and nothing is added.
      items.push(
        ...fileMenuItems({
          hasFile: !!t.has_audio,
          canDownload,
          onDownload: onDownload ? () => onDownload(t) : undefined,
          onRemove: onRemoveDownload ? () => onRemoveDownload(t) : undefined,
          onAddAudio: onAddAudio ? () => onAddAudio(t) : undefined,
        }),
      );
      setMenu({ x, y, items });
    },
    [
      onAlbumSaveToLiked,
      onAlbumAddToQueue,
      onAlbumGoToArtist,
      onAddAudio,
      onDownload,
      onRemoveDownload,
      canDownload,
    ],
  );
  const {
    playingUrl: playingPreviewUrl,
    toggle: togglePreview,
    stop: stopPreview,
  } = usePreviewPlayer();

  // Genre taxonomy — seeded from the persisted copy (so tiles still render
  // when the desktop is off), then refreshed from the hub.
  useEffect(() => {
    let cancelled = false;
    const cachedGenres = readGenresCache();
    if (cachedGenres && cachedGenres.length) setGenres(cachedGenres);
    getGenres(token)
      .then((g) => {
        if (cancelled) return;
        setGenres(g);
        writeGenresCache(g);
      })
      .catch(() => {
        /* keep the cached/empty list */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The feed, scoped to the active genre (or global). Stale-while-revalidate
  // backed by localStorage: show the persisted copy instantly (no "Loading…"
  // flash, and it survives reloads), then refresh from the hub. If the refresh
  // fails (desktop off), keep the persisted copy and flag it stale; if there's
  // nothing cached for this view yet, show the offline gate.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Scope the persisted Discover cache by profile: its chart tracks carry
    // per-profile ✓ "in library" marks, so one profile must not seed from
    // another's cached feed.
    const lsKey = profileScopedKey(feedStoreKey(activeGenre), activeProfileId);
    const seed = readFeed(lsKey);
    setData(seed ? seed.data : null);
    setStaleAt(null);
    setOffline(false);

    // A failed refresh is almost always transient on the desktop — the app
    // just restarted and the first call raced startup, or a chart source
    // (Billboard / Last.fm / iTunes / Deezer) briefly didn't answer. Rather
    // than sit on a stale banner until the user navigates away and back, we
    // retry quietly in the background on a short backoff. A success clears the
    // stale flag on its own, so the note simply disappears with no user action.
    const BACKOFF_MS = [15_000, 45_000, 120_000];
    const attempt = (retry: number) => {
      getBrowse(token, activeGenre)
        .then((r) => {
          if (cancelled) return;
          writeFeed(lsKey, r);
          setData(r);
          setStaleAt(null);
          setOffline(false);
        })
        .catch(() => {
          if (cancelled) return;
          const p = readFeed(lsKey);
          if (p) {
            setData(p.data);
            setStaleAt(p.savedAt);
          } else {
            setData(null);
            setOffline(true);
          }
          if (retry < BACKOFF_MS.length) {
            retryTimer = setTimeout(() => attempt(retry + 1), BACKOFF_MS[retry]);
          }
        });
    };
    attempt(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [token, activeGenre, activeProfileId]);

  // Refresh the feed when the library changes elsewhere — the genre track rows
  // carry per-profile "in library" ✓ marks, so adding/removing one of these
  // tracks to a playlist (via the ⋯ picker) would otherwise leave the ✓ stale
  // until you re-open the genre. A light refetch that just updates the marks;
  // skip the mount pass since the main effect above already fetched.
  const libTick = useLibraryChangeTick();
  const libSeeded = useRef(true);
  useEffect(() => {
    if (libSeeded.current) {
      libSeeded.current = false;
      return;
    }
    let cancelled = false;
    const lsKey = profileScopedKey(feedStoreKey(activeGenre), activeProfileId);
    getBrowse(token, activeGenre)
      .then((r) => {
        if (cancelled) return;
        writeFeed(lsKey, r);
        setData(r);
      })
      .catch(() => {
        /* keep what's shown on a transient failure */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh ✓ marks on a library change
  }, [libTick]);

  const openGenre = (g: Genre | null) => {
    stopPreview();
    setActiveGenre(g);
  };

  // Each Discover drill page is its own Back/Forward history entry (desktop).
  // `lastBrowseKey` tracks the page the host has recorded, so the push effect
  // can tell a genuine user drill from a restore re-applying the same page.
  const lastBrowseKey = useRef<string>('∅');

  // Host-driven restore: replays a drill page (or clears to the grid). Runs on
  // each signal bump AND on (re)mount — when you return to a Discover page via
  // Back/Forward after leaving the tab, BrowseScreen remounts and must re-open
  // it. Records the key first so the push effect no-ops for the replay.
  const restoreInit = useRef(true);
  const applyBrowseSnapshot = (snap: BrowseSnapshot | null) => {
    stopPreview();
    setPickerTrack(null);
    lastBrowseKey.current = browseKey(
      snap?.genre ?? null,
      snap?.artist ?? null,
      snap?.album ?? null,
      snap?.playlist ?? null,
    );
    setActiveGenre(snap?.genre ?? null);
    setOpenArtist(snap?.artist ?? null);
    setOpenAlbum(snap?.album ?? null);
    setOpenPlaylist(snap?.playlist ?? null);
  };
  useEffect(() => {
    if (restoreInit.current) {
      restoreInit.current = false;
      // On (re)mount: open any drill page we were sent back to.
      if (restore?.snapshot) applyBrowseSnapshot(restore.snapshot);
      return;
    }
    applyBrowseSnapshot(restore?.snapshot ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.signal]);

  // Push a history entry whenever the user drills to a NEW page; restores set
  // `lastBrowseKey` first, so this fires for them but no-ops. Skip the first run
  // entirely: on (re)mount the restore effect (above) has already set up the
  // drill + key, and the initial empty state here would otherwise clobber it and
  // push a spurious duplicate entry (truncating the forward history).
  const pushInit = useRef(true);
  useEffect(() => {
    if (pushInit.current) {
      pushInit.current = false;
      return;
    }
    const key = browseKey(activeGenre, openArtist, openAlbum, openPlaylist);
    if (key === lastBrowseKey.current) return;
    lastBrowseKey.current = key;
    if (key === '∅') return; // back to the global grid isn't a new stop
    onBrowsePush?.({
      genre: activeGenre,
      artist: openArtist,
      album: openAlbum,
      playlist: openPlaylist,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGenre, openArtist, openAlbum, openPlaylist, onBrowsePush]);

  const showingPage =
    !!pageMode && (!!openAlbum || !!openArtist || !!openPlaylist);

  // Genre page = a full-bleed page on desktop (like the album/playlist drill-ins),
  // so it gets a condensed sticky header + a hero Play/Shuffle row. The genre's
  // "Top songs this week" is its play context.
  const genrePage = !!activeGenre && !showingPage;
  const [genreCondensed, genreSentinelRef] = useCondensedHeader();
  const genreTop = data?.chart_tracks ?? [];
  const genreActive =
    !!isTrackCurrent && genreTop.length > 0 && genreTop.some((t) => isTrackCurrent(t));
  const genrePlaying = genreActive && !!isNowPlaying;
  const genreHeaderPlay = () => {
    if (genreActive && onTogglePlay) onTogglePlay();
    else if (genreTop.length > 0) onPlayTrack(genreTop[0], genreTop, 0);
  };
  const genreShuffle = () => {
    if (genreTop.length === 0) return;
    const arr = genreTop.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    onPlayTrack(arr[0], arr, 0);
  };

  return (
    <div
      className={
        // A genre page (desktop OR phone) is full-bleed: its hero owns the
        // edges + bleeds under the top bar, and the sections below add their
        // own px. The "Browse all" grid keeps its modest padding.
        pageMode
          ? showingPage || genrePage
            ? 'pb-6'
            : 'px-4 pt-6 pb-6'
          : genrePage
            ? 'pb-6'
            : // Embedded under the Search bar (eyebrow kicker): the SearchScreen
              // owns the horizontal inset so the grid lines up with the bar —
              // don't add our own px on top of it.
              titleVariant === 'eyebrow'
              ? 'pb-6'
              : 'px-4 pt-4 pb-6'
      }
    >
      <style>{PREVIEW_RING_KEYFRAMES}</style>
      {!showingPage && (
        <>
          {/* Desktop genre page: a condensed sticky header with a ⏸/▶ play
              button, pinned under the top bar once the hero scrolls away —
              matching the album/playlist pages. */}
          {activeGenre && pageMode && (
            <CondensedHeaderBar
              condensed={genreCondensed}
              title={activeGenre.name}
              playing={genrePlaying}
              onPlay={genreHeaderPlay}
            />
          )}
          {/* Header: a Spotify-style hero (matching the artist/album pages)
              in genre view, else the plain Discover title. */}
          {activeGenre ? (
            pageMode ? (
              // Desktop: the persistent top bar's global Back handles it (the
              // genre feed is its own history stop), so no inline back here.
              <GenreHero
                genre={activeGenre}
                pageMode
                sentinelRef={genreSentinelRef}
                hasTracks={genreTop.length > 0}
                playing={genrePlaying}
                onPlay={genreHeaderPlay}
                onShuffle={genreShuffle}
              />
            ) : (
              // Phone: full-bleed, playlist-style — a sticky back header floats
              // over the artwork wash, and the hero lifts up behind it (-mt-14)
              // so the wash runs edge-to-edge to the very top.
              <>
                {/* Sticky bar: at rest just a legibility gradient behind the
                    back arrow; once the hero scrolls past it frosts into the
                    chrome and the genre title + play fade in — same pattern as
                    the playlist / album detail pages. */}
                <div
                  className={`sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-2 transition-colors duration-200 ${
                    genreCondensed
                      ? 'bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/5'
                      : 'bg-gradient-to-b from-black/50 to-transparent'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => (onExitGenre ? onExitGenre() : openGenre(null))}
                    aria-label={onExitGenre ? 'Back to Search' : 'Back to Discover'}
                    className="h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-white/10 active:text-neutral-100"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span
                    className={`min-w-0 flex-1 truncate text-sm font-semibold transition-opacity duration-200 ${
                      genreCondensed ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    {activeGenre.name}
                  </span>
                  <button
                    type="button"
                    disabled={genreTop.length === 0}
                    onClick={genreHeaderPlay}
                    aria-label={genrePlaying ? 'Pause' : `Play ${activeGenre.name}`}
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-neutral-950 transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500 ${
                      genreCondensed ? 'opacity-100' : 'pointer-events-none opacity-0'
                    }`}
                  >
                    {genrePlaying ? (
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
                </div>
                <div className="relative -mt-14">
                  <GenreHero
                    genre={activeGenre}
                    pageMode={false}
                    sentinelRef={genreSentinelRef}
                    hasTracks={genreTop.length > 0}
                    playing={genrePlaying}
                    onPlay={genreHeaderPlay}
                    onShuffle={genreShuffle}
                  />
                </div>
              </>
            )
          ) : titleVariant === 'eyebrow' ? (
            <h2 className={cn(EYEBROW, 'mb-2')}>Browse</h2>
          ) : (
            <h1 className="text-2xl font-bold tracking-tight mb-4 px-1">Browse all</h1>
          )}

          {/* Everything below the hero. On a genre page (desktop or phone) the
              container is full-bleed, so the sections carry their own px-4,
              matching the album/playlist tracklists under their hero. */}
          <div className={genrePage ? 'px-4' : ''}>

          {/* Staleness only matters on a genre page — those show live charts
              that can age. The global "Browse all" grid is fixed category tiles
              (Pop, Rock, Jazz…) that never go stale, so a warning there is pure
              noise. And it's a quiet ambient line, not an alarm: the desktop
              retries in the background (see the fetch effect), so it clears
              itself; "Restart Beetbot" was misleading advice for a transient,
              self-healing upstream hiccup. */}
          {staleAt != null && activeGenre && (
            <div className="mx-1 mb-3 text-xs text-neutral-500 break-words">
              {desktop
                ? `Showing charts from ${relativeAge(staleAt)}.`
                : `Showing charts from ${relativeAge(staleAt)}. Reconnect your computer to update.`}
            </div>
          )}

          {/* BROWSE ALL (global view) — the category grid IS the page, Spotify
              Search-landing style: just the genre tiles, no charts stacked below
              (those live on Home + inside each genre page). */}
          {!activeGenre &&
            (genres.length > 0 ? (
              <div className="mb-8">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {genres.map((g) => (
                    <GenreTile
                      key={g.id}
                      genre={g}
                      onOpen={() =>
                        onOpenGenre ? onOpenGenre(g) : openGenre(g)
                      }
                    />
                  ))}
                </div>
              </div>
            ) : offline ? (
              <div className="px-2 pt-10 pb-6 text-center">
                <p className="text-sm text-neutral-300">
                  Discover lives on your computer.
                </p>
                <p className="mx-auto mt-2 max-w-xs text-xs text-neutral-500">
                  Reconnect to Beetbot on your computer to browse. Search &amp;
                  previews work anywhere.
                </p>
              </div>
            ) : (
              <div className="px-2 pt-2 text-sm text-neutral-500">Loading…</div>
            ))}

          {/* Genre-page charts + shelves (only when a genre is open). */}
          {activeGenre && !data && !offline && (
            <div className="px-2 pt-2 text-sm text-neutral-500">Loading…</div>
          )}

          {activeGenre && offline && !data && (
            <div className="px-2 pt-10 pb-6 text-center">
              <p className="text-sm text-neutral-300">
                Discover lives on your computer.
              </p>
              <p className="mx-auto mt-2 max-w-xs text-xs text-neutral-500">
                It builds these charts from several sources, so it refreshes
                once your computer is reachable. Search &amp; previews work
                anywhere.
              </p>
            </div>
          )}

          {activeGenre && data && (
            <div className="flex flex-col gap-6">
              {data.chart_tracks.length > 0 && (
                <Section title="Top songs">
                  <TrackList
                    tracks={data.chart_tracks}
                    onAdd={setPickerTrack}
                    onPlay={onPlayTrack}
                    playingPreviewUrl={playingPreviewUrl}
                    onTogglePreview={togglePreview}
                    isTrackCurrent={isTrackCurrent}
                    isNowPlaying={isNowPlaying}
                    onShowMenu={pageMode ? showTrackMenu : undefined}
                    onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
                  />
                </Section>
              )}
              {data.playlists && data.playlists.length > 0 && (
                <Section title="Popular playlists">
                  <PlaylistGrid
                    playlists={data.playlists}
                    onOpen={setOpenPlaylist}
                    layout="row"
                  />
                </Section>
              )}
              {data.all_time_tracks && data.all_time_tracks.length > 0 && (
                <Section title="All-time classics">
                  <TrackList
                    tracks={data.all_time_tracks}
                    onAdd={setPickerTrack}
                    onPlay={onPlayTrack}
                    playingPreviewUrl={playingPreviewUrl}
                    onTogglePreview={togglePreview}
                    isTrackCurrent={isTrackCurrent}
                    isNowPlaying={isNowPlaying}
                    onShowMenu={pageMode ? showTrackMenu : undefined}
                    onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
                  />
                </Section>
              )}
              {data.new_releases.length > 0 && (
                <Section title="New releases">
                  <AlbumGrid
                    albums={data.new_releases}
                    onOpen={setOpenAlbum}
                    onPlay={(a) => playAlbumCard(a, token, onPlayTrack)}
                    layout={activeGenre ? 'row' : 'grid'}
                    activeAlbumName={currentAlbumName}
                    isPlaying={isNowPlaying}
                    onToggle={onTogglePlay}
                  />
                </Section>
              )}
              {data.chart_albums.length > 0 && (
                <Section title="Top albums">
                  <AlbumGrid
                    albums={data.chart_albums}
                    onOpen={setOpenAlbum}
                    onPlay={(a) => playAlbumCard(a, token, onPlayTrack)}
                    layout={activeGenre ? 'row' : 'grid'}
                    activeAlbumName={currentAlbumName}
                    isPlaying={isNowPlaying}
                    onToggle={onTogglePlay}
                  />
                </Section>
              )}
              {data.chart_artists.length > 0 && (
                <Section title="Top artists">
                  <ArtistGrid
                    artists={data.chart_artists}
                    onOpen={setOpenArtist}
                    onPlay={(a) => playArtistCard(a, token, onPlayTrack)}
                    layout="row"
                  />
                </Section>
              )}
            </div>
          )}
          </div>
        </>
      )}

      {/* Drill-in: inline pages on desktop (pageMode), stacked modals on
          phone. Mirrors SearchScreen. */}
      {openArtist && (!pageMode || !openAlbum) && (
        <ArtistDetailModal
          inline={pageMode}
          key={openArtist.source_id}
          token={token}
          artist={openArtist}
          pin={pin}
          save={save}
          onClose={
            // Desktop: closing (Escape) is a real history Back, not an in-place
            // unwind — so it pops cleanly without pushing a phantom entry.
            pageMode
              ? () => onBrowseBack?.()
              : () => {
                  stopPreview();
                  setOpenArtist(null);
                }
          }
          onPickAlbum={setOpenAlbum}
          onPickTrack={setPickerTrack}
          onPlay={onPlayTrack}
          onPickArtist={(a) => {
            stopPreview();
            setOpenArtist(a);
          }}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
          onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
        />
      )}
      {openAlbum && (
        <AlbumDetailModal
          inline={pageMode}
          token={token}
          album={openAlbum}
          activeProfileId={activeProfileId}
          pin={pin}
          onClose={
            pageMode
              ? () => onBrowseBack?.()
              : () => {
                  stopPreview();
                  setOpenAlbum(null);
                }
          }
          onPickTrack={setPickerTrack}
          onPlay={onPlayTrack}
          // Desktop only: per-song "⋯" menu (parity with library/search albums).
          onShowTrackMenu={pageMode ? showTrackMenu : undefined}
          // Phone: "⋯" bottom sheet + swipe-to-queue / swipe-to-save.
          onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
          onQueueTrack={pageMode ? undefined : onAlbumAddToQueue}
          onSaveTrack={pageMode ? undefined : onAlbumSaveToLiked}
          onGoToArtist={onAlbumGoToArtist}
          onGoToAlbum={onAlbumGoToAlbum}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
        />
      )}
      {openPlaylist && (!pageMode || (!openAlbum && !openArtist)) && (
        <PlaylistDetailModal
          inline={pageMode}
          key={openPlaylist.source_id}
          token={token}
          playlist={openPlaylist}
          activeProfileId={activeProfileId}
          pin={pin}
          onClose={
            pageMode
              ? () => onBrowseBack?.()
              : () => {
                  stopPreview();
                  setOpenPlaylist(null);
                }
          }
          onPickTrack={setPickerTrack}
          onPlay={onPlayTrack}
          // Desktop only: per-song "⋯" menu, same as the album page.
          onShowTrackMenu={pageMode ? showTrackMenu : undefined}
          // Phone: "⋯" bottom sheet + swipe-to-queue / swipe-to-save.
          onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
          onQueueTrack={pageMode ? undefined : onAlbumAddToQueue}
          onSaveTrack={pageMode ? undefined : onAlbumSaveToLiked}
          onGoToArtist={onAlbumGoToArtist}
          onGoToAlbum={onAlbumGoToAlbum}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
        />
      )}
      {pickerTrack && (
        <AddToPlaylistModal
          token={token}
          track={pickerTrack}
          activeProfileId={activeProfileId}
          onClose={() => setPickerTrack(null)}
        />
      )}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Genre detail hero — same playlist-header treatment as the artist/album
 *  pages: a blurred backdrop pulled from the genre cover, a square cover on
 *  the left, and a "Genre" eyebrow + big title beside it. Melts into the
 *  page (gradient ends at neutral-950) so it reads as one surface. */
/** SVG glyphs shared by the genre hero's action row. */
const PlayGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
  </svg>
);
const PauseGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
  </svg>
);
const ShuffleGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
);

/**
 * Genre-page hero — mirrors the album/playlist page hero so Discover reads as
 * the same system: side-by-side cover + Play · Shuffle on desktop, a centered
 * Apple-style hero on the phone. The Play button reflects ⏸/▶ and toggles when
 * the genre's top songs are the active playback.
 */
function GenreHero({
  genre,
  pageMode,
  sentinelRef,
  hasTracks,
  playing,
  onPlay,
  onShuffle,
}: {
  genre: Genre;
  pageMode: boolean;
  sentinelRef: (node: HTMLElement | null) => void;
  hasTracks: boolean;
  playing: boolean;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const cover = genre.picture_url ? (
    <img
      src={genre.picture_url}
      alt=""
      draggable={false}
      className="h-full w-full object-cover"
    />
  ) : (
    <span className="text-5xl text-neutral-600">♪</span>
  );

  if (pageMode) {
    // DESKTOP: side-by-side, full-bleed, matching the album/playlist hero.
    return (
      <div className="relative overflow-hidden">
        <HeroWash coverUrl={genre.picture_url} />
        <div className="relative px-8 pt-6 pb-4">
          <div className="flex gap-6 items-end">
            <div className="relative h-44 w-44 shrink-0 rounded-xl overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
              {cover}
            </div>
            <div className="min-w-0">
              <p className={cn(EYEBROW_ON_ART, 'mb-1')}>Genre</p>
              <h1 className="text-4xl font-bold tracking-tight mb-2">{genre.name}</h1>
              <div ref={sentinelRef} aria-hidden className="h-px w-px" />
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={onPlay}
                  disabled={!hasTracks}
                  aria-label={playing ? 'Pause' : `Play ${genre.name}`}
                  title={playing ? 'Pause' : `Play ${genre.name}`}
                  className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition hover:bg-white hover:scale-105 active:scale-95 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:hover:scale-100"
                >
                  {playing ? <PauseGlyph /> : <PlayGlyph />}
                </button>
                <button
                  type="button"
                  onClick={onShuffle}
                  disabled={!hasTracks}
                  aria-label="Shuffle play"
                  title="Shuffle play"
                  className="grid h-10 w-10 place-items-center rounded-full text-neutral-300 hover:text-neutral-100 hover:bg-white/10 disabled:text-neutral-600 disabled:hover:bg-transparent transition"
                >
                  <ShuffleGlyph />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // PHONE: centered Apple-style hero, matching the album/playlist phone hero.
  return (
    <div className="relative overflow-hidden">
      <HeroWash coverUrl={genre.picture_url} />
      <div className="relative px-4 pt-20 pb-5 flex flex-col items-center text-center">
        <div className="relative h-52 w-52 rounded-2xl overflow-hidden bg-neutral-800 shadow-2xl shadow-black/60 ring-1 ring-white/10 grid place-items-center">
          {cover}
        </div>
        <div className="mt-4 w-full min-w-0 flex flex-col items-center">
          <p className={cn(EYEBROW_ON_ART, 'mb-1')}>Genre</p>
          <h1 className="text-2xl font-bold tracking-tight mb-1 min-w-0 max-w-full">
            <span className="block max-w-full truncate">{genre.name}</span>
          </h1>
          <div ref={sentinelRef} aria-hidden className="h-px w-px" />
          <div className="mt-4 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={onShuffle}
              disabled={!hasTracks}
              aria-label="Shuffle play"
              title="Shuffle play"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-neutral-200 active:bg-white/20 disabled:opacity-40 disabled:text-neutral-600"
            >
              <ShuffleGlyph />
            </button>
            <button
              type="button"
              onClick={onPlay}
              disabled={!hasTracks}
              aria-label={playing ? 'Pause' : `Play ${genre.name}`}
              className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {playing ? <PauseGlyph /> : <PlayGlyph />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Palette for genre tiles — indexed by id so a genre keeps its colour. */
const TILE_COLORS = [
  '#1e3a5f',
  '#7b2d5e',
  '#5a3e85',
  '#b35c00',
  '#1d6b4f',
  '#8a2b2b',
  '#2d6a8a',
  '#7a5c1e',
  '#3f3f8a',
  '#0f6e6e',
];

/** Spotify-style category card: a colour block with the genre name and a
 *  tilted cover thumbnail tucked into the corner. */
function GenreTile({ genre, onOpen }: { genre: Genre; onOpen: () => void }) {
  const color = TILE_COLORS[Math.abs(genre.id) % TILE_COLORS.length]!;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative isolate aspect-[2/1] rounded-lg overflow-hidden text-left p-4 transition hover:brightness-110 active:scale-95"
      style={{ backgroundColor: color }}
    >
      <span className="relative z-10 text-base font-bold tracking-tight text-white drop-shadow">
        {genre.name}
      </span>
      {genre.picture_url ? (
        // Spotify-style: the cover peeks out of the bottom-right corner,
        // tilted and clipped by the card.
        <img
          src={genre.picture_url}
          alt=""
          draggable={false}
          className="absolute -bottom-2 -right-4 h-[72%] aspect-square rounded-md object-cover rotate-[25deg] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        />
      ) : null}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-2 px-1">
        {title}
      </h2>
      {children}
    </section>
  );
}

