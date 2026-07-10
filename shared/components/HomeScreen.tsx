import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  banArtist,
  canPlayNow,
  getAlbumTracks,
  getArtistTopTracks,
  getCatalogPlaylist,
  getHome,
  getStation,
  getProfiles,
  importAlbum,
  listPlaylists,
  playlistArtUrl,
  profileAvatarUrl,
  profileScopedKey,
  sortPlaylistsByRecent,
  type CatalogPlaylistSummary,
  type HomeShelf,
  type PlaylistRow,
  type Profile,
  type SearchAlbumResult,
  type SearchArtistResult,
  type SearchTrackResult,
  type StatTrack,
} from '../api';
import {
  AddToPlaylistModal,
  AlbumDetailModal,
  ArtistDetailModal,
  MixDetailModal,
  PlaylistCard,
  PlaylistDetailModal,
  ShelfRow,
  usePreviewPlayer,
} from './SearchScreen';
import { CollageCover } from './CollageCover';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from './ContextMenu';
import { extractDominantColor } from '../albumColor';
import { CardPlayButton, Marquee } from './Marquee';
import { useHubReachable } from '../useHubReachable';

interface Props {
  token: string;
  activeProfileId: number | null;
  /** Bump to force a refetch (phone pull-to-refresh). Optional — desktop omits it. */
  refreshKey?: number;
  /** Play a track. With `list` + `index`, the host seeds the whole list as the
   *  queue starting there (so a shelf plays down its tracks). */
  onPlayTrack: (
    t: SearchTrackResult,
    list?: SearchTrackResult[],
    index?: number,
  ) => void | Promise<void>;
  /** Now-playing state for the Spotify-style card play/pause: the key of the
   *  collection the queue is currently seeded from (album:/playlist:), whether
   *  it's playing, and a play/pause toggle. `onPlayedFrom` lets a card record
   *  its key AFTER seeding the queue. All optional — omit to keep hover-only
   *  play buttons with no persistent now-playing state. */
  nowPlayingKey?: string | null;
  /** Library id of the CURRENT track — a song card lights up when it matches,
   *  following the queue as it advances (album/playlist cards use nowPlayingKey
   *  instead). */
  nowPlayingTrackId?: number | null;
  /** The CURRENT track's display fields — used to keep "Recently played" live:
   *  as the queue advances, the new track is optimistically prepended to that
   *  shelf (the server records the play at start and would return the same on
   *  the next fetch, so this just mirrors it instantly). Omit to disable. */
  nowPlayingTrack?: {
    id: number;
    title: string;
    artists: string[];
    album: string | null;
    album_art_url: string | null;
    duration_ms: number;
    has_audio?: boolean;
  } | null;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Host-built "is this row the current playback track?" — used by the mix
   *  drill-in for its row highlight + equalizer bars + ⏸/▶ hero (same as the
   *  library playlist page). Built from the REAL current track (matches on id /
   *  isrc / title+artist), which HomeScreen itself doesn't have. Omit → the mix
   *  page has no now-playing highlight. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  onPlayedFrom?: (key: string | null) => void;
  /**
   * Optional override for loading the quick-access playlists. The desktop
   * passes an IPC-backed loader (straight to the DB) so a momentary blip in
   * the loopback HTTP server can't blank the Home grid; the phone omits it and
   * falls back to the `/api/playlists` fetch.
   */
  loadPlaylists?: () => Promise<PlaylistRow[]>;
  /** Open one of the user's own playlists (full screen). */
  onOpenPlaylist: (id: number) => void;
  /** Jump to the full Browse/charts page. */
  onOpenBrowse: () => void;
  /**
   * Desktop only: open an artist as a full page (via the desktop nav bus)
   * instead of the built-in modal. When omitted (phone), the in-component
   * ArtistDetailModal is used.
   */
  onOpenArtist?: (name: string) => void;
  /**
   * Desktop only: open an album as a full page. When omitted (phone), the
   * in-component AlbumDetailModal is used.
   */
  onOpenAlbum?: (name: string, artist: string | null) => void;
  /**
   * Phone only: open the Settings screen. When provided, a tappable profile
   * avatar appears in the header (Spotify-style). Omitted on desktop, which
   * has Settings in its sidebar.
   */
  onOpenSettings?: () => void;
  /**
   * Called after the feed loads with whether a "Welcome back" win-back shelf
   * was hoisted (imp 8). The shell uses it to show a dot on the Home tab.
   */
  onWinBack?: (v: boolean) => void;
  /** Phone only: bumped when the Home tab is re-tapped, so any open drill-in
   *  (album/artist/playlist detail) closes back to the feed. */
  resetSignal?: number;
  /** Phone only: open the per-song "⋯" bottom sheet for an opened album/
   *  playlist row (same TrackActionSheet the library rows use). Its presence
   *  also arms the row's swipe-to-queue / swipe-to-save gestures. Omitted on
   *  desktop (which drives those from the hover "⋯" menu instead). */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /** Phone only: host-owned swipe-to-queue / swipe-to-save for a catalog row
   *  (resolves the row to a playable/library id first). Paired with
   *  `onShowTrackSheet`; omitted on desktop. */
  onAlbumAddToQueue?: (t: SearchTrackResult) => void;
  onAlbumSaveToLiked?: (t: SearchTrackResult) => void;
  /** Desktop only: opening a mix records a history stop (nav bus), and Back
   *  closes it — mix tiles are enabled by this prop's presence. When omitted
   *  (phone), the mix opens as an inline modal closed with local state. */
  onMixPush?: (snap: HomeDrillSnapshot) => void;
  /** Desktop only: bumped on Back/Forward to replay (or clear) the open mix. */
  mixRestore?: { signal: number; snapshot: HomeDrillSnapshot | null };
  /** Desktop only: close the mix page by routing through history Back. */
  onMixBack?: () => void;
}

/** True if a release date is within the last ~30 days — drives the "New" ribbon
 *  on fresh album tiles (N6). Deliberately TIGHTER than Release Radar's 120-day
 *  window: the radar can surface a few months of catch-up, but a "New" badge has
 *  to mean genuinely new, so it isn't slapped on a four-month-old release. */
function isRecentRelease(releaseDate: string | null | undefined): boolean {
  if (!releaseDate) return false;
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= 30 * 24 * 60 * 60 * 1000;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Honest "Updated …" caption for the header (N6). `ageSecs` is how old the
 *  discovery pool actually is (server-reported): fresh right after a rebuild,
 *  up to a few hours on a warm cache hit. We phrase the real age rather than
 *  always claiming "today" — but stay coarse (no ticking minute counter), since
 *  the per-visit arrangement is fresh regardless and the caption is ambient.
 *  Undefined age (older server) → the honest, non-committal "Updated today". */
function freshnessLabel(ageSecs: number | undefined): string {
  if (ageSecs == null) return 'Updated today';
  if (ageSecs < 10 * 60) return 'Updated just now';
  if (ageSecs < 60 * 60) return `Updated ${Math.round(ageSecs / 60)}m ago`;
  if (ageSecs < 6 * 60 * 60) return `Updated ${Math.round(ageSecs / 3600)}h ago`;
  return 'Updated today';
}

/** Module-level cache of the last home feed per profile. Home unmounts when you
 *  navigate away, so without this every return would re-flash the skeleton while
 *  the (server-cached) feed re-fetches. Seeded into state on mount; refreshed as
 *  the fetches land. Keyed by profile id.
 *
 *  Backed by localStorage (write-through, per profile) so an app RELAUNCH also
 *  paints the last feed instantly — stale-while-revalidate: the fresh fetch
 *  still runs on mount and quietly replaces it. Without this, the module cache
 *  dies with the process and every launch cold-starts into skeletons even
 *  though the server answers in ~30ms. */
const homeFeedCache = new Map<
  string,
  { shelves: HomeShelf[]; playlists: PlaylistRow[] }
>();
const homeCacheKey = (pid: number | null | undefined): string => String(pid ?? '');
const HOME_FEED_LS = 'beetbot.home.feed';
/** Don't resurrect a feed older than this — beyond it, skeletons are more
 *  honest than week-old shelves flashing before the refresh. */
const HOME_FEED_LS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function readHomeFeedLS(
  pid: number | null | undefined,
): { shelves: HomeShelf[]; playlists: PlaylistRow[] } | null {
  try {
    const raw = localStorage.getItem(profileScopedKey(HOME_FEED_LS, pid ?? null));
    if (!raw) return null;
    const v = JSON.parse(raw) as {
      savedAt?: number;
      shelves?: HomeShelf[];
      playlists?: PlaylistRow[];
    };
    if (!Array.isArray(v.shelves) || !Array.isArray(v.playlists)) return null;
    if (!v.savedAt || Date.now() - v.savedAt > HOME_FEED_LS_MAX_AGE_MS) return null;
    return { shelves: v.shelves, playlists: v.playlists };
  } catch {
    return null; // corrupt / private mode — behave like no cache
  }
}

function writeHomeFeedLS(
  pid: number | null | undefined,
  entry: { shelves: HomeShelf[]; playlists: PlaylistRow[] },
): void {
  try {
    localStorage.setItem(
      profileScopedKey(HOME_FEED_LS, pid ?? null),
      JSON.stringify({ savedAt: Date.now(), ...entry }),
    );
  } catch {
    /* quota / private mode — relaunches just keep the skeleton path */
  }
}

/** In-memory first, then the persisted copy (which also re-seeds the Map so
 *  subsequent reads in this session are cheap). */
function getHomeFeedCache(
  pid: number | null | undefined,
): { shelves: HomeShelf[]; playlists: PlaylistRow[] } | null {
  const key = homeCacheKey(pid);
  const m = homeFeedCache.get(key);
  if (m) return m;
  const ls = readHomeFeedLS(pid);
  if (ls) homeFeedCache.set(key, ls);
  return ls;
}

/** Spotify-style loading placeholders — pulsing gray boxes shown on the FIRST
 *  load (cold start), before the feed arrives, instead of a blank page. */
function QuickAccessSkeleton() {
  return (
    <div className="px-4 grid grid-cols-2 gap-2 mb-7 lg:mb-6" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-2 bg-neutral-900/80 rounded-lg overflow-hidden animate-pulse"
        >
          <div className="h-12 w-12 shrink-0 bg-neutral-800" />
          <div className="h-3.5 flex-1 mr-4 rounded bg-neutral-800" />
        </div>
      ))}
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <section className="mb-7 lg:mb-6" aria-hidden>
      {/* ml-4 (not px-4) so the bar is inset like the real title — px-4 would
          be padding INSIDE the fixed-width box, leaving it flush to the edge. */}
      <div className="ml-4 mb-2.5 h-5 w-44 rounded bg-neutral-800 animate-pulse" />
      <div className="flex gap-3 px-4 pb-1 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-32 shrink-0 animate-pulse">
            <div className="h-32 w-32 rounded-lg bg-neutral-800" />
            <div className="mt-2 h-3.5 w-28 rounded bg-neutral-800" />
            <div className="mt-1.5 h-3 w-20 rounded bg-neutral-800" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Adapt a play-log StatTrack into the SearchTrackResult shape the player
 *  expects, flagged as a LOCAL track so it plays straight from the library. */
function statToTrack(t: StatTrack): SearchTrackResult {
  return {
    source: 'local',
    source_id: String(t.track_id),
    title: t.title,
    artists: t.artists,
    album: t.album,
    album_art_url: t.album_art_url,
    duration_ms: t.duration_ms,
    isrc: null,
    local_track_id: t.track_id,
    in_playlist_ids: [],
    // Only history tracks with an imported audio file are playable; the player
    // gates play on has_audio.
    has_audio: t.has_audio ?? false,
    preview_url: null,
    explicit: false,
  };
}

/** A "Made for you" mix lifted out of a shelf into a rail tile + detail page. The
 *  `key` identifies it within the current feed (kind+title). */
export interface MixData {
  key: string;
  title: string;
  eyebrow: string | null;
  tracks: SearchTrackResult[];
  /** Refresh-cadence caption from the server (e.g. "New every Monday"). */
  cadence?: string;
}

/** Desktop history snapshot for an open Home drill-in — either a "Made for you"
 *  mix page OR a catalog (editorial) playlist. Stores the whole payload so
 *  Back/Forward replay is exact and immune to feed refreshes — no lookup against
 *  a possibly-changed feed. Exactly one of `mix` / `playlist` is set. */
export interface HomeDrillSnapshot {
  mix?: MixData;
  playlist?: CatalogPlaylistSummary;
  /** Desktop "Show all" on a big shelf → its full grid as a drill page. */
  shelfGrid?: HomeShelf;
}

/** Convert a rail-tagged shelf (artist-mix track_row, or genre/decade stat_row)
 *  into MixData. Returns null for an empty shelf (no tile). */
function toMixData(shelf: HomeShelf): MixData | null {
  const tracks =
    shelf.kind === 'stat_row'
      ? (shelf.stat_tracks ?? []).map(statToTrack)
      : (shelf.tracks ?? []);
  if (tracks.length === 0) return null;
  return {
    key: `${shelf.kind}:${shelf.title}`,
    title: shelf.title,
    eyebrow: shelf.eyebrow ?? null,
    tracks,
    cadence: shelf.cadence,
  };
}

/** Long-press (≈500ms hold, no drift) → onLongPress. A short tap is unaffected;
 *  a scroll (>10px drift) cancels it. Returns touch handlers + a `fired` ref so
 *  the card's onClick can ignore the tap that follows a long-press. */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const onTouchStart = (e: React.TouchEvent) => {
    fired.current = false;
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    clear();
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, 500);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) clear();
  };
  const onTouchEnd = () => clear();
  return { handlers: { onTouchStart, onTouchMove, onTouchEnd }, fired };
}

/**
 * Personal home — Spotify-inspired. The entire feed comes from one parallel,
 * profile-scoped `/api/home` call that returns an ordered list of typed shelves
 * (history, recommendations, decade/genre mixes, artists, new releases). The
 * client just renders each shelf by its `kind`, so new shelves are a
 * backend-only addition. The quick-access playlist grid is the one exception —
 * it stays client-side because it needs per-playlist art URLs.
 */
export function HomeScreen({
  token,
  activeProfileId,
  refreshKey,
  loadPlaylists,
  onPlayTrack,
  nowPlayingKey,
  nowPlayingTrackId,
  nowPlayingTrack,
  isPlaying,
  onTogglePlay,
  isTrackCurrent,
  onPlayedFrom,
  onOpenPlaylist,
  onOpenBrowse,
  onOpenArtist,
  onOpenAlbum,
  onOpenSettings,
  onWinBack,
  resetSignal,
  onShowTrackSheet,
  onAlbumAddToQueue,
  onAlbumSaveToLiked,
  onMixPush,
  mixRestore,
  onMixBack,
}: Props) {
  // Re-render on hub-reachability changes so the hero card's play gate
  // (canPlayNow below) stays live; TrackCard subscribes on its own.
  useHubReachable();
  // Seed from the per-profile cache (in-memory, falling back to the persisted
  // localStorage copy) so a return visit AND an app relaunch paint instantly
  // (no skeleton flash); a true cold start has no cache → null/[] → skeletons.
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(
    () => getHomeFeedCache(activeProfileId)?.playlists ?? null,
  );
  const [shelves, setShelves] = useState<HomeShelf[]>(
    () => getHomeFeedCache(activeProfileId)?.shelves ?? [],
  );
  // Server-computed greeting (HomeFeed.greeting) — falls back to the local
  // clock until the feed lands and on older bundled servers.
  const [serverGreeting, setServerGreeting] = useState<string | null>(null);
  // Age (secs) of the discovery pool this feed is built from — drives the honest
  // "Updated …" caption (N6). Undefined until the feed lands / on older servers.
  const [feedAgeSecs, setFeedAgeSecs] = useState<number | undefined>(undefined);
  // Whether the shelf feed has resolved at least once (drives the shelf
  // skeleton). Starts true only if the cache actually holds SHELVES — the
  // quick-access playlists loader also writes the cache entry, so merely
  // "entry exists" would skip the skeleton on a return visit made before the
  // first /api/home ever resolved (blank Home instead of loading boxes).
  const [feedLoaded, setFeedLoaded] = useState(() => {
    const cached = getHomeFeedCache(activeProfileId);
    return !!cached && cached.shelves.length > 0;
  });
  const [openArtist, setOpenArtist] = useState<SearchArtistResult | null>(null);
  const [openAlbum, setOpenAlbum] = useState<SearchAlbumResult | null>(null);
  const [openPlaylist, setOpenPlaylist] =
    useState<CatalogPlaylistSummary | null>(null);
  // Open "Made for you" mix detail page (a captured COPY, so a feed refresh
  // under an open page can't yank it out from under the user).
  const [openMix, setOpenMix] = useState<MixData | null>(null);
  // Desktop "Show all" drill: a big shelf's full grid as its own page (a COPY,
  // refresh-proof like the mix page).
  const [openShelfGrid, setOpenShelfGrid] = useState<HomeShelf | null>(null);
  // Re-tapping the Home tab (resetSignal bump) closes any open drill-in back to
  // the feed. Guarded to the first render so the mount pass is a no-op.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setOpenArtist(null);
    setOpenAlbum(null);
    setOpenPlaylist(null);
    setOpenMix(null);
    setOpenShelfGrid(null);
  }, [resetSignal]);
  // Desktop history replay: Back/Forward bumps mixRestore.signal with the drill
  // to show (mix OR playlist, or null to close). Pure state application — never
  // calls onMixPush, so there's no push/restore loop. Runs on mount too, to
  // reopen after a reload.
  useEffect(() => {
    if (mixRestore) {
      setOpenMix(mixRestore.snapshot?.mix ?? null);
      setOpenPlaylist(mixRestore.snapshot?.playlist ?? null);
      setOpenShelfGrid(mixRestore.snapshot?.shelfGrid ?? null);
    }
  }, [mixRestore]);
  // The Show-all page has no in-page Back button — it closes via the app's
  // top-bar Back/Forward. Escape is the keyboard equivalent (parity with the
  // mix/playlist pages), routed through the same history Back so Forward reopens
  // it. The mix/playlist pages own their own Escape (inside AlbumDetailModal).
  useEffect(() => {
    if (!(onOpenArtist && openShelfGrid)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (onMixBack) onMixBack();
      else setOpenShelfGrid(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenArtist, openShelfGrid, onMixBack]);
  // Desktop drill-ins render in-flow, REPLACING the feed. The host's scroll
  // container keeps whatever offset the feed was at, so a fresh page would open
  // mid-scroll (hero cut off, condensed header stuck on). Reset the nearest
  // scrollable ancestor to the top whenever a desktop drill opens.
  const rootRef = useRef<HTMLDivElement>(null);
  const anyDrillOpen = !!openMix || !!openPlaylist || !!openShelfGrid;
  useEffect(() => {
    // `onOpenArtist` present === desktop (same signal as `isDesktop` below).
    if (!(onOpenArtist && anyDrillOpen)) return;
    let el = rootRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        el.scrollTop = 0;
        break;
      }
      el = el.parentElement;
    }
    // Only fire on the open transition — `onOpenArtist` is a fresh inline arrow
    // each render, so depending on it would re-scroll (fighting the user) on
    // every render while a drill is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyDrillOpen]);
  // C2: long-press a track card → add-to-playlist sheet (reuses the search one).
  const [addTrack, setAddTrack] = useState<SearchTrackResult | null>(null);
  // Desktop per-song hover "⋯" menu for an opened drill-in (mix/album/playlist),
  // same as the library playlist + search-album pages. Built here (not host-
  // provided) so it reuses the add-to-playlist picker + nav callbacks we already
  // have. Only wired on desktop (isDesktop); phone uses the ⋯ bottom sheet.
  const [trackMenu, setTrackMenu] = useState<MenuState | null>(null);
  const showTrackMenu = (t: SearchTrackResult, x: number, y: number) => {
    const artist = t.artists[0]?.trim() ?? '';
    const items: MenuItem[] = [
      {
        label: 'Add to playlist',
        icon: MenuGlyphs.addToPlaylist,
        onClick: () => setAddTrack(t),
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
    if (onOpenArtist)
      items.push({
        label: 'Go to artist',
        icon: MenuGlyphs.artist,
        disabled: !artist,
        onClick: () => onOpenArtist(artist),
      });
    setTrackMenu({ x, y, items });
  };
  // Long-press an album/artist card → an action sheet (add-to-library / play).
  const [cardMenu, setCardMenu] = useState<
    | { kind: 'album'; album: SearchAlbumResult }
    | { kind: 'artist'; artist: SearchArtistResult }
    | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  };
  // Active profile — drives the greeting name and the header avatar.
  const [profile, setProfile] = useState<Profile | null>(null);
  const { playingUrl, toggle, stop } = usePreviewPlayer();

  // Resolve the active profile (name for the greeting, avatar for the header).
  useEffect(() => {
    let cancelled = false;
    void getProfiles(token)
      .then((ps) => {
        if (cancelled) return;
        setProfile(ps.find((p) => p.id === activeProfileId) ?? null);
      })
      .catch(() => {
        /* greeting just falls back to no name */
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId]);

  // N1: per-visit selection nonce. The server folds it into its shelf-selection
  // seed and deals a different slice of the day's cached discovery pools. Held
  // in sessionStorage so it's stable for the whole app SESSION (a tab switch
  // back to Home, or a remount, reuses it) — otherwise the cached shelves would
  // paint instantly then reshuffle out from under the user a second later on
  // every open. A pull-to-refresh (refreshKey bump) is the explicit "give me a
  // fresh feed" gesture, so it mints a NEW nonce; a genuinely new session
  // (app reopened) starts fresh because sessionStorage was cleared.
  const visitNonce = useMemo(
    () => {
      const mint = () =>
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const key = `beetbot.home.visit.${activeProfileId ?? 'none'}`;
      try {
        // refreshKey is 0/undefined on a normal mount → reuse the session nonce;
        // a bump (pull-to-refresh) always mints and persists a fresh one.
        if (!refreshKey) {
          const existing = sessionStorage.getItem(key);
          if (existing) return existing;
        }
        const n = mint();
        sessionStorage.setItem(key, n);
        return n;
      } catch {
        return mint(); // Private mode / storage disabled — degrade to per-mount.
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey re-mints; activeProfileId re-keys
    [refreshKey, activeProfileId],
  );

  useEffect(() => {
    let cancelled = false;
    const key = homeCacheKey(activeProfileId);
    const cachePatch = (patch: Partial<{ shelves: HomeShelf[]; playlists: PlaylistRow[] }>) => {
      const prev = homeFeedCache.get(key) ?? { shelves: [], playlists: [] };
      const next = { ...prev, ...patch };
      homeFeedCache.set(key, next);
      // Write-through so the NEXT app launch paints this feed instantly.
      writeHomeFeedLS(activeProfileId, next);
    };
    const load = loadPlaylists ?? (() => listPlaylists(token, activeProfileId));
    void load()
      .then((p) => {
        if (cancelled) return;
        setPlaylists(p);
        cachePatch({ playlists: p });
      })
      .catch(() => {
        // Don't leave it stuck on `null` (which reads as "still loading") — an
        // empty array lets the grid/empty-state resolve. Desktop's IPC loader
        // never lands here; only the phone's HTTP fetch can fail.
        if (!cancelled) setPlaylists((prev) => prev ?? []);
      });
    // The whole shelf feed. The discovery shelves are cached server-side for
    // hours; the history shelves are recomputed fresh on each call. A COLD start
    // can transiently fail — right after launch the server is still warming its
    // caches and under pre-warm load, so a single cold /api/home can error. Retry
    // with backoff instead of giving up and leaving Home empty until the user
    // navigates away and back. The shelf skeleton stays up across retries.
    const fetchHomeWithRetry = async () => {
      const backoffMs = [800, 2000, 4000, 8000];
      for (let attempt = 0; ; attempt++) {
        try {
          return await getHome(token, activeProfileId, visitNonce);
        } catch (err) {
          if (cancelled || attempt >= backoffMs.length) throw err;
          await new Promise((r) => window.setTimeout(r, backoffMs[attempt]));
        }
      }
    };
    void fetchHomeWithRetry()
      .then((h) => {
        if (cancelled) return;
        setShelves(h.shelves);
        setServerGreeting(h.greeting ?? null);
        setFeedAgeSecs(h.discovery_age_secs);
        onWinBack?.(h.welcome_back ?? false);
        setFeedLoaded(true);
        cachePatch({ shelves: h.shelves });
      })
      .catch(() => {
        // All retries failed — clear the skeleton so it doesn't spin forever.
        if (!cancelled) setFeedLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId, refreshKey, visitNonce, loadPlaylists, onWinBack]);

  // Keep "Recently played" LIVE: as the queue advances to a new track, prepend
  // it to that shelf instead of re-fetching the whole feed (which would reshuffle
  // every discovery shelf). The server records the play at track START and would
  // return the same ordering on the next fetch, so this just mirrors it instantly.
  // Dedup by track, cap the length, and skip if it's already at the front.
  useEffect(() => {
    const t = nowPlayingTrack;
    if (!t || t.id == null) return;
    const entry: StatTrack = {
      track_id: t.id,
      title: t.title,
      artists: t.artists,
      album: t.album,
      album_art_url: t.album_art_url,
      duration_ms: t.duration_ms,
      has_audio: t.has_audio,
      count: 1,
    };
    setShelves((prev) => {
      const idx = prev.findIndex(
        (s) => s.kind === 'stat_row' && s.title === 'Recently played',
      );
      if (idx === -1) return prev; // no such shelf in this feed → nothing to do
      const shelf = prev[idx];
      const existing = shelf.stat_tracks ?? [];
      if (existing[0]?.track_id === entry.track_id) return prev; // already first
      const nextTracks = [
        entry,
        ...existing.filter((x) => x.track_id !== entry.track_id),
      ].slice(0, Math.max(existing.length, 12));
      const next = prev.slice();
      next[idx] = { ...shelf, stat_tracks: nextTracks };
      // Persist so a remount before the next fetch keeps the live order.
      const key = homeCacheKey(activeProfileId);
      const merged = {
        ...(homeFeedCache.get(key) ?? { shelves: next, playlists: [] }),
        shelves: next,
      };
      homeFeedCache.set(key, merged);
      writeHomeFeedLS(activeProfileId, merged);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on track id change only
  }, [nowPlayingTrack?.id, activeProfileId]);

  // Liked pinned, then most-recently-played; cap at 8 tiles.
  const quickAccess = useMemo(() => {
    if (!playlists) return [];
    return [...sortPlaylistsByRecent(playlists)]
      .sort((a, b) => (a.source === 'liked' ? 0 : 1) - (b.source === 'liked' ? 0 : 1))
      .slice(0, 8);
  }, [playlists]);

  const openAlbumCard = (al: SearchAlbumResult) => {
    if (onOpenAlbum) {
      onOpenAlbum(al.name, al.artists[0] ?? null);
    } else {
      stop();
      setOpenAlbum(al);
    }
  };
  const openArtistCard = (a: SearchArtistResult) => {
    if (onOpenArtist) {
      onOpenArtist(a.name);
    } else {
      stop();
      setOpenArtist(a);
    }
  };
  const openCatalogPlaylist = (p: CatalogPlaylistSummary) => {
    stop();
    setOpenPlaylist(p);
    // Desktop (onMixPush present): register a nav-history entry so the top-bar
    // Back/Home close it like any other drill-in. Phone leaves it a local
    // overlay with its own close button.
    onMixPush?.({ playlist: p });
  };
  // Card Play buttons: fetch the collection's tracks and seed the queue so it
  // plays straight from the cover without opening the detail page first.
  const playAlbumCard = async (al: SearchAlbumResult) => {
    try {
      const list = await getAlbumTracks(al.source_id, token);
      // Deezer's album tracklist omits the (shared) album cover on each row, so
      // the queued tracks would show a blank cover in Now Playing. Backfill the
      // art + album name from the card we already have — mirrors the same
      // backfill AlbumDetailModal does on its own fetch path.
      const withArt = list.map((t) => ({
        ...t,
        album: t.album || al.name,
        album_art_url: t.album_art_url || al.cover_url,
      }));
      if (withArt.length) {
        // await so the host's setQueue (which clears nowPlayingKey) runs FIRST,
        // then stamp this album as the source — race-free on the async phone path.
        await onPlayTrack(withArt[0], withArt, 0);
        onPlayedFrom?.(`album:${al.source_id}`);
      } else showToast('No playable tracks');
    } catch {
      showToast('Could not play album');
    }
  };
  const playArtistCard = async (a: SearchArtistResult) => {
    try {
      const list = await getArtistTopTracks(a.source_id, token);
      if (list.length) {
        await onPlayTrack(list[0], list, 0);
        onPlayedFrom?.(`artist:${a.source_id}`);
      } else showToast('No playable tracks');
    } catch {
      showToast('Could not play');
    }
  };
  const playPlaylistCard = async (p: CatalogPlaylistSummary) => {
    try {
      const full = await getCatalogPlaylist(p.source_id, token);
      const list = full.tracks ?? [];
      if (list.length) {
        await onPlayTrack(list[0], list, 0);
        onPlayedFrom?.(`playlist:${p.source_id}`);
      } else showToast('No playable tracks');
    } catch {
      showToast('Could not play playlist');
    }
  };
  const banArtistAction = async (name: string) => {
    if (!name.trim()) return;
    try {
      await banArtist(token, activeProfileId, name);
      showToast(`Won't recommend ${name}`);
    } catch {
      showToast('Could not update');
    }
    setCardMenu(null);
  };
  // Which station is currently being assembled ('for-you' | 'deep' | 'fresh'),
  // or null. A cold press pays the fusion fan-out (a few seconds) — without this
  // the button gives no feedback and reads as broken. Also guards double-taps.
  const [stationLoading, setStationLoading] = useState<string | null>(null);
  // The one reserved beet moment: a ~1s crimson glow on the "My station"
  // tile the instant a station ignites (see the beet-ignite keyframe).
  const [igniting, setIgniting] = useState(false);
  const startStation = async (mode?: string) => {
    if (stationLoading) return; // a station is already being built — ignore
    setStationLoading(mode ?? 'for-you');
    try {
      const tracks = await getStation(token, activeProfileId, mode);
      if (tracks.length > 0) {
        onPlayTrack(tracks[0], tracks, 0);
        // Fire the brand pulse only for the main button (no steering mode).
        if (!mode) {
          setIgniting(true);
          setTimeout(() => setIgniting(false), 1000);
        }
      } else {
        showToast('Not enough listening yet for a station');
      }
    } catch {
      showToast("Couldn't start the station");
    } finally {
      setStationLoading(null);
    }
  };

  // Card action: import a whole album into the library (fetch its tracks, then
  // import). Runs in the background server-side; we just toast the result.
  const addAlbumToLibrary = async (al: SearchAlbumResult) => {
    showToast(`Adding “${al.name}”…`);
    try {
      const tracks = await getAlbumTracks(al.source_id, token);
      if (tracks.length === 0) {
        showToast('No songs to add');
        return;
      }
      await importAlbum(al.name, tracks, token, al.artists[0] ?? null, activeProfileId);
      showToast(`Added “${al.name}”`);
    } catch {
      showToast('Couldn’t add album');
    }
  };

  // Card action: play an artist's top tracks straight from Home.
  const playArtist = async (a: SearchArtistResult) => {
    try {
      const tracks = await getArtistTopTracks(a.source_id, token);
      if (tracks.length === 0) {
        showToast('No songs found');
        return;
      }
      stop();
      onPlayTrack(tracks[0], tracks, 0);
    } catch {
      showToast('Couldn’t play artist');
    }
  };

  const renderShelf = (shelf: HomeShelf, idx: number, forceExpand = false) => {
    // Feature the lead shelf with larger cards to break the "row of rows".
    const size = idx === 0 ? 'lg' : 'md';
    // Art heights, so the shelves' hover arrows center on the cover (not the
    // taller card): square covers (album/track/playlist) vs the round artist.
    // `mt-4` offsets the arrow past the scroller's py-4 top (which gives the
    // cards' -inset-3 hover highlight room), so it lands on the cover.
    const artClass = size === 'lg' ? 'mt-4 h-40' : 'mt-4 h-32';
    const artistArtClass = size === 'lg' ? 'mt-4 h-36' : 'mt-4 h-28';
    // Desktop: a big shelf's "Show all" opens its full grid as a drill PAGE
    // instead of unfolding in place (a 30-item in-place expand is a wall). Phone
    // keeps the in-place expand. `forceExpand` (set when rendering the page
    // itself) shows the full grid with no toggle button.
    const itemCount =
      (shelf.tracks?.length ?? 0) +
      (shelf.albums?.length ?? 0) +
      (shelf.stat_tracks?.length ?? 0) +
      (shelf.artists?.length ?? 0) +
      (shelf.playlists?.length ?? 0);
    const shelfExtra: { onShowAll?: () => void; forceExpand?: boolean } = forceExpand
      ? { forceExpand: true }
      : isDesktop && itemCount > 12 && onMixPush
        ? {
            onShowAll: () => {
              setOpenShelfGrid(shelf);
              onMixPush({ shelfGrid: shelf });
            },
          }
        : {};
    // Spotlight (P4): the server marks exactly one discovery track_row per visit
    // as the mid-feed band. Checked BEFORE the hero so it wins even at idx 0
    // (both are full-width). The band replaces the whole row; Play seeds the
    // shelf's list.
    if (shelf.display === 'spotlight' && shelf.kind === 'track_row') {
      const list = shelf.tracks ?? [];
      if (list.length === 0) return null;
      const head = list[0];
      const spotKey = `spotlight:${shelf.title}`;
      // Description: N songs · first 3 distinct artists.
      const distinctArtists: string[] = [];
      for (const t of list) {
        const a = t.artists[0];
        if (a && !distinctArtists.includes(a)) distinctArtists.push(a);
        if (distinctArtists.length >= 3) break;
      }
      const desc = `${list.length} songs${
        distinctArtists.length ? ` · ${distinctArtists.join(', ')}` : ''
      }`;
      // Render through the same HeroCard as the idx-0 lead so the two hero
      // banners are visually identical (full-bleed art + scrim + round stateful
      // play button + hover ring), just with shelf-level title/description.
      return (
        <section key={`spot:${idx}:${shelf.title}`} className="px-4 mb-7 lg:mb-6">
          <HeroCard
            cover={head.album_art_url ?? null}
            eyebrow={shelf.eyebrow ?? 'In the spotlight'}
            title={shelf.title}
            subtitle={desc}
            onClick={async () => {
              await onPlayTrack(list[0], list, 0);
              onPlayedFrom?.(spotKey);
            }}
            disabled={!canPlayNow(head)}
            active={nowPlayingKey === spotKey}
            isPlaying={!!isPlaying}
            onToggle={onTogglePlay}
          />
        </section>
      );
    }
    // Lead shelf: spotlight the top pick as a full-width hero card, then the
    // rest as a normal row. Applies to the common lead kinds (daypart / win-back
    // / discovery tracks); other lead kinds fall through to the standard row.
    if (idx === 0 && (shelf.kind === 'stat_row' || shelf.kind === 'track_row')) {
      const list =
        shelf.kind === 'stat_row'
          ? (shelf.stat_tracks ?? []).map(statToTrack)
          : (shelf.tracks ?? []);
      if (list.length === 0) return null;
      const [head, ...rest] = list;
      return (
        <section key={`hero:${idx}:${shelf.title}`} className="mb-7 lg:mb-6">
          {shelf.eyebrow ? (
            <p className="px-4 text-[11px] uppercase tracking-wide text-neutral-500">
              {shelf.eyebrow}
            </p>
          ) : null}
          <h2 className="px-4 mb-2.5 lg:mb-4 text-lg lg:text-2xl font-bold tracking-tight">{shelf.title}</h2>
          <div className="px-4 mb-3">
            <HeroCard
              cover={head.album_art_url ?? null}
              title={head.title}
              subtitle={head.artists.join(', ')}
              onClick={async () => {
                await onPlayTrack(head, list, 0);
                onPlayedFrom?.(`hero:${shelf.title}`);
              }}
              disabled={!canPlayNow(head)}
              active={nowPlayingKey === `hero:${shelf.title}`}
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
            />
          </div>
          {rest.length > 0 ? (
            <div className="-my-4">
            <ShelfRow artClass="mt-4 h-32" scrollerClassName="flex gap-4 lg:gap-6 overflow-x-auto overflow-y-clip px-4 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {rest.map((t, i) => (
                <TrackCard
                  key={`${shelf.kind}:${i}:${t.source_id}`}
                  track={t}
                  onClick={() => onPlayTrack(t, list, i + 1)}
                  onLongPress={() => setAddTrack(t)}
                  active={
                    nowPlayingTrackId != null &&
                    t.local_track_id === nowPlayingTrackId
                  }
                  isPlaying={!!isPlaying}
                  onToggle={onTogglePlay}
                />
              ))}
            </ShelfRow>
            </div>
          ) : null}
        </section>
      );
    }
    if (shelf.kind === 'album_row') {
      const albums = shelf.albums ?? [];
      if (albums.length === 0) return null;
      return (
        <Shelf key={`${shelf.kind}:${idx}:${shelf.title}`} title={shelf.title} eyebrow={shelf.eyebrow} artClass={artClass} {...shelfExtra}>
          {albums.map((al) => (
            <AlbumCard
              key={`${al.source}:${al.source_id}`}
              album={al}
              size={size}
              onClick={() => openAlbumCard(al)}
              onPlay={() => playAlbumCard(al)}
              onLongPress={() => setCardMenu({ kind: 'album', album: al })}
              active={nowPlayingKey === `album:${al.source_id}`}
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
            />
          ))}
        </Shelf>
      );
    }
    if (shelf.kind === 'artist_row') {
      const artists = shelf.artists ?? [];
      if (artists.length === 0) return null;
      return (
        <Shelf key={`${shelf.kind}:${idx}:${shelf.title}`} title={shelf.title} eyebrow={shelf.eyebrow} artClass={artistArtClass} {...shelfExtra}>
          {artists.map((a) => (
            <ArtistCard
              key={`${a.source}:${a.source_id}`}
              artist={a}
              size={size}
              onClick={() => openArtistCard(a)}
              onPlay={() => playArtistCard(a)}
              onLongPress={() => setCardMenu({ kind: 'artist', artist: a })}
              active={nowPlayingKey === `artist:${a.source_id}`}
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
            />
          ))}
        </Shelf>
      );
    }
    if (shelf.kind === 'stat_row') {
      // Local library tracks — adapt to the player shape, seed the shelf as
      // the queue so tapping plays down the row.
      const list = (shelf.stat_tracks ?? []).map(statToTrack);
      if (list.length === 0) return null;
      return (
        <Shelf key={`${shelf.kind}:${idx}:${shelf.title}`} title={shelf.title} eyebrow={shelf.eyebrow} artClass={artClass} {...shelfExtra}>
          {list.map((t, i) => (
            <TrackCard
              key={`local:${t.source_id}`}
              track={t}
              size={size}
              onClick={() => onPlayTrack(t, list, i)}
              onLongPress={() => setAddTrack(t)}
              active={
                nowPlayingTrackId != null &&
                t.local_track_id === nowPlayingTrackId
              }
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
            />
          ))}
        </Shelf>
      );
    }
    if (shelf.kind === 'playlist_row') {
      const playlists = shelf.playlists ?? [];
      if (playlists.length === 0) return null;
      return (
        <Shelf
          key={`${shelf.kind}:${idx}:${shelf.title}`}
          title={shelf.title}
          eyebrow={shelf.eyebrow}
          artClass={artClass}
          {...shelfExtra}
        >
          {playlists.map((p) => (
            <PlaylistCard
              key={`${p.source}:${p.source_id}`}
              playlist={p}
              onOpen={openCatalogPlaylist}
              onPlay={() => playPlaylistCard(p)}
              active={nowPlayingKey === `playlist:${p.source_id}`}
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
              className={`${size === 'lg' ? 'w-40' : 'w-32'} shrink-0`}
            />
          ))}
        </Shelf>
      );
    }
    if (shelf.kind === 'track_row') {
      const tracks = shelf.tracks ?? [];
      if (tracks.length === 0) return null;
      return (
        <Shelf
          key={`${shelf.kind}:${idx}:${shelf.title}`}
          title={shelf.title}
          eyebrow={shelf.eyebrow}
          artClass={artClass}
          {...shelfExtra}
        >
          {tracks.map((t, i) => (
            <TrackCard
              key={`${t.source}:${t.source_id}`}
              track={t}
              size={size}
              onClick={() => onPlayTrack(t, tracks, i)}
              onLongPress={() => setAddTrack(t)}
              active={
                nowPlayingTrackId != null &&
                t.local_track_id === nowPlayingTrackId
              }
              isPlaying={!!isPlaying}
              onToggle={onTogglePlay}
            />
          ))}
        </Shelf>
      );
    }
    // Unknown kind — e.g. a forward-deployed playlist_row/hero this shell doesn't
    // render yet. Render nothing rather than mis-rendering as a track row, so the
    // server can ship a new kind ahead of a not-yet-updated client.
    return null;
  };

  // Desktop supplies the nav-bus openers; the phone omits them and uses inline
  // modals. Drives tile sizing + hover affordances.
  const isDesktop = !!onOpenArtist;

  // Mix tiles: always on the phone; on desktop only once the host wires the
  // nav-history mix page (onMixPush). When enabled, the rail-tagged mix shelves
  // become tiles and STOP rendering as rows (declutter); otherwise they stay
  // rows and the rail is stations-only.
  const mixTilesEnabled = !isDesktop || !!onMixPush;
  const railMixes = mixTilesEnabled
    ? (shelves.filter((s) => s.display === 'rail').map(toMixData).filter(Boolean) as MixData[])
    : [];
  const rows = mixTilesEnabled ? shelves.filter((s) => s.display !== 'rail') : shelves;

  // Representative artwork for the station tiles (they have no cover of their
  // own): My station leans on YOUR library (stat_row arts), Discovery on the
  // catalog picks (track_row arts); each falls back to the other so a thin feed
  // still shows a collage. CollageCover dedupes + takes the first 4.
  const collect = (kind: string) =>
    shelves
      .filter((s) => s.kind === kind)
      .flatMap((s) =>
        kind === 'stat_row'
          ? (s.stat_tracks ?? []).map((t) => t.album_art_url)
          : (s.tracks ?? []).map((t) => t.album_art_url),
      )
      .filter((u): u is string => !!u)
      .slice(0, 12);
  const statArts = collect('stat_row');
  const trackArts = collect('track_row');
  const myStationArts = statArts.length ? statArts : trackArts;
  const discoveryStationArts = trackArts.length ? trackArts : statArts;

  // "Made for you" rail: two endless stations then the daily mixes as portrait
  // tiles. Spliced into the feed after the second shelf so the page opens with a
  // hero + one shelf, then this personal tier.
  const madeForYouRail = (
    <MadeForYouRail key="made-for-you-rail">
      <StationTile
        variant="my"
        loading={stationLoading === 'for-you'}
        igniting={igniting}
        desktop={isDesktop}
        arts={myStationArts}
        onPress={() => void startStation()}
      />
      <StationTile
        variant="discovery"
        loading={stationLoading === 'fresh'}
        desktop={isDesktop}
        arts={discoveryStationArts}
        onPress={() => void startStation('fresh')}
      />
      {railMixes.map((mix) => (
        <MixTile
          key={mix.key}
          mix={mix}
          cadence={mix.cadence ?? 'New every day'}
          desktop={isDesktop}
          onOpen={() => {
            // Show the page now; on desktop also record the history stop (the
            // push doesn't restore — same "record without restoring" convention
            // as the search/Discover drills).
            setOpenMix(mix);
            onMixPush?.({ mix });
          }}
          onPlay={() => onPlayTrack(mix.tracks[0], mix.tracks, 0)}
        />
      ))}
    </MadeForYouRail>
  );

  return (
    <div ref={rootRef} className="min-h-full bg-transparent text-neutral-100 pb-28">
      {/* On desktop, an open drill-in (mix page OR catalog playlist) renders
          inline (in-flow) and REPLACES the feed, so the global top-bar Back
          reveals what's underneath. The phone keeps the feed and overlays the
          drill as a fixed modal (in the modals block below). */}
      {!(isDesktop && (openMix || openPlaylist || openShelfGrid)) && (
        <>
      <div
        // Phone only (onOpenSettings is omitted on desktop): a sticky, frosted
        // header so the greeting/Browse stay put and content tucks under it
        // instead of bleeding past the status bar in the standalone PWA.
        // z-10 (not z-20): stays above Home's shelf cards, but sits BELOW a
        // drill-in detail page (also z-10, rendered later) so opening an album/
        // playlist from Home covers this header + reveals the page's back
        // chevron — while the bottom nav (z-20) stays on top.
        className={`px-4 pt-5 pb-3 flex items-center justify-between gap-3 ${
          onOpenSettings ? 'sticky top-0 z-10 bg-neutral-950/70 backdrop-blur-xl' : ''
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Settings"
              className="h-9 w-9 shrink-0 rounded-full overflow-hidden active:opacity-80"
            >
              {profile?.avatar_path ? (
                <img
                  src={profileAvatarUrl(profile.id, token)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span
                  className="h-full w-full grid place-items-center text-sm font-semibold text-white"
                  style={{ backgroundColor: profile?.avatar_color ?? '#3f3f46' }}
                >
                  {(profile?.name ?? '?').trim().charAt(0).toUpperCase() || '?'}
                </span>
              )}
            </button>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight truncate">
              {serverGreeting ?? greeting()}
              {profile?.name ? `, ${profile.name}` : ''}
            </h1>
            {/* Apple-style caption: lives with the title it describes rather
                than floating between sections. Honest freshness from the real
                discovery-pool age (N6), not a hardcoded "today". */}
            {feedLoaded && shelves.length > 0 && (
              <p className="text-xs text-neutral-500">{freshnessLabel(feedAgeSecs)}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenBrowse}
          className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-neutral-700 text-neutral-300 active:bg-neutral-800"
        >
          Browse
        </button>
      </div>

      {playlists === null && <QuickAccessSkeleton />}

      {quickAccess.length > 0 && (
        <div className="px-4 grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 mb-7 lg:mb-6">
          {quickAccess.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpenPlaylist(p.id)}
              className="group flex items-center gap-2 overflow-hidden rounded-lg bg-neutral-900/80 text-left transition-colors duration-200 hover:bg-neutral-800 active:bg-neutral-800"
            >
              <div className="h-12 w-12 shrink-0 bg-neutral-800">
                {p.source === 'liked' ? (
                  <LikedTile />
                ) : (
                  <img
                    src={playlistArtUrl(p.id, token)}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                    loading="lazy"
                  />
                )}
              </div>
              <Marquee text={p.name} className="min-w-0 flex-1 pr-2 text-sm font-medium" />
            </button>
          ))}
        </div>
      )}

      {rows.length > 0 ? (
        // Splice the "Made for you" rail in after the second shelf (hero + one
        // row), so the page opens with content then hits the personal tier.
        // `rows` has the mix shelves removed when tiles are on, so the hero
        // (idx 0) still lands on the daypart / win-back shelf.
        rows.flatMap((shelf, i) => {
          const node = renderShelf(shelf, i);
          return i === Math.min(1, rows.length - 1) ? [node, madeForYouRail] : [node];
        })
      ) : feedLoaded ? (
        // Feed resolved but empty (thin library): still offer the stations.
        madeForYouRail
      ) : (
        // Cold start: a few pulsing placeholder shelves until the feed lands.
        <>
          <ShelfSkeleton />
          <ShelfSkeleton />
          <ShelfSkeleton />
        </>
      )}

      {feedLoaded &&
        playlists !== null &&
        shelves.length === 0 &&
        quickAccess.length === 0 && (
          <div className="px-4 mt-10 text-sm text-neutral-500">
            Once you&apos;ve added music to your library and played a few tracks,
            your recent and most-played picks show up here.
          </div>
        )}
        </>
      )}

      {openArtist && (
        <ArtistDetailModal
          token={token}
          artist={openArtist}
          onClose={() => {
            stop();
            setOpenArtist(null);
          }}
          onPickAlbum={setOpenAlbum}
          onPickTrack={onPlayTrack}
          onPlay={onPlayTrack}
          onPickArtist={(a) => {
            stop();
            setOpenArtist(a);
          }}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
        />
      )}
      {openAlbum && (
        <AlbumDetailModal
          token={token}
          album={openAlbum}
          activeProfileId={activeProfileId}
          onClose={() => {
            stop();
            setOpenAlbum(null);
          }}
          onPickTrack={onPlayTrack}
          onPlay={onPlayTrack}
          // Phone: "⋯" bottom sheet + swipe-to-queue / swipe-to-save, matching
          // the library page. Absent on desktop (uses the hover "⋯" menu).
          onShowTrackSheet={onShowTrackSheet}
          onQueueTrack={onAlbumAddToQueue}
          onSaveTrack={onAlbumSaveToLiked}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
        />
      )}
      {openPlaylist && (
        <PlaylistDetailModal
          token={token}
          playlist={openPlaylist}
          activeProfileId={activeProfileId}
          inline={isDesktop}
          onClose={() => {
            stop();
            // Desktop: close by routing through history Back so the entry pops
            // and the restore clears the page (never an in-place null — the nav
            // convention). Phone: local overlay close.
            if (onMixBack) onMixBack();
            else setOpenPlaylist(null);
          }}
          onPickTrack={onPlayTrack}
          onPlay={onPlayTrack}
          onShowTrackSheet={onShowTrackSheet}
          onQueueTrack={onAlbumAddToQueue}
          onSaveTrack={onAlbumSaveToLiked}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
        />
      )}
      {openMix && (
        <MixDetailModal
          token={token}
          mix={openMix}
          activeProfileId={activeProfileId}
          inline={isDesktop}
          onClose={() => {
            stop();
            // Desktop: close by routing through history Back, so the entry pops
            // and the restore clears the page (never an in-place null). Phone:
            // local close.
            if (onMixBack) onMixBack();
            else setOpenMix(null);
          }}
          onPickTrack={onPlayTrack}
          onPlay={onPlayTrack}
          onShowTrackSheet={onShowTrackSheet}
          // Desktop: the per-song hover "⋯" menu (Add to playlist / Favorites /
          // queue / Go to artist), same as the library playlist page. Phone folds
          // it into the ⋯ bottom sheet (onShowTrackSheet) instead.
          onShowTrackMenu={isDesktop ? showTrackMenu : undefined}
          onQueueTrack={onAlbumAddToQueue}
          onSaveTrack={onAlbumSaveToLiked}
          onGoToArtist={onOpenArtist}
          onGoToAlbum={onOpenAlbum}
          // Now-playing awareness, same as the library playlist page: equalizer
          // bars + row highlight on the current track, and a ⏸/▶ hero that
          // toggles instead of restarting. The host builds `isTrackCurrent` from
          // the REAL current track (a mix's rows are catalog tracks, so it matches
          // on id OR isrc OR title+artist — a plain id check would never light up
          // the playing row). NB: `nowPlayingTrack` here is the last LOGGED play
          // (feeds Recently-played), not the current track, so it can't be used.
          isTrackCurrent={isTrackCurrent}
          isPlaying={!!isPlaying}
          onTogglePlay={onTogglePlay}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
        />
      )}
      {/* Desktop "Show all" drill: the big shelf's full grid, replacing the feed
          (in-flow, so the top-bar Back reveals what's underneath — same as the
          mix page). No in-page Back button: the app's global top-bar Back/Forward
          (and Escape below) close it, matching the mix/playlist drill pages. */}
      {isDesktop && openShelfGrid && (
        <div className="pt-2">{renderShelf(openShelfGrid, 1, true)}</div>
      )}
      {addTrack && (
        <AddToPlaylistModal
          token={token}
          track={addTrack}
          activeProfileId={activeProfileId}
          onClose={() => setAddTrack(null)}
        />
      )}
      {trackMenu && (
        <ContextMenu state={trackMenu} onClose={() => setTrackMenu(null)} />
      )}
      {cardMenu && (
        <ActionSheet
          title={cardMenu.kind === 'album' ? cardMenu.album.name : cardMenu.artist.name}
          subtitle={
            cardMenu.kind === 'album' ? cardMenu.album.artists.join(', ') : 'Artist'
          }
          actions={
            cardMenu.kind === 'album'
              ? [
                  {
                    label: 'Add to library',
                    onClick: () => void addAlbumToLibrary(cardMenu.album),
                  },
                  { label: 'Open album', onClick: () => openAlbumCard(cardMenu.album) },
                  {
                    label: "Don't recommend this artist",
                    onClick: () =>
                      void banArtistAction(cardMenu.album.artists[0] ?? ''),
                  },
                ]
              : [
                  { label: 'Play', onClick: () => void playArtist(cardMenu.artist) },
                  {
                    label: 'Go to artist',
                    onClick: () => openArtistCard(cardMenu.artist),
                  },
                  {
                    label: "Don't recommend",
                    onClick: () => void banArtistAction(cardMenu.artist.name),
                  },
                ]
          }
          onClose={() => setCardMenu(null)}
        />
      )}
      {toast && <Toast message={toast} />}
    </div>
  );
}

/** Bottom-sheet list of actions for a long-pressed card. */
function ActionSheet({
  title,
  subtitle,
  actions,
  onClose,
}: {
  title: string;
  subtitle?: string;
  actions: { label: string; onClick: () => void }[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative bg-neutral-900 rounded-t-2xl px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-neutral-700" />
        <div className="px-1 mb-2">
          <div className="text-sm font-semibold text-neutral-100 truncate">{title}</div>
          {subtitle && (
            <div className="text-xs text-neutral-500 truncate">{subtitle}</div>
          )}
        </div>
        <ul className="flex flex-col">
          {actions.map((a) => (
            <li key={a.label}>
              <button
                type="button"
                onClick={() => {
                  a.onClick();
                  onClose();
                }}
                className="w-full text-left py-3 px-1 rounded-lg active:bg-neutral-800 text-sm text-neutral-100"
              >
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

/** Transient toast above the player bar (action feedback). */
function Toast({ message }: { message: string }) {
  return createPortal(
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 6rem)' }}
    >
      <div className="bg-neutral-800/95 backdrop-blur text-neutral-100 text-sm px-4 py-2 rounded-full shadow-lg ring-1 ring-white/10">
        {message}
      </div>
    </div>,
    document.body,
  );
}

/** A "Made for you" rail: a horizontally scrolling row of portrait tiles under
 *  one uniform shelf header. Holds the two station tiles (and, from P3, the mix
 *  tiles as children). */
function MadeForYouRail({ children }: { children: ReactNode }) {
  return (
    <section className="mb-7 lg:mb-6">
      <h2 className="px-4 mb-2.5 lg:mb-4 text-lg lg:text-2xl font-bold tracking-tight">Made for you</h2>
      {/* No scroll-snap here: `snap-x` + `snap-start` made the browser scroll past
          the px-4 left padding to align the first tile, so tiles sat flush at the
          edge (unlike every other shelf). Plain overflow matches the shelves.
          ShelfRow adds the same desktop hover ‹ › arrows as the shelves. */}
      <ShelfRow scrollerClassName="flex gap-3 overflow-x-auto overscroll-x-contain px-4 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </ShelfRow>
    </section>
  );
}

/** The play button used on rail tiles — same look/position as the album-card
 *  `CardPlayButton` (white circle, bottom-right, drop shadow). Hover-reveals on
 *  desktop; always visible on phone (where there's no hover and tapping the tile
 *  opens rather than plays, so the button is the direct-play affordance). */
function TilePlayButton({
  label,
  desktop,
  onPlay,
}: {
  label: string;
  desktop?: boolean;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onPlay();
      }}
      className={`absolute bottom-2 right-2 grid h-10 w-10 place-items-center rounded-full bg-white text-neutral-950 shadow-[0_8px_16px_rgba(0,0,0,0.5)] transition duration-200 ease-out hover:scale-105 active:scale-95 ${
        desktop
          ? 'opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0'
          : ''
      }`}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
        <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
      </svg>
    </button>
  );
}

/** An endless-station tile (portrait 3:4): "My station" (your for-you blend, with
 *  the reserved beet-ignite glow) or "Discovery station" (all-new, mode 'fresh').
 *  Shows a collage of representative artwork under a branded (crimson / indigo)
 *  wash so it reads as a station, not an album. Tapping the tile — or the play
 *  button — starts the station immediately (there's no detail page for a
 *  never-ending radio). */
function StationTile({
  variant,
  loading,
  igniting,
  desktop,
  arts,
  onPress,
}: {
  variant: 'my' | 'discovery';
  loading: boolean;
  igniting?: boolean;
  desktop?: boolean;
  arts: string[];
  onPress: () => void;
}) {
  const my = variant === 'my';
  const label = my ? 'Play My station' : 'Play Discovery station';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!loading) onPress();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !loading) {
          e.preventDefault();
          onPress();
        }
      }}
      aria-label={label}
      aria-busy={loading}
      className={`group relative shrink-0 aspect-[3/4] overflow-hidden rounded-2xl ring-1 ring-white/10 cursor-pointer transition-transform active:scale-[0.98] ${
        desktop ? 'w-[200px] hover:ring-white/25' : 'w-[55vw] max-w-[240px]'
      }`}
    >
      <CollageCover urls={arts} className="absolute inset-0 h-full w-full" />
      {/* Branded wash: a full-tile tint (so the station reads crimson / indigo
          over the collage) plus a heavier bottom gradient for the label. */}
      <span
        aria-hidden
        className={`absolute inset-0 ${my ? 'bg-rose-950/55' : 'bg-indigo-950/55'}`}
      />
      <span
        aria-hidden
        className={`absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t ${
          my ? 'from-rose-950/95' : 'from-indigo-950/95'
        } to-transparent`}
      />
      {my && igniting ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-[beet-ignite_1s_ease-out]"
        />
      ) : null}
      {loading ? (
        <span className="absolute inset-0 grid place-items-center text-white/90">
          <svg className="animate-spin" width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
      ) : (
        <TilePlayButton label={label} desktop={desktop} onPlay={onPress} />
      )}
      <span className="absolute inset-x-0 bottom-0 p-3 pr-14">
        <span className="block text-[15px] font-semibold text-white">
          {my ? 'My station' : 'Discovery station'}
        </span>
        <span className="block text-[11.5px] text-white/80">
          {loading ? 'Starting…' : 'Endless'}
        </span>
      </span>
    </div>
  );
}

/** A "Made for you" mix tile (portrait 3:4): a 2×2 collage cover tinted from its
 *  own artwork, the mix title + a cadence caption inside the bottom, and a play
 *  button (always shown on phone, hover-revealed on desktop) that starts the mix
 *  without opening. Tapping the tile opens the mix detail page. */
function MixTile({
  mix,
  cadence,
  desktop,
  onOpen,
  onPlay,
}: {
  mix: MixData;
  cadence: string;
  desktop?: boolean;
  onOpen: () => void;
  onPlay: () => void;
}) {
  const arts = mix.tracks
    .map((t) => t.album_art_url)
    .filter((u): u is string => !!u);
  const [tint, setTint] = useState<string | null>(null);
  const seed = arts[0];
  useEffect(() => {
    let alive = true;
    if (seed) {
      void extractDominantColor(seed).then((rgb) => {
        if (alive && rgb) setTint(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
      });
    }
    return () => {
      alive = false;
    };
  }, [seed]);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open ${mix.title}`}
      className={`group relative shrink-0 aspect-[3/4] overflow-hidden rounded-2xl ring-1 ring-white/10 cursor-pointer transition-transform active:scale-[0.98] ${
        desktop ? 'w-[200px] hover:ring-white/25' : 'w-[55vw] max-w-[240px]'
      }`}
    >
      <CollageCover urls={arts} className="absolute inset-0 h-full w-full" />
      {/* Artwork-tint wash + black scrim so the label stays legible. */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-2/3"
        style={{
          background: tint
            ? `linear-gradient(to top, ${tint} 0%, transparent 100%)`
            : 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
        }}
      />
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent"
      />
      <TilePlayButton label={`Play ${mix.title}`} desktop={desktop} onPlay={onPlay} />
      {/* pr-14 keeps a long title from running under the play button. */}
      <span className="absolute inset-x-0 bottom-0 p-3 pr-14">
        <span className="block text-[15px] font-semibold leading-tight text-white line-clamp-2">
          {mix.title}
        </span>
        <span className="mt-0.5 block text-[11.5px] text-white/70">{cadence}</span>
      </span>
    </div>
  );
}

function Shelf({
  title,
  eyebrow,
  artClass,
  children,
  onShowAll,
  forceExpand,
}: {
  title: string;
  eyebrow?: string | null;
  /** Artwork height (e.g. "h-32") so the hover arrows center on the cover, not
   *  the taller card (art + title). */
  artClass?: string;
  children: ReactNode;
  /** Desktop: open the full grid as its own drill page instead of expanding in
   *  place (avoids a huge in-place unfold). When absent, "Show all" expands. */
  onShowAll?: () => void;
  /** Render the full wrapping grid with no toggle — used on the drill page. */
  forceExpand?: boolean;
}) {
  // "Show all" flips the scroll row into a wrapping grid (same pattern as
  // Discover's shelves). Only offered when there's actually more to see.
  const [expanded, setExpanded] = useState(false);
  const count = Children.count(children);
  const showGrid = forceExpand || expanded;
  return (
    <section className="mb-7 lg:mb-6">
      <div className="px-4 mb-2.5 lg:mb-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-lg lg:text-2xl font-bold tracking-tight truncate">{title}</h2>
        </div>
        {count > 4 && !forceExpand && (
          <button
            type="button"
            onClick={onShowAll ?? (() => setExpanded((v) => !v))}
            className="shrink-0 pb-0.5 text-xs font-medium text-neutral-400 hover:text-neutral-100 active:text-neutral-100"
          >
            {onShowAll ? 'Show all' : expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      {showGrid ? (
        <div className="px-4 py-4 -my-4 flex flex-wrap gap-4 lg:gap-6">{children}</div>
      ) : (
        // Same Apple-Music-style hover ‹ › arrows as the artist page (ShelfRow,
        // shared). Desktop-only (sm:flex); the phone still swipes. The scroller
        // keeps py-4 so the cards' -inset-3 hover highlight fits inside it (no
        // vertical overflow → no stray scroll, no clipped shadow); the -my-4
        // goes on THIS outer wrapper, NOT the scroller — a negative margin on
        // the scroller collapses ShelfRow's positioning box and kills the arrows.
        <div className="-my-4">
          <ShelfRow artClass={artClass} scrollerClassName="flex gap-4 lg:gap-6 overflow-x-auto overflow-y-clip px-4 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {children}
          </ShelfRow>
        </div>
      )}
    </section>
  );
}

/** Full-width spotlight card for the lead shelf's top pick — breaks the
 *  row-of-cards grid and answers "where do I start". */
function HeroCard({
  cover,
  eyebrow,
  title,
  subtitle,
  onClick,
  disabled = false,
  active = false,
  isPlaying = false,
  onToggle,
}: {
  cover: string | null;
  eyebrow?: string | null;
  title: string;
  subtitle?: string | null;
  onClick: () => void;
  /** Non-downloaded lead track + hub unreachable → dim + inert (banner explains). */
  disabled?: boolean;
  /** This hero is the active playback source → the round button flips to Pause
   *  and clicking the card toggles play/pause instead of restarting. */
  active?: boolean;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={
        disabled ? undefined : active && onToggle ? onToggle : onClick
      }
      className={`group relative block w-full overflow-hidden rounded-2xl text-left ring-2 ring-transparent transition duration-200 hover:ring-white/25 active:scale-[0.99] ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {/* Blurred, enlarged copy of the cover fills the banner — the crop reads
          as ambient colour/texture, not a cut-off image (Apple-Music-style), so
          the SHARP square cover below is never cropped. */}
      {cover ? (
        <img
          src={cover}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 bg-neutral-800" />
      )}
      <div className="absolute inset-0 bg-black/50" />
      {/* Content: sharp full square cover · text · round play/pause button. */}
      <div className="relative flex items-center gap-4 p-4">
        <div className="h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-neutral-800 shadow-lg ring-1 ring-white/10 sm:h-36 sm:w-36">
          {cover ? (
            <img
              src={cover}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="mb-0.5 text-[11px] text-white/70">{eyebrow}</div>
          ) : null}
          <div className="line-clamp-2 text-2xl font-bold tracking-tight leading-tight text-white">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-1 line-clamp-1 text-xs text-white/70">{subtitle}</div>
          ) : null}
        </div>
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white text-neutral-950 shadow-[0_8px_16px_rgba(0,0,0,0.45)] transition duration-200 group-hover:scale-105 group-active:scale-95">
          {active && isPlaying ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
            </svg>
          )}
        </div>
      </div>
    </button>
  );
}

/** A square track card (album art + title + artists). Used for both local
 *  play-log shelves and external catalog shelves. Long-press opens the
 *  add-to-playlist sheet (Spotify-style inline card action). */
function TrackCard({
  track,
  onClick,
  onPlay,
  onLongPress,
  size = 'md',
  active = false,
  isPlaying = false,
  onToggle,
}: {
  track: SearchTrackResult;
  onClick: () => void;
  onPlay?: () => void;
  onLongPress?: () => void;
  size?: 'md' | 'lg';
  /** This track is the current track → persistent play/pause (follows the
   *  queue as it advances). */
  active?: boolean;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  const lp = useLongPress(() => onLongPress?.());
  // Re-render on hub-reachability changes; a non-downloaded track can't start
  // its live stream while the desktop is unreachable, so its card dims + stops
  // playing on tap (the connection banner explains why).
  useHubReachable();
  const playableNow = canPlayNow(track);
  const box = size === 'lg' ? 'w-40' : 'w-32';
  const art = size === 'lg' ? 'h-40 w-40' : 'h-32 w-32';
  const activate = () => {
    if (lp.fired.current) {
      lp.fired.current = false;
      return;
    }
    if (!playableNow) return;
    onClick();
  };
  return (
    <div
      role="button"
      tabIndex={playableNow ? 0 : -1}
      aria-disabled={!playableNow || undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && playableNow) {
          e.preventDefault();
          onClick();
        }
      }}
      {...(onLongPress ? lp.handlers : {})}
      className={`group relative ${box} shrink-0 text-left transition duration-200 active:scale-[0.98] ${
        playableNow ? 'cursor-pointer' : 'cursor-default opacity-50'
      }`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-3 rounded-2xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className={`relative ${art}`}>
          <div className="h-full w-full overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {track.album_art_url ? (
              <img
                src={track.album_art_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : null}
          </div>
          {playableNow || active ? (
            <CardPlayButton
              label={`Play ${track.title}`}
              onPlay={active && onToggle ? onToggle : (onPlay ?? onClick)}
              persistent={active}
              playing={isPlaying}
            />
          ) : null}
        </div>
        <Marquee text={track.title} className="mt-1.5 text-sm" />
        <div className="truncate text-xs text-neutral-500">
          {track.artists.join(', ')}
        </div>
      </div>
    </div>
  );
}

function AlbumCard({
  album,
  onClick,
  onPlay,
  onLongPress,
  size = 'md',
  active = false,
  isPlaying = false,
  onToggle,
}: {
  album: SearchAlbumResult;
  onClick: () => void;
  onPlay: () => void;
  onLongPress?: () => void;
  size?: 'md' | 'lg';
  /** This album is the active playback source → persistent play/pause. */
  active?: boolean;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  const lp = useLongPress(() => onLongPress?.());
  const box = size === 'lg' ? 'w-40' : 'w-32';
  const art = size === 'lg' ? 'h-40 w-40' : 'h-32 w-32';
  const activate = () => {
    if (lp.fired.current) {
      lp.fired.current = false;
      return;
    }
    onClick();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      {...(onLongPress ? lp.handlers : {})}
      className={`group relative ${box} shrink-0 cursor-pointer text-left transition duration-200 active:scale-[0.98]`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-3 rounded-2xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className={`relative ${art}`}>
          <div className="h-full w-full overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {isRecentRelease(album.release_date) ? (
              <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-neutral-950 shadow">
                New
              </span>
            ) : null}
            {album.cover_url ? (
              <img
                src={album.cover_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : null}
          </div>
          <CardPlayButton
            label={`Play ${album.name}`}
            onPlay={active && onToggle ? onToggle : onPlay}
            persistent={active}
            playing={isPlaying}
          />
        </div>
        <Marquee text={album.name} className="mt-1.5 text-sm" />
        <div className="truncate text-xs text-neutral-500">
          {album.artists.join(', ')}
        </div>
      </div>
    </div>
  );
}

function ArtistCard({
  artist,
  onClick,
  onPlay,
  onLongPress,
  size = 'md',
  active = false,
  isPlaying = false,
  onToggle,
}: {
  artist: SearchArtistResult;
  onClick: () => void;
  onPlay: () => void;
  onLongPress?: () => void;
  size?: 'md' | 'lg';
  /** This artist is the active playback source → persistent play/pause. */
  active?: boolean;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  const lp = useLongPress(() => onLongPress?.());
  const box = size === 'lg' ? 'w-36' : 'w-28';
  const art = size === 'lg' ? 'h-36 w-36' : 'h-28 w-28';
  const activate = () => {
    if (lp.fired.current) {
      lp.fired.current = false;
      return;
    }
    onClick();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      {...(onLongPress ? lp.handlers : {})}
      className={`group relative ${box} shrink-0 cursor-pointer text-center transition duration-200 active:scale-[0.98]`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-3 rounded-2xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className={`relative ${art} mx-auto`}>
          <div className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-neutral-800 text-3xl font-semibold text-neutral-500 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {artist.picture_url ? (
              <img
                src={artist.picture_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : (
              artist.name.trim().charAt(0).toUpperCase() || '♪'
            )}
          </div>
          <CardPlayButton
            label={`Play ${artist.name}`}
            onPlay={active && onToggle ? onToggle : onPlay}
            persistent={active}
            playing={isPlaying}
          />
        </div>
        <div className="mt-1.5 truncate text-sm">{artist.name}</div>
        <div className="text-xs text-neutral-500">Artist</div>
      </div>
    </div>
  );
}

function LikedTile() {
  return (
    <div className="h-full w-full grid place-items-center bg-gradient-to-br from-indigo-500 to-purple-400">
      {/* Star (not a heart) — matches the Favorites star toggle used everywhere. */}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="white" aria-hidden>
        <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
      </svg>
    </div>
  );
}
