import {
  Children,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  banArtist,
  canPlayNow,
  getAlbumTracks,
  getArtistTopTracks,
  getCatalogPlaylist,
  getHome,
  getStation,
  importAlbum,
  listPlaylists,
  playlistArtUrl,
  profileScopedKey,
  sortPlaylistsByRecent,
  type CatalogPlaylistSummary,
  type HomeShelf,
  type PlaylistRow,
  type SearchAlbumResult,
  type SearchArtistResult,
  type SearchTrackResult,
  type StatTrack,
} from '../api';
import { useRecentlyPlayedVersion } from '../useRecentPlaylists';
import { AddToPlaylistModal } from './modals/AddToPlaylistModal';
import { statToTrack } from '../trackAdapter';
import {
  AlbumDetailModal,
  ArtistDetailModal,
  MixDetailModal,
  PlaylistCard,
  PlaylistDetailModal,
  ShelfRow,
  usePreviewPlayer,
  type SidebarPinController,
  type SavedArtistController,
} from './SearchScreen';
import { CollageCover } from './CollageCover';
import { NowPlayingCover } from './NowPlayingCover';
import { SettingsAvatar, useActiveProfile } from './PhoneTopBar';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from './ContextMenu';
import { extractDominantColor } from '../albumColor';
import { CardPlayButton, Marquee } from './Marquee';
import { ShowAllTitle } from './ShowAllTitle';
import { Toast } from './Toast';
import { useHubReachable } from '../useHubReachable';
import { useToast } from '../useToast';
import { HOME_INSTANT_EVENT, takeInstantHomeShelves } from '../onboardingHome';

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
  /** Jump to the full Browse/charts page (desktop header button). Omitted on
   *  the phone, which reaches Browse via the Search tab instead. */
  onOpenBrowse?: () => void;
  /** Somewhere to go and find music — the first-run welcome card's one action.
   *  Each shell maps it to its own route to the same place: the phone's Search
   *  tab (whose empty state is the browse grid), the desktop's Browse page (the
   *  same grid; its search field is always in the top bar anyway). The card is
   *  not rendered without it. */
  onOpenSearch?: () => void;
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
  /** Desktop only: reports the currently-open drill's identity (or null on the
   *  feed), so the host knows to show its drill overlay. */
  onDrillKeyChange?: (key: string | null) => void;
  /** Desktop only: element to render drill-ins into — an overlay that SITS OVER
   *  the feed with its own scroll, rather than replacing the feed in-flow. That
   *  keeps the feed mounted and un-scrolled, so Back reveals it exactly where it
   *  was (the iOS navigation-stack model) instead of rebuilding it. Omitted on
   *  the phone, which already stacks drills as fixed modals. */
  drillPortal?: HTMLElement | null;
  /** Desktop-only Pin/Save controls, forwarded to the artist / album / mix /
   *  playlist detail pages so those buttons show no matter where a page was
   *  opened from. Omitted on the phone. */
  pin?: SidebarPinController;
  save?: SavedArtistController;
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

// Local fallback for the header greeting until the server's lands. MUST match
// the server's 4 buckets (daypart_for_hour in server/mod.rs: 5–11 / 12–16 /
// 17–21 / else) — otherwise the fallback and the server greeting disagree (e.g.
// local "Good evening" vs server "Late night") and the header visibly switches
// text when the feed arrives.
function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Late night';
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
/** What we remember about a profile's Home between mounts and launches.
 *  `stationReady` is optional because entries persisted before it existed (and
 *  older servers) simply don't carry it — absent means "assume ready". */
type HomeFeedCacheEntry = {
  shelves: HomeShelf[];
  playlists: PlaylistRow[];
  stationReady?: boolean;
  /** Server greeting (HomeFeed.greeting). Cached so a remount paints it straight
   *  away instead of flashing the local clock greeting until the feed re-lands. */
  greeting?: string | null;
};

const homeFeedCache = new Map<string, HomeFeedCacheEntry>();
const homeCacheKey = (pid: number | null | undefined): string => String(pid ?? '');
const HOME_FEED_LS = 'beetbot.home.feed';
/** Don't resurrect a feed older than this — beyond it, skeletons are more
 *  honest than week-old shelves flashing before the refresh. */
const HOME_FEED_LS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// Bump when a fix changes shelf CONTENT for the same shelf title — Home appends
// the fresh feed by title and never replaces a shelf already on screen, so a
// persisted pre-fix feed would otherwise keep showing (e.g. a "Your top artists"
// row built when Drake resolved to a same-name impostor's photo) for up to the
// max age. A version bump discards those caches once and forces a clean rebuild.
// v3: "Top songs" became "Your top songs" — a RETITLE changes the append-by-title
// key, so without a bump the cached shelf and the renamed one would both render
// until the cache aged out.
const HOME_FEED_VERSION = 3;

function readHomeFeedLS(pid: number | null | undefined): HomeFeedCacheEntry | null {
  try {
    const raw = localStorage.getItem(profileScopedKey(HOME_FEED_LS, pid ?? null));
    if (!raw) return null;
    const v = JSON.parse(raw) as {
      version?: number;
      savedAt?: number;
      shelves?: HomeShelf[];
      playlists?: PlaylistRow[];
      stationReady?: boolean;
    };
    if (v.version !== HOME_FEED_VERSION) return null; // pre-fix feed — discard
    if (!Array.isArray(v.shelves) || !Array.isArray(v.playlists)) return null;
    if (!v.savedAt || Date.now() - v.savedAt > HOME_FEED_LS_MAX_AGE_MS) return null;
    return { shelves: v.shelves, playlists: v.playlists, stationReady: v.stationReady };
  } catch {
    return null; // corrupt / private mode — behave like no cache
  }
}

function writeHomeFeedLS(
  pid: number | null | undefined,
  entry: HomeFeedCacheEntry,
): void {
  try {
    localStorage.setItem(
      profileScopedKey(HOME_FEED_LS, pid ?? null),
      JSON.stringify({ version: HOME_FEED_VERSION, savedAt: Date.now(), ...entry }),
    );
  } catch {
    /* quota / private mode — relaunches just keep the skeleton path */
  }
}

/** Base key for "this profile has dismissed Home's welcome card" — scoped per
 *  profile via `profileScopedKey`, like the desktop's first-run flag, so one
 *  person dismissing it never silences it for the next profile. */
const WELCOME_LS = 'beetbot.home_welcome_dismissed';

function readWelcomeDismissed(pid: number | null | undefined): boolean {
  try {
    return localStorage.getItem(profileScopedKey(WELCOME_LS, pid ?? null)) === '1';
  } catch {
    return false; // private mode — showing it again beats never showing it
  }
}

/** In-memory first, then the persisted copy (which also re-seeds the Map so
 *  subsequent reads in this session are cheap). */
function getHomeFeedCache(
  pid: number | null | undefined,
): HomeFeedCacheEntry | null {
  const key = homeCacheKey(pid);
  const m = homeFeedCache.get(key);
  if (m) return m;
  const ls = readHomeFeedLS(pid);
  if (ls) homeFeedCache.set(key, ls);
  return ls;
}

/** Drop a profile's cached feed (memory + persisted) so the next fetch rebuilds
 *  from scratch instead of re-painting a stale copy. Called right after
 *  onboarding writes the user's picks, so Home doesn't resurrect the empty page
 *  it cached at first launch. */
export function clearHomeFeedCache(pid: number | null | undefined): void {
  homeFeedCache.delete(homeCacheKey(pid));
  try {
    localStorage.removeItem(profileScopedKey(HOME_FEED_LS, pid ?? null));
  } catch {
    /* private mode — the in-memory delete already covers this session */
  }
}

/** Spotify-style loading placeholders — pulsing gray boxes shown on the FIRST
 *  load (cold start), before the feed arrives, instead of a blank page. */
function QuickAccessSkeleton() {
  return (
    <div className="px-4 lg:px-8 grid grid-cols-2 gap-2 mb-7 lg:mb-10" aria-hidden>
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
    <section className="mb-7 lg:mb-10" aria-hidden>
      {/* ml-4 (not px-4) so the bar is inset like the real title — px-4 would
          be padding INSIDE the fixed-width box, leaving it flush to the edge. */}
      <div className="ml-4 mb-2.5 h-5 w-44 rounded bg-neutral-800 animate-pulse" />
      <div className="flex gap-3 px-4 lg:px-8 pb-1 overflow-hidden">
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
  onOpenSearch,
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
  onDrillKeyChange,
  drillPortal,
  pin,
  save,
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
  // clock until the feed lands and on older bundled servers. Seeded from the
  // cache (like shelves/playlists) so a remount doesn't flash the local greeting
  // and then swap to the server one.
  const [serverGreeting, setServerGreeting] = useState<string | null>(
    () => getHomeFeedCache(activeProfileId)?.greeting ?? null,
  );
  // Whether the endless stations have anything to seed from (HomeFeed
  // .station_ready). A profile that has never played a track can't have a
  // station, so we hide the tiles rather than hand it a button that yields an
  // empty queue. Defaults to true — an older server that omits the field, or a
  // pre-field cache entry, keeps the tiles exactly as they were.
  const [stationReady, setStationReady] = useState(
    () => getHomeFeedCache(activeProfileId)?.stationReady ?? true,
  );
  // Whether this profile has dismissed the first-run welcome card. Dismissal is
  // forever — the ✕ means what it says.
  const [welcomeDismissed, setWelcomeDismissed] = useState(() =>
    readWelcomeDismissed(activeProfileId),
  );
  // Re-read on a profile switch: the phone keeps HomeScreen mounted across one,
  // so a lazy initializer alone would leave the previous profile's answer in
  // place and hide the card from someone who's never seen it.
  useEffect(() => {
    setWelcomeDismissed(readWelcomeDismissed(activeProfileId));
  }, [activeProfileId]);
  // Whether the shelf feed has resolved at least once (drives the shelf
  // skeleton). Starts true only if the cache actually holds SHELVES — the
  // quick-access playlists loader also writes the cache entry, so merely
  // "entry exists" would skip the skeleton on a return visit made before the
  // first /api/home ever resolved (blank Home instead of loading boxes).
  const [feedLoaded, setFeedLoaded] = useState(() => {
    const cached = getHomeFeedCache(activeProfileId);
    return !!cached && cached.shelves.length > 0;
  });
  // Re-seed every piece of feed state from the cache when the feed's IDENTITY
  // changes (a profile switch) or its cache is deliberately dropped (the
  // first-run wizard's home-refresh once it has written your picks). All of the
  // above are lazy initializers — they run at MOUNT and never again — and both
  // hosts keep HomeScreen mounted across a profile switch, so without this the
  // state simply persists and Home keeps painting a feed built for a different
  // moment: the previous profile's shelves under the new profile's name, or the
  // empty page cached before onboarding wrote your artists. It self-corrects
  // only when the next fetch lands, which on a cold profile is many seconds of
  // showing someone else's recommendations — and the quick-access playlists
  // reload over IPC in milliseconds, so the two halves of the page visibly
  // disagree meanwhile. Same reason welcomeDismissed re-reads above; this is the
  // rest of that fix. The fetch effect is declared below, so a landed feed always
  // wins over this re-seed rather than racing it.
  const feedStateSeeded = useRef(true);
  useEffect(() => {
    if (feedStateSeeded.current) {
      feedStateSeeded.current = false; // mount: the initializers just did this
      return;
    }
    const cached = getHomeFeedCache(activeProfileId);
    setShelves(cached?.shelves ?? []);
    setPlaylists(cached?.playlists ?? null);
    setServerGreeting(cached?.greeting ?? null);
    setStationReady(cached?.stationReady ?? true);
    setFeedLoaded(!!cached && cached.shelves.length > 0);
  }, [activeProfileId, refreshKey]);
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
  // Tell the host which drill (if any) is showing, so it scopes scroll memory
  // to a distinct key per drill and keeps the feed's own position intact.
  const drillKey = openMix
    ? `mix:${openMix.key}`
    : openPlaylist
      ? `hpl:${openPlaylist.source_id}`
      : openShelfGrid
        ? `shelf:${openShelfGrid.kind}:${openShelfGrid.title}`
        : null;
  // Layout effect (not passive) so the host's scroll key flips BEFORE paint —
  // the drill then paints at the top in one frame (no mid-scroll flash) and the
  // reset can't be mis-attributed to the feed's key.
  useLayoutEffect(() => {
    onDrillKeyChange?.(drillKey);
  }, [drillKey, onDrillKeyChange]);
  useEffect(() => {
    // When the host gives us an overlay to portal into, the drill has its own
    // scroll container (which starts at the top on its own) and the feed
    // underneath must KEEP its position — scrolling it here would destroy the
    // very thing the overlay exists to preserve.
    if (drillPortal) return;
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
  const { toast, showToast } = useToast(2600);
  // Active profile — drives the greeting name and the header avatar. Shared with
  // Search/Library through one cached resolver: this screen used to hand-roll
  // the same fetch, which meant its avatar (and greeting name) restarted from
  // nothing on every visit even though the other two already knew the answer.
  const profile = useActiveProfile(token, activeProfileId ?? null);
  const { playingUrl, toggle, stop } = usePreviewPlayer();

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
    // A profile that JUST finished onboarding has picks-derived shelves waiting
    // (see shared/onboardingHome) — paint them at once, ahead of the cold server
    // build, so Home fills immediately instead of flashing the empty partial the
    // ~40s discovery build leaves behind. One-shot: cleared on read.
    const seeded = takeInstantHomeShelves(activeProfileId ?? -1);
    if (seeded.length) {
      setShelves((prev) => {
        if (!prev.length) return seeded;
        const shown = new Set(prev.map((s) => s.title));
        return [...seeded.filter((s) => !shown.has(s.title)), ...prev];
      });
      setFeedLoaded(true);
    }
    const key = homeCacheKey(activeProfileId);
    const cachePatch = (patch: Partial<HomeFeedCacheEntry>) => {
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
      // Retry on ERROR (a cold server is still warming). Retryable errors only —
      // a 401 means the token's dead and retrying just burns the backoff.
      const errBackoff = [800, 2000, 4000, 8000];
      // POLL while the server serves a PARTIAL feed. On a cold cache it kicks the
      // full discovery build into the BACKGROUND and answers immediately with a
      // partial — which for a freshly-onboarded profile (no play history yet, the
      // discovery shelves still building) is EMPTY. Settling on that empty partial
      // is exactly what flashed the "add music" empty state before the real feed
      // landed. So hold out for the complete feed (`partial` drops off the
      // response once the build caches); the fast pass below still paints any
      // partial shelves meanwhile, so a profile with content isn't held back.
      // ~45s of polling comfortably outlasts a cold build's ~15-40s wall clock.
      const partialBackoff = [1500, 2500, 3500, 4500, 5500, 6000, 6000, 6000, 6000];
      let errAttempt = 0;
      let partialAttempt = 0;
      for (;;) {
        try {
          const h = await getHome(token, activeProfileId, visitNonce);
          if (h.partial && partialAttempt < partialBackoff.length) {
            if (cancelled) return h;
            await new Promise((r) =>
              window.setTimeout(r, partialBackoff[partialAttempt++]),
            );
            continue;
          }
          return h;
        } catch (err) {
          if (cancelled || errAttempt >= errBackoff.length) throw err;
          await new Promise((r) => window.setTimeout(r, errBackoff[errAttempt++]));
        }
      }
    };
    // Progressive paint. Every Deezer call the server makes is spaced 110ms apart
    // process-wide, so a build's wall clock is almost exactly (calls × 110ms) —
    // measured at ~6s for an established profile and ~40s for a brand-new one,
    // whose artists the catalogue has never seen. But the shelves don't finish
    // together: the cheap ones land in the first ~3s and four expensive ones own
    // the long tail. So ask for BOTH at once — `fast` (the cheap subset, uncached)
    // to paint immediately, and the real feed, which arrives later and caches as
    // always. Nothing extra is asked of Deezer that the full build wasn't already
    // going to ask; the fast pass just front-runs it.
    //
    // The fast result only ever paints if it wins the race AND nothing is on
    // screen yet — on a warm profile the full feed answers from cache in ~13ms and
    // this never shows at all.
    if (!getHomeFeedCache(activeProfileId)?.shelves.length) {
      void getHome(token, activeProfileId, visitNonce, true)
        .then((h) => {
          if (cancelled || !h.shelves.length) return;
          setShelves((prev) => (prev.length ? prev : h.shelves)); // never clobber the real feed
          setServerGreeting((prev) => prev ?? h.greeting ?? null);
          setFeedLoaded(true);
        })
        .catch(() => {
          // Best-effort: the full fetch below is the real one.
        });
    }
    void fetchHomeWithRetry()
      .then((h) => {
        if (cancelled) return;
        // APPEND, don't replace. The full feed is a superset of the fast one, but
        // it's independently arranged, so swapping it in wholesale would reshuffle
        // a page the user is already reading. Keep what's shown, in place, and add
        // only what's new — the page grows instead of jumping.
        setShelves((prev) => {
          if (!prev.length) return h.shelves;
          const shown = new Set(prev.map((s) => s.title));
          return [...prev, ...h.shelves.filter((s) => !shown.has(s.title))];
        });
        setServerGreeting(h.greeting ?? null);
        onWinBack?.(h.welcome_back ?? false);
        setFeedLoaded(true);
        const ready = h.station_ready !== false; // absent (older server) ⇒ ready
        setStationReady(ready);
        // Cache the SERVER's own ordering, not the appended view: the next visit
        // should open on the properly arranged feed, not on this one-off union.
        // Never cache a still-partial feed (polling capped out on a slow build) —
        // it would shadow the real one and open Home thin on the next visit.
        if (!h.partial) {
          cachePatch({
            shelves: h.shelves,
            stationReady: ready,
            greeting: h.greeting ?? null,
          });
        }
      })
      .catch(() => {
        // All retries failed — clear the skeleton so it doesn't spin forever.
        if (!cancelled) setFeedLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId, refreshKey, visitNonce, loadPlaylists, onWinBack]);

  // Onboarding finishes ASYNChronously relative to Home's mount: the picks' top
  // tracks are still fetching when the wizard closes and Home appears, so the
  // sync read above often finds nothing. When they land and the wizard stashes
  // the instant shelves, prepend them (once) — the same shelves that read would
  // have caught had they been ready in time.
  useEffect(() => {
    const onInstant = (e: Event) => {
      const pid = (e as CustomEvent<{ profileId: number }>).detail?.profileId;
      if (pid == null || pid !== activeProfileId) return;
      const seeded = takeInstantHomeShelves(activeProfileId ?? -1);
      if (!seeded.length) return;
      setShelves((prev) => {
        const shown = new Set(prev.map((s) => s.title));
        return [...seeded.filter((s) => !shown.has(s.title)), ...prev];
      });
      setFeedLoaded(true);
    };
    window.addEventListener(HOME_INSTANT_EVENT, onInstant);
    return () => window.removeEventListener(HOME_INSTANT_EVENT, onInstant);
  }, [activeProfileId]);

  // Keep the quick-access playlists current when the library changes elsewhere —
  // a like from the player bar creates/updates Favorites, an add-to-playlist, a
  // delete. Refetch ONLY the playlists (same window event the sidebar refetches
  // on), never the whole feed: reshuffling every discovery shelf just because you
  // starred a song would be jarring, and the shelves haven't changed.
  useEffect(() => {
    const reload = () => {
      const key = homeCacheKey(activeProfileId);
      const load = loadPlaylists ?? (() => listPlaylists(token, activeProfileId));
      void load()
        .then((p) => {
          setPlaylists(p);
          const prev = homeFeedCache.get(key) ?? { shelves: [], playlists: [] };
          const next = { ...prev, playlists: p };
          homeFeedCache.set(key, next);
          writeHomeFeedLS(activeProfileId, next);
        })
        .catch(() => {
          /* transient loader failure — the next real load reconciles */
        });
    };
    window.addEventListener('beetbot:library-changed', reload);
    return () => window.removeEventListener('beetbot:library-changed', reload);
  }, [token, activeProfileId, loadPlaylists]);

  // Pre-warm the stations once Home is up, so the "Made for you" station tiles
  // open instantly. The server pre-warm builds home feeds FIRST and only reaches
  // the stations in a later pass (prewarm_home_once), so on a fresh launch the
  // first station tap would otherwise pay the ~14s cold fusion. Fire a background
  // getStation per mode (for-you first — the primary tile — then fresh); the
  // payoff is the server's 6h station_cache, so we discard the tracks. Once per
  // profile (ref-guarded); a repeat call after a profile switch is a cheap cache
  // hit. Keyed off feedLoaded so it yields to the initial /api/home fetch.
  const stationWarmedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!token || !feedLoaded) return;
    const key = `${activeProfileId ?? 'none'}`;
    if (stationWarmedFor.current === key) return;
    stationWarmedFor.current = key; // set up-front so a re-render can't double-fire
    let cancelled = false;
    void (async () => {
      try {
        await getStation(token, activeProfileId); // My station (for-you)
        if (!cancelled) await getStation(token, activeProfileId, 'fresh'); // Discovery
      } catch {
        // Best-effort: a failed warm just means that tap pays the cost, and the
        // server's own pre-warm loop is the backstop.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId, feedLoaded]);

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

  // Liked pinned, then most-recently-played; cap at 8 tiles. `recentsVersion`
  // re-runs the sort when the hub's shared recency lands, so tiles reflect what
  // was played on the user's other device.
  const recentsVersion = useRecentlyPlayedVersion();
  const quickAccess = useMemo(() => {
    if (!playlists) return [];
    return [...sortPlaylistsByRecent(playlists)]
      .sort((a, b) => (a.source === 'liked' ? 0 : 1) - (b.source === 'liked' ? 0 : 1))
      .slice(0, 8);
  // `recentsVersion` isn't read in the body on purpose: it's the signal that the
  // hub's shared recency merged in. Dropping it would silently stop the other
  // device's plays from ever reordering this list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, recentsVersion]);

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
  // Play a track from WITHIN an open detail page (mix / album / playlist), then
  // stamp its source key — so clicking a row inside the page tags the source
  // exactly like pressing the card's play button does, and the Home card then
  // reflects play/pause (was showing a static play until you pressed the card).
  const playFromDetail = async (
    key: string,
    t: SearchTrackResult,
    list?: SearchTrackResult[],
    index?: number,
  ) => {
    await onPlayTrack(t, list, index);
    onPlayedFrom?.(key);
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
  // Which station's PAGE is being fetched to open (separate from the direct-play
  // `stationLoading` above), so the tile shows a spinner while today's ~40-track
  // batch loads before the drill page appears.
  const [stationOpening, setStationOpening] = useState<string | null>(null);
  // The one reserved beet moment: a ~1s crimson glow on the "My station"
  // tile the instant a station ignites (see the beet-ignite keyframe).
  const [igniting, setIgniting] = useState(false);
  const startStation = async (mode?: string) => {
    if (stationLoading) return; // a station is already being built — ignore
    setStationLoading(mode ?? 'for-you');
    try {
      const tracks = await getStation(token, activeProfileId, mode);
      if (tracks.length > 0) {
        // await so the host's setQueue (which clears nowPlayingKey) lands first,
        // then stamp this station as the source so its tile shows play/pause.
        await onPlayTrack(tracks[0], tracks, 0);
        onPlayedFrom?.(`station:${mode ?? 'for-you'}`);
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

  // Open a station as a PAGE (not just play it): fetch today's ~40-track batch,
  // wrap it in a MixData, and open the SAME drill page the mixes use (Play +
  // Shuffle header, tracklist, per-song menus, desktop Back/Forward history). The
  // daily rotation is unchanged — this shows today's batch; the tile's play
  // button still starts it straight away, and the queue's autoplay keeps it
  // endless past the batch exactly like a direct station press.
  const openStationPage = async (mode?: string) => {
    if (stationOpening) return; // already fetching a page
    const key = mode ?? 'for-you';
    setStationOpening(key);
    try {
      const tracks = await getStation(token, activeProfileId, mode);
      if (tracks.length === 0) {
        showToast('Not enough listening yet for a station');
        return;
      }
      const mix: MixData = {
        key: `station:${key}`,
        title: mode === 'fresh' ? 'Discovery station' : 'My station',
        eyebrow: 'Endless',
        tracks,
        cadence: 'Updated daily',
      };
      setOpenMix(mix);
      onMixPush?.({ mix });
    } catch {
      showToast("Couldn't open the station");
    } finally {
      setStationOpening(null);
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
    const artClass = size === 'lg' ? 'mt-4 h-40 lg:h-44' : 'mt-4 h-32 lg:h-44';
    const artistArtClass = size === 'lg' ? 'mt-4 h-36 lg:h-40' : 'mt-4 h-28 lg:h-40';
    // Desktop: every shelf's "Show all" opens its full grid as a drill PAGE
    // (uniform behavior — the Shelf button already only shows for count > 4, so
    // small shelves get no toggle at all). Phone home rows just scroll.
    // `forceExpand` (set when rendering the page itself) shows the full grid
    // with no toggle button.
    const shelfExtra: { desktop: boolean; onShowAll?: () => void; forceExpand?: boolean } =
      forceExpand
        ? { desktop: isDesktop, forceExpand: true }
        : isDesktop && onMixPush
          ? {
              desktop: isDesktop,
              onShowAll: () => {
                setOpenShelfGrid(shelf);
                onMixPush({ shelfGrid: shelf });
              },
            }
          : { desktop: isDesktop };
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
        <section key={`spot:${idx}:${shelf.title}`} className="px-4 lg:px-8 mb-7 lg:mb-10">
          {/* Phone: the kicker rides ABOVE the card — the same place every other
              shelf puts it (and where this hero's `lead` sibling already puts
              it). Inside a 183px column it wraps to two lines, which stacked
              with the title and the two-line subtitle packed five lines into a
              112px box. Desktop keeps it in the card: that column is 712px. */}
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500 sm:hidden">
            {shelf.eyebrow ?? 'In the spotlight'}
          </p>
          <HeroCard
            cover={head.album_art_url ?? null}
            eyebrow={shelf.eyebrow ?? 'In the spotlight'}
            title={shelf.title}
            subtitle={desc}
            subtitleShort={`${list.length} songs`}
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
        <section key={`hero:${idx}:${shelf.title}`} className="mb-7 lg:mb-10">
          {shelf.eyebrow ? (
            <p className="px-4 lg:px-8 text-[11px] uppercase tracking-wide text-neutral-500">
              {shelf.eyebrow}
            </p>
          ) : null}
          <h2 className="px-4 lg:px-8 mb-2.5 lg:mb-4 text-lg lg:text-2xl font-bold tracking-tight">{shelf.title}</h2>
          <div className="px-4 lg:px-8 mb-3 lg:mb-6">
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
            <ShelfRow artClass="mt-4 h-32 lg:h-44" scrollerClassName="flex gap-4 lg:gap-6 overflow-x-auto overflow-y-clip px-4 lg:px-8 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {rest.map((t, i) => (
                <TrackCard
                  key={`${shelf.kind}:${i}:${t.source_id}`}
                  track={t}
                  onOpenArtist={onOpenArtist}
                  onOpenAlbum={onOpenAlbum}
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
              onOpenArtist={onOpenArtist}
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
              onOpenArtist={onOpenArtist}
              onOpenAlbum={onOpenAlbum}
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
              className={`${size === 'lg' ? 'w-40 lg:w-44' : 'w-32 lg:w-44'} shrink-0`}
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
              onOpenArtist={onOpenArtist}
              onOpenAlbum={onOpenAlbum}
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
    if (shelf.kind === 'mixed_row') {
      // Heterogeneous row (Spotify's "More like {X}"): each item carries its own
      // type, mapped onto the same artist/album/playlist cards the homogeneous
      // rows use. Keys are `type:source:source_id` so the id spaces can't collide.
      const items = shelf.items ?? [];
      if (items.length === 0) return null;
      return (
        <Shelf
          key={`${shelf.kind}:${idx}:${shelf.title}`}
          title={shelf.title}
          eyebrow={shelf.eyebrow}
          artClass={artClass}
          icon={shelf.seed_art}
          {...shelfExtra}
        >
          {items.map((it) => {
            if (it.type === 'artist') {
              const a = it.artist;
              return (
                <ArtistCard
                  key={`artist:${a.source}:${a.source_id}`}
                  artist={a}
                  size={size}
                  matchAlbumSize
                  onClick={() => openArtistCard(a)}
                  onPlay={() => playArtistCard(a)}
                  onLongPress={() => setCardMenu({ kind: 'artist', artist: a })}
                  active={nowPlayingKey === `artist:${a.source_id}`}
                  isPlaying={!!isPlaying}
                  onToggle={onTogglePlay}
                />
              );
            }
            if (it.type === 'album') {
              const al = it.album;
              return (
                <AlbumCard
                  key={`album:${al.source}:${al.source_id}`}
                  album={al}
                  onOpenArtist={onOpenArtist}
                  size={size}
                  onClick={() => openAlbumCard(al)}
                  onPlay={() => playAlbumCard(al)}
                  onLongPress={() => setCardMenu({ kind: 'album', album: al })}
                  active={nowPlayingKey === `album:${al.source_id}`}
                  isPlaying={!!isPlaying}
                  onToggle={onTogglePlay}
                />
              );
            }
            if (it.type === 'playlist') {
              const p = it.playlist;
              return (
                <PlaylistCard
                  key={`playlist:${p.source}:${p.source_id}`}
                  playlist={p}
                  onOpen={openCatalogPlaylist}
                  onPlay={() => playPlaylistCard(p)}
                  active={nowPlayingKey === `playlist:${p.source_id}`}
                  isPlaying={!!isPlaying}
                  onToggle={onTogglePlay}
                  className={`${size === 'lg' ? 'w-40 lg:w-44' : 'w-32 lg:w-44'} shrink-0`}
                />
              );
            }
            // Unknown item type from a newer server on a stale bundle — skip the
            // card rather than crash the whole feed (mirrors the shelf-kind guard).
            return null;
          })}
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
  //
  // A profile with no listening history has neither (the server says
  // `station_ready: false`, and mixes are built from the same play data), so the
  // whole rail drops out — a "Made for you" heading over an empty strip, or a
  // station tile that can only produce an empty queue, is worse than no rail.
  const madeForYouRail = !stationReady && railMixes.length === 0 ? null : (
    <MadeForYouRail key="made-for-you-rail">
      {stationReady && (
        <>
          <StationTile
            variant="my"
            loading={stationLoading === 'for-you'}
            opening={stationOpening === 'for-you'}
            igniting={igniting}
            desktop={isDesktop}
            arts={myStationArts}
            active={nowPlayingKey === 'station:for-you'}
            isPlaying={!!isPlaying}
            onOpen={() => void openStationPage()}
            onPress={() => void startStation()}
            onToggle={onTogglePlay}
          />
          <StationTile
            variant="discovery"
            loading={stationLoading === 'fresh'}
            opening={stationOpening === 'fresh'}
            desktop={isDesktop}
            arts={discoveryStationArts}
            active={nowPlayingKey === 'station:fresh'}
            isPlaying={!!isPlaying}
            onOpen={() => void openStationPage('fresh')}
            onPress={() => void startStation('fresh')}
            onToggle={onTogglePlay}
          />
        </>
      )}
      {railMixes.map((mix) => (
        <MixTile
          key={mix.key}
          mix={mix}
          cadence={mix.cadence ?? 'New every day'}
          desktop={isDesktop}
          active={nowPlayingKey === `mix:${mix.key}`}
          isPlaying={!!isPlaying}
          onOpen={() => {
            // Show the page now; on desktop also record the history stop (the
            // push doesn't restore — same "record without restoring" convention
            // as the search/Discover drills).
            setOpenMix(mix);
            onMixPush?.({ mix });
          }}
          onPlay={async () => {
            // await so setQueue (clears nowPlayingKey) runs before we stamp this
            // mix as the source — mirrors the album/playlist card play path.
            await onPlayTrack(mix.tracks[0], mix.tracks, 0);
            onPlayedFrom?.(`mix:${mix.key}`);
          }}
          onToggle={onTogglePlay}
        />
      ))}
    </MadeForYouRail>
  );

  return (
    <div ref={rootRef} className="min-h-full bg-transparent text-neutral-100 pb-6">
      {/* The feed ALWAYS renders. A desktop drill-in is portaled into the
          host's overlay (see `drillPortal`) and covers this, rather than
          replacing it — so the feed is never unmounted and never loses its
          scroll. The phone likewise keeps the feed and stacks the drill as a
          fixed modal (in the modals block below). */}
      <>
      <div
        // Phone only (onOpenSettings is omitted on desktop): a sticky, frosted
        // header so the greeting/Browse stay put and content tucks under it
        // instead of bleeding past the status bar in the standalone PWA.
        // z-10 (not z-20): stays above Home's shelf cards, but sits BELOW a
        // drill-in detail page (also z-10, rendered later) so opening an album/
        // playlist from Home covers this header + reveals the page's back
        // chevron — while the bottom nav (z-20) stays on top.
        className={`px-4 lg:px-8 pt-4 pb-2 ${
          onOpenSettings ? 'sticky top-0 z-10 bg-neutral-950/70 backdrop-blur-xl' : ''
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          {/* min-w-0 so `truncate` can actually shrink a long greeting — as a
              direct flex child it would otherwise refuse to go below its
              content width and push the avatar off the row. */}
          <h1 className="min-w-0 flex-1 text-xl font-bold tracking-tight truncate">
            {serverGreeting ?? greeting()}
            {profile?.name ? `, ${profile.name}` : ''}
          </h1>
          {/* Desktop only: the phone reaches Browse via the Search tab's empty
              state (the "Browse all" genre grid), so no header button there.
              `onOpenSettings` is the phone marker — absent ⇒ desktop. */}
          {onOpenBrowse && !onOpenSettings && (
            <button
              type="button"
              onClick={onOpenBrowse}
              className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-neutral-700 text-neutral-300 active:bg-neutral-800"
            >
              Browse
            </button>
          )}
          {onOpenSettings && (
            <SettingsAvatar
              profile={profile}
              token={token}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
      </div>

      {/* First run for this profile: no plays (so the stations are already
          hidden) and no playlists. `playlists === null` means still loading —
          don't guess. `stationReady` starts true, so this can't flash before the
          feed lands. Both platforms: the Mac's first-run wizard fires on having
          no PLAYLISTS, which is a different question, and it only ever fires
          once — so a Mac profile that has skipped it still arrives at a bare
          Home with nothing explaining it. */}
      {onOpenSearch &&
        !stationReady &&
        !welcomeDismissed &&
        playlists?.length === 0 && (
          <WelcomeCard
            onFind={onOpenSearch}
            onDismiss={() => {
              setWelcomeDismissed(true);
              try {
                localStorage.setItem(
                  profileScopedKey(WELCOME_LS, activeProfileId ?? null),
                  '1',
                );
              } catch {
                /* private mode — it reappears next launch, which is survivable */
              }
            }}
          />
        )}

      {playlists === null && <QuickAccessSkeleton />}

      {quickAccess.length > 0 && (
        <div className="px-4 lg:px-8 grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 lg:gap-3 mb-7 lg:mb-10">
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
              <Marquee text={p.name} lines={2} className="min-w-0 flex-1 pr-2 text-sm font-medium leading-tight" />
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
        // Feed resolved but empty (thin library): still offer the stations —
        // unless there's no history to seed them with either, in which case the
        // rail is null and Home stays honestly bare.
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
          <div className="px-4 lg:px-8 mt-10 text-sm text-neutral-500">
            Once you&apos;ve added music to your library and played a few tracks,
            your recent and most-played picks show up here.
          </div>
        )}
        </>

      {openArtist && (
        <ArtistDetailModal
          token={token}
          artist={openArtist}
          pin={pin}
          save={save}
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
          isTrackCurrent={isTrackCurrent}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
          onShowTrackSheet={onShowTrackSheet}
        />
      )}
      {openAlbum && (
        <AlbumDetailModal
          token={token}
          album={openAlbum}
          activeProfileId={activeProfileId}
          pin={pin}
          onClose={() => {
            stop();
            setOpenAlbum(null);
          }}
          onPickTrack={(t) => void playFromDetail(`album:${openAlbum.source_id}`, t)}
          onPlay={(t, list, index) =>
            void playFromDetail(`album:${openAlbum.source_id}`, t, list, index)
          }
          // Phone: "⋯" bottom sheet + swipe-to-queue / swipe-to-save, matching
          // the library page. Absent on desktop (uses the hover "⋯" menu).
          onShowTrackSheet={onShowTrackSheet}
          onQueueTrack={onAlbumAddToQueue}
          onSaveTrack={onAlbumSaveToLiked}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
        />
      )}
      {/* The three desktop drill-ins. On desktop they're portaled into the
          host's overlay so they cover the feed with their OWN scroll container,
          leaving the feed mounted and un-scrolled underneath (Back is then a
          pure reveal — nothing to rebuild, nothing to restore). Without a
          portal (the phone) they render right here, as the fixed modals they
          already were. */}
      {(() => {
        const drill = (
          <>
      {openPlaylist && (
        <PlaylistDetailModal
          token={token}
          playlist={openPlaylist}
          activeProfileId={activeProfileId}
          inline={isDesktop}
          pin={pin}
          onClose={() => {
            stop();
            // Desktop: close by routing through history Back so the entry pops
            // and the restore clears the page (never an in-place null — the nav
            // convention). Phone: local overlay close.
            if (onMixBack) onMixBack();
            else setOpenPlaylist(null);
          }}
          onPickTrack={(t) => void playFromDetail(`playlist:${openPlaylist.source_id}`, t)}
          onPlay={(t, list, index) =>
            void playFromDetail(`playlist:${openPlaylist.source_id}`, t, list, index)
          }
          onShowTrackSheet={onShowTrackSheet}
          onQueueTrack={onAlbumAddToQueue}
          onSaveTrack={onAlbumSaveToLiked}
          playingPreviewUrl={playingUrl}
          onTogglePreview={toggle}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
        />
      )}
      {openMix && (
        <MixDetailModal
          token={token}
          mix={openMix}
          activeProfileId={activeProfileId}
          inline={isDesktop}
          pin={pin}
          onClose={() => {
            stop();
            // Desktop: close by routing through history Back, so the entry pops
            // and the restore clears the page (never an in-place null). Phone:
            // local close.
            if (onMixBack) onMixBack();
            else setOpenMix(null);
          }}
          onPickTrack={(t) => void playFromDetail(openMix.key, t)}
          onPlay={(t, list, index) => void playFromDetail(openMix.key, t, list, index)}
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
      {/* Desktop "Show all" drill: the big shelf's full grid. No in-page Back
          button: the app's global top-bar Back/Forward (and Escape below) close
          it, matching the mix/playlist drill pages. */}
      {isDesktop && openShelfGrid && (
        <div className="pt-2">{renderShelf(openShelfGrid, 1, true)}</div>
      )}
          </>
        );
        return isDesktop && drillPortal
          ? createPortal(drill, drillPortal)
          : drill;
      })()}
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
      {toast && <Toast message={toast} placement="floating" />}
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
      <div className="relative bg-neutral-900 rounded-t-2xl px-4 lg:px-8 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
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

/** A "Made for you" rail: a horizontally scrolling row of portrait tiles under
 *  one uniform shelf header. Holds the two station tiles (and, from P3, the mix
 *  tiles as children). */
function MadeForYouRail({ children }: { children: ReactNode }) {
  return (
    <section className="mb-7 lg:mb-10">
      <h2 className="px-4 lg:px-8 mb-2.5 lg:mb-4 text-lg lg:text-2xl font-bold tracking-tight">Made for you</h2>
      {/* No scroll-snap here: `snap-x` + `snap-start` made the browser scroll past
          the px-4 left padding to align the first tile, so tiles sat flush at the
          edge (unlike every other shelf). Plain overflow matches the shelves.
          ShelfRow adds the same desktop hover ‹ › arrows as the shelves. */}
      <ShelfRow scrollerClassName="flex gap-3 overflow-x-auto overscroll-x-contain px-4 lg:px-8 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </ShelfRow>
    </section>
  );
}

/** Home's first-run card: a profile with no listening history has no stations
 *  (they seed off play history, so the tiles are hidden) and no mixes, which
 *  leaves Home honestly bare. This says why, and offers the one action that
 *  fixes it.
 *
 *  That action is "go find something" rather than a one-tap "play something for
 *  me" on purpose: the first thing you play becomes the seed every mix and
 *  station is built from afterwards, so it should be a song you chose, not one
 *  the app picked to fill a button.
 *
 *  Phone stacks it; desktop lays it out as a band — copy left, action right — so
 *  it spans the same grid as every shelf and its trailing edge lands under the
 *  account avatar. A half-width block ended on nothing, and a full-width one
 *  with everything huddled at the left would just be a wide block with a hole in
 *  it; using the width is what keeps it reading as a notice rather than a promo. */
function WelcomeCard({
  onFind,
  onDismiss,
}: {
  onFind: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="px-4 lg:px-8 mb-7 lg:mb-10">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-rose-700 to-rose-950 p-4 ring-1 ring-white/10 lg:flex lg:items-center lg:gap-5 lg:p-5">
        {/* Corner bloom — the same branded-wash language as the station tiles.
            Absolute, so it sits out of the desktop row's flow. */}
        <div
          className="pointer-events-none absolute -right-7 -top-7 h-24 w-24 rounded-full bg-white/10"
          aria-hidden
        />
        <div className="relative lg:min-w-0 lg:flex-1">
          {/* pr-8 clears the phone's corner ✕; on desktop the ✕ joins the row
              instead, so the copy gets the whole left side. */}
          <h2 className="pr-8 text-[15px] font-bold tracking-tight text-white lg:pr-0 lg:text-base">
            Welcome to Beetbot
          </h2>
          <p className="mt-1 text-[13px] leading-snug text-white/70 lg:text-sm">
            Play anything and this page fills up — mixes, stations and picks, all
            built from what you actually listen to.
          </p>
        </div>
        <button
          type="button"
          onClick={onFind}
          className="relative mt-3 shrink-0 rounded-full bg-white/15 px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-white/25 active:scale-95 lg:mt-0"
        >
          Find something to play
        </button>
        {/* Pinned to the corner on the phone, but a trailing member of the row on
            desktop (`lg:static`) — chasing the corner of a wide band would strand
            it miles from the button it belongs beside. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-3 top-3 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/15 text-white/80 transition hover:bg-white/25 hover:text-white active:scale-95 lg:static"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M5 5l14 14M19 5L5 19" />
          </svg>
        </button>
      </div>
    </div>
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
  opening,
  igniting,
  desktop,
  arts,
  active,
  isPlaying,
  onOpen,
  onPress,
  onToggle,
}: {
  variant: 'my' | 'discovery';
  loading: boolean;
  opening?: boolean;
  igniting?: boolean;
  desktop?: boolean;
  arts: string[];
  /** This station is the current playback source → persistent play/pause button. */
  active?: boolean;
  isPlaying?: boolean;
  onOpen: () => void;
  onPress: () => void;
  onToggle?: () => void;
}) {
  const my = variant === 'my';
  const title = my ? 'My station' : 'Discovery station';
  // Busy = either a direct play (loading) or a page fetch (opening) in flight.
  const busy = loading || !!opening;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!busy) onOpen();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open ${title}`}
      aria-busy={busy}
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
      {busy ? (
        <span className="absolute inset-0 grid place-items-center text-white/90">
          <svg className="animate-spin" width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
      ) : (
        <CardPlayButton
          label={`Play ${title}`}
          persistent={!desktop || !!active}
          playing={!!active && !!isPlaying}
          onPlay={active && onToggle ? onToggle : onPress}
        />
      )}
      {/* pointer-events-none so a click on the play button underneath isn't
          swallowed by this label overlay (which would open the page instead). */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pr-14">
        <span className="block text-[15px] font-semibold text-white">
          {title}
        </span>
        <span className="block text-[11.5px] text-white/80">
          {loading ? 'Starting…' : opening ? 'Opening…' : 'Endless'}
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
  active,
  isPlaying,
  onOpen,
  onPlay,
  onToggle,
}: {
  mix: MixData;
  cadence: string;
  desktop?: boolean;
  /** This mix is the current playback source → persistent play/pause button. */
  active?: boolean;
  isPlaying?: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onToggle?: () => void;
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
      <CardPlayButton
        label={`Play ${mix.title}`}
        persistent={!desktop || !!active}
        playing={!!active && !!isPlaying}
        onPlay={active && onToggle ? onToggle : onPlay}
      />
      {/* pointer-events-none so a click on the play button underneath isn't
          swallowed by this label (pr-14 only keeps the TEXT clear of it). */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pr-14">
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
  desktop = false,
  icon,
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
  /** Desktop chrome active. On phone the in-place "Show all" expand is hidden —
   *  rows just scroll horizontally, like Spotify's mobile home. */
  desktop?: boolean;
  /** Optional round header thumbnail (the seed artist on a "More like {X}" row). */
  icon?: string | null;
}) {
  // "Show all" flips the scroll row into a wrapping grid (same pattern as
  // Discover's shelves). Only offered when there's actually more to see.
  const [expanded, setExpanded] = useState(false);
  const count = Children.count(children);
  const showGrid = forceExpand || expanded;
  // Offer either affordance only when there's actually more to see, and never
  // on the phone (its rows scroll) or in an already-expanded grid.
  const offerShowAll = count > 4 && !forceExpand && !!desktop;
  const drillable = offerShowAll && !!onShowAll;
  const expandable = offerShowAll && !onShowAll;
  return (
    <section className="mb-7 lg:mb-10">
      <div className="px-4 lg:px-8 mb-2.5 lg:mb-4 flex items-end justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {icon ? (
            <img
              src={icon}
              alt=""
              className="h-10 w-10 lg:h-12 lg:w-12 shrink-0 rounded-full object-cover"
            />
          ) : null}
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-[11px] uppercase tracking-wide text-neutral-500">
                {eyebrow}
              </p>
            ) : null}
            {/* The title IS the show-all link when there's a page to drill to —
                "Golden ›" — matching the artist page instead of a separate
                right-aligned text link. Desktop only: phone rows just scroll,
                like Spotify's mobile home. */}
            <h2 className="text-lg lg:text-2xl font-bold tracking-tight">
              <ShowAllTitle
                label={title}
                onShowAll={
                  drillable ? onShowAll : undefined
                }
              />
            </h2>
          </div>
        </div>
        {/* The expand-in-place shelves keep a text toggle: a bare chevron can
            say "there's more", but nothing about it says "collapse", and this
            control has to say both. */}
        {expandable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 pb-0.5 text-xs font-medium text-neutral-400 hover:text-neutral-100 active:text-neutral-100"
          >
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      {showGrid ? (
        <div className="px-4 lg:px-8 py-4 -my-4 flex flex-wrap gap-4 lg:gap-6">{children}</div>
      ) : (
        // Same Apple-Music-style hover ‹ › arrows as the artist page (ShelfRow,
        // shared). Desktop-only (sm:flex); the phone still swipes. The scroller
        // keeps py-4 so the cards' -inset-3 hover highlight fits inside it (no
        // vertical overflow → no stray scroll, no clipped shadow); the -my-4
        // goes on THIS outer wrapper, NOT the scroller — a negative margin on
        // the scroller collapses ShelfRow's positioning box and kills the arrows.
        <div className="-my-4">
          <ShelfRow artClass={artClass} scrollerClassName="flex gap-4 lg:gap-6 overflow-x-auto overflow-y-clip px-4 lg:px-8 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
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
  subtitleShort,
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
  /** A trimmed subtitle for the phone, where the full one wraps. The spotlight
   *  band's subtitle lists the result artists — redundant with the covers in
   *  the row below — so on a narrow screen it collapses to just the count.
   *  Omitted ⇒ the phone shows `subtitle` like the desktop. */
  subtitleShort?: string | null;
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
      {/* Content: sharp full square cover · text · (desktop) round play/pause. */}
      <div className="relative flex items-center gap-4 p-4">
        <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-neutral-800 shadow-lg ring-1 ring-white/10 sm:h-36 sm:w-36">
          {cover ? (
            <img
              src={cover}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : null}
          {/* Phone: the round play button is hidden below to give the title its
              width back, so the artwork carries the play/pause state instead —
              the same marker every other phone list already uses. */}
          <div className="sm:hidden">
            <NowPlayingCover current={active} playing={isPlaying} />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="mb-0.5 hidden text-[11px] text-white/70 sm:block">
              {eyebrow}
            </div>
          ) : null}
          <div className="line-clamp-2 text-2xl font-bold tracking-tight leading-tight text-white">
            {title}
          </div>
          {subtitle ? (
            // line-clamp-1 everywhere: the phone used to get TWO lines here while
            // the roomier desktop got one — backwards. Now the phone shows the
            // short variant (when given) on one line; the desktop shows the full
            // subtitle on one line.
            <div className="mt-1 line-clamp-1 text-xs text-white/70">
              {subtitleShort ? (
                <>
                  <span className="sm:hidden">{subtitleShort}</span>
                  <span className="hidden sm:inline">{subtitle}</span>
                </>
              ) : (
                subtitle
              )}
            </div>
          ) : null}
        </div>
        {/* Desktop only: the card is far wider there, so the round ▶/⏸ costs
            nothing. On the phone it ate 64px (button + gap) of a 311px row and
            squeezed the title to 119px — the artwork shows the state instead.
            Purely decorative either way: the whole card is the button. */}
        <div className="hidden h-12 w-12 shrink-0 place-items-center rounded-full bg-white text-neutral-950 shadow-[0_8px_16px_rgba(0,0,0,0.45)] transition duration-200 group-hover:scale-105 group-active:scale-95 sm:grid">
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

/** Per-name artist links for a card's credit line. stopPropagation keeps the
 *  card's own click (play/open) from firing under a name tap. Only rendered
 *  when a navigation handler exists — the phone home passes none, so its
 *  tiles keep plain text and stay single-tap targets. */
function ArtistLinks({
  artists,
  onOpen,
}: {
  artists: string[];
  onOpen: (name: string) => void;
}) {
  return (
    <>
      {artists.map((a, i) => (
        <span key={`${a}-${i}`}>
          {i > 0 ? ', ' : ''}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(a);
            }}
            className="hover:underline hover:text-neutral-300"
            title={`Go to ${a}`}
          >
            {a}
          </button>
        </span>
      ))}
    </>
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
  onOpenArtist,
  onOpenAlbum,
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
  /** Desktop-only navigation (absent on the phone): title → the album page,
   *  each artist name → that artist's page. */
  onOpenArtist?: (name: string) => void;
  onOpenAlbum?: (name: string, artist: string | null) => void;
}) {
  const lp = useLongPress(() => onLongPress?.());
  // Re-render on hub-reachability changes; a non-downloaded track can't start
  // its live stream while the desktop is unreachable, so its card dims + stops
  // playing on tap (the connection banner explains why).
  useHubReachable();
  const playableNow = canPlayNow(track);
  const box = size === 'lg' ? 'w-40 lg:w-44' : 'w-32 lg:w-44';
  const art = size === 'lg' ? 'h-40 w-40 lg:h-44 lg:w-44' : 'h-32 w-32 lg:h-44 lg:w-44';
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
        <Marquee text={track.title} className="mt-1.5 lg:mt-2.5 text-sm">
          {onOpenAlbum && track.album ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenAlbum(track.album!, track.artists[0] ?? null);
              }}
              className="hover:underline"
              title={`Go to album: ${track.album}`}
            >
              {track.title}
            </button>
          ) : undefined}
        </Marquee>
        <Marquee text={track.artists.join(', ')} className="text-xs text-neutral-500">
          {onOpenArtist ? (
            <ArtistLinks artists={track.artists} onOpen={onOpenArtist} />
          ) : undefined}
        </Marquee>
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
  onOpenArtist,
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
  /** Desktop-only: each artist name → that artist's page. (The card itself
   *  already opens the album, so the title needs no separate link.) */
  onOpenArtist?: (name: string) => void;
}) {
  const lp = useLongPress(() => onLongPress?.());
  const box = size === 'lg' ? 'w-40 lg:w-44' : 'w-32 lg:w-44';
  const art = size === 'lg' ? 'h-40 w-40 lg:h-44 lg:w-44' : 'h-32 w-32 lg:h-44 lg:w-44';
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
        <Marquee text={album.name} className="mt-1.5 lg:mt-2.5 text-sm" />
        <Marquee text={album.artists.join(', ')} className="text-xs text-neutral-500">
          {onOpenArtist ? (
            <ArtistLinks artists={album.artists} onOpen={onOpenArtist} />
          ) : undefined}
        </Marquee>
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
  matchAlbumSize = false,
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
  /** In a MIXED row, size the circle to match the album/playlist squares so
   *  every label below lines up. Homogeneous artist shelves leave this off and
   *  keep the slightly smaller circle (the usual music-UI convention). */
  matchAlbumSize?: boolean;
}) {
  const lp = useLongPress(() => onLongPress?.());
  // Match AlbumCard's box (w-40/w-32) + art (h-40/h-32) when asked, so a circle
  // and a square in the same row share a height and their captions align.
  const box = matchAlbumSize
    ? size === 'lg'
      ? 'w-40 lg:w-44'
      : 'w-32 lg:w-44'
    : size === 'lg'
      ? 'w-36 lg:w-40'
      : 'w-28 lg:w-40';
  const art = matchAlbumSize
    ? size === 'lg'
      ? 'h-40 w-40 lg:h-44 lg:w-44'
      : 'h-32 w-32 lg:h-44 lg:w-44'
    : size === 'lg'
      ? 'h-36 w-36 lg:h-40 lg:w-40'
      : 'h-28 w-28 lg:h-40 lg:w-40';
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
        <div className="mt-1.5 lg:mt-2.5 truncate text-sm">{artist.name}</div>
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
