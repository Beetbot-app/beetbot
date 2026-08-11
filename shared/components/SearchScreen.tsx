import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  cn,
  POPOVER,
  navPill,
  INPUT,
  CALLOUT_WARN,
  CALLOUT_ERROR,
  EYEBROW,
  EYEBROW_ON_ART,
} from '../ui';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from './ContextMenu';
import { CardPlayButton, Marquee } from './Marquee';
import { HeroWash } from './HeroWash';
import { audioStarted, registerAudioPauser } from '../audioCoordinator';
import {
  addRecentAlbum,
  addRecentArtist,
  addRecentPlaylist,
  addRecentQuery,
  addRecentTrack,
  clearRecentSearches,
  removeRecentItem,
  coverSrc,
  getAlbumTracks,
  getArtistAlbums,
  getArtistAppearsOn,
  getArtistBio,
  getArtistRelated,
  getArtistTopTracks,
  canPlayNow,
  friendlyError,
  getCatalogPlaylist,
  importAlbum,
  deletePlaylist,
  getRecentItems,
  getStats,
  importPlaylist,
  isHubReachable,
  isPlayable,
  listLibrarySongs,
  listPlaylists,
  onHubReachability,
  playlistArtUrl,
  searchCatalog,
  type ArtistBio,
  type CatalogOpenRequest,
  type CatalogPlaylist,
  type CatalogPlaylistSummary,
  type PlaylistRow,
  type RecentItem,
  type SearchAlbumResult,
  type SearchArtistResult,
  type SearchResults,
  type SearchTrackResult,
  type StreamTrack,
} from '../api';
import { useHubReachable } from '../useHubReachable';
import { useLibraryChangeTick } from '../useLibraryChange';
import { formatDuration } from '../format';
import { isPhantomArtist } from '../artistName';
import { CondensedHeaderBar, useCondensedHeader } from './StickyHeader';
import { useScrollMemory } from '../useScrollMemory';
import { EqualizerBars } from './EqualizerBars';
import { useActiveProfile, SettingsAvatar, STICKY_FROST } from './PhoneTopBar';
import { ModalShell } from './modals/ModalShell';
import { AddToPlaylistModal } from './modals/AddToPlaylistModal';
import { AlbumDetailModal } from './modals/AlbumDetailModal';
import { PreviewRing, ExplicitBadge, AlbumDownloadedBadge, ShelfRow, AlbumGrid, playAlbumCard, albumTypeLabel, formatReleaseDate, PREVIEW_RING_KEYFRAMES, type SidebarPinController } from './searchPrimitives';
import { notifyLibraryChanged } from '../libraryChanged';
import { ShowAllTitle } from './ShowAllTitle';
// Re-export the extracted primitives + modal so existing external importers
// (BrowseScreen, HomeScreen, Playlist, TrackRow, Search, web-player, detailControllers)
// keep importing them from this module unchanged.
export { AlbumDetailModal } from './modals/AlbumDetailModal';
export { PreviewRing, AlbumGrid, ShelfRow, playAlbumCard, PREVIEW_RING_KEYFRAMES, type SidebarPinController } from './searchPrimitives';

/**
 * A restorable snapshot of the search overlay's "current page": the committed
 * query plus any drilled-into artist/album. The desktop host stores one of
 * these per view-history entry so Back/Forward can replay searched pages (the
 * overlay is otherwise ephemeral and would vanish the moment you navigate away).
 */
/** Which "show all" grid an artist page can drill into (the › chevron next to
 *  a section). Apple-Music-style: a full page listing every item in that
 *  section, reached from the artist page and its own Back/Forward stop. */
export type ShowAllSection = 'albums' | 'singles' | 'related' | 'songs';

/** Data the artist page already loaded, handed to the show-all page on drill-in
 *  so it renders instantly with no fetch/skeleton flash — it seeds from this and
 *  skips the request. `albums` is the FULL discography (the show-all filters it
 *  into the albums vs singles view itself). Absent fields fall back to a fetch. */
export interface ShowAllInitial {
  albums?: SearchAlbumResult[];
  topTracks?: SearchTrackResult[];
  related?: SearchArtistResult[];
}

export interface OverlaySnapshot {
  query: string;
  artist: SearchArtistResult | null;
  album: SearchAlbumResult | null;
  /** A drilled-into catalog playlist (from the Playlists search results). */
  playlist?: CatalogPlaylistSummary | null;
  /** When set, the artist page is showing one of its sections in full (the
   *  show-all grid). Always rides on a non-null `artist`. */
  showAll?: ShowAllSection | null;
}

/** Stable identity of an overlay page, for detecting genuine drill transitions
 *  (vs. a restore re-applying the same page). `∅` means "no overlay" (idle). */
function overlayKey(
  query: string,
  artist: SearchArtistResult | null,
  album: SearchAlbumResult | null,
  showAll: ShowAllSection | null = null,
  playlist: CatalogPlaylistSummary | null = null,
): string {
  const q = query.trim();
  return q || artist || album || playlist
    ? `${q}|${artist?.source_id ?? ''}|${album?.source_id ?? ''}|${showAll ?? ''}|${playlist?.source_id ?? ''}`
    : '∅';
}

interface Props {
  token: string;
  /**
   * Bundle-supplied "play this track" callback. The phone bundle
   * seeds its zustand store with a one-track queue; the desktop
   * bundle does the same against its own PlaylistTrack-shaped store.
   * Either way SearchScreen stays a pure UI component with no
   * knowledge of which player lives behind it.
   *
   * Plays the FULL song (the host resolves a catalog result to a library row
   * and plays it). When `list` + `index` are passed, the host seeds the
   * whole list as the play queue starting at `index`, so playback auto-advances
   * down the list (Spotify-style); omitted ⇒ play just this one track.
   */
  onPlayTrack: (
    track: SearchTrackResult,
    list?: SearchTrackResult[],
    index?: number,
  ) => void;
  /**
   * Empty-state body (no query yet). When provided it replaces the built-in
   * static genre tiles — the phone passes the real <BrowseScreen> genre grid
   * here so opening Search lands on "Browse all", Spotify-style. Threaded as a
   * slot (rather than importing BrowseScreen) to avoid a circular import, since
   * BrowseScreen imports from this file.
   */
  browseSlot?: ReactNode;
  /**
   * Desktop only: render artist/album drill-ins as full inline pages
   * (with a Back button) in place of the search UI, instead of as modal
   * overlays. The phone leaves this off and keeps the bottom-sheet modals.
   */
  pageMode?: boolean;
  /**
   * True in the desktop app. The "hub" there is the app's own loopback
   * server, so the offline banner is reworded — "restart the app" rather than
   * the phone's "connect to your computer" (the desktop IS the computer).
   */
  desktop?: boolean;
  /**
   * Imperative "open this artist/album page" request, identified by name
   * (the now-playing bar has no Deezer ids). When set, the screen resolves
   * the name via `searchCatalog` and drills into the best hit, then calls
   * `onRequestHandled`. Desktop-only; the phone leaves both undefined.
   */
  openRequest?: CatalogOpenRequest | null;
  onRequestHandled?: () => void;
  /** Phone only: bumped when the Search tab is re-tapped, so any open drill-in
   *  (artist/album/playlist/show-all) closes back to the results. */
  resetSignal?: number;
  /**
   * The active user profile. New playlists / album imports created here are
   * assigned to this profile so they show up in that profile's library.
   * Omitted ⇒ the host's default profile.
   */
  activeProfileId?: number | null;
  /**
   * Phone-only: opens Settings from the account avatar in the Search header
   * (same top-left spot as Home / Library). Omitted on desktop, which has its
   * own top bar — so no avatar renders there.
   */
  onOpenSettings?: () => void;
  /**
   * Desktop "top bar" mode. When `barSlot` is a DOM node, the search bar +
   * dropdown render into it (a persistent top bar) via a portal instead of
   * inline. With `overlayMode`, the rest (results + detail pages) renders as an
   * absolute overlay over the main area, collapsing to nothing when idle so the
   * underlying view (Home, etc.) shows through — so search is no longer a
   * sidebar tab. Both default off: the phone and the old layout are untouched.
   */
  barSlot?: HTMLElement | null;
  overlayMode?: boolean;
  /**
   * Host-driven overlay restore. On each `signal` bump the overlay is reset to
   * `snapshot`: `null` clears it (navigating to a fresh view), a snapshot
   * replays a previously-saved search page (Back/Forward landing on a history
   * entry that had a search open). Supersedes the old fire-and-forget clear.
   */
  restore?: { signal: number; snapshot: OverlaySnapshot | null };
  /**
   * Called when the user drills to a NEW search page (commits a search, opens
   * an artist/album, drills deeper). The host pushes a view-history entry for
   * it, so each searched page is its own Back/Forward stop and Back is pure
   * history navigation (not a destructive in-place unwind). Desktop-only.
   */
  onOverlayPush?: (snapshot: OverlaySnapshot) => void;
  /**
   * Closes the current overlay page by stepping BACK one history entry
   * (overlayMode only) — wired to the host's Back. Closing a detail (Escape /
   * the ✕) routes here instead of mutating overlay state in place, so it's a
   * real Back (pops to the page underneath) rather than a phantom forward push.
   */
  onOverlayBack?: () => void;
  /**
   * Desktop-only: called when the user focuses the (idle) search input.
   * The host navigates the main view to Discover, Spotify/Apple-Music-style —
   * tapping into search surfaces browse categories until a query is typed.
   * Only fired while the overlay is idle, so re-focusing during an active
   * search never navigates.
   */
  onSearchFocus?: () => void;
  /**
   * Desktop-only: renders a Spotify-style Browse button inside the search box
   * (right edge, behind a hairline divider) that always jumps to Discover —
   * even mid-search (the host's navigation clears the overlay via `restore`).
   */
  onOpenBrowse?: () => void;
  /** Open one of the user's OWN library playlists (the "From your library"
   *  search matches). Host navigates to the library playlist page. Omitted ⇒
   *  library playlists aren't surfaced in results. */
  onOpenLibraryPlaylist?: (id: number) => void;
  /** Play one of the user's OWN library songs (a "From your library" match). */
  onPlayLibrarySong?: (t: StreamTrack) => void;
  /** Desktop-only sidebar-pin controls, injected by the host. Omitted on the
   *  phone (no pinned sidebar) → the artist/album pages render no Pin button. */
  pin?: SidebarPinController;
  /** Desktop-only save-to-library control for the artist page (Library ›
   *  Artists). Omitted on the phone → no Save button. */
  save?: SavedArtistController;
  /**
   * Desktop-only browse-album "⋯" menu handlers. When supplied (with
   * `pageMode`), each track row in an opened browse album gets a per-song
   * overflow menu — mirroring the library album/playlist menus. "Add to
   * playlist" is handled internally (it reuses the picker); these cover the
   * actions that need a host round-trip on a *catalog* track that may have no
   * library row yet (the host resolves it first). Omitted on the phone.
   */
  onAlbumGoToArtist?: (name: string) => void;
  onAlbumAddToQueue?: (t: SearchTrackResult) => void;
  onAlbumSaveToLiked?: (t: SearchTrackResult) => void;
  /** Desktop "Add audio file" — attach a file you own to a fileless track.
   *  Undefined on the phone (no file dialog). Shown only for tracks with no
   *  local file yet. */
  onAddAudio?: (t: SearchTrackResult) => void;
  /** Open an album by name (clickable Album column on catalog-playlist rows). */
  onAlbumGoToAlbum?: (name: string, artist: string | null) => void;
  /**
   * Phone-only: open the per-song "⋯" bottom sheet for an opened album/playlist
   * row. The host (web-player) owns the sheet UI (the same TrackActionSheet the
   * library album/playlist rows use) and its actions. When supplied, catalog
   * album/playlist rows show a touch ⋯ and fold their add control into it.
   */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /**
   * Now-playing awareness for the opened album/playlist page (desktop). Lets the
   * shared AlbumDetailModal mirror the library playlist page: highlight + show
   * equalizer bars on the current track, and a ⏸/▶ hero + sticky Play button.
   * Omitted on the phone (which stays play-state-agnostic there).
   */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isNowPlaying?: boolean;
  onTogglePlay?: () => void;
}


/** "Save to library" toggle for an artist detail-page header — populates the
 *  Library › Artists tab (distinct from pinning to the sidebar). */
export interface SavedArtistController {
  isSaved: (name: string) => boolean;
  toggle: (a: { key: string; name: string; art: string | null }) => void;
}

/** Spotify-style "Save"/"Saved" pill for an artist header. */
function SaveArtistButton({ saved, onClick }: { saved: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={saved ? 'Remove from your library' : 'Save to your library'}
      aria-label={saved ? 'Remove from your library' : 'Save to your library'}
      aria-pressed={saved}
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
        saved
          ? 'border-transparent bg-accent/15 text-accent'
          : 'border-neutral-600 text-neutral-200 hover:border-neutral-300 hover:text-white'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {saved ? <path d="M20 6 9 17l-5-5" /> : <path d="M12 5v14M5 12h14" />}
      </svg>
      {saved ? 'Saved' : 'Save'}
    </button>
  );
}

/** "Pin to sidebar" toggle for a detail-page header (artist / album). */
function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  // Icon-only pin, matching the album/playlist page's pin button exactly (no
  // "Pin" text pill) — filled when pinned to the sidebar.
  return (
    <button
      type="button"
      onClick={onClick}
      title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-label={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
      aria-pressed={pinned}
      className={`rounded-lg px-3 py-2 transition hover:bg-neutral-900 ${
        pinned ? 'text-white' : 'text-neutral-400 hover:text-neutral-100'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
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
  );
}

type Tab = 'all' | 'tracks' | 'albums' | 'artists' | 'playlists';

/** Renders children into `target` via a portal when set (the desktop top bar),
 *  otherwise inline. */
function MaybePortal({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? createPortal(children, target) : <>{children}</>;
}

/**
 * Catalog search → add-to-playlist UI.
 *
 * Hits /api/search (which proxies to Spotify) on a debounced timer, then
 * lets the user tap "+" on a track to pick a target playlist. Album cards
 * drill into a track list for that album so individual tracks (or "Add all")
 * can be appended.
 *
 * The add operation is local-only on the host.
 */
export function SearchScreen({
  token,
  onPlayTrack,
  browseSlot,
  pageMode,
  desktop,
  openRequest,
  onRequestHandled,
  resetSignal,
  activeProfileId,
  onOpenSettings,
  barSlot,
  overlayMode,
  restore,
  onOverlayPush,
  onOverlayBack,
  onSearchFocus,
  onOpenBrowse,
  onOpenLibraryPlaylist,
  onPlayLibrarySong,
  pin,
  save,
  onAlbumGoToArtist,
  onAlbumAddToQueue,
  onAlbumSaveToLiked,
  onAddAudio,
  onAlbumGoToAlbum,
  onShowTrackSheet,
  isTrackCurrent,
  isNowPlaying,
  onTogglePlay,
}: Props) {
  // Re-render this screen (and its inline handlers) when the hub drops/returns,
  // so canPlayNow gating in replayRecentTrack / applySuggestion stays live.
  useHubReachable();
  // Phone header avatar (→ Settings). Resolved from the active profile id, same
  // as Home / Library. Unused on desktop (no avatar renders there).
  const profile = useActiveProfile(token, activeProfileId ?? null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Spotify-style "commit" model: while you type, only the suggestion
  // dropdown shows. The full results page renders for `committedQuery`, set
  // when you press the keyboard's search/return key or tap a suggestion.
  // Editing the box clears it, so the page disappears and suggestions return.
  const [committedQuery, setCommittedQuery] = useState('');
  // Which query `results` actually belong to — so we don't flash the previous
  // committed search's page while a freshly-committed one is still loading.
  const [resultsQuery, setResultsQuery] = useState('');
  // Per-query results cache (session-scoped), so restoring a search page via
  // Back/Forward shows its results instantly instead of flashing "Searching…"
  // while the network refetch revalidates. Keyed by the debounced query.
  const resultsCache = useRef<Map<string, SearchResults>>(new Map());
  // The overlay page last recorded in the host's history (pushed or restored),
  // so the push effect can tell a genuine user drill from a restore re-applying
  // the same page (which must NOT push a duplicate entry). `∅` = idle.
  const lastOverlayKey = useRef<string>('∅');
  const [pickerTrack, setPickerTrack] = useState<SearchTrackResult | null>(null);
  // Desktop browse-album "⋯" overflow menu (cursor-anchored), built per row.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [openAlbum, setOpenAlbum] = useState<SearchAlbumResult | null>(null);
  const [openPlaylist, setOpenPlaylist] =
    useState<CatalogPlaylistSummary | null>(null);
  const [openArtist, setOpenArtist] = useState<SearchArtistResult | null>(null);
  // A section of the open artist page ("Albums"/"Singles & EPs"/"Similar
  // Artists") shown in full as its own grid page — reached via the section's ›
  // chevron, its own Back/Forward stop. Only meaningful while `openArtist` set.
  const [openShowAll, setOpenShowAll] = useState<ShowAllSection | null>(null);
  // Data the artist page had already loaded when its ›-chevron was clicked, so
  // the show-all seeds instantly instead of refetching. Cleared alongside
  // openShowAll (a fresh open with no seed just fetches).
  const [showAllInitial, setShowAllInitial] = useState<ShowAllInitial | null>(
    null,
  );
  // Phone: re-tapping the Search tab (resetSignal bump) pops any open drill-in
  // back to the results. Guarded so the mount pass is a no-op.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setOpenShowAll(null);
    setOpenArtist(null);
    setOpenAlbum(null);
    setOpenPlaylist(null);
  }, [resetSignal]);
  // Persisted recents — Spotify-style. A mix of committed text queries and
  // entities (tracks/artists/albums) the user actually opened or played.
  // Shown as rich rows when the search bar is empty. Backed by localStorage.
  const [recents, setRecents] = useState<RecentItem[]>(() => getRecentItems());
  // Re-read when the profile changes. `getRecentItems` is profile-scoped, but a
  // mount-only initializer never runs again — and the desktop switches between
  // no-PIN profiles WITHOUT unmounting (TopBar's `setActiveProfile`), leaving
  // this component alive with the previous person's searches in state. The next
  // person opening the search box would see them.
  useEffect(() => {
    setRecents(getRecentItems());
  }, [activeProfileId]);
  // Tracks whether the desktop hub answered. When it's unreachable, catalog
  // reads transparently fall back to hitting Deezer directly (search/preview
  // still work); we show a banner and steer the user away from save actions
  // that genuinely need the computer.
  const [hubUp, setHubUp] = useState(isHubReachable());
  useEffect(() => onHubReachability(setHubUp), []);
  // Personal listening history (your most-played artists → play count), fetched
  // once so the ranking can nudge artists you actually listen to up the list —
  // Spotify's top-documented signal. Empty (and a no-op) if the hub is
  // unreachable or stats haven't been recorded yet.
  const [played, setPlayed] = useState<ReadonlyMap<string, number>>(EMPTY_PLAYED);
  useEffect(() => {
    let cancelled = false;
    getStats(token, activeProfileId)
      .then((stats) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        for (const a of stats.top_artists ?? []) {
          const k = normalizeForMatch(a.name);
          if (k) m.set(k, a.count);
        }
        setPlayed(m);
      })
      .catch(() => {
        /* no stats (hub down / fresh profile) → ranking just skips the boost */
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId]);
  // For the clear-(✕) button so clearing keeps focus in the field.
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Shared 30-second-preview player. One <audio> element for the whole
  // screen; starting a clip stops any other.
  const {
    playingUrl: playingPreviewUrl,
    toggle: togglePreview,
    stop: stopPreview,
  } = usePreviewPlayer();

  // --- Typeahead dropdown state ---
  // Shown while the field is focused and the user has typed something. We
  // suppress it after a selection / Escape so it doesn't pop back over the
  // results; typing again (onChange) clears the suppression.
  const [inputFocused, setInputFocused] = useState(false);
  const [suppressSuggest, setSuppressSuggest] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const ql = q.toLowerCase();
    const out: Suggestion[] = [];
    // First row: commit the typed query (explicit "search this", and what the
    // keyboard's return key does).
    out.push({ kind: 'search', text: q });
    // Top entities by relevance — songs, artists, and albums mixed and ranked
    // by the same federated scoring the results page uses, so the most
    // relevant hit (e.g. the actual song you typed) shows first. Only once
    // results have settled on the current query, so we never show stale rows.
    if (!loading && results && debounced === q) {
      const fed = buildFederated(results, normalizeForMatch(q), played);
      const entities = [fed.top, ...fed.rest].filter(
        (x): x is FederatedItem => !!x,
      );
      for (const it of entities) {
        // Leave room for a couple of playlist rows below (Spotify shows
        // playlists inline in the dropdown), so don't fill all 8 with entities.
        if (out.length >= 6) break;
        if (it.kind === 'track') out.push({ kind: 'track', track: it.track });
        else if (it.kind === 'artist')
          out.push({ kind: 'artist', artist: it.artist });
        else out.push({ kind: 'album', album: it.album });
      }
      // A couple of matching catalog playlists, inline (Spotify-style) — so you
      // can jump straight into "80s Hits" without filtering by the Playlists tab.
      for (const p of results.playlists ?? []) {
        if (out.length >= 8) break;
        out.push({ kind: 'playlist', playlist: p });
      }
    }
    // Recent-search completions (from past text queries), filling remaining room.
    for (const r of recents) {
      if (out.length >= 10) break;
      if (r.kind !== 'query') continue;
      const rl = r.text.toLowerCase();
      if (rl !== ql && rl.includes(ql)) out.push({ kind: 'query', text: r.text });
    }
    return out;
  }, [query, recents, results, loading, debounced, played]);

  const showSuggest =
    inputFocused &&
    !suppressSuggest &&
    query.trim().length > 0 &&
    suggestions.length > 0;
  // Spotify-style: focusing the empty box shows recent searches in a dropdown
  // under the bar (not a page-body section). An empty focused box always offers
  // recents — `suppressSuggest` only guards the typing dropdown from popping
  // back over committed results, which never applies when the box is empty.
  // Show only the entities you actually opened (artist/album/track), not the raw
  // query strings you typed — those still feed the typing-completion suggestions
  // but look messy listed here.
  const recentEntities = recents.filter((it) => it.kind !== 'query');
  const showRecents = inputFocused && !query.trim() && recentEntities.length > 0;

  // Reset the keyboard highlight whenever the menu opens/closes or its
  // contents change.
  useEffect(() => {
    setActiveSuggestion(-1);
  }, [showSuggest, suggestions.length]);

  // Commit a search: render the full results page for `text`. Fires the
  // fetch immediately (skips the debounce), records it in recents, and closes
  // the dropdown.
  const commitSearch = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setQuery(t);
    setCommittedQuery(t);
    setDebounced(t);
    setRecents(addRecentQuery(t));
    setSuppressSuggest(true);
    setActiveSuggestion(-1);
    searchInputRef.current?.blur();
  }, []);

  // Engaging with an entity (playing a track, opening an artist/album) records
  // it in recents AND performs the action — so the empty-search state fills
  // with the things you actually used, Spotify-style.
  const playTrack = useCallback(
    (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => {
      setRecents(addRecentTrack(t));
      onPlayTrack(t, list, index);
    },
    [onPlayTrack],
  );
  // Card play buttons: a hovered album/artist card plays without opening its
  // page first (see playAlbumCard/playArtistCard).
  const playAlbumResult = useCallback(
    (a: SearchAlbumResult) => playAlbumCard(a, token, onPlayTrack),
    [onPlayTrack, token],
  );
  const playArtistResult = useCallback(
    (a: SearchArtistResult) => playArtistCard(a, token, onPlayTrack),
    [onPlayTrack, token],
  );
  // Opening a page from any entry point (typeahead suggestion or a recent
  // search row) navigates away, so always close the dropdown: blur the field
  // (the recents/suggest menus are gated on `inputFocused`) and suppress the
  // typing dropdown so it can't pop back over the page.
  const closeDropdown = useCallback(() => {
    setSuppressSuggest(true);
    setActiveSuggestion(-1);
    searchInputRef.current?.blur();
  }, []);

  // Desktop: clicking the top bar's empty area should dismiss the search —
  // otherwise a header click just drags the window and the search stays "stuck".
  // That empty area is a Tauri `data-tauri-drag-region`, which intercepts
  // MOUSEDOWN natively for window-dragging (so a JS mousedown listener never
  // fires). The CLICK event is untouched, though, so the TopBar fires an
  // `onClick` there that dispatches this event; we dismiss state-aware: a
  // committed results/detail page steps back out (like the ✕); an open recents
  // dropdown just blurs shut.
  useEffect(() => {
    if (!overlayMode) return;
    const dismiss = () => {
      if (committedQuery.trim() || openArtist || openAlbum || openPlaylist) {
        onOverlayBack?.();
      } else if (inputFocused) {
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('beetbot:dismiss-search', dismiss);
    return () => window.removeEventListener('beetbot:dismiss-search', dismiss);
  }, [
    overlayMode,
    committedQuery,
    openArtist,
    openAlbum,
    openPlaylist,
    inputFocused,
    onOverlayBack,
  ]);
  const openArtistPage = useCallback(
    (a: SearchArtistResult) => {
      setRecents(addRecentArtist(a));
      stopPreview();
      setOpenShowAll(null);
      // Supersede any open album/playlist so the artist page actually renders —
      // the detail render lets an open album win, so a stale `openAlbum` (e.g.
      // you came from an album page) would otherwise keep showing it.
      setOpenAlbum(null);
      setOpenPlaylist(null);
      setOpenArtist(a);
      closeDropdown();
    },
    [stopPreview, closeDropdown],
  );
  const openAlbumPage = useCallback(
    (a: SearchAlbumResult) => {
      setRecents(addRecentAlbum(a));
      stopPreview();
      // Symmetric with openArtistPage: opening one detail surface clears the
      // others (and any artist "Show all") so navigation lands cleanly.
      setOpenShowAll(null);
      setOpenArtist(null);
      setOpenPlaylist(null);
      setOpenAlbum(a);
      closeDropdown();
    },
    [stopPreview, closeDropdown],
  );
  // Open a catalog playlist from the Playlists search results. Like the album
  // opener, but the drilled surface is the shared PlaylistDetailModal page.
  const openPlaylistPage = useCallback(
    (p: CatalogPlaylistSummary) => {
      stopPreview();
      setOpenShowAll(null);
      setOpenArtist(null);
      setOpenAlbum(null);
      setOpenPlaylist(p);
      // Remember it as a recent, like opening a track/artist/album does — so a
      // tap re-opens the exact playlist from the recents list.
      setRecents(addRecentPlaylist(p));
      closeDropdown();
    },
    [stopPreview, closeDropdown],
  );

  // The trailing + on album / playlist result rows: fetch the item's tracks and
  // import it into the library (same as the detail page's add). importAlbum
  // lands it in the Albums tab; importPlaylist as a plain playlist. A
  // library-changed event refreshes the sidebar / Library list.
  const addAlbumToLibrary = useCallback(
    async (album: SearchAlbumResult) => {
      const tracks = await getAlbumTracks(album.source_id, token);
      await importAlbum(album.name, tracks, token, album.artists[0] ?? null, activeProfileId);
      if (typeof window !== 'undefined')
        notifyLibraryChanged();
    },
    [token, activeProfileId],
  );
  const addPlaylistToLibrary = useCallback(
    async (p: CatalogPlaylistSummary) => {
      const detail = await getCatalogPlaylist(p.source_id, token);
      await importPlaylist(p.title, detail.tracks, token, activeProfileId);
      if (typeof window !== 'undefined')
        notifyLibraryChanged();
    },
    [token, activeProfileId],
  );
  // Per-song "⋯" menu for an opened browse album's rows (desktop only). Mirrors
  // the library album menu, but the row is a *catalog* result that may have no
  // library track yet — so "Add to queue" / "Save to Liked" defer to the host,
  // which resolves (imports) the track first. "Add to playlist" reuses the
  // picker here (the AddToPlaylistModal lives in this component).
  const showAlbumTrackMenu = useCallback(
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
      // Attach your own file — only when this track has no local file yet.
      if (onAddAudio && !t.has_audio)
        items.push({
          label: 'Add audio file',
          icon: MenuGlyphs.plus,
          onClick: () => onAddAudio(t),
        });
      setMenu({ x, y, items });
    },
    [onAlbumSaveToLiked, onAlbumAddToQueue, onAlbumGoToArtist, onAddAudio],
  );
  // Re-engage a recent track row: a downloaded file (or any track while the hub
  // is reachable) plays in full. A non-downloaded track when the hub is
  // unreachable is inert — the row dims and the connection banner explains why;
  // we don't substitute a preview for a play tap.
  const replayRecentTrack = useCallback(
    (t: SearchTrackResult) => {
      if (canPlayNow(t)) {
        setRecents(addRecentTrack(t));
        onPlayTrack(t);
      }
    },
    [onPlayTrack],
  );

  const applySuggestion = useCallback(
    (s: Suggestion) => {
      // The explicit search row and a recent-search completion commit a text
      // query → full results page.
      if (s.kind === 'search' || s.kind === 'query') {
        commitSearch(s.text);
        return;
      }
      // Tapping a song suggestion mirrors the results rows: a playable track
      // (a downloaded file, or any track while the hub is reachable) plays in
      // full and closes the dropdown. When it can't start now (open build, or
      // hub unreachable) we commit a full search rather than a preview.
      if (s.kind === 'track') {
        const t = s.track;
        if (canPlayNow(t)) {
          playTrack(t);
          closeDropdown();
        } else {
          // Can't start playing right now (open build, or hub unreachable) —
          // fall back to a full search rather than a preview substitute.
          commitSearch(t.title);
        }
        return;
      }
      // Artist/album rows jump straight to their page instead (and record).
      // openArtistPage/openAlbumPage close the dropdown themselves. Clear the
      // half-typed query too, so the box doesn't keep showing it once we've
      // left search for the entity page — matching the empty query the history
      // snapshot records for this drill-in (committedQuery is '' while typing).
      setQuery('');
      setCommittedQuery('');
      if (s.kind === 'artist') openArtistPage(s.artist);
      else if (s.kind === 'playlist') openPlaylistPage(s.playlist);
      else openAlbumPage(s.album);
    },
    [
      commitSearch,
      playTrack,
      togglePreview,
      openArtistPage,
      openAlbumPage,
      openPlaylistPage,
      closeDropdown,
    ],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuppressSuggest(true);
        setActiveSuggestion(-1);
        searchInputRef.current?.blur();
        return;
      }
      if (showSuggest && e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSuggestion((i) => (i + 1) % suggestions.length);
        return;
      }
      if (showSuggest && e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSuggestion((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (
          showSuggest &&
          activeSuggestion >= 0 &&
          activeSuggestion < suggestions.length
        ) {
          applySuggestion(suggestions[activeSuggestion]);
        } else {
          // Return key with nothing highlighted ⇒ search the typed text.
          commitSearch(query);
        }
      }
    },
    [
      showSuggest,
      suggestions,
      activeSuggestion,
      applySuggestion,
      commitSearch,
      query,
    ],
  );

  // 200ms debounce — snappy for a local-hub catalog while still coalescing
  // fast typing into one request (and Deezer's keyless API stays well under
  // its rate limit). Stale in-flight responses are ignored below.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(id);
  }, [query]);

  // Re-fetch results when the library changes elsewhere so the Songs rows' "in a
  // playlist" ✓ reflects a track just added/removed via the picker. No spinner
  // flash: `loading` only shows the spinner when there are no results yet (see
  // the results page below), so the current rows stay put and swap in fresh marks.
  const libTick = useLibraryChangeTick();
  useEffect(() => {
    if (!debounced) {
      setResults(null);
      setResultsQuery('');
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Fires for both the live dropdown (entity jumps as you type) and the
    // committed results page; the recents list is written on commit instead.
    searchCatalog(debounced, token, 'track,album,artist,playlist')
      .then((r) => {
        if (cancelled) return;
        // Clean the catalog's artist results before anything consumes them
        // (dropdown, Artists tab, federated rows): collapse duplicate profiles,
        // drop derivative "junk twins" (Tribute/Karaoke/Covers acts named
        // around a real artist), drop low-quality lookalike profiles, then
        // drop artists that only matched the query by typo distance.
        const cleaned = {
          ...r,
          artists: dropWeakArtistMatches(
            dropCombinedCreditArtists(
              dropLookalikeArtists(dropDerivativeArtists(dedupeArtists(r.artists))),
            ),
            normalizeForMatch(debounced),
          ),
        };
        resultsCache.current.set(debounced, cleaned);
        setResults(cleaned);
        setResultsQuery(debounced);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, token, libTick]);

  // Auto-flip to whichever tab has results when the user toggles the
  // currently-empty side. Saves a tap when search yields, say, only
  // tracks for a name like "Hozier".
  const hasTracks = (results?.tracks.length ?? 0) > 0;
  const hasAlbums = (results?.albums.length ?? 0) > 0;
  const hasArtists = (results?.artists.length ?? 0) > 0;
  useEffect(() => {
    if (!results) return;
    const currentEmpty =
      (tab === 'tracks' && !hasTracks) ||
      (tab === 'albums' && !hasAlbums) ||
      (tab === 'artists' && !hasArtists);
    if (!currentEmpty) return;
    // Flip to whichever tab actually has content, in priority order:
    // songs first (most common), then albums, then artists.
    if (hasTracks) setTab('tracks');
    else if (hasAlbums) setTab('albums');
    else if (hasArtists) setTab('artists');
  }, [results, tab, hasTracks, hasAlbums, hasArtists]);

  // Stop any in-flight preview when the user runs a new search or
  // switches tabs — the row that owns the clip is no longer on screen,
  // so leaving it playing would be orphan audio with no stop control.
  useEffect(() => {
    stopPreview();
  }, [debounced, tab, stopPreview]);

  // Resolve an imperative open-request (from the now-playing bar) into a
  // real Deezer hit and drill into it. We only have names to go on, so we
  // search and pick the closest match. If nothing matches (local-only album,
  // odd tag spelling) or the search itself fails (catalog hiccup), fall back
  // to a committed search for the name — the click always lands SOMEWHERE
  // instead of being silently swallowed (which read as a dead card).
  useEffect(() => {
    if (!openRequest) return;
    let cancelled = false;
    (async () => {
      let opened = false;
      try {
        if (openRequest.kind === 'artist') {
          const r = await searchCatalog(openRequest.name, token, 'artist', 10);
          if (cancelled) return;
          // Collapse Deezer's duplicate/impersonator profiles to the
          // most-followed one BEFORE picking — the raw order can put a junk
          // twin first (a 37-fan "Coldplay" above the real 18M-fan one), and
          // taking it opened a ghost page: placeholder image, a handful of
          // compilation credits as "Top Songs". Same cleanup the results
          // pipeline runs; only the dedupe though — the lookalike/weak-match
          // filters could drop a genuinely tiny exact-name artist entirely
          // and misroute the click to a bigger wrong-name act.
          const artists = dedupeArtists(r.artists);
          const want = openRequest.name.trim().toLowerCase();
          const hit =
            artists.find((a) => a.name.trim().toLowerCase() === want) ??
            artists[0];
          if (hit) {
            opened = true;
            setOpenShowAll(null);
            setOpenAlbum(null);
            setOpenArtist(hit);
          }
        } else {
          const artist = (openRequest.artist ?? '').trim();
          const q = artist ? `${openRequest.name} ${artist}` : openRequest.name;
          const r = await searchCatalog(q, token, 'album', 15);
          if (cancelled) return;
          const wantName = openRequest.name.trim().toLowerCase();
          const wantArtist = artist.toLowerCase();
          const byBoth = r.albums.find(
            (al) =>
              al.name.trim().toLowerCase() === wantName &&
              (!wantArtist ||
                al.artists.some((x) => x.trim().toLowerCase() === wantArtist)),
          );
          const byName = r.albums.find(
            (al) => al.name.trim().toLowerCase() === wantName,
          );
          const hit = byBoth ?? byName ?? r.albums[0];
          if (hit) {
            opened = true;
            setOpenShowAll(null);
            setOpenArtist(null);
            setOpenAlbum(hit);
          }
        }
      } catch {
        /* fall through to the search-results fallback below */
      } finally {
        if (!cancelled) {
          if (!opened && openRequest.name.trim()) {
            setOpenShowAll(null);
            setOpenArtist(null);
            setOpenAlbum(null);
            commitSearch(openRequest.name);
          }
          onRequestHandled?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openRequest, token, onRequestHandled, commitSearch]);

  // Host-driven restore: on each `restore.signal` bump, reset the overlay to
  // `restore.snapshot`. A null snapshot clears it (navigating to a fresh view);
  // a snapshot replays a saved search page (Back/Forward landing on a history
  // entry that had a search/artist/album open). Skips the initial mount.
  const restoreInit = useRef(true);
  useEffect(() => {
    if (restoreInit.current) {
      restoreInit.current = false;
      return;
    }
    stopPreview();
    setPickerTrack(null);
    const snap = restore?.snapshot ?? null;
    // Record what we're restoring BEFORE applying it, so the push effect (which
    // fires on the resulting state change) sees no new page and doesn't push a
    // duplicate history entry for a Back/Forward replay.
    lastOverlayKey.current = overlayKey(
      snap?.query ?? '',
      snap?.artist ?? null,
      snap?.album ?? null,
      snap?.showAll ?? null,
      snap?.playlist ?? null,
    );
    if (!snap) {
      setQuery('');
      setCommittedQuery('');
      setDebounced('');
      setOpenArtist(null);
      setOpenAlbum(null);
      setOpenPlaylist(null);
      setOpenShowAll(null);
      setShowAllInitial(null);
    } else {
      setQuery(snap.query);
      setDebounced(snap.query);
      setCommittedQuery(snap.query);
      setOpenArtist(snap.artist);
      setOpenAlbum(snap.album);
      setOpenPlaylist(snap.playlist ?? null);
      setOpenShowAll(snap.showAll ?? null);
      // A history-restored show-all has no fresh seed from a chevron click —
      // clear any lingering one so it fetches (fast: server artist cache) for
      // the correct artist rather than seeding stale rows.
      setShowAllInitial(null);
      // Seed the results page from cache so a restored search shows instantly;
      // the fetch effect still revalidates in the background (no visible flash).
      const cached = resultsCache.current.get(snap.query);
      if (cached) {
        setResults(cached);
        setResultsQuery(snap.query);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.signal]);

  // Push a history entry whenever the user drills to a NEW search page (commit,
  // open artist/album, drill deeper), so each page is its own Back/Forward stop.
  // Restores set `lastOverlayKey` first, so this fires for them but no-ops —
  // only genuine forward transitions push.
  useEffect(() => {
    const key = overlayKey(
      committedQuery,
      openArtist,
      openAlbum,
      openShowAll,
      openPlaylist,
    );
    if (key === lastOverlayKey.current) return;
    lastOverlayKey.current = key;
    if (key === '∅') return; // clearing / editing-to-empty isn't a new stop
    onOverlayPush?.({
      query: committedQuery,
      artist: openArtist,
      album: openAlbum,
      playlist: openPlaylist,
      showAll: openShowAll,
    });
  }, [
    committedQuery,
    openArtist,
    openAlbum,
    openPlaylist,
    openShowAll,
    onOverlayPush,
  ]);

  // Desktop pageMode: when an artist/album drill-in is open, it takes
  // over the content area as a full page, so we hide the search UI.
  const showingPage =
    !!pageMode && (!!openAlbum || !!openArtist || !!openPlaylist);
  // A nav request from the player is mid-flight (resolving the name to a
  // Deezer hit) but the page/modal hasn't opened yet. We suppress the search
  // UI during this window so the empty search box (and recent searches) don't
  // flash before the artist/album view appears. Not gated on pageMode: the
  // phone drives the same openRequest path but renders the result as a modal
  // (no pageMode), and needs the same flash suppression.
  const navPending = !!openRequest && !showingPage;

  // Phone (and any non-overlay host): opening an album/artist/playlist stacks a
  // `fixed inset-0` modal (ModalShell, z-10) over the search surface — but the
  // sticky search pill is z-20, so it paints *over* the modal, leaving the bar
  // floating above the page you opened (looks broken). The fix is to step the
  // bar aside while a detail is open. Desktop's overlay bar lives in the top bar
  // and stays put (its page-takeover is handled by `showingPage`).
  const detailOpen = !!openAlbum || !!openArtist || !!openPlaylist;
  const hideBarForDetail = !overlayMode && detailOpen;

  // Whether the overlay surface is showing anything — drives the overlayMode
  // render branch and the idle-input focus handoff below.
  const overlayActive =
    !!committedQuery.trim() ||
    !!openArtist ||
    !!openAlbum ||
    !!openPlaylist ||
    navPending ||
    !!openRequest;

  // The committed results page only renders once a search has been committed
  // *and* the loaded results belong to that exact query (so we never flash a
  // previous search's page while a new one is mid-flight).
  const showResultsPage = committedQuery.trim().length > 0;
  const pageResults =
    showResultsPage && results && resultsQuery === committedQuery
      ? results
      : null;

  // Order the type tabs by per-query relevance, Spotify-style: the type of the
  // single best (top) result leads, the rest follow by result count. So a
  // song-title query surfaces "Songs" first; an artist name surfaces "Artists".
  // The single best (top) result across all types — drives both the tab order
  // and whether "Fans also like" appears (only when the search is about an
  // artist, i.e. this is that artist).
  const topResult = useMemo(
    () =>
      pageResults
        ? buildFederated(pageResults, normalizeForMatch(committedQuery), played)
            .top
        : null,
    [pageResults, committedQuery, played],
  );
  const typeTabOrder = useMemo<Array<'tracks' | 'albums' | 'artists'>>(() => {
    const order: Array<'tracks' | 'albums' | 'artists'> = [
      'tracks',
      'artists',
      'albums',
    ];
    if (!pageResults) return order;
    const counts = {
      tracks: pageResults.tracks.length,
      artists: pageResults.artists.length,
      albums: pageResults.albums.length,
    };
    const topTab =
      topResult?.kind === 'track'
        ? 'tracks'
        : topResult?.kind === 'artist'
          ? 'artists'
          : topResult?.kind === 'album'
            ? 'albums'
            : null;
    return [...order].sort((a, b) => {
      if (a === topTab) return -1;
      if (b === topTab) return 1;
      return counts[b] - counts[a];
    });
  }, [pageResults, topResult]);

  // "Fans also like" — like Spotify, surface artists similar to the one you
  // searched, but ONLY when the search is genuinely about an artist (the
  // federated top result IS that artist), so a song/genre query doesn't seed a
  // shelf off some incidental famous name. Pull the seed's Deezer neighbours
  // (popularity-ranked, junk dropped), minus ones already in the results.
  // Cleared synchronously so a rapid re-search never flashes the previous
  // artist's neighbours during the next fetch.
  const [relatedArtists, setRelatedArtists] = useState<SearchArtistResult[]>([]);
  useEffect(() => {
    const seed = topResult?.kind === 'artist' ? topResult.artist : null;
    setRelatedArtists([]);
    if (!seed) return;
    let cancelled = false;
    getArtistRelated(seed.source_id, token)
      .then((rows) => {
        if (cancelled) return;
        const have = new Set(pageResults?.artists.map((a) => a.source_id));
        setRelatedArtists(
          rankRelatedArtists(rows).filter((a) => !have.has(a.source_id)),
        );
      })
      .catch(() => {
        if (!cancelled) setRelatedArtists([]);
      });
    return () => {
      cancelled = true;
    };
  }, [topResult, pageResults, token]);

  // "From your library" — surface the user's OWN playlists + songs in the
  // results, matched client-side against the committed query. Fetched once
  // (lazily, on the first committed search), only when the host wired the
  // open/play handlers; reset when the active profile changes.
  const [libPlaylists, setLibPlaylists] = useState<PlaylistRow[] | null>(null);
  const [libSongs, setLibSongs] = useState<StreamTrack[] | null>(null);
  useEffect(() => {
    setLibPlaylists(null);
    setLibSongs(null);
  }, [activeProfileId]);
  useEffect(() => {
    if (!committedQuery.trim()) return;
    let cancelled = false;
    if (libPlaylists === null && onOpenLibraryPlaylist) {
      listPlaylists(token, activeProfileId)
        .then((rows) => !cancelled && setLibPlaylists(rows))
        .catch(() => !cancelled && setLibPlaylists([]));
    }
    if (libSongs === null && onPlayLibrarySong) {
      listLibrarySongs(token, activeProfileId)
        .then((rows) => !cancelled && setLibSongs(rows))
        .catch(() => !cancelled && setLibSongs([]));
    }
    return () => {
      cancelled = true;
    };
  }, [
    committedQuery,
    token,
    activeProfileId,
    libPlaylists,
    libSongs,
    onOpenLibraryPlaylist,
    onPlayLibrarySong,
  ]);
  const libPlaylistMatches = useMemo(() => {
    const nq = normalizeForMatch(committedQuery);
    if (!nq || !libPlaylists) return [];
    return libPlaylists
      .filter((p) => normalizeForMatch(p.name).includes(nq))
      .slice(0, 4);
  }, [libPlaylists, committedQuery]);
  const libSongMatches = useMemo(() => {
    const nq = normalizeForMatch(committedQuery);
    if (!nq || !libSongs) return [];
    return libSongs
      .filter(
        (s) =>
          normalizeForMatch(s.title).includes(nq) ||
          s.artists.some((a) => normalizeForMatch(a).includes(nq)),
      )
      .slice(0, 4);
  }, [libSongs, committedQuery]);
  const hasLibMatches =
    libPlaylistMatches.length > 0 || libSongMatches.length > 0;

  const relatedSection =
    relatedArtists.length > 0 ? (
      <div className="mt-6">
        <h2 className={cn(EYEBROW, 'px-1 mb-2')}>
          Fans also like
        </h2>
        <ArtistGrid
          artists={relatedArtists}
          onOpen={openArtistPage}
          onPlay={playArtistResult}
        />
      </div>
    ) : null;

  // Remember scroll position per drill page. Desktop overlay: ONE scroll
  // container holds the results and every drill-in (artist/album/show-all),
  // swapping content — so each page's position is tracked separately by its
  // identity, and Back lands where you were instead of at the top. Null on the
  // phone (its pages scroll in their own stacked containers) and while the
  // overlay is idle.
  const overlayScrollRef = useScrollMemory(
    overlayMode && overlayActive
      ? openAlbum
        ? `album:${openAlbum.source_id}`
        : openArtist && openShowAll
          ? `artist:${openArtist.source_id}:${openShowAll}`
          : openArtist
            ? `artist:${openArtist.source_id}`
            : openPlaylist
              ? `catpl:${openPlaylist.source_id}`
              : committedQuery.trim()
                ? `search:${committedQuery.trim().toLowerCase()}`
                : null
      : null,
  );

  // Overlay mode: the search surface floats over the main area and is shown
  // only when `overlayActive` (computed above). Idle ⇒ nothing, so the
  // underlying view shows through; the portaled top-bar input stays visible.
  return (
    <div
      ref={overlayScrollRef}
      className={
        overlayMode
          ? overlayActive
            ? // z-40: must beat the z-30 CondensedHeaderBar of whatever page
              // sits UNDER this overlay (e.g. a scrolled genre page's sticky
              // title), which otherwise paints through the drill-in. Stays
              // below the phone's sheets/scrims (z-50); the desktop top bar
              // lives outside <main> entirely.
              showingPage
              ? // A drill-in page (artist/album) has a full-bleed hero, so it
                // owns its edges + top clearance — no container padding. That
                // includes the BOTTOM: this used to keep a pb-6, which is what
                // stopped the artist page's closing shade short of the edge.
                // A page that bleeds to three edges and not the fourth is just
                // a card with extra steps.
                'absolute inset-0 z-40 overflow-y-auto bg-neutral-950'
              : 'absolute inset-0 z-40 overflow-y-auto bg-neutral-950 px-4 pt-6 pb-6'
            : 'hidden'
          : 'px-4 pt-4 pb-6'
      }
    >
      {/* Keyframes for the Shazam-style preview countdown ring. Injected
          here (once) so both the search list and the album modal can use
          the pure-CSS animation without a global stylesheet edit. */}
      <style>{PREVIEW_RING_KEYFRAMES}</style>
      {navPending && (
        // Pulsing hero-shaped placeholder while the requested artist/album
        // resolves (matches the app-wide skeleton pattern).
        <div className="px-4 pt-6" aria-hidden>
          <div className="flex items-end gap-5 animate-pulse">
            <div className="h-36 w-36 sm:h-52 sm:w-52 shrink-0 rounded-xl bg-neutral-800/80" />
            <div className="flex-1 pb-2">
              <div className="h-3 w-16 rounded bg-neutral-800/80" />
              <div className="mt-3 h-7 w-1/2 rounded bg-neutral-800/80" />
              <div className="mt-3 h-3.5 w-1/3 rounded bg-neutral-800/80" />
            </div>
          </div>
          <div className="mt-8 flex flex-col gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 animate-pulse">
                <div className="h-11 w-11 rounded-lg bg-neutral-800/80 shrink-0" />
                <div className="flex-1">
                  <div className="h-3.5 w-1/3 rounded bg-neutral-800/80" />
                  <div className="mt-1.5 h-3 w-1/4 rounded bg-neutral-800/80" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Search bar — persistent (portaled to the top bar) in overlay mode,
          otherwise inline at the top of the page. Rendered ungated in overlay
          mode so it stays put even while a detail page is showing. */}
      <MaybePortal target={overlayMode ? barSlot ?? null : null}>
        {!overlayMode && !showingPage && !navPending && !hideBarForDetail && (
          // Phone title row — the account avatar (→ Settings) in the same
          // top-right spot as Home / Library, opposite the title. Scrolls away
          // on scroll; the search pill below pins on its own (frosted).
          <div className="mb-2 flex items-center justify-between gap-3">
            <h1 className="text-xl font-bold tracking-tight">Search</h1>
            {onOpenSettings && (
              <SettingsAvatar
                profile={profile}
                token={token}
                onOpenSettings={onOpenSettings}
              />
            )}
          </div>
        )}
        {(overlayMode || (!showingPage && !navPending && !hideBarForDetail)) && (
      <div
        className={
          // Phone: the search pill pins to the top on scroll (frosted, breaks
          // out to full width). Desktop (overlay) keeps its top-bar styling.
          overlayMode
            ? 'px-1 mb-3'
            : // z-20 (not z-10): the genre tiles' labels are `relative z-10`,
              // so the pinned pill must outrank them or they paint over it.
              cn(STICKY_FROST, 'sticky top-0 z-20 -mx-4 px-4 pt-2 pb-3')
        }
      >
        <div className="relative">
          <input
            ref={searchInputRef}
            type="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // New keystroke ⇒ re-open suggestions and step back out of the
              // committed results page until they search again.
              setSuppressSuggest(false);
              setCommittedQuery('');
              // Desktop: typing starts a fresh search — drop any open detail so
              // the dropdown takes over and the overlay goes idle (no phantom
              // history entry pushed for the in-place close).
              if (overlayMode) {
                setOpenArtist(null);
                setOpenAlbum(null);
                setOpenShowAll(null);
              }
            }}
            onFocus={() => {
              setInputFocused(true);
              if (!overlayActive) onSearchFocus?.();
            }}
            onBlur={() => setInputFocused(false)}
            onKeyDown={onSearchKeyDown}
            placeholder="What do you want to play?"
            role="combobox"
            aria-expanded={showSuggest || showRecents}
            aria-controls="search-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={
              showSuggest && activeSuggestion >= 0
                ? `search-suggestion-${activeSuggestion}`
                : undefined
            }
            // Right padding keeps text clear of the ✕ (and, on desktop, the
            // Browse button + divider); the webkit-cancel override hides the
            // native clear so we don't show two.
            className={cn(
              INPUT,
              'w-full text-base [&::-webkit-search-cancel-button]:appearance-none',
              onOpenBrowse ? (query ? 'pr-20' : 'pr-12') : 'pr-10',
            )}
            // Don't auto-focus: opening the Search tab should show the Browse
            // grid, not immediately pop the recent-searches dropdown (and the
            // keyboard). Recents appear only once the user taps the bar.
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                // Desktop: ✕ on a committed results/detail page steps back out
                // of the search (history Back) so no stale entry is left behind;
                // while editing (no committed query) it just clears the box.
                if (overlayMode && committedQuery.trim()) {
                  onOverlayBack?.();
                  return;
                }
                setQuery('');
                setCommittedQuery('');
                searchInputRef.current?.focus();
              }}
              aria-label="Clear search"
              className={`absolute ${
                onOpenBrowse ? 'right-11' : 'right-2'
              } top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center rounded-full text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800`}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          ) : null}
          {onOpenBrowse && (
            <>
              {/* Spotify-style: hairline divider + always-present Browse
                  button living inside the search field. */}
              <div className="absolute right-10 top-1/2 -translate-y-1/2 h-5 w-px bg-white/15" aria-hidden />
              <button
                type="button"
                onClick={onOpenBrowse}
                aria-label="Browse"
                title="Browse"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center rounded-full text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
              >
                {/* Compass — the app's long-standing Discover glyph. */}
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="m15 9-2 6-4 2 2-6 4-2z" />
                </svg>
              </button>
            </>
          )}
          {showSuggest && (
            <ul
              id="search-suggestions"
              role="listbox"
              // Keep the input focused through the tap so onBlur doesn't fire
              // before the click registers (the standard combobox dance).
              onMouseDown={(e) => e.preventDefault()}
              className={cn(POPOVER, 'absolute left-0 right-0 top-full mt-1 z-40 max-h-[60vh] overflow-y-auto overscroll-contain')}
            >
              {suggestions.map((s, i) => (
                <li key={suggestionKey(s)}>
                  <button
                    type="button"
                    id={`search-suggestion-${i}`}
                    role="option"
                    aria-selected={i === activeSuggestion}
                    onMouseEnter={() => setActiveSuggestion(i)}
                    onClick={() => applySuggestion(s)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left ${
                      i === activeSuggestion
                        ? 'bg-neutral-800'
                        : 'hover:bg-neutral-800/70'
                    }`}
                  >
                    <SuggestionContent
                      s={s}
                      playingPreviewUrl={playingPreviewUrl}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {showRecents && (
            // Recent searches live here (Spotify-style), shown when the box is
            // focused but empty. Keep focus through taps so a click registers
            // before onBlur closes the menu.
            <div
              onMouseDown={(e) => e.preventDefault()}
              className={cn(POPOVER, 'absolute left-0 right-0 top-full mt-1 z-40 overflow-hidden')}
            >
              <div className="flex items-center justify-between px-3 pt-2 pb-1">
                <span className={EYEBROW}>
                  Recent searches
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearRecentSearches();
                    setRecents([]);
                  }}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  Clear
                </button>
              </div>
              <ul className="flex flex-col max-h-[55vh] overflow-y-auto overscroll-contain px-1 pb-1">
                {recentEntities.map((it) => (
                  <li key={recentItemKey(it)}>
                    <RecentRow
                      item={it}
                      playingPreviewUrl={playingPreviewUrl}
                      onQuery={commitSearch}
                      onTrack={replayRecentTrack}
                      onArtist={openArtistPage}
                      onAlbum={openAlbumPage}
                      onPlaylist={openPlaylistPage}
                      onRemove={() => setRecents(removeRecentItem(it))}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
        )}
      </MaybePortal>
      {!showingPage && !navPending && (
        <>
      {showResultsPage && error && (
        <div className={cn(CALLOUT_ERROR, 'mx-1 mb-3 text-xs break-words')}>
          {error}
        </div>
      )}

      {!hubUp && (
        <div className={cn(CALLOUT_WARN, 'mx-1 mb-3 text-xs break-words')}>
          {desktop
            ? 'Can’t reach Beetbot’s local server — search and previews still work, but your library is unavailable. Restart the app if this sticks.'
            : 'Not connected to Beetbot on your computer — search & previews work, but saving songs and playing your library need the computer.'}
        </div>
      )}

      {pageResults && (
        <div className="px-1 mb-3 flex gap-2 text-xs">
          <TabBtn active={tab === 'all'} onClick={() => setTab('all')}>
            All
          </TabBtn>
          {typeTabOrder.map((tk) => {
            const label =
              tk === 'tracks' ? 'Songs' : tk === 'albums' ? 'Albums' : 'Artists';
            return (
              <TabBtn key={tk} active={tab === tk} onClick={() => setTab(tk)}>
                {label}
              </TabBtn>
            );
          })}
          {/* Playlists trails the relevance-ordered type tabs (only when the
              search actually matched some catalog playlists). */}
          {(pageResults?.playlists?.length ?? 0) > 0 && (
            <TabBtn
              active={tab === 'playlists'}
              onClick={() => setTab('playlists')}
            >
              Playlists
            </TabBtn>
          )}
        </div>
      )}

      {!query.trim() &&
        (browseSlot ? (
          // Phone: the real "Browse all" genre grid (drills into genre pages),
          // titled with the small "Browse" eyebrow. Recent searches still live
          // in the focus-state dropdown above the bar.
          <div className="pt-2">{browseSlot}</div>
        ) : (
          <div className="px-1 pt-2">
            {/* Fallback (desktop): static browse-by-genre tiles that just fire a
                text search — Spotify's "Browse all" idea adapted to catalog
                search. (Recent searches live in the focus-state dropdown.) */}
            <div className="px-1">
              <h2 className={cn(EYEBROW, 'mb-2')}>Browse</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {BROWSE_TILES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => commitSearch(t.query)}
                    style={{ backgroundColor: t.color }}
                    className="relative aspect-[2/1] rounded-lg overflow-hidden p-4 text-left text-base font-bold tracking-tight text-white shadow transition hover:brightness-110 active:scale-95"
                  >
                    <span className="relative z-10 drop-shadow">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}

      {showResultsPage && loading && !pageResults && (
        <div className="px-2 pt-2 text-sm text-neutral-500">Searching…</div>
      )}

      {pageResults && tab === 'all' && hasLibMatches && (
        <LibrarySection
          playlists={libPlaylistMatches}
          songs={libSongMatches}
          token={token}
          onOpenPlaylist={onOpenLibraryPlaylist}
          onPlaySong={onPlayLibrarySong}
        />
      )}
      {pageResults && tab === 'all' && (
        <FederatedResults
          token={token}
          query={committedQuery}
          results={pageResults}
          played={played}
          // Cap the inline playlists in "All" so a mood/genre query (e.g.
          // "workout" → 25 playlists) doesn't bury the exact matches under a
          // wall of them. The dedicated Playlists tab shows the full list.
          playlists={(pageResults.playlists ?? []).slice(0, 4)}
          onOpenPlaylist={openPlaylistPage}
          onAddPlaylist={addPlaylistToLibrary}
          onAdd={(t) => setPickerTrack(t)}
          onPlay={playTrack}
          onOpenArtist={openArtistPage}
          onOpenAlbum={openAlbumPage}
          onAddAlbum={addAlbumToLibrary}
          save={save}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
        />
      )}
      {pageResults && tab === 'tracks' && (
        <TrackList
          tracks={pageResults.tracks}
          onAdd={(t) => setPickerTrack(t)}
          onPlay={playTrack}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
          // Same component as the genre pages — wire the same now-playing
          // state so the current track lights up here too.
          isTrackCurrent={isTrackCurrent}
          isNowPlaying={isNowPlaying}
        />
      )}
      {pageResults && tab === 'all' && relatedSection}
      {pageResults && tab === 'albums' && (
        <AlbumGrid
          albums={pageResults.albums}
          onOpen={openAlbumPage}
          onPlay={playAlbumResult}
        />
      )}
      {/* NB: playlists in the "All" tab now render inline as list rows inside
          FederatedResults (above), not as a separate bigger-art grid — so every
          result in "All" reads the same. The dedicated Playlists tab keeps its
          grid, matching the Albums / Artists tabs. */}
      {pageResults && tab === 'artists' && (
        <>
          <ArtistGrid
            artists={pageResults.artists}
            onOpen={openArtistPage}
            onPlay={playArtistResult}
          />
          {relatedSection}
        </>
      )}
      {/* Dedicated Playlists tab: the full grid on its own, matching how the
          Albums / Artists tabs render. (In "All", playlists are inline rows.) */}
      {pageResults && tab === 'playlists' && (
        <PlaylistGrid
          playlists={pageResults.playlists ?? []}
          onOpen={openPlaylistPage}
        />
      )}
        </>
      )}

      {/* Drill-in stack. On phone (not pageMode) these are stacked modal
          overlays — DOM order = z-order, so album sits over artist over the
          results, and the picker over all. On desktop (pageMode) they
          render inline as full pages (album takes precedence over artist),
          replacing the search UI above; the picker stays an overlay. */}
      {openArtist && (!pageMode || !openAlbum) && (!openShowAll || !pageMode) && (
        <ArtistDetailModal
          inline={pageMode}
          pin={pin}
          save={save}
          // Remount on drill-in (A → related artist B) so all three
          // sections reset to their loading state instead of flashing
          // the previous artist's data.
          key={openArtist.source_id}
          token={token}
          artist={openArtist}
          onClose={
            // Desktop: closing (Escape) is a real history Back — pops to the
            // results/view underneath without pushing a phantom forward entry.
            overlayMode
              ? () => onOverlayBack?.()
              : () => {
                  stopPreview();
                  setOpenArtist(null);
                }
          }
          onPickAlbum={(a) => setOpenAlbum(a)}
          onPickTrack={(t) => setPickerTrack(t)}
          onPickPlaylist={openPlaylistPage}
          onAddAlbum={addAlbumToLibrary}
          onPlay={onPlayTrack}
          onPickArtist={(a) => {
            stopPreview();
            setOpenShowAll(null);
            setOpenArtist(a);
          }}
          onShowAll={(section, initial) => {
            setShowAllInitial(initial ?? null);
            setOpenShowAll(section);
          }}
          // Phone: a show-all grid (or an album) can stack over this still-mounted
          // page; only the topmost layer should close on a single Escape.
          escapeActive={!openShowAll && !openAlbum}
          // Now-playing: ⏸/▶ hero + sticky Play, highlighted current Top-Songs
          // row, persistent play on the playing album's card — on the phone too.
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
        />
      )}
      {/* Show-all grid for one artist-page section. On desktop (pageMode) it
          replaces the inline artist page (hidden above when openShowAll is set);
          on phone it stacks as a modal over the still-mounted artist page, so
          closing it reveals the artist beneath without a refetch. Album takes
          precedence over it on desktop, same as over the artist page. */}
      {openArtist && openShowAll && (!pageMode || !openAlbum) && (
        <ArtistShowAll
          key={`${openArtist.source_id}:${openShowAll}`}
          inline={pageMode}
          token={token}
          artist={openArtist}
          section={openShowAll}
          // Seed from the data the artist page already had (drill-in only),
          // guarded by artist id so a stale seed never bleeds across artists.
          initial={
            showAllInitial &&
            (showAllInitial.albums?.[0] ||
              showAllInitial.topTracks?.[0] ||
              showAllInitial.related?.[0])
              ? showAllInitial
              : undefined
          }
          onClose={
            overlayMode ? () => onOverlayBack?.() : () => setOpenShowAll(null)
          }
          onPickAlbum={(a) => setOpenAlbum(a)}
          onPickArtist={(a) => {
            stopPreview();
            setOpenShowAll(null);
            setOpenArtist(a);
          }}
          onPickTrack={(t) => setPickerTrack(t)}
          onPlay={onPlayTrack}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
          // Phone: an album can stack over this grid; defer Escape to it.
          escapeActive={!openAlbum}
        />
      )}
      {openAlbum && (
        <AlbumDetailModal
          // Remount when navigating album → album (via "More by") so tracks +
          // the More-by shelf reset instead of flashing the previous album.
          key={openAlbum.source_id}
          inline={pageMode}
          token={token}
          album={openAlbum}
          pin={pin}
          activeProfileId={activeProfileId}
          onClose={
            // Desktop: closing (Escape) is a real history Back — pops to the
            // artist/results/view underneath, no phantom forward entry.
            overlayMode
              ? () => onOverlayBack?.()
              : () => {
                  stopPreview();
                  setOpenAlbum(null);
                }
          }
          onPickTrack={(t) => setPickerTrack(t)}
          onPlay={onPlayTrack}
          onPickAlbum={openAlbumPage}
          // Desktop only: per-song "⋯" menu (same as library albums).
          onShowTrackMenu={pageMode ? showAlbumTrackMenu : undefined}
          // Phone: per-song "⋯" bottom sheet, matching the library album rows.
          onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
          // Phone: swipe-to-queue / swipe-to-save, matching the library page.
          onQueueTrack={pageMode ? undefined : onAlbumAddToQueue}
          onSaveTrack={pageMode ? undefined : onAlbumSaveToLiked}
          // Clickable artist names in track rows → that artist's page.
          onGoToArtist={onAlbumGoToArtist}
          onGoToAlbum={onAlbumGoToAlbum}
          // Now-playing: highlight + equalizer on the current row, ⏸/▶ hero +
          // sticky Play button (host wires it from its player store) — on the
          // phone too, so a catalog album matches the library album page.
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
        />
      )}
      {openPlaylist && (!pageMode || (!openAlbum && !openArtist)) && (
        <PlaylistDetailModal
          // Remount per playlist so its tracklist resets cleanly.
          key={openPlaylist.source_id}
          inline={pageMode}
          token={token}
          playlist={openPlaylist}
          activeProfileId={activeProfileId}
          pin={pin}
          onClose={
            overlayMode
              ? () => onOverlayBack?.()
              : () => {
                  stopPreview();
                  setOpenPlaylist(null);
                }
          }
          onPickTrack={(t) => setPickerTrack(t)}
          onPlay={onPlayTrack}
          // Desktop only: per-song "⋯" menu (same as browse albums).
          onShowTrackMenu={pageMode ? showAlbumTrackMenu : undefined}
          // Phone: per-song "⋯" bottom sheet, matching the library playlist rows.
          onShowTrackSheet={pageMode ? undefined : onShowTrackSheet}
          // Phone: swipe-to-queue / swipe-to-save, matching the library page.
          onQueueTrack={pageMode ? undefined : onAlbumAddToQueue}
          onSaveTrack={pageMode ? undefined : onAlbumSaveToLiked}
          onGoToArtist={onAlbumGoToArtist}
          onGoToAlbum={onAlbumGoToAlbum}
          // Now-playing: equalizer bars on the current row + a ⏸/▶ hero that
          // toggles (matching the album + library playlist pages) — on the phone
          // too, not just desktop.
          isTrackCurrent={isTrackCurrent}
          isPlaying={isNowPlaying}
          onTogglePlay={onTogglePlay}
          playingPreviewUrl={playingPreviewUrl}
          onTogglePreview={togglePreview}
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

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded-full px-3 py-1 transition active:bg-white/5', navPill(active))}
    >
      {children}
    </button>
  );
}

/**
 * Single-clip player for 30-second Deezer previews. One shared <audio>
 * element across the whole search UI, so starting a new preview
 * automatically stops whichever one was playing. The clips are Deezer's
 * official CDN MP3s (no auth, no DRM) — purely for auditioning a track
 * before adding it; it has nothing to do with playing the real
 * downloaded file (that goes through the bundle's own player).
 */
export function usePreviewPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  // Create the element once; tear it down on unmount so a half-played
  // clip doesn't keep going after the user navigates away from search.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'none';
    const onEnded = () => setPlayingUrl(null);
    audio.addEventListener('ended', onEnded);
    audioRef.current = audio;
    // Mutual exclusion with the full-track player: when the music player
    // starts, this pauses the preview clip.
    const unregister = registerAudioPauser('preview', () => {
      audio.pause();
      setPlayingUrl(null);
    });
    return () => {
      unregister();
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    setPlayingUrl(null);
  }, []);

  const toggle = useCallback(
    (url: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (playingUrl === url) {
        audio.pause();
        setPlayingUrl(null);
        return;
      }
      // Switching clips: point the shared element at the new src and
      // play from the top. The previous clip stops on its own.
      audio.src = url;
      audio.currentTime = 0;
      void audio
        .play()
        .then(() => {
          setPlayingUrl(url);
          // Pause the full-track player so the two don't overlap.
          audioStarted('preview');
        })
        .catch(() => setPlayingUrl(null));
    },
    [playingUrl],
  );

  return { playingUrl, toggle, stop };
}


/** Whether the primary input can hover (desktop mouse). Touch devices (the
 *  phone bundle) can't, so a hover-only affordance would be invisible there —
 *  we show the play hint at rest instead. Evaluated once; hover capability
 *  doesn't change at runtime. */
const CAN_HOVER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

/**
 * Album-art thumbnail with the Shazam-style preview overlay. Purely
 * presentational — the click handler lives on the parent row button, so
 * tapping the song name is what starts/stops the clip. While `playing`
 * it dims the art, shows a pause glyph, and draws the depleting ring.
 * The play-triangle tap hint reveals on hover where a mouse exists, and
 * stays visible on touch (no hover) so the phone always shows the cue.
 */
function ArtworkThumb({
  artUrl,
  playing,
  nowPlaying = false,
  pausedCurrent = false,
  showHoverPlay = true,
  small = false,
}: {
  artUrl: string | null;
  /** 30s preview auditioning this row → pause glyph + depleting ring. */
  playing: boolean;
  /** This row is the actual now-playing track (audible) → equalizer bars. */
  nowPlaying?: boolean;
  /** This row is the current track but PAUSED → a static ♪ (matches the playlist
   *  page's paused marker, so paused reads the same on every list). */
  pausedCurrent?: boolean;
  /** Show the ▶ hover overlay on the cover. Off when the row's # gutter carries
   *  the play/now-playing indicator instead (genre pages match the playlist). */
  showHoverPlay?: boolean;
  /** 40px cover (h-10) instead of 44px — matches the phone playlist rows. */
  small?: boolean;
}) {
  return (
    <div
      className={`relative ${
        small ? 'h-10 w-10' : 'h-11 w-11'
      } shrink-0 rounded-lg overflow-hidden bg-neutral-800`}
    >
      {artUrl ? (
        <img
          src={artUrl}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          loading="lazy"
        />
      ) : (
        <div className="h-full w-full grid place-items-center text-neutral-600">
          ♪
        </div>
      )}
      {nowPlaying && !playing ? (
        // Now playing (audible): equalizer bars over the cover, always shown.
        <div className="absolute inset-0 grid place-items-center bg-black/55">
          <EqualizerBars className="text-white" />
        </div>
      ) : pausedCurrent && !playing ? (
        // Current track, paused: static ♪ (matches the playlist page).
        <div className="absolute inset-0 grid place-items-center bg-black/55">
          <span className="text-sm text-white">♪</span>
        </div>
      ) : playing ? (
        // 30s preview auditioning: pause glyph over a darkened cover.
        <div className="absolute inset-0 grid place-items-center bg-black/55">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        </div>
      ) : showHoverPlay ? (
        <div
          className={`absolute inset-0 grid place-items-center transition-colors ${
            CAN_HOVER ? 'bg-black/0 group-hover/info:bg-black/35' : 'bg-black/30'
          }`}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="white"
            className={
              CAN_HOVER
                ? 'opacity-0 group-hover/info:opacity-90 transition-opacity'
                : 'opacity-90'
            }
            aria-hidden
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      ) : null}
      {playing ? <PreviewRing size={small ? 40 : 44} strokeWidth={3} /> : null}
    </div>
  );
}

/** Compact count: 1226890 → "1.2M", 12345 → "12.3K". */
function formatCompact(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}


/** Small bordered pill naming a row's entity type ("Song" / "Artist" /
 *  "Album"). Used in the federated "All" view so each interleaved row reads
 *  its type at a glance — the type-specific tabs don't need it. */
function RowTypeTag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full border border-neutral-700/70 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
      {label}
    </span>
  );
}

/** Right-chevron affordance for the artist/album rows in the All view. */
function RowChevron() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-neutral-600"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// --- Federated "All" results ------------------------------------------
//
// Spotify's "All" tab leads with a single Top Result card (the one thing you
// most likely meant) followed by an interleaved, relevance-ranked mix of
// songs, artists, and albums, each tagged with its type. Deezer hands us
// three separately-ranked lists (no unified relevance), so we synthesize one:
//   • a fuzzy name-match score against the query,
//   • a per-type bias (a bare name usually means the artist), and
//   • the item's rank within its own list (Deezer orders by popularity).
// We then weave the types together so the list doesn't clump into long
// same-type runs.

type FederatedItem =
  | { kind: 'track'; track: SearchTrackResult; score: number }
  | { kind: 'artist'; artist: SearchArtistResult; score: number }
  | { kind: 'album'; album: SearchAlbumResult; score: number };

type FederatedKind = FederatedItem['kind'];

/** Lowercase, strip accents + punctuation, collapse whitespace. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop a single leading article so "The Weeknd" and "Weeknd" compare equal.
 *  Only strips when something remains (so a band literally named "The" is
 *  left alone). Expects an already-`normalizeForMatch`'d string. */
function stripLeadingArticle(n: string): string {
  const stripped = n.replace(/^(?:the|a|an) /, '');
  return stripped.length > 0 ? stripped : n;
}

/** Collapse near-identical artist profiles — the same name once a leading
 *  article is dropped — down to the most-followed one. Deezer's index is full
 *  of impersonator/tribute duplicates ("Weeknd", "The Weeknd" ×2 alongside the
 *  real 14M-fan "The Weeknd"); genuinely different names ("The Retro Weeknd")
 *  are untouched. First-seen order is preserved. */
function dedupeArtists(artists: SearchArtistResult[]): SearchArtistResult[] {
  const best = new Map<string, SearchArtistResult>();
  const order: string[] = [];
  artists.forEach((a, i) => {
    const norm = stripLeadingArticle(normalizeForMatch(a.name));
    const key = norm || `#${i}`; // never collapse an unnormalizable name
    const prev = best.get(key);
    if (!prev) {
      best.set(key, a);
      order.push(key);
    } else if ((a.total_fans ?? 0) > (prev.total_fans ?? 0)) {
      best.set(key, a);
    }
  });
  return order.map((k) => best.get(k) as SearchArtistResult);
}

/** Drop "junk twin" profiles — a name built AROUND another result's full name
 *  ("Coldplay" → "Coldplay Tribute Band", "Karaoke - Coldplay", "Coldplay
 *  Mindfulness") with a following orders of magnitude smaller. These clear the
 *  fan floor below (tribute acts collect a few thousand fans) but their pages
 *  are ghosts: no picture, no albums, no top songs. Token-subset + fan-ratio,
 *  so real near-names survive: "Vampire Weekend" shares no token with
 *  "The Weeknd"; "Selena" isn't a superset of "Selena Gomez" (it's the other
 *  way round, and we only ever drop the superset side); "Bob Marley & The
 *  Wailers" IS a superset of "Bob Marley" but passes the ratio bar (1% of the
 *  base act's fans — a real co-credited act clears it, a tribute never does).
 *  NOT used by the imperative name→artist resolution: someone whose library
 *  genuinely holds a tribute act must still land on it, not the base artist. */
function dropDerivativeArtists(
  artists: SearchArtistResult[],
): SearchArtistResult[] {
  const tokens = artists.map(
    (a) =>
      new Set(
        stripLeadingArticle(normalizeForMatch(a.name)).split(' ').filter(Boolean),
      ),
  );
  return artists.filter((b, bi) => {
    const bTokens = tokens[bi];
    return !artists.some((a, ai) => {
      if (ai === bi) return false;
      const aTokens = tokens[ai];
      if (aTokens.size === 0 || aTokens.size >= bTokens.size) return false;
      if (![...aTokens].every((t) => bTokens.has(t))) return false;
      return (b.total_fans ?? 0) < (a.total_fans ?? 0) * 0.01;
    });
  });
}

/** Drop Deezer's phantom combined-credit artists — a collaboration indexed as a
 *  single "A & B" artist object (own id + page) alongside the real solo acts,
 *  e.g. "Marshmello & Omar LinX" next to "Marshmello". `isPhantomArtist` gates
 *  on a collab-shaped name AND a missing portrait, so genuine "A & B" bands
 *  (which always have artwork) are kept. */
function dropCombinedCreditArtists(
  artists: SearchArtistResult[],
): SearchArtistResult[] {
  return artists.filter((a) => !isPhantomArtist(a));
}

/** Minimum follower count for an artist to count as "real" regardless of the
 *  query — below this and far from the top match, it's a tribute/lookalike. */
const ARTIST_FAN_FLOOR = 1000;

/** Hide low-quality lookalike/tribute artist profiles that clutter a search for
 *  a real artist — Deezer's index is full of them ("The Weeknd Brasileiro",
 *  "The Retro Weeknd", 0-60 fans), and Spotify suppresses them. Keep an artist
 *  if it has a genuine following (>= ARTIST_FAN_FLOOR) OR is within 1% of the
 *  most-popular match — so a legit famous near-name (Vampire Weekend, 471k, for
 *  "weeknd") survives, and a niche search (where the top match is itself small,
 *  so the relative bar is tiny) keeps everyone. The top match always passes. */
function dropLookalikeArtists(
  artists: SearchArtistResult[],
): SearchArtistResult[] {
  const top = artists.reduce((m, a) => Math.max(m, a.total_fans ?? 0), 0);
  const relFloor = top * 0.01;
  return artists.filter((a) => {
    const fans = a.total_fans ?? 0;
    return fans >= ARTIST_FAN_FLOOR || fans >= relFloor;
  });
}

// matchScore tiers (see scoreNameMatch): a REAL match (exact/prefix/whole-word/
// substring) scores >= 300; a typo-distance-only coincidence scores <= 160.
const WEAK_MATCH_CEIL = 240; // below this = typo-only or no real name match
const STRONG_MATCH = 460; // whole-word-or-better: the query clearly names an artist
const MAJOR_ARTIST_FANS = 2_000_000; // globally famous — keep even on a weak match

/** When the query clearly names an artist (some result matches it as a whole
 *  word or better), drop the artists that matched ONLY by typo distance — e.g.
 *  "weeknd" pulling in "The Weeks" or a "…A Week Away" cast off a 2-edit fuzzy
 *  match. Skipped entirely when no strong match exists (a genuinely misspelled
 *  query), so the intended-but-typo'd artist is never lost. Real same-word
 *  names ("Nick Drake" for "drake") score >= 460 and are kept, and a globally
 *  famous artist is kept even on a weak match (so "weekend" — a whole word for
 *  Vampire Weekend but a typo for The Weeknd — doesn't drop The Weeknd). */
function dropWeakArtistMatches(
  artists: SearchArtistResult[],
  queryNorm: string,
): SearchArtistResult[] {
  if (!queryNorm) return artists;
  const scored = artists.map((a) => ({ a, score: matchScore(a.name, queryNorm) }));
  if (!scored.some((s) => s.score >= STRONG_MATCH)) return artists;
  return scored
    .filter(
      (s) =>
        s.score >= WEAK_MATCH_CEIL ||
        (s.a.total_fans ?? 0) >= MAJOR_ARTIST_FANS,
    )
    .map((s) => s.a);
}

/** Deezer's related-artist list interleaves real neighbours with near-zero-fan
 *  junk (e.g. The Weeknd → "Jr. Hi" 230 fans, "Rajaste" 26). Sort by popularity
 *  so the real artists lead, then drop the low-fan tail — the floor is relative
 *  to the most-popular neighbour so a niche seed (whose neighbours are all
 *  small) still keeps a shelf, falling back to the top few if it over-prunes. */
function rankRelatedArtists(rows: SearchArtistResult[]): SearchArtistResult[] {
  const sorted = [...rows].sort(
    (a, b) => (b.total_fans ?? 0) - (a.total_fans ?? 0),
  );
  const top = sorted[0]?.total_fans ?? 0;
  const floor = Math.max(1000, top * 0.005);
  const kept = sorted.filter((a) => (a.total_fans ?? 0) >= floor);
  return kept.length >= 5 ? kept : sorted.slice(0, 8);
}

/** Levenshtein edit distance, capped: bails out (returns `max + 1`) as soon
 *  as the whole row exceeds `max`, so it stays cheap for the common no-match
 *  case. Used only as the typo-tolerance fallback in `matchScore`. */
function editDistance(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[bl];
}

/** Tiered match of an already-normalized name against a normalized query. */
function scoreNameMatch(n: string, queryNorm: string): number {
  if (n === queryNorm) return 1000;
  if (n.startsWith(`${queryNorm} `)) return 720;
  if (n.startsWith(queryNorm)) return 640;
  // The query fully contains the name (e.g. "olivia rodrigo vampire" ⊇ artist
  // "olivia rodrigo") — a strong signal the name is what they meant.
  if (n.length >= 3 && queryNorm.includes(n)) return 520;
  // Whole-word hit somewhere inside the name.
  if (n.split(' ').some((w) => w === queryNorm)) return 460;
  if (n.includes(queryNorm)) return 300;
  // Typo tolerance: Deezer often still returns the right hit for a misspelled
  // query ("beleive", "collrane"), but the checks above would score it 0. Allow
  // 1 edit for short queries, 2 for longer, measured against the whole name and
  // each of its words — whichever is closest — for a reduced score.
  if (queryNorm.length >= 4 && n.length <= 64) {
    const maxEdits = queryNorm.length <= 6 ? 1 : 2;
    let best = editDistance(queryNorm, n, maxEdits);
    if (best > maxEdits) {
      for (const w of n.split(' ')) {
        if (Math.abs(w.length - queryNorm.length) > maxEdits) continue;
        const d = editDistance(queryNorm, w, maxEdits);
        if (d < best) best = d;
        if (best === 0) break;
      }
    }
    if (best <= maxEdits) return 240 - best * 80; // 160 (1 edit) / 80 (2)
  }
  return 0;
}

/** Fuzzy match of `name` against an already-normalized query. 0 = no match.
 *  Also scores with a leading article dropped on both sides, so the canonical
 *  "The Weeknd" matches "weeknd" exactly (1000) instead of as a mere word hit
 *  (460) — otherwise a knock-off literally named "Weeknd" outranks it. */
function matchScore(name: string, queryNorm: string): number {
  if (!queryNorm) return 0;
  const n = normalizeForMatch(name);
  if (!n) return 0;
  const raw = scoreNameMatch(n, queryNorm);
  const nNoArt = stripLeadingArticle(n);
  const qNoArt = stripLeadingArticle(queryNorm);
  if (nNoArt === n && qNoArt === queryNorm) return raw;
  return Math.max(raw, scoreNameMatch(nNoArt, qNoArt));
}

// Popularity bonus, comparable across types, so a globally-famous song wins
// over an obscure artist that merely shares the query as its name (e.g.
// "beat it" → Michael Jackson's song, not some act literally named "Beat It").
//   • artists: from Deezer's fan count (log scale) — a real fame signal.
//   • tracks/albums: from position in their popularity-sorted list (Deezer
//     orders each list best-first, so index 0 is the most popular).
function artistPop(a: SearchArtistResult): number {
  const fans = a.total_fans ?? 0;
  return fans > 0 ? Math.min(200, Math.log10(fans + 1) * 30) : 0;
}
function rankPop(index: number, top: number, step: number): number {
  return Math.max(0, top - index * step);
}

// Personalization — the single biggest lever in Spotify's own ranking is
// "your music." We get it two ways:
//   • Ownership: the hub annotates each track with library state, so a track
//     you own (`local_track_id`) gets a strong nudge, and the artists of your
//     owned tracks form an "owned artists" set that lifts matching rows.
//   • Listening history: Spotify's top documented signal. /api/stats gives us
//     your most-played artists (from play_events), so artists you actually
//     listen to a lot get an extra, play-count-weighted nudge.
// Both are tuned to nudge, not to override a clearly more-relevant hit.
// (Direct/offline results carry no library state, and an empty stats map makes
// the history term naturally no-op.)
const OWNED_TRACK_BONUS = 110;
const OWNED_ARTIST_BONUS = 70;
const PLAYED_ARTIST_BONUS = 90;

/** Shared empty map so the history term is a no-op until stats load. */
const EMPTY_PLAYED: ReadonlyMap<string, number> = new Map();

/** Personal-listening nudge for one artist name: how much you actually play
 *  them (play count from /api/stats top_artists), saturating so heavy rotation
 *  can't bury a clearly more-relevant hit. 0 when you've never played them. */
function playedBonus(name: string, played: ReadonlyMap<string, number>): number {
  const c = played.get(normalizeForMatch(name)) ?? 0;
  return c > 0 ? Math.min(PLAYED_ARTIST_BONUS, 30 + Math.log2(c + 1) * 25) : 0;
}
/** The strongest history nudge across a track/album's artists. */
function playedBonusForArtists(
  names: string[],
  played: ReadonlyMap<string, number>,
): number {
  let best = 0;
  for (const n of names) {
    const b = playedBonus(n, played);
    if (b > best) best = b;
  }
  return best;
}

/** Normalized artist names inferred from the tracks the user already owns in
 *  this result set — the cheap personalization signal. */
function ownedArtistSet(results: SearchResults): Set<string> {
  const s = new Set<string>();
  for (const t of results.tracks) {
    if (t.local_track_id != null) {
      for (const a of t.artists) s.add(normalizeForMatch(a));
    }
  }
  return s;
}

function trackScore(
  t: SearchTrackResult,
  q: string,
  rank: number,
  owned: Set<string>,
  played: ReadonlyMap<string, number>,
): number {
  let s =
    matchScore(t.title, q) +
    0.4 * matchScore(t.artists.join(' '), q) +
    rankPop(rank, 175, 14);
  if (t.local_track_id != null) s += OWNED_TRACK_BONUS;
  else if (t.artists.some((a) => owned.has(normalizeForMatch(a))))
    s += OWNED_ARTIST_BONUS;
  s += playedBonusForArtists(t.artists, played);
  return s;
}
function artistScore(
  a: SearchArtistResult,
  q: string,
  rank: number,
  owned: Set<string>,
  played: ReadonlyMap<string, number>,
): number {
  let s = matchScore(a.name, q) + artistPop(a) - rank * 2;
  if (owned.has(normalizeForMatch(a.name))) s += OWNED_ARTIST_BONUS;
  s += playedBonus(a.name, played);
  return s;
}
function albumScore(
  a: SearchAlbumResult,
  q: string,
  rank: number,
  owned: Set<string>,
  played: ReadonlyMap<string, number>,
): number {
  let s =
    matchScore(a.name, q) +
    0.3 * matchScore(a.artists.join(' '), q) +
    rankPop(rank, 120, 12);
  if (a.artists.some((x) => owned.has(normalizeForMatch(x))))
    s += OWNED_ARTIST_BONUS;
  s += playedBonusForArtists(a.artists, played);
  return s;
}

/** Stable id for a federated item (React key). */
function federatedKey(it: FederatedItem): string {
  if (it.kind === 'track') return `track:${it.track.source}:${it.track.source_id}`;
  if (it.kind === 'artist')
    return `artist:${it.artist.source}:${it.artist.source_id}`;
  return `album:${it.album.source}:${it.album.source_id}`;
}

/** Weave items so no single type runs more than twice in a row, while still
 *  honouring score order as much as possible. */
function weaveByKind(items: FederatedItem[]): FederatedItem[] {
  const queues: Record<FederatedKind, FederatedItem[]> = {
    track: [],
    artist: [],
    album: [],
  };
  for (const it of items) queues[it.kind].push(it);
  (Object.keys(queues) as FederatedKind[]).forEach((k) =>
    queues[k].sort((a, b) => b.score - a.score),
  );
  const out: FederatedItem[] = [];
  let lastKind: FederatedKind | null = null;
  let run = 0;
  const remaining = () =>
    queues.track.length + queues.artist.length + queues.album.length;
  while (remaining() > 0) {
    const heads = (['track', 'artist', 'album'] as const)
      .filter((k) => queues[k].length > 0)
      .map((k) => ({ k, score: queues[k][0].score }))
      .sort((a, b) => b.score - a.score);
    let pick = heads[0].k;
    // Avoid a third-in-a-row of the same type when another type is waiting.
    if (pick === lastKind && run >= 2 && heads.length > 1) pick = heads[1].k;
    out.push(queues[pick].shift() as FederatedItem);
    if (pick === lastKind) run += 1;
    else {
      lastKind = pick;
      run = 1;
    }
  }
  return out;
}

const DOMINANT_MIN_FANS = 1_000_000; // a famous artist
const DOMINANT_RATIO = 5; // …that dwarfs the closer-but-obscure name match

/** Spotify-style intent override for the Top Result: when one artist is FAR more
 *  popular than the artist that's the closest *string* match — and still matches
 *  the query at least fuzzily — it's almost certainly the one meant, so surface
 *  it as the Top Result. Fixes "weekend" → The Weeknd (14M) instead of the exact
 *  but obscure "Weekend" act. Returns that artist's federated item, or null when
 *  no artist dominates (so an exact match by a comparably-famous artist, e.g.
 *  "muse", is left alone). */
function dominantArtistItem(
  items: FederatedItem[],
  artists: SearchArtistResult[],
  queryNorm: string,
): FederatedItem | null {
  const matching = artists.filter((a) => matchScore(a.name, queryNorm) > 0);
  if (matching.length === 0) return null;
  const champ = matching.reduce((b, a) =>
    (a.total_fans ?? 0) > (b.total_fans ?? 0) ? a : b,
  );
  const closest = matching.reduce((b, a) =>
    matchScore(a.name, queryNorm) > matchScore(b.name, queryNorm) ? a : b,
  );
  if (champ === closest) return null; // the famous artist IS the closest match
  const champFans = champ.total_fans ?? 0;
  if (champFans < DOMINANT_MIN_FANS) return null;
  if (champFans < (closest.total_fans ?? 0) * DOMINANT_RATIO) return null;
  return items.find((it) => it.kind === 'artist' && it.artist === champ) ?? null;
}

/** Pick the single Top Result + a capped, woven mix for the "All" tab. */
function buildFederated(
  results: SearchResults,
  queryNorm: string,
  played: ReadonlyMap<string, number> = EMPTY_PLAYED,
): { top: FederatedItem | null; rest: FederatedItem[] } {
  const owned = ownedArtistSet(results);
  // A single's (or EP's) album is the same release as its song, so showing both
  // ("My Love" SONG + "My Love" ALBUM) is just noise. Drop a single/EP album
  // when a track with the same title + primary artist is already in the results.
  const trackSigs = new Set<string>();
  for (const t of results.tracks) {
    trackSigs.add(
      `${normalizeForMatch(t.title)}|${normalizeForMatch(t.artists[0] ?? '')}`,
    );
  }
  const dedupedAlbums = results.albums.filter((a) => {
    const type = (a.album_type ?? '').toLowerCase();
    if (type !== 'single' && type !== 'ep') return true;
    const sig = `${normalizeForMatch(a.name)}|${normalizeForMatch(
      a.artists[0] ?? '',
    )}`;
    return !trackSigs.has(sig);
  });
  const items: FederatedItem[] = [];
  results.tracks.forEach((t, i) =>
    items.push({
      kind: 'track',
      track: t,
      score: trackScore(t, queryNorm, i, owned, played),
    }),
  );
  results.artists.forEach((a, i) =>
    items.push({
      kind: 'artist',
      artist: a,
      score: artistScore(a, queryNorm, i, owned, played),
    }),
  );
  dedupedAlbums.forEach((a, i) =>
    items.push({
      kind: 'album',
      album: a,
      score: albumScore(a, queryNorm, i, owned, played),
    }),
  );
  if (items.length === 0) return { top: null, rest: [] };
  // A vastly-more-popular artist that still matches the query wins the Top
  // Result slot over a closer-but-obscure string match (Spotify's intent bias);
  // otherwise the highest combined score leads.
  const top =
    dominantArtistItem(items, results.artists, queryNorm) ??
    items.reduce((best, it) => (it.score > best.score ? it : best));
  // Candidate pool excludes the top result; cap per type so one prolific type
  // can't crowd out the others, then weave.
  const caps: Record<FederatedKind, number> = { track: 6, artist: 4, album: 4 };
  const seen: Record<FederatedKind, number> = { track: 0, artist: 0, album: 0 };
  const pool = items
    .filter((it) => it !== top)
    .sort((a, b) => b.score - a.score)
    .filter((it) => (seen[it.kind] += 1) <= caps[it.kind]);
  return { top, rest: weaveByKind(pool) };
}

interface FederatedHandlers {
  onAdd: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  onOpenArtist: (a: SearchArtistResult) => void;
  onOpenAlbum: (a: SearchAlbumResult) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** Add a catalog album to the library (trailing + on album rows). When
   *  omitted the row falls back to a plain navigation chevron. */
  onAddAlbum?: (a: SearchAlbumResult) => Promise<void>;
  /** Save-artist controller (trailing + on artist rows). Omitted ⇒ chevron. */
  save?: SavedArtistController;
}

/**
 * Whether a catalog row should render as "in your library" (green ✓) instead
 * of "add" (+). This means the track is actually in at least one playlist — NOT
 * merely that a bare `tracks` row exists. Playing or queueing a song resolves a
 * library row with no playlist link (so there's an id to stream by), and those
 * must still show + so you can add them to a playlist. Keying the ✓ on
 * `local_track_id` made every just-played song look "added", which it isn't.
 */
function isInLibrary(t: SearchTrackResult): boolean {
  return t.in_playlist_ids.length > 0;
}

/** Small green add/✓ button shared by the track rows + Top Result card. */
function AddTrackButton({
  track: t,
  onAdd,
  className,
}: {
  track: SearchTrackResult;
  onAdd: (t: SearchTrackResult) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onAdd(t)}
      aria-label={
        isInLibrary(t) ? 'Manage playlists for this track' : 'Add to playlist'
      }
      title={
        isInLibrary(t)
          ? `In ${t.in_playlist_ids.length} ${
              t.in_playlist_ids.length === 1 ? 'playlist' : 'playlists'
            } — tap to manage`
          : 'Add to playlist'
      }
      className={cn(
        'grid place-items-center rounded-full shrink-0 leading-none transition active:scale-95',
        isInLibrary(t)
          ? 'bg-neutral-100 text-neutral-950 hover:bg-white'
          : 'text-neutral-200 hover:bg-neutral-800 active:bg-neutral-800',
        className ?? 'h-9 w-9 text-xl',
      )}
    >
      {isInLibrary(t) ? (
        <svg
          width="16"
          height="16"
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
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      )}
    </button>
  );
}

/** +/✓ button that adds a catalog album or playlist to the library. One-shot:
 *  tap +, it imports (spinner), then shows ✓. Stops propagation so the row's
 *  name area (which opens the page) doesn't also fire. */
function LibraryAddButton({
  onAdd,
  label,
}: {
  onAdd: () => Promise<void>;
  label: string;
}) {
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle');
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        if (state !== 'idle') return;
        setState('adding');
        try {
          await onAdd();
          setState('added');
        } catch {
          setState('idle');
        }
      }}
      disabled={state !== 'idle'}
      aria-label={state === 'added' ? 'Added to your library' : label}
      title={state === 'added' ? 'Added to your library' : label}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-full shrink-0 leading-none transition active:scale-95',
        state === 'added'
          ? 'bg-neutral-100 text-neutral-950'
          : 'text-neutral-200 hover:bg-neutral-800 active:bg-neutral-800',
      )}
    >
      {state === 'adding' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" className="animate-spin" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : state === 'added' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 12 5 5 9-11" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )}
    </button>
  );
}

/** +/✓ save toggle for an artist result row — mirrors the SaveArtistButton pill
 *  in the artist header, but as the compact round row action. Optimistic local
 *  state so the ✓ flips instantly. */
function ArtistSaveButton({
  artist: a,
  save,
}: {
  artist: SearchArtistResult;
  save: SavedArtistController;
}) {
  const [saved, setSaved] = useState(() => save.isSaved(a.name));
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        save.toggle({ key: a.name, name: a.name, art: a.picture_url ?? null });
        setSaved((s) => !s);
      }}
      aria-label={saved ? 'Remove artist from your library' : 'Save artist to your library'}
      title={saved ? 'Remove from your library' : 'Save to your library'}
      aria-pressed={saved}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-full shrink-0 leading-none transition active:scale-95',
        saved
          ? 'bg-neutral-100 text-neutral-950'
          : 'text-neutral-200 hover:bg-neutral-800 active:bg-neutral-800',
      )}
    >
      {saved ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 12 5 5 9-11" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )}
    </button>
  );
}

/** "From your library" search results — the user's OWN playlists + songs that
 *  match the query, as the same 44px list rows as the catalog results so the
 *  two read as one list. Library playlists open the library page; songs play. */
function LibrarySection({
  playlists,
  songs,
  token,
  onOpenPlaylist,
  onPlaySong,
}: {
  playlists: PlaylistRow[];
  songs: StreamTrack[];
  token: string;
  onOpenPlaylist?: (id: number) => void;
  onPlaySong?: (t: StreamTrack) => void;
}) {
  if (playlists.length === 0 && songs.length === 0) return null;
  return (
    <div className="mb-5">
      <div className={cn(EYEBROW, 'px-1 mb-1')}>From your library</div>
      <ul className="px-1">
        {playlists.map((p) => (
          <li key={`lp:${p.id}`} className="py-2.5 flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => onOpenPlaylist?.(p.id)}
              aria-label={`Open ${p.name}`}
              className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
            >
              <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
                <img
                  src={playlistArtUrl(p.id, token)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                  loading="lazy"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
                  <RowTypeTag label="Playlist" />
                  <span className="truncate">
                    {p.track_count} {p.track_count === 1 ? 'song' : 'songs'}
                  </span>
                </div>
              </div>
            </button>
            <RowChevron />
          </li>
        ))}
        {songs.map((t) => {
          // canPlayNow, not raw has_audio: on the full build a matched-but-not-
          // downloaded library song live-streams — dimming it here contradicted
          // every other list (same bug class as the artist-page preview gate).
          const playable = canPlayNow(t);
          return (
            <li
              key={`ls:${t.id}`}
              className={`py-2.5 flex items-center gap-3 min-w-0 ${
                playable ? '' : 'opacity-60'
              }`}
            >
              <button
                type="button"
                disabled={!playable}
                onClick={() => playable && onPlaySong?.(t)}
                aria-label={`Play ${t.title}`}
                className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
              >
                <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
                  {t.album_art_url ? (
                    <img
                      src={t.album_art_url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-neutral-600">♪</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
                    <RowTypeTag label="Song" />
                    <span className="truncate">{t.artists.join(', ')}</span>
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Genre/mood tiles shown in the empty-search state — tapping runs a catalog
 *  search for that term, so the empty state is a discovery launcher rather
 *  than a dead end (Spotify's "Browse all" idea, adapted to our search). */
// Muted category colours matching BrowseScreen's GenreTile palette, so the
// empty-search launcher and the Browse genre grid read as the same component.
const BROWSE_TILES: Array<{ label: string; query: string; color: string }> = [
  { label: 'Pop', query: 'pop', color: '#7b2d5e' },
  { label: 'Hip-Hop', query: 'hip hop', color: '#b35c00' },
  { label: 'R&B', query: 'r&b', color: '#5a3e85' },
  { label: 'Rock', query: 'rock', color: '#8a2b2b' },
  { label: 'Electronic', query: 'electronic', color: '#0f6e6e' },
  { label: 'Dance', query: 'dance', color: '#3f3f8a' },
  { label: 'Indie', query: 'indie', color: '#1d6b4f' },
  { label: 'Jazz', query: 'jazz', color: '#7a5c1e' },
  { label: 'Classical', query: 'classical', color: '#2d6a8a' },
  { label: 'Country', query: 'country', color: '#4f6b1d' },
  { label: 'Latin', query: 'latin', color: '#8a2b5e' },
  { label: 'Chill', query: 'chill', color: '#1e3a5f' },
];

/** Stable React key for a recent item. */
function recentItemKey(it: RecentItem): string {
  switch (it.kind) {
    case 'query':
      return `q:${it.text.toLowerCase()}`;
    case 'track':
      return `t:${it.track.source_id}`;
    case 'artist':
      return `a:${it.artist.source_id}`;
    case 'album':
      return `al:${it.album.source_id}`;
    case 'playlist':
      return `pl:${it.playlist.source_id}`;
  }
}

/** One row in the empty-state recents list: a past text query (clock icon) or
 *  an entity (art + name + type) the user opened/played — tap to re-engage. */
function RecentRow({
  item,
  playingPreviewUrl,
  onQuery,
  onTrack,
  onArtist,
  onAlbum,
  onPlaylist,
  onRemove,
}: {
  item: RecentItem;
  playingPreviewUrl: string | null;
  onQuery: (text: string) => void;
  onTrack: (t: SearchTrackResult) => void;
  onArtist: (a: SearchArtistResult) => void;
  onAlbum: (a: SearchAlbumResult) => void;
  onPlaylist: (p: CatalogPlaylistSummary) => void;
  /** Drop just this entry (the trailing ✕), leaving the rest of the list. */
  onRemove: () => void;
}) {
  // The tap area takes all the width; a trailing ✕ removes just this entry.
  const tapCls =
    'min-w-0 flex-1 flex items-center gap-3 px-2 py-2 rounded-l-lg text-left';
  let onClick: () => void;
  let removeLabel: string;
  let inner: React.ReactNode;
  if (item.kind === 'query') {
    onClick = () => onQuery(item.text);
    removeLabel = `Remove “${item.text}” from recent searches`;
    inner = (
      <>
        {/* Clock (recent/history). Inline SVG avoids the ↩ char iOS shows as
            a blue emoji. */}
        <svg
          className="h-4 w-4 shrink-0 text-neutral-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="text-sm text-neutral-200 truncate">{item.text}</span>
      </>
    );
  } else if (item.kind === 'track') {
    const t = item.track;
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    onClick = () => onTrack(t);
    removeLabel = `Remove ${t.title} from recent searches`;
    inner = (
      <>
        <div className="relative h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {t.album_art_url ? (
            <img
              src={t.album_art_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
          {previewing ? <PreviewRing size={44} strokeWidth={2} /> : null}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-neutral-100 truncate">{t.title}</div>
          <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
            {t.explicit && <ExplicitBadge />}
            <RowTypeTag label="Song" />
            <span className="truncate">{t.artists.join(', ')}</span>
          </div>
        </div>
      </>
    );
  } else if (item.kind === 'artist') {
    const a = item.artist;
    onClick = () => onArtist(a);
    removeLabel = `Remove ${a.name} from recent searches`;
    inner = (
      <>
        <div className="h-11 w-11 shrink-0 rounded-full overflow-hidden bg-neutral-800 grid place-items-center">
          {a.picture_url ? (
            <img
              src={a.picture_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-neutral-100 truncate">{a.name}</div>
          <div className="text-xs text-neutral-500">
            <RowTypeTag label="Artist" />
          </div>
        </div>
      </>
    );
  } else if (item.kind === 'album') {
    const a = item.album;
    onClick = () => onAlbum(a);
    removeLabel = `Remove ${a.name} from recent searches`;
    inner = (
      <>
        <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {a.cover_url ? (
            <img
              src={a.cover_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-neutral-100 truncate">{a.name}</div>
          <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
            <RowTypeTag label={albumTypeLabel(a.album_type) || 'Album'} />
            <span className="truncate">{a.artists.join(', ')}</span>
          </div>
        </div>
      </>
    );
  } else {
    const p = item.playlist;
    onClick = () => onPlaylist(p);
    removeLabel = `Remove ${p.title} from recent searches`;
    inner = (
      <>
        <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {p.cover_url ? (
            <img
              src={coverSrc(p.cover_url)}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-neutral-100 truncate">{p.title}</div>
          <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
            <RowTypeTag label="Playlist" />
            <span className="truncate">{p.creator || 'Playlist'}</span>
          </div>
        </div>
      </>
    );
  }
  return (
    <div className="flex items-center rounded-lg hover:bg-neutral-800 active:bg-neutral-800">
      <button type="button" onClick={onClick} className={tapCls}>
        {inner}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-700 hover:text-neutral-200 active:scale-95"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** The Spotify-style "Top result" hero card: a big cover, title, type tag,
 *  and the primary action (play/preview for a song; open for artist/album). */
function TopResultCard({
  token,
  item,
  onAdd,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  playingPreviewUrl,
  onTogglePreview,
}: { token: string; item: FederatedItem } & FederatedHandlers) {
  // Re-render when hub reachability changes so canPlayNow gating stays live.
  useHubReachable();
  const heading = (
    <div className={cn(EYEBROW, 'px-1 mb-1')}>
      Top result
    </div>
  );

  if (item.kind === 'track') {
    const t = item.track;
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    // Playable in full only when the track has a local file (has_audio), or a
    // non-downloaded track while live streaming AND the hub is reachable.
    const playable = canPlayNow(t);
    const canPreview = !isPlayable(t) && !!t.preview_url;
    const interactive = playable || canPreview;
    return (
      <div>
        {heading}
        <div
          className={`relative rounded-xl bg-neutral-900 transition p-4 ${
            interactive ? 'hover:bg-neutral-800/70' : 'opacity-60'
          }`}
        >
          <button
            type="button"
            disabled={!interactive}
            onClick={() =>
              playable ? onPlay(t) : onTogglePreview(t.preview_url as string)
            }
            aria-label={
              playable
                ? `Play ${t.title}`
                : previewing
                  ? `Stop preview of ${t.title}`
                  : `Preview ${t.title}`
            }
            className="block w-full text-left focus:outline-none"
          >
            <div className="relative h-20 w-20 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
              {t.album_art_url ? (
                <img
                  src={t.album_art_url}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="text-3xl text-neutral-600">♪</span>
              )}
              {previewing ? <PreviewRing size={80} strokeWidth={3} /> : null}
            </div>
            <div className="mt-3 text-xl font-bold tracking-tight truncate pr-14">
              {t.title}
            </div>
            <div className="mt-1 text-xs text-neutral-400 truncate flex items-center gap-1.5 pr-14">
              {t.explicit && <ExplicitBadge />}
              <span className="truncate">{t.artists.join(', ')}</span>
              <RowTypeTag label="Song" />
            </div>
          </button>
          <AddTrackButton
            track={t}
            onAdd={onAdd}
            className="absolute bottom-4 right-4 h-12 w-12 text-2xl shadow-lg"
          />
        </div>
      </div>
    );
  }

  if (item.kind === 'artist') {
    const a = item.artist;
    return (
      <div>
        {heading}
        <div className="relative rounded-xl bg-neutral-900 hover:bg-neutral-800/70 transition p-4">
          <button
            type="button"
            onClick={() => onOpenArtist(a)}
            aria-label={`Open ${a.name}`}
            className="block w-full text-left focus:outline-none"
          >
            <div className="h-20 w-20 rounded-full overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
              {a.picture_url ? (
                <img
                  src={a.picture_url}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="text-3xl text-neutral-600">♪</span>
              )}
            </div>
            <div className="mt-3 text-xl font-bold tracking-tight truncate pr-14">{a.name}</div>
            <div className="mt-1 text-xs text-neutral-400 truncate flex items-center gap-1.5 pr-14">
              <RowTypeTag label="Artist" />
              <span className="truncate">
                {a.total_fans
                  ? `${formatCompact(a.total_fans)} listeners`
                  : 'Artist'}
              </span>
            </div>
          </button>
          <TopResultPlayButton
            token={token}
            kind="artist"
            sourceId={a.source_id}
            label={a.name}
            onPlay={onPlay}
          />
        </div>
      </div>
    );
  }

  const a = item.album;
  const year = a.release_date ? a.release_date.slice(0, 4) : '';
  return (
    <div>
      {heading}
      <div className="relative rounded-xl bg-neutral-900 hover:bg-neutral-800/70 transition p-4">
        <button
          type="button"
          onClick={() => onOpenAlbum(a)}
          aria-label={`Open ${a.name}`}
          className="block w-full text-left focus:outline-none"
        >
          <div className="h-20 w-20 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
            {a.cover_url ? (
              <img
                src={a.cover_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-3xl text-neutral-600">♪</span>
            )}
          </div>
          <div className="mt-3 text-xl font-bold tracking-tight truncate pr-14">{a.name}</div>
          <div className="mt-1 text-xs text-neutral-400 truncate flex items-center gap-1.5 pr-14">
            <RowTypeTag label={albumTypeLabel(a.album_type) || 'Album'} />
            <span className="truncate">
              {a.artists.join(', ')}
              {year ? ` · ${year}` : ''}
            </span>
          </div>
        </button>
        <TopResultPlayButton
          token={token}
          kind="album"
          sourceId={a.source_id}
          label={a.name}
          onPlay={onPlay}
        />
      </div>
    </div>
  );
}

/** Green circular play button on the artist/album Top Result card. Fetches the
 *  artist's top track / the album's first track and plays it in FULL — a
 *  downloaded track plays instantly, otherwise the host resolves it to a row
 *  and plays it. Spotify's "play the top result" affordance. */
function TopResultPlayButton({
  token,
  kind,
  sourceId,
  label,
  onPlay,
}: {
  token: string;
  kind: 'artist' | 'album';
  sourceId: string;
  label: string;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  // The fetch is a network round-trip; if the card unmounts mid-flight (user
  // edits the box / clears / drills into a page), bail before kicking off audio
  // — otherwise we'd start playback the user can no longer see they triggered.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const onClick = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const tracks =
        kind === 'artist'
          ? await getArtistTopTracks(sourceId, token)
          : await getAlbumTracks(sourceId, token);
      if (!mounted.current) return;
      // Prefer a downloaded track (instant); otherwise play the artist's top
      // track / the album's first — the host resolves it and plays it.
      const target =
        tracks.find((t) => t.has_audio && t.local_track_id != null) ??
        tracks[0];
      if (target) onPlay(target);
    } catch {
      /* best-effort; ignore fetch errors */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [loading, kind, sourceId, token, onPlay]);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-label={`Play ${label}`}
      className="absolute bottom-4 right-4 h-12 w-12 grid place-items-center rounded-full bg-neutral-100 hover:bg-white text-neutral-950 shadow-lg transition disabled:opacity-70"
    >
      {loading ? (
        <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : (
        <svg className="h-6 w-6 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
    </button>
  );
}

/** A single row in the interleaved "All" results list. */
function FederatedRow({
  item,
  onAdd,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onAddAlbum,
  save,
  playingPreviewUrl,
  onTogglePreview,
}: { item: FederatedItem } & FederatedHandlers) {
  // Re-render when hub reachability changes so canPlayNow gating stays live.
  useHubReachable();
  if (item.kind === 'track') {
    const t = item.track;
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    // Playable in full only when the track has a local file (has_audio), or a
    // non-downloaded track while live streaming AND the hub is reachable.
    const playable = canPlayNow(t);
    const canPreview = !isPlayable(t) && !!t.preview_url;
    const interactive = playable || canPreview;
    const InfoArea: React.ElementType = interactive ? 'button' : 'div';
    return (
      <li
        className={`py-2.5 flex items-center gap-3 min-w-0 ${
          interactive ? '' : 'opacity-60'
        }`}
      >
        <InfoArea
          {...(interactive
            ? {
                type: 'button' as const,
                onClick: () =>
                  playable
                    ? onPlay(t)
                    : onTogglePreview(t.preview_url as string),
                'aria-label': playable
                  ? `Play ${t.title}`
                  : previewing
                    ? `Stop preview of ${t.title}`
                    : `Preview ${t.title}`,
              }
            : {})}
          className="group/info flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
        >
          <ArtworkThumb artUrl={t.album_art_url} playing={previewing} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{t.title}</div>
            <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
              <RowTypeTag label="Song" />
              {t.explicit && <ExplicitBadge />}
              <span className="truncate">{t.artists.join(', ')}</span>
            </div>
          </div>
        </InfoArea>
        <AddTrackButton track={t} onAdd={onAdd} />
      </li>
    );
  }

  if (item.kind === 'artist') {
    const a = item.artist;
    return (
      <li className="py-2.5 flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={() => onOpenArtist(a)}
          aria-label={`Open ${a.name}`}
          className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
        >
          <div className="h-11 w-11 shrink-0 rounded-full overflow-hidden bg-neutral-800 grid place-items-center">
            {a.picture_url ? (
              <img
                src={a.picture_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : (
              <span className="text-neutral-600">♪</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{a.name}</div>
            <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
              <RowTypeTag label="Artist" />
              <span className="truncate">
                {a.total_fans
                  ? `${formatCompact(a.total_fans)} listeners`
                  : 'Artist'}
              </span>
            </div>
          </div>
        </button>
        {save ? <ArtistSaveButton artist={a} save={save} /> : <RowChevron />}
      </li>
    );
  }

  const a = item.album;
  const year = a.release_date ? a.release_date.slice(0, 4) : '';
  return (
    <li className="py-2.5 flex items-center gap-3 min-w-0">
      <button
        type="button"
        onClick={() => onOpenAlbum(a)}
        aria-label={`Open ${a.name}`}
        className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
      >
        <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {a.cover_url ? (
            <img
              src={a.cover_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{a.name}</div>
          <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
            <RowTypeTag label={albumTypeLabel(a.album_type) || 'Album'} />
            <span className="truncate">
              {a.artists.join(', ')}
              {year ? ` · ${year}` : ''}
            </span>
          </div>
        </div>
      </button>
      {onAddAlbum ? (
        <LibraryAddButton
          onAdd={() => onAddAlbum(a)}
          label={`Add ${a.name} to your library`}
        />
      ) : (
        <RowChevron />
      )}
    </li>
  );
}

/** The federated "All" tab: a Top Result card followed by an interleaved,
 *  relevance-ranked mix of songs, artists, and albums. */
export function FederatedResults({
  token,
  query,
  results,
  played = EMPTY_PLAYED,
  playlists = [],
  onOpenPlaylist,
  onAddPlaylist,
  ...handlers
}: {
  token: string;
  query: string;
  results: SearchResults;
  played?: ReadonlyMap<string, number>;
  /** Catalog playlists that matched. Rendered as list rows in the SAME
   *  "Results" list as songs / artists / albums — same 11×11 art, same row
   *  height, same trailing +/chevron — so nothing reads as a separate shelf. */
  playlists?: CatalogPlaylistSummary[];
  onOpenPlaylist?: (p: CatalogPlaylistSummary) => void;
  /** Add a matched catalog playlist to the library (its trailing +). */
  onAddPlaylist?: (p: CatalogPlaylistSummary) => Promise<void>;
} & FederatedHandlers) {
  const queryNorm = normalizeForMatch(query);
  const { top, rest } = useMemo(
    () => buildFederated(results, queryNorm, played),
    [results, queryNorm, played],
  );
  const hasPlaylistRows = playlists.length > 0 && !!onOpenPlaylist;
  if (!top && !hasPlaylistRows) {
    return <div className="px-2 pt-3 text-sm text-neutral-500">No results.</div>;
  }
  return (
    <div className="flex flex-col gap-5">
      {top && <TopResultCard token={token} item={top} {...handlers} />}
      {(rest.length > 0 || hasPlaylistRows) && (
        <div>
          <div className={cn(EYEBROW, 'px-1 mb-1')}>
            Results
          </div>
          <ul className="px-1">
            {rest.map((it) => (
              <FederatedRow key={federatedKey(it)} item={it} {...handlers} />
            ))}
            {/* Playlists trail the relevance-ranked track/artist/album rows, but
                in the same list — an exact song/artist/album match is a stronger
                hit than a playlist that merely mentions the query. */}
            {hasPlaylistRows &&
              playlists.map((p) => (
                <PlaylistRow
                  key={`pl:${p.source}:${p.source_id}`}
                  playlist={p}
                  onOpen={onOpenPlaylist as (p: CatalogPlaylistSummary) => void}
                  onAdd={onAddPlaylist}
                />
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One catalog-playlist row for the federated results list — mirrors the album
 *  arm of FederatedRow exactly (11×11 rounded cover, title, "Playlist" tag +
 *  creator, chevron) so playlists sit inline with the rest of the results. */
function PlaylistRow({
  playlist: p,
  onOpen,
  onAdd,
}: {
  playlist: CatalogPlaylistSummary;
  onOpen: (p: CatalogPlaylistSummary) => void;
  /** Add this catalog playlist to the library (trailing +). Omitted ⇒ chevron. */
  onAdd?: (p: CatalogPlaylistSummary) => Promise<void>;
}) {
  return (
    <li className="py-2.5 flex items-center gap-3 min-w-0">
      <button
        type="button"
        onClick={() => onOpen(p)}
        aria-label={`Open ${p.title}`}
        className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
      >
        <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {p.cover_url ? (
            <img
              src={coverSrc(p.cover_url)}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{p.title}</div>
          <div className="text-xs text-neutral-500 truncate flex items-center gap-1.5">
            <RowTypeTag label="Playlist" />
            <span className="truncate">{p.creator || 'Playlist'}</span>
          </div>
        </div>
      </button>
      {onAdd ? (
        <LibraryAddButton
          onAdd={() => onAdd(p)}
          label={`Add ${p.title} to your library`}
        />
      ) : (
        <RowChevron />
      )}
    </li>
  );
}

// --- Typeahead suggestions --------------------------------------------
//
// A focused-state dropdown under the search box, Spotify-style: query
// completions drawn from recent searches that match what you've typed, plus
// a couple of inline "jump" rows for the top artist/album so you can hop
// straight to a page without scrolling the results. Tracks are intentionally
// left out — they have no page, and the live results list right below already
// gives every song a preview + add control.

type Suggestion =
  // The explicit "search what I typed" action — first row, and what the
  // keyboard's return key does. Commits the live query to the results page.
  | { kind: 'search'; text: string }
  // A recent-search completion (commits that past query).
  | { kind: 'query'; text: string }
  | { kind: 'track'; track: SearchTrackResult }
  | { kind: 'artist'; artist: SearchArtistResult }
  | { kind: 'album'; album: SearchAlbumResult }
  | { kind: 'playlist'; playlist: CatalogPlaylistSummary };

function suggestionKey(s: Suggestion): string {
  if (s.kind === 'search') return `s:${s.text}`;
  if (s.kind === 'query') return `q:${s.text}`;
  if (s.kind === 'track') return `t:${s.track.source_id}`;
  if (s.kind === 'artist') return `a:${s.artist.source_id}`;
  if (s.kind === 'playlist') return `pl:${s.playlist.source_id}`;
  return `al:${s.album.source_id}`;
}

/** The inner content of one suggestion row (icon/art + label + type tag). */
function SuggestionContent({
  s,
  playingPreviewUrl,
}: {
  s: Suggestion;
  playingPreviewUrl: string | null;
}) {
  if (s.kind === 'search') {
    return (
      <>
        {/* Magnifier — the "search this" action. */}
        <svg
          className="h-4 w-4 shrink-0 text-neutral-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="flex-1 min-w-0 text-sm text-neutral-100 truncate">
          {s.text}
        </span>
      </>
    );
  }
  if (s.kind === 'query') {
    return (
      <>
        {/* Clock — a past search. */}
        <svg
          className="h-4 w-4 shrink-0 text-neutral-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="flex-1 min-w-0 text-sm text-neutral-200 truncate">
          {s.text}
        </span>
      </>
    );
  }
  if (s.kind === 'track') {
    const t = s.track;
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    return (
      <>
        {/* Album art shows the preview state. Tapping the row engages the track
            (parent onClick): a downloaded file plays in full, a catalog result
            plays / pauses the 30s clip in place. */}
        <div className="relative h-8 w-8 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {t.album_art_url ? (
            <img
              src={t.album_art_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
          {t.preview_url ? (
            <div
              className={`absolute inset-0 grid place-items-center ${
                previewing ? 'bg-black/55' : 'bg-black/40'
              }`}
            >
              {previewing ? (
                <>
                  <PreviewRing size={32} strokeWidth={2.5} />
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="white"
                    className="absolute"
                    aria-hidden
                  >
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                </>
              ) : (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="white"
                  className="opacity-90"
                  aria-hidden
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </div>
          ) : null}
        </div>
        <span className="min-w-0 flex-1 text-sm text-neutral-200 truncate">
          <span className="text-neutral-100">{t.title}</span>
          <span className="text-neutral-500"> · {t.artists.join(', ')}</span>
        </span>
        <RowTypeTag label="Song" />
      </>
    );
  }
  if (s.kind === 'artist') {
    const a = s.artist;
    return (
      <>
        <div className="h-8 w-8 shrink-0 rounded-full overflow-hidden bg-neutral-800 grid place-items-center">
          {a.picture_url ? (
            <img
              src={a.picture_url}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
        </div>
        <span className="flex-1 min-w-0 text-sm text-neutral-200 truncate">
          {a.name}
        </span>
        <RowTypeTag label="Artist" />
      </>
    );
  }
  if (s.kind === 'playlist') {
    const p = s.playlist;
    return (
      <>
        <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
          {p.cover_url ? (
            <img
              src={coverSrc(p.cover_url)}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
        </div>
        <span className="min-w-0 flex-1 text-sm text-neutral-200 truncate">
          <span className="text-neutral-100">{p.title}</span>
          {p.creator ? (
            <span className="text-neutral-500"> · {p.creator}</span>
          ) : null}
        </span>
        <RowTypeTag label="Playlist" />
      </>
    );
  }
  const a = s.album;
  return (
    <>
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
        {a.cover_url ? (
          <img
            src={a.cover_url}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="text-neutral-600 text-xs">♪</span>
        )}
      </div>
      <span className="flex-1 min-w-0 text-sm text-neutral-200 truncate">
        {a.name}
      </span>
      <RowTypeTag label="Album" />
    </>
  );
}

/** Shared column template for the desktop Songs "table" so the header row and
 *  every body row stay aligned: # · title · album · File · duration · add.
 *  Applied only at md+ (the phone keeps a compact single-line list). */
const SONGS_COLS =
  'grid-cols-[1.5rem_minmax(0,2fr)_minmax(0,1fr)_2.5rem_3rem_2.5rem]';

export function TrackList({
  tracks,
  onAdd,
  onPlay,
  playingPreviewUrl,
  onTogglePreview,
  isTrackCurrent,
  isNowPlaying,
  onShowMenu,
  onShowTrackSheet,
}: {
  tracks: SearchTrackResult[];
  onAdd: (t: SearchTrackResult) => void;
  // Passes the whole list + this row's index so the host seeds the play queue
  // from here and auto-advances down the list.
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** Now-playing: the current row highlights + shows equalizer bars over its
   *  cover, matching the playlist/album track rows. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isNowPlaying?: boolean;
  /** Desktop: open the per-song "⋯" overflow menu at a screen point. When set,
   *  each row shows a hover ⋯ (with "Add to playlist" etc.) INSTEAD of the bare
   *  + button, plus a small "in a playlist" ✓ next to Time — matching the album
   *  page. When absent, the row keeps the simple hover +. */
  onShowMenu?: (t: SearchTrackResult, x: number, y: number) => void;
  /** Phone: open the per-song "⋯" action sheet (same bottom sheet the library /
   *  playlist rows use). When set, each row's trailing control is a ⋯ instead of
   *  the + button — matching the playlist page. */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
}) {
  // Re-render when hub reachability changes so canPlayNow gating stays live.
  useHubReachable();
  // With a ⋯ menu the trailing + is replaced by ⋯, and a Spotify-style
  // "in a playlist" ✓ column sits before Time — so the grid gains that column.
  const hasMenu = !!onShowMenu;
  const cols = hasMenu
    ? 'grid-cols-[1.5rem_minmax(0,2fr)_minmax(0,1fr)_2.5rem_2rem_3rem_2.5rem]'
    : SONGS_COLS;
  if (tracks.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No songs matched.</div>
    );
  }
  return (
    // Phone sheet mode (genre): break out of the parent's px-4 so the rows run
    // edge-to-edge with px-4 content — same width + dividers as the playlist.
    <div className={onShowTrackSheet ? '-mx-4 md:mx-0 md:px-1' : 'px-1'}>
      {/* Column headers frame the desktop "table" (md+); the phone keeps the
          compact list below, so this header stays hidden there. */}
      <div
        className={`hidden md:grid ${cols} items-center gap-3 px-2 pb-1.5 mb-1 border-b border-white/5 text-[11px] uppercase tracking-wider text-neutral-500`}
      >
        <div className="text-right pr-1">#</div>
        <div>Title</div>
        <div>Album</div>
        <div>File</div>
        {hasMenu ? <div /> : null}
        <div className="text-right">Time</div>
        <div />
      </div>
      <ul>
      {tracks.map((t, i) => {
        const previewing =
          !!t.preview_url && playingPreviewUrl === t.preview_url;
        // Tap behavior: if the real file is already downloaded, play it
        // in the bundle's player; otherwise audition Deezer's 30s
        // preview. Rows with neither (no preview AND not downloaded)
        // stay non-interactive. Play gates on canPlayNow so a non-downloaded
        // row dims when the hub is unreachable.
        const playable = canPlayNow(t);
        const canPreview = !isPlayable(t) && !!t.preview_url;
        const interactive = playable || canPreview;
        const current = !!isTrackCurrent && isTrackCurrent(t);
        const InfoArea: React.ElementType = interactive ? 'button' : 'div';
        return (
          <li
            key={`${t.source}:${t.source_id}`}
            onContextMenu={
              onShowMenu
                ? (e) => {
                    e.preventDefault();
                    onShowMenu(t, e.clientX, e.clientY);
                  }
                : undefined
            }
            className={`group flex items-center gap-3 min-w-0 ${
              onShowTrackSheet ? 'px-4' : 'px-2'
            } py-2.5 md:grid ${cols} md:items-center md:gap-3 md:py-1.5 md:px-2 md:rounded-lg transition-colors ${
              interactive ? 'md:hover:bg-neutral-800/40' : 'opacity-60'
            }`}
          >
            {/* Track number — desktop table only. In menu mode (genre pages)
                the # gutter carries the now-playing indicator like the playlist:
                equalizer bars while playing, a ▶ on hover, else the number. */}
            <div
              className={`relative hidden md:flex items-center justify-end h-6 pr-1 text-xs tabular-nums ${
                current ? 'text-neutral-100' : 'text-neutral-500'
              }`}
            >
              {hasMenu && current && isNowPlaying ? (
                <EqualizerBars className="text-neutral-100" />
              ) : (
                <>
                  <span
                    className={
                      hasMenu && interactive && !current ? 'group-hover:opacity-0' : ''
                    }
                  >
                    {i + 1}
                  </span>
                  {hasMenu && interactive && !current ? (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-end pr-1 text-neutral-100 opacity-0 group-hover:opacity-100">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <InfoArea
              {...(interactive
                ? {
                    type: 'button' as const,
                    onClick: () =>
                      playable
                        ? onPlay(t, tracks, i)
                        : onTogglePreview(t.preview_url as string),
                    'aria-label': playable
                      ? `Play ${t.title}`
                      : previewing
                        ? `Stop preview of ${t.title}`
                        : `Preview ${t.title}`,
                  }
                : {})}
              className="group/info flex-1 md:flex-none min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
            >
              <ArtworkThumb
                artUrl={t.album_art_url}
                playing={previewing}
                // Now-playing marker on the cover: equalizer bars when this row
                // is the current track. On desktop menu mode the # gutter carries
                // it; on the phone sheet mode (genre) the cover does — matching
                // the playlist. Keep the cover plain otherwise (no ▶ scrim) so it
                // reads like the playlist rows, not the search results.
                nowPlaying={!hasMenu && current && !!isNowPlaying}
                pausedCurrent={!hasMenu && current && !isNowPlaying}
                showHoverPlay={!hasMenu && !onShowTrackSheet}
                small={!!onShowTrackSheet}
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm ${
                    hasMenu ? 'md:text-base' : ''
                  } font-medium truncate ${current ? 'text-accent' : 'text-neutral-300'}`}
                >
                  {t.title}
                </div>
                <div
                  className={`text-xs ${
                    hasMenu ? 'md:text-sm' : ''
                  } text-neutral-500 truncate flex items-center gap-1.5`}
                >
                  {t.explicit && <ExplicitBadge />}
                  <span className="truncate">
                    {t.artists.join(', ')}
                    {t.album ? <span className="md:hidden"> · {t.album}</span> : null}
                  </span>
                </div>
              </div>
            </InfoArea>
            {/* Album column — desktop table only (on the phone it rides in the
                subtitle above). */}
            <div
              className={`hidden md:block min-w-0 text-xs ${
                hasMenu ? 'md:text-sm' : ''
              } text-neutral-400 truncate`}
            >
              {t.album ?? ''}
            </div>
            {/* File column — the green "downloaded" seal when the track's audio
                is on the device (desktop table only), matching the playlist rows. */}
            <div className="hidden md:grid place-items-start">
              <span className="grid h-7 w-7 place-items-center">
                {t.has_audio ? <AlbumDownloadedBadge /> : null}
              </span>
            </div>
            {/* "In a playlist" ✓ (desktop, menu mode) — a white check shown only
                for tracks already in ≥1 playlist; click to manage (opens the
                add-to-playlist picker, pre-checked). Blank otherwise. */}
            {hasMenu ? (
              <div className="hidden md:grid place-items-center">
                {isInLibrary(t) ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd(t);
                    }}
                    aria-label="Manage playlists for this track"
                    title={`In ${t.in_playlist_ids.length} ${
                      t.in_playlist_ids.length === 1 ? 'playlist' : 'playlists'
                    } — click to manage`}
                    className="grid h-6 w-6 place-items-center rounded-full bg-white text-neutral-950 hover:bg-neutral-200 transition active:scale-95"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m5 12 5 5 9-11" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ) : null}
            <div
              className={`text-[11px] ${
                hasMenu ? 'md:text-sm md:text-neutral-500' : ''
              } text-neutral-600 tabular-nums w-10 md:w-auto text-right shrink-0 ${
                onShowTrackSheet ? 'hidden md:block' : ''
              }`}
            >
              {formatDuration(t.duration_ms)}
            </div>
            {hasMenu ? (
              <div className="hidden md:grid place-items-center">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowMenu!(t, e.clientX, e.clientY);
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
            ) : onShowTrackSheet ? (
              // Phone: ⋯ opens the track action sheet, matching the playlist rows.
              <button
                type="button"
                aria-label={`More options for ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onShowTrackSheet(t);
                }}
                className="h-11 w-9 -my-2 -mr-2 grid place-items-center text-neutral-500 active:text-neutral-200 shrink-0"
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.7" />
                  <circle cx="12" cy="12" r="1.7" />
                  <circle cx="19" cy="12" r="1.7" />
                </svg>
              </button>
            ) : (
              <AddTrackButton track={t} onAdd={onAdd} />
            )}
          </li>
        );
      })}
      </ul>
    </div>
  );
}

export async function playArtistCard(
  artist: SearchArtistResult,
  token: string,
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void,
) {
  try {
    const list = await getArtistTopTracks(artist.source_id, token);
    if (list.length) onPlay(list[0], list, 0);
  } catch {
    /* leave the card as-is on failure */
  }
}


/** A single artist card — circular avatar + name + "Artist · N albums".
 *  Shared by the wrapping `ArtistGrid` and the horizontal artist shelf on the
 *  Browse page. `className` lets the shelf pin a fixed width (`w-36 shrink-0`)
 *  while the grid stays fluid. */
export function ArtistCard({
  showKind = true,
  artist: a,
  onOpen,
  onPlay,
  className,
}: {
  artist: SearchArtistResult;
  onOpen: (a: SearchArtistResult) => void;
  /** When set, a white play button lifts in over the avatar and plays the
      artist's top tracks (the card click still opens the page). */
  onPlay?: (a: SearchArtistResult) => void;
  className?: string;
  /** Show the "Artist · N albums" line. Off where every tile is an
   *  artist and the words would repeat under each face. */
  showKind?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(a)}
      onKeyDown={(e) => {
        // Only the card root answers keys — a bubbled Enter/Space from the
        // nested play button must NOT also open the page.
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onOpen(a);
        }
      }}
      className={`group relative cursor-pointer text-center transition active:scale-[0.98] ${className ?? ''}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-x-2 inset-y-0 rounded-xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        {/* Circular avatar is the convention for artists in music UIs. The
            play button anchors to the avatar box (not the wider grid cell) so
            it hugs the circle's bottom-right, Spotify-style. */}
        <div className="relative mx-auto w-full max-w-[160px]">
          <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-full bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {a.picture_url ? (
              <img
                src={a.picture_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : (
              <span className="text-4xl text-neutral-600">♪</span>
            )}
          </div>
          {onPlay ? (
            <CardPlayButton label={`Play ${a.name}`} onPlay={() => onPlay(a)} />
          ) : null}
        </div>
        <div className="mt-2 w-full min-w-0">
          <div className="truncate text-sm font-medium">{a.name}</div>
          {/* The kind + album count earn their place in mixed search results,
              where a row could be an album or a track. In a row that is all
              artists they are the same words under every face. */}
          {showKind ? (
            <div className="truncate text-xs text-neutral-500">
              Artist
              {a.total_albums ? ` · ${a.total_albums} albums` : ''}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ArtistGrid({
  artists,
  onOpen,
  onPlay,
  showKind = true,
  layout = 'grid',
}: {
  artists: SearchArtistResult[];
  onOpen: (a: SearchArtistResult) => void;
  /** Threaded to each card: hover play button that plays the artist's top tracks. */
  onPlay?: (a: SearchArtistResult) => void;
  /** 'grid' = wrapping grid; 'row' = horizontal scroller (artist-page carousel). */
  layout?: 'grid' | 'row';
  /** Passed to each card — see `ArtistCard`. */
  showKind?: boolean;
}) {
  if (artists.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No artists matched.</div>
    );
  }
  // Same grid breakpoints as AlbumGrid so the search results read as
  // a single visual rhythm regardless of which tab you're on.
  if (layout === 'row') {
    // The scroller needs room for each card's -inset-3 hover highlight, or
    // `overflow-x-auto` slices it off — the first tile shows a rectangle cut
    // flat against the row's edge. Pad the scroller, then pull the padding
    // back on an outer wrapper. The negative margin must NOT go on the
    // scroller itself: that collapses ShelfRow's positioning box and takes
    // the ‹ › arrows with it (the same lesson is written into Home's shelf).
    return (
      <div className="-mx-3 -my-3">
      <ShelfRow
        artClass="h-28 sm:h-32"
        scrollerClassName="flex gap-3 overflow-x-auto overscroll-x-contain px-3 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {artists.map((a) => (
          <div
            key={`${a.source}:${a.source_id}`}
            className="w-28 sm:w-32 shrink-0"
          >
            <ArtistCard artist={a} onOpen={onOpen} onPlay={onPlay} showKind={showKind} />
          </div>
        ))}
      </ShelfRow>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {artists.map((a) => (
        <ArtistCard
          key={`${a.source}:${a.source_id}`}
          artist={a}
          onOpen={onOpen}
          onPlay={onPlay}
          showKind={showKind}
        />
      ))}
    </div>
  );
}

/** Apple-Music-style compact "Top Songs": short rows grouped into columns of
 *  three that scroll horizontally, so the next songs are a swipe away. Each row
 *  plays (downloaded) or auditions the 30s preview (catalog-only). */
function ArtistTopSongs({
  tracks,
  onAdd,
  onPlay,
  playingPreviewUrl,
  onTogglePreview,
  layout = 'carousel',
  isTrackCurrent,
  isPlaying,
  onShowTrackSheet,
}: {
  tracks: SearchTrackResult[];
  onAdd: (t: SearchTrackResult) => void;
  onPlay: (
    t: SearchTrackResult,
    list?: SearchTrackResult[],
    index?: number,
  ) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** 'carousel' = columns-of-3 horizontal shelf (artist page); 'list' = a
   *  single vertical list of every track (the phone's Top Songs show-all);
   *  'table' = the numbered # · Title · Album · Time table matching the
   *  playlist/album pages (the desktop Top Songs show-all). */
  layout?: 'carousel' | 'list' | 'table';
  /** Now-playing: the current row highlights + shows equalizer bars / ♪. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  /** Phone: open the per-song ⋯ action sheet (same as every other music list).
   *  When set, the trailing control is a ⋯ instead of the +/✓. */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
}) {
  // Re-render when hub reachability changes so canPlayNow gating stays live.
  useHubReachable();
  const renderRow = (t: SearchTrackResult, idx: number) => {
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    const playable = canPlayNow(t);
    const canPreview = !isPlayable(t) && !!t.preview_url;
    const interactive = playable || canPreview;
    const current = !!isTrackCurrent && isTrackCurrent(t);
    const activate = () => {
      if (playable) onPlay(t, tracks, idx);
      else if (canPreview) onTogglePreview(t.preview_url as string);
    };
    return (
      <div
        key={`${t.source}:${t.source_id}:${idx}`}
        className={`group flex items-center gap-3 rounded-lg px-2 -mx-2 py-2 transition-colors ${
          interactive ? '' : 'opacity-60'
        }`}
      >
        <button
          type="button"
          disabled={!interactive}
          onClick={activate}
          className="relative h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center"
          aria-label={previewing ? 'Stop preview' : 'Play'}
        >
          {t.album_art_url ? (
            <img
              src={t.album_art_url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-neutral-600">♪</span>
          )}
          {current && isPlaying && !previewing ? (
            // Now playing (audible): equalizer bars over the cover.
            <span className="absolute inset-0 grid place-items-center bg-black/55">
              <EqualizerBars className="text-white" />
            </span>
          ) : current && !previewing ? (
            // Current track, paused: static ♪ (matches the playlist page).
            <span className="absolute inset-0 grid place-items-center bg-black/55">
              <span className="text-sm text-white">♪</span>
            </span>
          ) : interactive ? (
            <span
              className={`absolute inset-0 grid place-items-center bg-black/45 transition-opacity ${
                previewing || current
                  ? 'opacity-100'
                  : CAN_HOVER
                    ? 'opacity-0 group-hover:opacity-100'
                    : 'opacity-90'
              }`}
            >
              {previewing ? (
                <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg className="h-4 w-4 text-white translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          disabled={!interactive}
          onClick={activate}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`truncate text-sm font-medium ${current ? 'text-accent' : 'text-neutral-300'}`}>
              {t.title}
            </span>
            {t.explicit ? <ExplicitBadge /> : null}
          </div>
          {t.album ? (
            <div className="truncate text-xs text-neutral-500">{t.album}</div>
          ) : null}
        </button>
        {onShowTrackSheet ? (
          // Phone: the shared ⋯ action sheet (Favorite / Add / Go to Artist /
          // Album) — same trailing control as every other music list.
          <button
            type="button"
            aria-label={`More options for ${t.title}`}
            onClick={() => onShowTrackSheet(t)}
            className="h-11 w-9 -my-2 -mr-2 grid place-items-center text-neutral-500 active:text-neutral-200 shrink-0"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
        ) : (
          /* Desktop / show-all: in a playlist → a persistent white ✓ that opens
             the add-to-playlist picker; otherwise a hover-revealed +. */
          <button
            type="button"
            onClick={() => onAdd(t)}
            aria-label={
              isInLibrary(t) ? 'Manage playlists for this track' : 'Add to playlist'
            }
            title={
              isInLibrary(t)
                ? `In ${t.in_playlist_ids.length} ${
                    t.in_playlist_ids.length === 1 ? 'playlist' : 'playlists'
                  } — click to manage`
                : 'Add to playlist'
            }
            className={cn(
              'shrink-0 w-7 h-7 grid place-items-center rounded-full transition active:scale-95',
              isInLibrary(t)
                ? 'bg-white text-neutral-950 hover:bg-neutral-200'
                : cn(
                    'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 active:bg-neutral-800',
                    CAN_HOVER
                      ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                      : 'opacity-100',
                  ),
            )}
          >
            {isInLibrary(t) ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m5 12 5 5 9-11" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            )}
          </button>
        )}
      </div>
    );
  };

  // Show-all page: one long vertical list of every track.
  if (layout === 'list') {
    return <div className="flex flex-col">{tracks.map((t, idx) => renderRow(t, idx))}</div>;
  }

  // Desktop show-all: the numbered table every other track surface uses
  // (playlist / album pages) — # · cover · Title · Album · Time · add, with a
  // sticky column header. The # cell swaps to ▶ on hover and to equalizer
  // bars / ♪ for the current row, matching the album page's convention.
  if (layout === 'table') {
    const grid =
      'grid grid-cols-[2.5rem_3rem_minmax(0,1fr)_minmax(0,1fr)_5rem_2.5rem] gap-3 items-center';
    return (
      <div>
        <div
          className={`${grid} sticky top-14 z-20 px-2 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-white/5 bg-neutral-950/60 backdrop-blur-xl`}
        >
          <span className="text-center">#</span>
          <span></span>
          <span>Title</span>
          <span>Album</span>
          <span className="text-right">Time</span>
          <span></span>
        </div>
        {tracks.map((t, idx) => {
          const previewing =
            !!t.preview_url && playingPreviewUrl === t.preview_url;
          const playable = canPlayNow(t);
          const canPreview = !isPlayable(t) && !!t.preview_url;
          const interactive = playable || canPreview;
          const current = !!isTrackCurrent && isTrackCurrent(t);
          const activate = () => {
            if (playable) onPlay(t, tracks, idx);
            else if (canPreview) onTogglePreview(t.preview_url as string);
          };
          return (
            <div
              key={`${t.source}:${t.source_id}:${idx}`}
              onClick={interactive ? activate : undefined}
              className={`group ${grid} px-2 py-1.5 rounded-lg transition-colors ${
                interactive ? 'cursor-pointer hover:bg-white/5' : 'opacity-60'
              }`}
            >
              <span className="relative grid place-items-center text-sm tabular-nums text-neutral-500">
                {current && isPlaying && !previewing ? (
                  <EqualizerBars className="text-accent" />
                ) : current && !previewing ? (
                  <span className="text-accent">♪</span>
                ) : (
                  <>
                    <span
                      className={
                        interactive && CAN_HOVER ? 'group-hover:opacity-0' : ''
                      }
                    >
                      {idx + 1}
                    </span>
                    {interactive && CAN_HOVER ? (
                      <span className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100">
                        {previewing ? (
                          <svg className="h-3.5 w-3.5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4 text-white translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </span>
                    ) : null}
                  </>
                )}
              </span>
              <span className="h-10 w-10 rounded overflow-hidden bg-neutral-800 grid place-items-center">
                {t.album_art_url ? (
                  <img
                    src={t.album_art_url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-neutral-600">♪</span>
                )}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`truncate text-sm font-medium ${
                      current ? 'text-accent' : 'text-neutral-200'
                    }`}
                  >
                    {t.title}
                  </span>
                  {t.explicit ? <ExplicitBadge /> : null}
                </span>
                {t.artists.length > 0 ? (
                  <span className="block truncate text-xs text-neutral-500">
                    {t.artists.join(', ')}
                  </span>
                ) : null}
              </span>
              <span className="truncate text-sm text-neutral-400">
                {t.album ?? ''}
              </span>
              <span className="text-right text-sm tabular-nums text-neutral-400">
                {t.duration_ms ? formatDuration(t.duration_ms) : ''}
              </span>
              <span
                onClick={(e) => e.stopPropagation()}
                className="grid place-items-center"
              >
                <button
                  type="button"
                  onClick={() => onAdd(t)}
                  aria-label={
                    isInLibrary(t)
                      ? 'Manage playlists for this track'
                      : 'Add to playlist'
                  }
                  title={
                    isInLibrary(t)
                      ? `In ${t.in_playlist_ids.length} ${
                          t.in_playlist_ids.length === 1
                            ? 'playlist'
                            : 'playlists'
                        } — click to manage`
                      : 'Add to playlist'
                  }
                  className={cn(
                    'w-7 h-7 grid place-items-center rounded-full transition active:scale-95',
                    isInLibrary(t)
                      ? 'bg-white text-neutral-950 hover:bg-neutral-200'
                      : cn(
                          'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800',
                          CAN_HOVER
                            ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                            : 'opacity-100',
                        ),
                  )}
                >
                  {isInLibrary(t) ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m5 12 5 5 9-11" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                  )}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // Artist page: Apple-style paged columns of FOUR on a horizontal shelf —
  // the next column peeks in from the right edge and pages with snap.
  const columns: SearchTrackResult[][] = [];
  for (let i = 0; i < tracks.length; i += 4) columns.push(tracks.slice(i, i + 4));
  return (
    <ShelfRow scrollerClassName="flex gap-x-6 overflow-x-auto overscroll-x-contain pb-1 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {columns.map((col, ci) => (
        <div
          key={ci}
          className="flex flex-col shrink-0 w-[86%] lg:w-[calc(50%-0.75rem)] snap-start"
        >
          {col.map((t, ri) => renderRow(t, ci * 4 + ri))}
        </div>
      ))}
    </ShelfRow>
  );
}

/** A section title with an optional show-all affordance. The affordance itself
 *  lives in `ShowAllTitle` (shared with home's shelves); this only places it. */
function SectionHeader({
  label,
  onShowAll,
}: {
  label: string;
  onShowAll?: () => void;
}) {
  return (
    <div className="px-1 mb-2">
      <ShowAllTitle
        label={label}
        onShowAll={onShowAll}
        className="text-lg font-bold tracking-tight"
      />
    </div>
  );
}


/**
 * Full-grid "show all" page for one artist-page section, reached via that
 * section's › chevron (Apple Music's "See All"). Re-fetches the same data the
 * artist page uses — its own discography / related artists — and lays it out as
 * a wrapping grid instead of the horizontal carousel. A first-class Back/Forward
 * stop on desktop (rendered inline, replacing the artist page); a stacked modal
 * on the phone (over the still-mounted artist page).
 */
function ArtistShowAll({
  token,
  artist,
  section,
  onClose,
  onPickAlbum,
  onPickArtist,
  onPickTrack,
  onPlay,
  playingPreviewUrl,
  onTogglePreview,
  inline,
  escapeActive = true,
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
  initial,
}: {
  token: string;
  artist: SearchArtistResult;
  section: ShowAllSection;
  onClose: () => void;
  onPickAlbum: (a: SearchAlbumResult) => void;
  onPickArtist: (a: SearchArtistResult) => void;
  /** Song handlers — only used by the 'songs' (Top Songs) show-all. */
  onPickTrack?: (t: SearchTrackResult) => void;
  onPlay?: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  /** Data the artist page already loaded (drill-in only) — seeds the grid so
   *  it paints instantly with no fetch/skeleton flash. Section-matched: only
   *  the field this section needs is read; anything else falls back to a fetch. */
  initial?: ShowAllInitial;
  playingPreviewUrl?: string | null;
  onTogglePreview?: (url: string) => void;
  /** Desktop: render as a full inline page instead of a modal overlay. */
  inline?: boolean;
  /** Now-playing awareness for the songs table (desktop): the current row
   *  highlights + shows equalizer bars, like the playlist/album pages. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  /** Pause/resume the current playback — the hero/sticky Play toggles instead
   *  of restarting when this section is already the active context. */
  onTogglePlay?: () => void;
  /** Whether this is the topmost surface and should answer Escape. On the phone
   *  this page can stack OVER the still-mounted artist page (and an album can
   *  stack over it); only the top layer should close on a single Escape, else
   *  one keypress collapses the whole stack. Defaults true. */
  escapeActive?: boolean;
}) {
  const wantAlbums = section === 'albums' || section === 'singles';
  const wantSongs = section === 'songs';
  // Seed from the artist page's already-loaded data (drill-in): a non-null
  // start means the fetch effect below sees data present and skips the request.
  // Keyed remount per section, so these lazy initializers run fresh each open.
  // `related` from the artist page is already rank-sorted, so don't re-rank.
  const [albums, setAlbums] = useState<SearchAlbumResult[] | null>(
    () => initial?.albums ?? null,
  );
  const [related, setRelated] = useState<SearchArtistResult[] | null>(
    () => initial?.related ?? null,
  );
  const [topTracks, setTopTracks] = useState<SearchTrackResult[] | null>(
    () => initial?.topTracks ?? null,
  );
  // Spotify-style condensed header: once the hero title scrolls under the top
  // bar the compact sticky Play bar fades in (desktop) — the same trigger the
  // artist / album / playlist pages use.
  const [condensed, heroSentinelRef] = useCondensedHeader();

  useEffect(() => {
    if (!wantAlbums || albums !== null) return; // seeded or already fetched
    let cancelled = false;
    getArtistAlbums(artist.source_id, token)
      .then((rows) => {
        if (cancelled) return;
        // Backfill the per-album artist (the endpoint elides it) so the cards
        // read the same as on the artist page's carousel.
        setAlbums(
          rows.map((r) => ({
            ...r,
            artists: r.artists.length > 0 ? r.artists : [artist.name],
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setAlbums([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantAlbums, albums, artist.source_id, artist.name, token]);

  useEffect(() => {
    if (section !== 'related' || related !== null) return;
    let cancelled = false;
    getArtistRelated(artist.source_id, token)
      .then((rows) => {
        if (!cancelled) setRelated(rankRelatedArtists(rows));
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [section, related, artist.source_id, token]);

  useEffect(() => {
    if (!wantSongs || topTracks !== null) return;
    let cancelled = false;
    getArtistTopTracks(artist.source_id, token)
      .then((rows) => {
        if (!cancelled) setTopTracks(rows);
      })
      .catch(() => {
        if (!cancelled) setTopTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wantSongs, topTracks, artist.source_id, token]);

  useEffect(() => {
    if (!escapeActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, escapeActive]);

  const title =
    section === 'albums'
      ? 'Albums'
      : section === 'singles'
        ? 'Singles & EPs'
        : section === 'songs'
          ? 'Top Songs'
          : 'Fans also like';

  // Same split + newest-first ordering as the artist page, so the grid mirrors
  // the carousel it was opened from.
  const albumItems = useMemo(() => {
    if (!albums) return null;
    const byNewest = (a: SearchAlbumResult, b: SearchAlbumResult) =>
      (b.release_date ?? '').localeCompare(a.release_date ?? '');
    return albums
      .filter((a) => {
        const t = (a.album_type ?? '').toLowerCase();
        const isSingle = t === 'single' || t === 'ep';
        return section === 'singles' ? isSingle : !isSingle;
      })
      .sort(byNewest);
  }, [albums, section]);

  const loading = wantAlbums
    ? albumItems === null
    : wantSongs
      ? topTracks === null
      : related === null;

  // Hero / sticky Play: ONLY the songs page gets one — it plays its own list
  // (toggling pause when those tracks are already the active context, like
  // the artist/album/playlist pages). The Albums / Singles & EPs / Similar
  // grids get no Play at all: what "play an albums grid" means is ambiguous,
  // so the button read as noise there.
  const contextActive =
    !!isTrackCurrent && !!topTracks && topTracks.some((t) => isTrackCurrent(t));
  const contextPlaying = contextActive && !!isPlaying;
  const headerPlay = wantSongs
    ? () => {
        if (contextActive && onTogglePlay) onTogglePlay();
        else if (topTracks && topTracks.length > 0)
          onPlay?.(topTracks[0], topTracks, 0);
      }
    : undefined;

  // Desktop hero: artist round art · artist-name eyebrow · big section title ·
  // round Play — the same header language as the artist/album pages (the
  // default ModalShell title block read as unstyled next to them). The phone
  // keeps the shell's own compact header.
  const hero = inline ? (
    <div className="px-4 pt-6 pb-2">
      <div className="flex items-end gap-5">
        {artist.picture_url ? (
          <img
            src={artist.picture_url}
            alt=""
            className="h-28 w-28 shrink-0 rounded-full object-cover shadow-lg"
            draggable={false}
          />
        ) : null}
        <div className="min-w-0 flex-1 pb-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
            {artist.name}
          </div>
          {/* Condensed-header trigger ABOVE the title (not below, like the
              taller artist/album heroes): the bar takes over as soon as the
              title starts sliding under the top bar. Below-the-title, a short
              page (10 top songs) can't scroll far enough to ever trip it. */}
          <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
          <h1 className="mt-1 text-3xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] break-words">
            {title}
          </h1>
        </div>
        {/* Play rides the title's baseline at the row's end — a lone button
            stranded on its own line below read as misplaced. Songs only. */}
        {headerPlay ? (
          <button
            type="button"
            onClick={headerPlay}
            aria-label={contextPlaying ? 'Pause' : `Play ${title}`}
            title={contextPlaying ? 'Pause' : `Play ${title}`}
            className="mb-1 grid h-12 w-12 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition hover:bg-white hover:scale-105 active:scale-95"
          >
            {contextPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
    </div>
  ) : undefined;

  return (
    <ModalShell
      title={title}
      subtitle={artist.name}
      onClose={onClose}
      wide
      inline={inline}
      hero={hero}
      stickyBar={
        inline ? (
          <CondensedHeaderBar
            condensed={condensed}
            title={`${artist.name} · ${title}`}
            onPlay={headerPlay}
            playing={headerPlay ? contextPlaying : undefined}
          />
        ) : undefined
      }
    >
      <div className="px-4 pt-4 pb-4">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4" aria-hidden>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-square w-full rounded-lg bg-neutral-800/80" />
                <div className="mt-2 h-3.5 w-3/4 rounded bg-neutral-800/80" />
                <div className="mt-1.5 h-3 w-1/2 rounded bg-neutral-800/80" />
              </div>
            ))}
          </div>
        ) : wantAlbums ? (
          <AlbumGrid
            albums={albumItems ?? []}
            onOpen={onPickAlbum}
            onPlay={onPlay ? (a) => playAlbumCard(a, token, onPlay) : undefined}
            subtitleMode="discography"
            layout="grid"
          />
        ) : wantSongs ? (
          <ArtistTopSongs
            tracks={topTracks ?? []}
            // Desktop: the numbered table every other track surface uses;
            // phone keeps the compact art+title rows (its playlist look).
            layout={inline ? 'table' : 'list'}
            onAdd={(t) => onPickTrack?.(t)}
            onPlay={(t, list, index) => onPlay?.(t, list, index)}
            playingPreviewUrl={playingPreviewUrl ?? null}
            onTogglePreview={(url) => onTogglePreview?.(url)}
            isTrackCurrent={isTrackCurrent}
            isPlaying={isPlaying}
          />
        ) : (
          <ArtistGrid
            artists={related ?? []}
            onOpen={onPickArtist}
            onPlay={onPlay ? (a) => playArtistCard(a, token, onPlay) : undefined}
            layout="grid"
          />
        )}
      </div>
    </ModalShell>
  );
}

/** The saved-album playlist id shared by EVERY track of an album (⇒ the album
 *  is saved to the library), or null. Profile-scoped: the tracks come from a
 *  profile-scoped fetch, so `in_saved_album_ids` already reflects the caller's
 *  profile. Intersecting across tracks is what the album page does too. */
function sharedSavedAlbumId(tracks: SearchTrackResult[]): number | null {
  if (!tracks.length) return null;
  const shared = tracks
    .map((t) => new Set(t.in_saved_album_ids ?? []))
    .reduce((acc, ids) => new Set([...acc].filter((id) => ids.has(id))));
  return [...shared][0] ?? null;
}

/** Words that mark a re-release of a record rather than a different record. */
const EDITION = 'deluxe|expanded|remaster(?:ed)?|edition|anniversary|bonus|reissue|explicit|standard';

/**
 * A comparison key that gives one record one name, however many times the
 * catalog lists it. Drops the edition marker — bracketed ("(Deluxe)",
 * "[Remastered 2011]"), after a dash ("- Remastered and Reissued"), or just
 * trailing ("B'Day Deluxe Edition") — then case and punctuation:
 *
 *   "After Hours (Deluxe)"           → "after hours"
 *   "OK Computer OKNOTOK 1997 2017"  → unchanged — a different record, rightly
 *   "Fearless (Taylor's Version)"    → unchanged — also a different record
 *
 * That last one is why "version" is not an edition word on its own: only the
 * fixed phrases ("Standard Version", "Deluxe Version") count.
 */
function albumNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(new RegExp(`\\s*[([][^)\\]]*\\b(?:${EDITION})\\b[^)\\]]*[)\\]]`, 'g'), '')
    .replace(new RegExp(`\\s*[-–—]\\s*[^-–—]*\\b(?:${EDITION})\\b.*$`), '')
    .replace(
      /\s+(?:deluxe|expanded|remastered?|standard|special|collector'?s)(?:\s+(?:edition|version))?$/,
      '',
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Modal showing an artist's discography. Loads /api/artists/:id/albums
 * and renders the result with the same AlbumGrid we use on the search
 * page, so tapping any album drills into the existing AlbumDetailModal
 * flow (which then offers per-track add and the whole-album import).
 */
export function ArtistDetailModal({
  token,
  artist,
  onClose,
  onPickAlbum,
  onPickTrack,
  onPlay,
  onPickArtist,
  onShowAll,
  playingPreviewUrl,
  onTogglePreview,
  inline,
  escapeActive = true,
  pin,
  save,
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
  onShowTrackSheet,
  onPickPlaylist,
  onAddAlbum,
}: {
  token: string;
  artist: SearchArtistResult;
  onClose: () => void;
  onPickAlbum: (a: SearchAlbumResult) => void;
  onPickTrack: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  onPickArtist: (a: SearchArtistResult) => void;
  /** Open one section's full grid (the › chevron). Omitted ⇒ no chevrons. */
  onShowAll?: (section: ShowAllSection, initial?: ShowAllInitial) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** Desktop: render as a full page instead of a modal overlay. */
  inline?: boolean;
  /** Whether this page is the topmost surface and should answer Escape. On the
   *  phone a show-all grid (or album) can stack OVER this still-mounted page, so
   *  only the top layer closes on a single Escape — otherwise one keypress
   *  collapses the whole stack. Defaults true. */
  escapeActive?: boolean;
  pin?: SidebarPinController;
  /** Save-to-library control (Library › Artists). Desktop only for now. */
  save?: SavedArtistController;
  /** Now-playing awareness (desktop), so the artist page mirrors the album /
   *  playlist pages: a ⏸/▶ hero + sticky Play button, the current Top-Songs row
   *  highlights + shows equalizer bars, and the album card of the playing album
   *  shows a persistent pause. Omitted on the phone. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Phone: open the per-song ⋯ action sheet on the Top-Songs rows. */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /** Open a catalog playlist (the Artist Playlists rail). Omitted ⇒ rail hidden. */
  onPickPlaylist?: (p: CatalogPlaylistSummary) => void;
  /** Import an album into the library (the Latest Release + button).
   *  Omitted ⇒ no + button. */
  onAddAlbum?: (a: SearchAlbumResult) => Promise<void> | void;
}) {
  const [albums, setAlbums] = useState<SearchAlbumResult[] | null>(null);
  const [topTracks, setTopTracks] = useState<SearchTrackResult[] | null>(null);
  const [related, setRelated] = useState<SearchArtistResult[] | null>(null);
  const [bio, setBio] = useState<ArtistBio | null>(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Apple-style About: the bio clamps to a few lines with a MORE toggle.
  // (No reset needed — the modal remounts per artist via key=source_id.)
  // Apple-style rails, both best-effort (empty just hides the section):
  // albums by OTHERS featuring this artist, and catalog playlists about them.
  const [appearsOn, setAppearsOn] = useState<SearchAlbumResult[]>([]);
  const [artistPlaylists, setArtistPlaylists] = useState<
    CatalogPlaylistSummary[]
  >([]);
  // Latest Release +/✓ button. Reflects whether the album is ACTUALLY in the
  // library (derived below from the featured album's tracks), so the ✓ persists
  // across revisits and the button toggles rather than being a one-shot "added"
  // that disables itself. `featuredSavedId` is the saved-album playlist id we
  // delete to un-save. The toggle updates it optimistically (no re-fetch that
  // would flash the button through its other glyph — see the onClick below).
  const [featuredSavedId, setFeaturedSavedId] = useState<number | null>(null);
  const [latestBusy, setLatestBusy] = useState(false);
  // Phone hero ⋯ menu (Apple-Music-style): Save / Pin / Shuffle live here
  // instead of as hero buttons, so the hero carries a single Play action.
  const [heroMenu, setHeroMenu] = useState<MenuState | null>(null);
  // Track count for the Featured Album. The artist-albums endpoint elides
  // nb_tracks, so when it's missing we fetch the album's tracks once and count
  // them — Apple-style "N songs" instead of a redundant "Album" label.
  const [featuredCount, setFeaturedCount] = useState<number | null>(null);

  // Spotify-style condensed header: a 1px sentinel under the hero name flips
  // `condensed` true once the name scrolls past the top bar (desktop sticky bar).
  const [condensed, heroSentinelRef] = useCondensedHeader();

  // Newest release = the Featured Album. Computed here (not inline) so the
  // track-count effect below can key off it.
  const featured = useMemo(() => {
    if (!albums || albums.length === 0) return null;
    return [...albums].sort((a, b) =>
      (b.release_date ?? '').localeCompare(a.release_date ?? ''),
    )[0];
  }, [albums]);

  // "Essential Albums" — Apple curates theirs editorially; we have no editorial
  // signal, so the Top Songs ARE the signal: rank full albums by how many top
  // songs they carry and keep the ones with at least two. Popularity-derived,
  // honest, and zero extra requests.
  //
  // The Latest Release is excluded, because the page has already given it the
  // hero. The two sections answer different questions — "what's new?" and
  // "where do I start?" — but a new record usually dominates its artist's top
  // songs for a while, so on exactly the artists you are most likely to be
  // reading about, both would show the same cover twice and read as a bug.
  const essentials = useMemo(() => {
    if (!albums || !topTracks || topTracks.length === 0) return [];
    // Excluding the Latest Release means excluding the *record*, not the one
    // catalog row: with only the row gone, an artist whose newest entry is a
    // reissue would put the same cover back under Essentials.
    const featuredKey = featured ? albumNameKey(featured.name) : '';
    const eligible = albums.filter((a) => {
      if (featured && a.source_id === featured.source_id) return false;
      if (featuredKey && albumNameKey(a.name) === featuredKey) return false;
      const ty = (a.album_type ?? '').toLowerCase();
      return ty !== 'single' && ty !== 'ep';
    });
    if (eligible.length === 0) return [];
    // One group per record, holding every catalog row for it — the original
    // and its reissues. Counting rows instead splits a record's top songs
    // between its editions and can cost it its place: Lana Del Rey's "Born To
    // Die" scores 3 as a record but 2 and 1 as two rows.
    type Group = { rep: (typeof eligible)[number]; ids: Set<string> };
    const groups = new Map<string, Group>();
    for (const a of eligible) {
      // Empty key (a title that is all punctuation) falls back to the id, so
      // such albums group only with themselves rather than all together.
      const key = albumNameKey(a.name) || a.source_id;
      const held = groups.get(key);
      if (!held) {
        groups.set(key, { rep: a, ids: new Set([a.source_id]) });
      } else {
        held.ids.add(a.source_id);
        // Show the plainest title of the group — the record, not the reissue.
        if (a.name.length < held.rep.name.length) held.rep = a;
      }
    }
    const groupOfId = new Map<string, string>();
    for (const [key, g] of groups) for (const id of g.ids) groupOfId.set(id, key);

    const counts = new Map<string, number>();
    for (const t of topTracks) {
      // The album id is exact and is tried first; the name is the fallback for
      // a hub too old to send one, and for the tracks Deezer credits to a row
      // outside this artist's album list.
      let key = t.album_id ? groupOfId.get(t.album_id) : undefined;
      if (key === undefined && t.album) {
        const nameKey = albumNameKey(t.album);
        if (groups.has(nameKey)) key = nameKey;
      }
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...groups]
      .map(([key, g]) => ({ a: g.rep, n: counts.get(key) ?? 0 }))
      .filter((x) => x.n >= 2)
      .sort((x, y) => y.n - x.n)
      .slice(0, 3)
      .map((x) => x.a);
  }, [albums, topTracks, featured]);

  // Re-fetch this artist page's fetched membership/saved indicators when the
  // library changes elsewhere (a Top Song added to a playlist via its ⋯ picker,
  // or the Latest Release saved from its own album page) — the modal floats over
  // the results, so without this the ✓ marks stay as captured when it opened.
  const libTick = useLibraryChangeTick();

  useEffect(() => {
    setFeaturedCount(null);
    setFeaturedSavedId(null);
    if (!featured) return;
    // Always fetch the tracks (not just when the count is missing): they're
    // profile-scoped, so their `in_saved_album_ids` tell us whether the album
    // is saved. Same signal the album page uses — the album is saved iff every
    // track shares one saved-album playlist id, which is what we delete to
    // un-save.
    let cancelled = false;
    getAlbumTracks(featured.source_id, token)
      .then((tracks) => {
        if (cancelled) return;
        setFeaturedCount(featured.total_tracks ?? tracks.length);
        setFeaturedSavedId(sharedSavedAlbumId(tracks));
      })
      .catch(() => {
        // Leave count on the album's own total (or null → album-type label).
        if (!cancelled) setFeaturedCount(featured.total_tracks ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [featured, token, libTick]);

  // Albums are the primary section; a failure here surfaces the banner.
  useEffect(() => {
    let cancelled = false;
    getArtistAlbums(artist.source_id, token)
      .then((rows) => {
        if (cancelled) return;
        // The artist-albums endpoint elides the per-album artist
        // (the caller already knows whose discography this is), so
        // we backfill from the artist row before passing into the
        // shared AlbumGrid component — that way the album cards show
        // "Artist Name · 2013" subtitles like the search-results
        // grid does.
        setAlbums(
          rows.map((r) => ({
            ...r,
            artists: r.artists.length > 0 ? r.artists : [artist.name],
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artist.source_id, artist.name, token]);

  // Popular tracks + related artists are best-effort: on failure we
  // just hide the section (set to []) rather than block the modal.
  useEffect(() => {
    let cancelled = false;
    getArtistTopTracks(artist.source_id, token)
      .then((rows) => {
        if (!cancelled) setTopTracks(rows);
      })
      .catch(() => {
        if (!cancelled) setTopTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [artist.source_id, token, libTick]);

  useEffect(() => {
    let cancelled = false;
    getArtistRelated(artist.source_id, token)
      .then((rows) => {
        if (!cancelled) setRelated(rankRelatedArtists(rows));
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [artist.source_id, token]);

  // Wikipedia "About" blurb — best-effort, by artist name. Null hides it.
  useEffect(() => {
    let cancelled = false;
    getArtistBio(artist.name, token)
      .then((b) => {
        if (!cancelled) setBio(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artist.name, token]);

  // "Appears On" — features on other artists' records (server heuristic).
  useEffect(() => {
    let cancelled = false;
    getArtistAppearsOn(artist.name, token)
      .then((rows) => {
        if (!cancelled) setAppearsOn(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artist.name, token]);

  // "Artist Playlists" — catalog playlists surfacing this artist (Apple's rail,
  // minus the editorial branding). Plain name search; relevance is decent.
  useEffect(() => {
    let cancelled = false;
    searchCatalog(artist.name, token, 'playlist', 12)
      .then((r) => {
        if (!cancelled) setArtistPlaylists((r.playlists ?? []).slice(0, 8));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [artist.name, token]);

  useEffect(() => {
    if (!escapeActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, escapeActive]);

  // Now-playing awareness: is the currently-playing track one of this artist's
  // top tracks? That makes the artist's top-tracks the active context, so the
  // hero + sticky Play button mirror the now-playing bar (⏸ while playing) and
  // toggle instead of restarting. The playing track's album name lights up the
  // matching album card. Absent `isTrackCurrent` → agnostic (old behavior).
  const contextActive =
    !!isTrackCurrent && !!topTracks && topTracks.some((t) => isTrackCurrent(t));
  const contextPlaying = contextActive && !!isPlaying;
  const headerPlay = () => {
    if (contextActive && onTogglePlay) onTogglePlay();
    else if (topTracks && topTracks.length > 0) onPlay(topTracks[0], topTracks, 0);
  };
  // The album name of the now-playing track, so its card on this page shows a
  // persistent pause. Derived from the current top-track (the only rows we can
  // match against here); null when nothing of this artist's is playing.
  const currentAlbumName =
    (isTrackCurrent && topTracks?.find((t) => isTrackCurrent(t))?.album) || null;

  return (
    <ModalShell
      title={artist.name}
      subtitle="Artist"
      onClose={onClose}
      wide
      inline={inline}
      condensed={condensed}
      onHeaderPlay={headerPlay}
      headerPlaying={contextPlaying}
      headerExtra={
        // Phone: a one-tap Save (+ → ✓, the album-save convention) next to a
        // ⋯ menu at the bar's right edge, Apple-Music-style — the hero itself
        // carries only Play. Desktop keeps its explicit button row instead.
        !inline ? (
          <>
          <button
            type="button"
            aria-label={`More options for ${artist.name}`}
            onClick={(e) => {
              const items: MenuItem[] = [];
              if (topTracks && topTracks.length > 0) {
                items.push({
                  label: 'Shuffle play',
                  icon: MenuGlyphs.play,
                  onClick: () => {
                    const shuffled = [...topTracks];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                      const j = Math.floor(Math.random() * (i + 1));
                      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                    onPlay(shuffled[0], shuffled, 0);
                  },
                });
              }
              if (save) {
                items.push({
                  label: save.isSaved(artist.name)
                    ? 'Remove from Library'
                    : 'Save to Library',
                  icon: MenuGlyphs.star,
                  onClick: () =>
                    save.toggle({
                      key: artist.name,
                      name: artist.name,
                      art: artist.picture_url ?? null,
                    }),
                });
              }
              if (pin) {
                items.push({
                  label: pin.isArtistPinned(artist.name)
                    ? 'Unpin from Sidebar'
                    : 'Pin to Sidebar',
                  icon: MenuGlyphs.pin,
                  onClick: () =>
                    pin.toggleArtist({
                      key: artist.name,
                      name: artist.name,
                      art: artist.picture_url ?? null,
                    }),
                });
              }
              if (items.length > 0) {
                setHeroMenu({ x: e.clientX, y: e.clientY, items });
              }
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-black/30 text-neutral-100 backdrop-blur-md active:bg-white/15"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          {save ? (
            <button
              type="button"
              aria-label={
                save.isSaved(artist.name)
                  ? `Remove ${artist.name} from library`
                  : `Save ${artist.name} to library`
              }
              onClick={() =>
                save.toggle({
                  key: artist.name,
                  name: artist.name,
                  art: artist.picture_url ?? null,
                })
              }
              className={cn(
                'grid h-8 w-8 shrink-0 place-items-center rounded-full backdrop-blur-md transition active:scale-95',
                save.isSaved(artist.name)
                  ? 'bg-white text-neutral-950'
                  : 'bg-black/30 text-neutral-100 active:bg-white/15',
              )}
            >
              {save.isSaved(artist.name) ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m5 12 5 5 9-11" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              )}
            </button>
          ) : null}
          </>
        ) : undefined
      }
      stickyBar={
        <CondensedHeaderBar
          condensed={condensed}
          title={artist.name}
          playing={contextPlaying}
          onPlay={headerPlay}
        />
      }
      hero={
        !inline ? (
          // Phone: Apple-Music hero — the PHOTO is the header. Full-bleed
          // square running up behind the translucent top bar, the name overlaid
          // on a legibility scrim, and a single accent Play on the photo. The
          // secondary actions (Save / Pin / Shuffle) live in the bar's ⋯ menu.
          <div className="relative overflow-hidden">
            <div className="relative w-full aspect-square max-h-[58vh] bg-neutral-800">
              {artist.picture_url ? (
                <img
                  src={artist.picture_url}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-6xl text-neutral-600">
                  ♪
                </div>
              )}
              <div
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/75 via-black/30 to-transparent"
              />
              <h2 className="absolute bottom-4 left-4 right-20 text-4xl font-extrabold tracking-tight leading-[1.02] drop-shadow break-words">
                {artist.name}
              </h2>
              {topTracks && topTracks.length > 0 ? (
                <button
                  type="button"
                  onClick={headerPlay}
                  aria-label={contextPlaying ? 'Pause' : `Play ${artist.name}`}
                  className="absolute bottom-4 right-4 grid h-12 w-12 place-items-center rounded-full bg-white text-neutral-950 shadow-lg transition active:scale-95"
                >
                  {contextPlaying ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
                    </svg>
                  )}
                </button>
              ) : null}
            </div>
            {/* Condensed-header trigger: the bar's title/play fade in once the
                photo (and the name on it) scrolls past. */}
            <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
            {/* Listener/album fallback when there's no bio to carry it. */}
            {!bio && artist.total_fans ? (
              <div className="px-4 pt-3 text-sm font-medium text-neutral-200">
                {formatCompact(artist.total_fans)} listeners
              </div>
            ) : !bio && artist.total_albums ? (
              <div className="px-4 pt-3 text-xs text-neutral-300">
                {artist.total_albums} albums on Deezer
              </div>
            ) : null}
          </div>
        ) : (
        // Desktop: Spotify playlist-header style — a full, uncropped square of
        // the artist photo on the left with the name + listener count written
        // out beside it, over a colour wash pulled from a blurred copy of
        // the same photo (so we don't need a colour-extraction step).
        <div className="relative overflow-hidden">
          <HeroWash coverUrl={artist.picture_url} />
          <div className="relative flex items-end gap-4 sm:gap-5 px-5 sm:px-6 pb-5 sm:pb-6 pt-6">
            <div className="h-36 w-36 sm:h-52 sm:w-52 shrink-0 rounded-xl overflow-hidden bg-neutral-800 grid place-items-center shadow-2xl">
              {artist.picture_url ? (
                <img
                  src={artist.picture_url}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="text-5xl text-neutral-600">♪</span>
              )}
            </div>
            <div className="min-w-0 pb-1">
              <div className={cn(EYEBROW_ON_ART, 'mb-1.5')}>
                Artist
              </div>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] drop-shadow break-words">
                {artist.name}
              </h2>
              {/* Condensed-header trigger: once this scrolls under the top bar,
                  the compact sticky bar fades in (desktop). */}
              <div ref={heroSentinelRef} aria-hidden className="h-px w-px" />
              {/* No listener count here either. It used to appear only when
                  there was no bio, on the reasoning that About showed it
                  otherwise — but About no longer does, and a number that
                  turns up on artists without a bio and vanishes on artists
                  with one is worse than not showing it at all. It never told
                  you anything about the music. The album count stays: it says
                  how much there is to play. */}
              {!bio && artist.total_albums ? (
                <div className="text-xs text-neutral-300 mt-3">
                  {artist.total_albums} albums on Deezer
                </div>
              ) : null}
              <div className="mt-4 flex items-center gap-3">
                {topTracks && topTracks.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={headerPlay}
                      aria-label={contextPlaying ? 'Pause' : `Play ${artist.name}`}
                      title={contextPlaying ? 'Pause' : `Play ${artist.name}`}
                      className="grid h-14 w-14 place-items-center rounded-full bg-neutral-100 text-neutral-950 shadow-lg transition hover:bg-white hover:scale-105 active:scale-95"
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
                      onClick={() => {
                        // Fisher-Yates — sort(() => Math.random() - 0.5) is a
                        // biased shuffle (comparators must be consistent).
                        const shuffled = [...topTracks];
                        for (let i = shuffled.length - 1; i > 0; i--) {
                          const j = Math.floor(Math.random() * (i + 1));
                          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                        }
                        onPlay(shuffled[0], shuffled, 0);
                      }}
                      aria-label="Shuffle play"
                      title="Shuffle play"
                      className="grid h-10 w-10 place-items-center rounded-full text-neutral-200 transition hover:text-white hover:bg-white/10"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                      </svg>
                    </button>
                  </>
                ) : null}
                {save ? (
                  <SaveArtistButton
                    saved={save.isSaved(artist.name)}
                    onClick={() =>
                      save.toggle({
                        key: artist.name,
                        name: artist.name,
                        art: artist.picture_url ?? null,
                      })
                    }
                  />
                ) : null}
                {pin ? (
                  <PinButton
                    pinned={pin.isArtistPinned(artist.name)}
                    onClick={() =>
                      pin.toggleArtist({
                        key: artist.name,
                        name: artist.name,
                        art: artist.picture_url ?? null,
                      })
                    }
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
        )
      }
    >
      <div className="flex flex-col gap-6 px-4 pt-4 pb-4">
        {error && (
          <div className={cn(CALLOUT_ERROR, 'text-xs')}>
            {error}
          </div>
        )}

        {/* Featured Album + Top Songs, side by side like Apple Music's hero:
            the newest release on the left, a compact scrollable song list on
            the right. Stacks on narrow screens. */}
        {(() => {
          const hasSongs = !!topTracks && topTracks.length > 0;
          // Nothing to show once both have finished loading empty.
          if (!featured && topTracks !== null && !hasSongs) return null;
          return (
            <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-x-8 gap-y-6">
              {featured ? (
                <div className="min-w-0">
                  <div className="text-lg font-bold tracking-tight px-1 mb-2">
                    Latest Release
                  </div>
                  {/* Cover + metadata side by side, Apple-Music style: tiny
                      uppercase DATE eyebrow, title, track count, and a circular
                      + that imports the album. The + is a sibling (not nested in
                      the open-album button) — nested buttons are invalid HTML. */}
                  <div className="group flex items-center gap-4 w-full">
                    <button
                      type="button"
                      onClick={() => onPickAlbum(featured)}
                      aria-label={`Open ${featured.name}`}
                      className="aspect-square w-44 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center shadow-lg"
                    >
                      {featured.cover_url ? (
                        <img
                          src={featured.cover_url}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="text-3xl text-neutral-600">♪</span>
                      )}
                    </button>
                    <div className="min-w-0">
                      {featured.release_date && (
                        <div className="text-[11px] uppercase tracking-wide text-neutral-400">
                          {formatReleaseDate(featured.release_date)}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => onPickAlbum(featured)}
                        className="block text-left font-semibold line-clamp-2 hover:underline mt-1"
                      >
                        {featured.name}
                      </button>
                      <div className="text-sm text-neutral-400 mt-1">
                        {featuredCount != null
                          ? `${featuredCount} ${featuredCount === 1 ? 'song' : 'songs'}`
                          : albumTypeLabel(featured.album_type)}
                      </div>
                      {onAddAlbum ? (
                        <button
                          type="button"
                          aria-label={
                            featuredSavedId != null
                              ? `Remove ${featured.name} from library`
                              : `Add ${featured.name} to library`
                          }
                          disabled={latestBusy}
                          onClick={async () => {
                            if (latestBusy) return;
                            setLatestBusy(true);
                            try {
                              if (featuredSavedId != null) {
                                await deletePlaylist(featuredSavedId, token);
                                if (typeof window !== 'undefined')
                                  notifyLibraryChanged();
                                // Un-saved: null is authoritative (we just
                                // deleted it). Set it in the same tick the
                                // spinner clears → ✓ → +, no stale re-fetch that
                                // could flash the ✓ back.
                                setFeaturedSavedId(null);
                              } else {
                                await onAddAlbum(featured);
                                // Re-derive the new saved-album id INLINE, while
                                // the spinner still shows, so the button goes
                                // loading → ✓ directly (no flash back through +)
                                // and the ✓ can remove on the next click.
                                const tracks = await getAlbumTracks(
                                  featured.source_id,
                                  token,
                                );
                                setFeaturedSavedId(sharedSavedAlbumId(tracks));
                              }
                            } catch {
                              /* leave the control as-is on failure */
                            } finally {
                              setLatestBusy(false);
                            }
                          }}
                          className={cn(
                            'mt-3 h-8 w-8 grid place-items-center rounded-full transition active:scale-95',
                            featuredSavedId != null
                              ? 'bg-white text-neutral-950 hover:bg-neutral-200'
                              : 'bg-white/10 text-neutral-100 hover:bg-white/20',
                          )}
                        >
                          {latestBusy ? (
                            <span
                              aria-hidden
                              className="h-4 w-4 rounded-full border-2 border-neutral-400 border-t-transparent animate-spin"
                            />
                          ) : featuredSavedId != null ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="m5 12 5 5 9-11" />
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 5v14" />
                              <path d="M5 12h14" />
                            </svg>
                          )}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="hidden lg:block" />
              )}
              <div className="min-w-0">
                <SectionHeader
                  label="Top Songs"
                  onShowAll={
                    onShowAll && topTracks && topTracks.length > 6
                      ? () => onShowAll('songs', { topTracks })
                      : undefined
                  }
                />
                {topTracks === null ? (
                  <div className="text-sm text-neutral-500 px-1">
                    Loading popular songs…
                  </div>
                ) : hasSongs ? (
                  <ArtistTopSongs
                    tracks={topTracks}
                    onAdd={onPickTrack}
                    onPlay={onPlay}
                    playingPreviewUrl={playingPreviewUrl}
                    onTogglePreview={onTogglePreview}
                    isTrackCurrent={isTrackCurrent}
                    isPlaying={isPlaying}
                    onShowTrackSheet={onShowTrackSheet}
                  />
                ) : null}
              </div>
            </div>
          );
        })()}

        {/* Essential Albums — Apple curates theirs; ours are the albums that
            carry the most Top Songs (see `essentials`). Giant one-card-per-page
            snap carousel, matching Apple's oversized treatment. */}
        {essentials.length > 0 ? (
          <div>
            <SectionHeader label="Essential Albums" />
            <div className="flex gap-4 overflow-x-auto overscroll-x-contain snap-x pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {essentials.map((a) => (
                <button
                  key={`${a.source}:${a.source_id}`}
                  type="button"
                  onClick={() => onPickAlbum(a)}
                  className="group w-[85%] sm:w-[22rem] shrink-0 snap-start text-left"
                >
                  <div className="aspect-square w-full rounded-xl overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
                    {a.cover_url ? (
                      <img
                        src={a.cover_url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-4xl text-neutral-600">♪</span>
                    )}
                  </div>
                  <div className="mt-2 font-semibold group-hover:underline truncate">
                    {a.name}
                  </div>
                  {a.release_date ? (
                    <div className="text-sm text-neutral-400">
                      {a.release_date.slice(0, 4)}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Albums + Singles & EPs — separate sections like Apple Music, each
            newest-first and collapsed to a preview with a "Show all" toggle so
            prolific artists don't flood the page. */}
        {!albums ? (
          !error && (
            <div className="text-sm text-neutral-500 px-1">Loading albums…</div>
          )
        ) : (
          (() => {
            const byNewest = (a: SearchAlbumResult, b: SearchAlbumResult) =>
              (b.release_date ?? '').localeCompare(a.release_date ?? '');
            // Albums + compilations in one section; singles + EPs in another.
            // Unknown types fall in with albums (Deezer usually labels them).
            const albumsOnly = albums
              .filter((a) => {
                const t = (a.album_type ?? '').toLowerCase();
                return t !== 'single' && t !== 'ep';
              })
              .sort(byNewest);
            const singlesOnly = albums
              .filter((a) => {
                const t = (a.album_type ?? '').toLowerCase();
                return t === 'single' || t === 'ep';
              })
              .sort(byNewest);
            // Horizontal carousel per section (Apple-Music style): all releases
            // sit in one scrollable row instead of a paged grid. A › chevron
            // opens the full grid (show-all page) once the row overflows.
            const section = (
              label: string,
              items: SearchAlbumResult[],
              key: ShowAllSection,
            ) => {
              if (items.length === 0) return null;
              return (
                <div>
                  <SectionHeader
                    label={label}
                    onShowAll={
                      onShowAll && items.length > 4
                        ? // Seed with the FULL discography (the show-all
                          // re-splits it into albums vs singles), not `items`.
                          () => onShowAll(key, albums ? { albums } : undefined)
                        : undefined
                    }
                  />
                  <AlbumGrid
                    albums={items}
                    onOpen={onPickAlbum}
                    onPlay={(a) => playAlbumCard(a, token, onPlay)}
                    subtitleMode="discography"
                    layout="row"
                    activeAlbumName={currentAlbumName}
                    isPlaying={isPlaying}
                    onToggle={onTogglePlay}
                  />
                </div>
              );
            };
            return (
              <>
                {section('Albums', albumsOnly, 'albums')}
                {section('Singles & EPs', singlesOnly, 'singles')}
              </>
            );
          })()
        )}

        {/* Artist Playlists — catalog playlists surfacing this artist (Apple's
            rail, minus the editorial branding). */}
        {onPickPlaylist && artistPlaylists.length > 0 ? (
          <div>
            <SectionHeader label="Artist Playlists" />
            <PlaylistGrid
              playlists={artistPlaylists}
              onOpen={onPickPlaylist}
              layout="row"
            />
          </div>
        ) : null}

        {/* Appears On — albums by other artists featuring this one. */}
        {appearsOn.length > 0 ? (
          <div>
            <SectionHeader label="Appears On" />
            <AlbumGrid
              albums={appearsOn}
              onOpen={onPickAlbum}
              onPlay={(a) => playAlbumCard(a, token, onPlay)}
              layout="row"
            />
          </div>
        ) : null}

        {/* The page's closing stretch, Apple's shape: the blurb reads down the
            left with the facts beside it as a sidebar, and "Fans also like"
            shares the same ground. Not a card — a card would be the only boxed
            thing on a page of plain rows. Just a change of shade behind a
            hairline, running to both edges at every width (escaping the
            column's px-4). */}
        {bio || (related && related.length > 0) ? (
          <div
            className={cn(
              'mt-2 flex flex-col gap-8 border-t border-white/[0.06] bg-neutral-900 pt-6 pb-10',
              // Reach every edge. -mx-4 escapes this column's px-4; the bottom
              // has to swallow the column's pb-4 AND, on the desktop page,
              // ModalShell's own pb-6 wrapper outside it — 40px in total. Miss
              // that second one and the shade stops short, leaving a dark strip
              // under it. The phone's sheet has no such wrapper, so it only
              // needs the 16.
              '-mx-4 px-4 sm:px-6',
              inline ? '-mb-10' : '-mb-4',
            )}
          >
            {bio ? (
              <div className="flex flex-col gap-6 sm:flex-row sm:gap-12">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold tracking-tight">
                    About {artist.name}
                  </h2>
                  {/* Clamped, with MORE opening it in place. The Wikipedia
                      link belongs to the opened state: it is where you go when
                      the blurb was not enough, so it appears once you have
                      asked for more (or when the bio is short enough that
                      there was never anything to open). */}
                  <p
                    className={cn(
                      'mt-3 max-w-2xl text-[15px] leading-relaxed text-neutral-300 whitespace-pre-line',
                      !bioExpanded && 'line-clamp-4',
                    )}
                  >
                    {bio.extract}
                  </p>
                  <div className="mt-2 flex items-center gap-5">
                    {bio.extract.length > 220 ? (
                      <button
                        type="button"
                        onClick={() => setBioExpanded((v) => !v)}
                        className="text-[13px] font-semibold tracking-wide text-neutral-200 hover:text-white"
                      >
                        {bioExpanded ? 'LESS' : 'MORE'}
                      </button>
                    ) : null}
                    {bio.url && (bioExpanded || bio.extract.length <= 220) ? (
                      <a
                        href={bio.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-neutral-400 hover:text-white underline underline-offset-2"
                      >
                        Read more on Wikipedia →
                      </a>
                    ) : null}
                  </div>
                </div>
                {/* The facts, stacked in their own column beside the prose.
                    As a row under the bio they were four values of wildly
                    different widths pretending to be columns; as a sidebar
                    they are a short list that ends where it ends. */}
                {bio.from || bio.born || bio.genre ? (
                  <div className="flex shrink-0 flex-col gap-4 sm:w-60">
                    {bio.from ? (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                          From
                        </div>
                        <div className="mt-1 text-[15px] text-neutral-100">
                          {bio.from}
                        </div>
                      </div>
                    ) : null}
                    {bio.born ? (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                          Born
                        </div>
                        <div className="mt-1 text-[15px] text-neutral-100">
                          {bio.born}
                        </div>
                      </div>
                    ) : null}
                    {bio.genre ? (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                          Genre
                        </div>
                        <div className="mt-1 text-[15px] text-neutral-100">
                          {bio.genre}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {related && related.length > 0 ? (
              <div>
                <SectionHeader
                  label="Fans also like"
                  onShowAll={
                    onShowAll && related.length > 5
                      ? () => onShowAll('related', { related })
                      : undefined
                  }
                />
                <ArtistGrid
                  artists={related}
                  onOpen={onPickArtist}
                  onPlay={(a) => playArtistCard(a, token, onPlay)}
                  layout="row"
                  showKind={false}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {heroMenu ? (
        <ContextMenu state={heroMenu} onClose={() => setHeroMenu(null)} />
      ) : null}
    </ModalShell>
  );
}


/** A single catalog-playlist card — square cover + title + creator/count.
 *  Shared by the wrapping `PlaylistGrid` and the horizontal "shelf" carousel
 *  on the Browse page, so both render identically. `className` lets the
 *  carousel pin a fixed width (`w-44 shrink-0`) while the grid stays fluid. */
export function PlaylistCard({
  playlist: p,
  onOpen,
  onPlay,
  active = false,
  isPlaying = false,
  onToggle,
  className,
}: {
  playlist: CatalogPlaylistSummary;
  onOpen: (p: CatalogPlaylistSummary) => void;
  /** Hover play affordance — seeds the queue from the playlist's tracks without
   *  opening the drill-in first (matches the album/song cards). Omit to hide. */
  onPlay?: () => void;
  /** This playlist is the active playback source → persistent play/pause that
   *  reflects `isPlaying` and toggles via `onToggle` (Spotify-style). */
  active?: boolean;
  isPlaying?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  return (
    // A div (role=button), not a <button>, so the CardPlayButton (a real
    // <button>) can nest validly — same as AlbumCard/TrackCard.
    // Block layout (not flex-col) + min-w-0 so the fixed card width bounds the
    // title's Marquee clip box — matching AlbumCard. Under flex-col the text
    // column sized to the (nowrap) title's content width, so long titles
    // escaped the card and overlapped neighbours instead of clipping/scrolling.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(p)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(p);
        }
      }}
      className={cn(
        'group relative block min-w-0 cursor-pointer text-left transition active:scale-[0.98]',
        className,
      )}
    >
      {/* Hover halo — even inset + softer radius so it floats like the album
          cards' hover, not a tight box flush to the card's top/bottom edges. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-3 rounded-2xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative isolate aspect-square w-full rounded-lg overflow-hidden bg-neutral-800 ring-1 ring-white/5 grid place-items-center">
        {p.cover_url ? (
          <img
            src={coverSrc(p.cover_url)}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
          />
        ) : (
          <span className="text-4xl text-neutral-600">♪</span>
        )}
        {/* Hover play — the primary affordance when you mouse over the cover. */}
        {onPlay ? (
          <CardPlayButton
            label={`Play ${p.title}`}
            onPlay={active && onToggle ? onToggle : onPlay}
            persistent={active}
            playing={isPlaying}
            className="z-20"
          />
        ) : null}
      </div>
      <div className="relative mt-2 min-w-0">
        {/* Match the album cards' title treatment (Marquee: soft right-edge
            fade on overflow + slide-on-hover, normal weight) so Deezer
            playlists read the same as the regular albums/playlists rather than
            a harsher bold hard-clip. */}
        <Marquee text={p.title} className="text-sm" />
        {/* One muted line — the creator when we have it, else nothing. The word
            "Playlist" and the song count are noise in a shelf of playlists. */}
        {p.creator ? (
          <div className="truncate text-xs text-neutral-500">{p.creator}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Grid of catalog (Deezer) playlist cards — the "Popular [genre]
 *  playlists" row on the genre Browse page. Tapping one drills into its
 *  tracklist (PlaylistDetailModal). Square cover + title + creator/count. */
export function PlaylistGrid({
  playlists,
  onOpen,
  layout = 'grid',
}: {
  playlists: CatalogPlaylistSummary[];
  onOpen: (p: CatalogPlaylistSummary) => void;
  /** 'grid' = wrapping grid; 'row' = horizontal scroller (genre-page carousel,
   *  matching AlbumGrid/ArtistGrid). */
  layout?: 'grid' | 'row';
}) {
  if (playlists.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No playlists found.</div>
    );
  }
  if (layout === 'row') {
    // Mirror AlbumGrid's row layout exactly so PlaylistCard's -inset-3 hover
    // halo has vertical room (py-4 + overflow-y-clip inside a -my-4 wrapper),
    // with mt-4 on the arrow alignment to re-center on the padded cover.
    return (
      <div className="-my-4">
        <ShelfRow
          artClass="mt-4 h-40 sm:h-44"
          scrollerClassName="flex gap-3 overflow-x-auto overflow-y-clip overscroll-x-contain py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {playlists.map((p) => (
            <PlaylistCard
              key={`${p.source}:${p.source_id}`}
              playlist={p}
              onOpen={onOpen}
              className="w-40 sm:w-44 shrink-0"
            />
          ))}
        </ShelfRow>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {playlists.map((p) => (
        <PlaylistCard
          key={`${p.source}:${p.source_id}`}
          playlist={p}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/**
 * Drill-in for a catalog (Deezer) playlist surfaced on the genre Browse
 * page. Mirrors AlbumDetailModal: a playlist-header hero, an "Add all to
 * library" button (imports as a plain playlist), then the tracklist with
 * preview + per-track add-to-playlist. Tracks come pre-annotated with
 * library state, so ✓ marks render immediately.
 */
export function PlaylistDetailModal({
  token,
  playlist,
  onClose,
  onPickTrack,
  onPlay,
  playingPreviewUrl,
  onTogglePreview,
  inline,
  activeProfileId,
  onShowTrackMenu,
  onShowTrackSheet,
  onQueueTrack,
  onSaveTrack,
  onGoToArtist,
  onGoToAlbum,
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
  pin,
}: {
  token: string;
  playlist: CatalogPlaylistSummary;
  onClose: () => void;
  onPickTrack: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  inline?: boolean;
  activeProfileId?: number | null;
  /** Desktop per-song "⋯" menu — forwarded straight to the shared page. */
  onShowTrackMenu?: (t: SearchTrackResult, x: number, y: number) => void;
  /** Phone per-song "⋯" bottom sheet — forwarded straight to the shared page. */
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  /** Phone swipe-to-queue / swipe-to-save — forwarded straight to the page. */
  onQueueTrack?: (t: SearchTrackResult) => void;
  onSaveTrack?: (t: SearchTrackResult) => void;
  /** Clickable artist / Album names in the tracklist — forwarded to the page. */
  onGoToArtist?: (name: string) => void;
  onGoToAlbum?: (name: string, artist: string | null) => void;
  /** Now-playing awareness (desktop): equalizer bars on the current row + a
   *  ⏸/▶ hero that toggles playback. Forwarded straight to the shared page. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Desktop "Pin to sidebar" — forwarded to the shared album-page header. */
  pin?: SidebarPinController;
}) {
  const [detail, setDetail] = useState<CatalogPlaylist | null>(null);
  // Id of an existing library playlist that already matches this catalog
  // playlist (by name). Imports don't record the catalog source id, so name is
  // the only link we have — and it also covers copies imported before this
  // check existed. When set, the page shows "In your library" ✓ instead of the
  // "+" importer, so a playlist you've already added no longer reads as missing
  // (or invites a silent duplicate).
  const [savedCopyId, setSavedCopyId] = useState<number | null>(null);

  // Re-fetch on a library change elsewhere. This page wraps AlbumDetailModal with
  // `disableFetch`, so the shared page WON'T refresh itself — the fresh tracklist
  // (with updated per-track ✓) and the "in your library" ✓ have to come from
  // re-fetching here. (The picker floats over this still-mounted page.)
  const libTick = useLibraryChangeTick();

  // Pull the full tracklist for this catalog playlist. The shared page below
  // renders its hero immediately (from the summary) and shows "Loading tracks…"
  // until this resolves.
  useEffect(() => {
    let cancelled = false;
    getCatalogPlaylist(playlist.source_id, token)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        /* leave the tracklist empty; the header still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [playlist.source_id, token, libTick]);

  // Detect an already-imported copy by name (case-insensitive, trimmed). A
  // best-effort library read; a failure just leaves the importer showing.
  useEffect(() => {
    let cancelled = false;
    const want = playlist.title.trim().toLowerCase();
    listPlaylists(token, activeProfileId)
      .then((rows) => {
        if (cancelled) return;
        const hit = rows.find((r) => r.name.trim().toLowerCase() === want);
        setSavedCopyId(hit?.id ?? null);
      })
      .catch(() => {
        /* leave savedCopyId null — importer stays available */
      });
    return () => {
      cancelled = true;
    };
  }, [playlist.title, token, activeProfileId, libTick]);

  const tracks = detail?.tracks ?? null;
  const cover = detail?.cover_url ?? playlist.cover_url;
  const creator = detail?.creator ?? playlist.creator;

  // A catalog playlist renders through the SAME page as albums and library
  // albums (AlbumDetailModal) — one Spotify-style surface with the sticky
  // header, per-song ⋯ menu, and preview/play. It stays read-only: in place of
  // the album +/✓ it shows "Add all to library" (imports as a playlist);
  // renaming/reordering only exist once it's in your own library. Modeled as a
  // synthetic album whose "artist" is the creator, so the hero reads
  // "Playlist · {creator} · N songs".
  const synthetic: SearchAlbumResult = {
    source: playlist.source,
    source_id: playlist.source_id,
    name: playlist.title,
    artists: creator ? [creator] : [],
    cover_url: cover,
    album_type: 'playlist',
    release_date: null,
    total_tracks: playlist.track_count,
  };

  const handleImport = async () => {
    if (!tracks || tracks.length === 0) return;
    const r = await importPlaylist(playlist.title, tracks, token, activeProfileId);
    // Remember the new id so the just-saved ✓ is immediately removable.
    setSavedCopyId(r.playlist_id);
  };

  return (
    <AlbumDetailModal
      token={token}
      album={synthetic}
      presetTracks={tracks ?? undefined}
      disableFetch
      kindLabel="Playlist"
      importLabel="Add all to library"
      onImport={handleImport}
      savedCopyId={savedCopyId}
      onClose={onClose}
      onPickTrack={onPickTrack}
      onPlay={onPlay}
      onShowTrackMenu={onShowTrackMenu}
      onShowTrackSheet={onShowTrackSheet}
      onQueueTrack={onQueueTrack}
      onSaveTrack={onSaveTrack}
      onGoToArtist={onGoToArtist}
      onGoToAlbum={onGoToAlbum}
      isTrackCurrent={isTrackCurrent}
      isPlaying={isPlaying}
      onTogglePlay={onTogglePlay}
      playingPreviewUrl={playingPreviewUrl}
      onTogglePreview={onTogglePreview}
      inline={inline}
      activeProfileId={activeProfileId}
      pin={pin}
    />
  );
}

/** A "Made for you" mix (artist / genre / decade) rendered through the SAME
 *  album/playlist page as everything else. A mix is EPHEMERAL feed data — no
 *  catalog id to fetch — so its tracks come straight from the Home payload
 *  (`presetTracks`, `disableFetch`). It spans many albums, so it uses the
 *  playlist-style rows + a collage hero, and hides the +/✓ (there's no album to
 *  add). */
export function MixDetailModal({
  token,
  mix,
  onClose,
  onPickTrack,
  onPlay,
  playingPreviewUrl,
  onTogglePreview,
  inline,
  activeProfileId,
  onShowTrackMenu,
  onShowTrackSheet,
  onQueueTrack,
  onSaveTrack,
  onGoToArtist,
  onGoToAlbum,
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
  pin,
}: {
  token: string;
  mix: { title: string; eyebrow?: string | null; tracks: SearchTrackResult[] };
  onClose: () => void;
  onPickTrack: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  inline?: boolean;
  activeProfileId?: number | null;
  onShowTrackMenu?: (t: SearchTrackResult, x: number, y: number) => void;
  onShowTrackSheet?: (t: SearchTrackResult) => void;
  onQueueTrack?: (t: SearchTrackResult) => void;
  onSaveTrack?: (t: SearchTrackResult) => void;
  onGoToArtist?: (name: string) => void;
  onGoToAlbum?: (name: string, artist: string | null) => void;
  /** Now-playing awareness (desktop), same as the library playlist page:
   *  equalizer bars + row highlight on the current track, and a ⏸/▶ hero that
   *  toggles playback instead of restarting. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  /** Desktop "Pin to sidebar" — forwarded to the shared album-page header. */
  pin?: SidebarPinController;
}) {
  const coverUrls = mix.tracks
    .map((t) => t.album_art_url)
    .filter((u): u is string => !!u)
    .slice(0, 8); // CollageCover dedupes and takes the first 4 distinct
  const synthetic: SearchAlbumResult = {
    source: 'mix',
    source_id: mix.title,
    name: mix.title,
    artists: [],
    cover_url: coverUrls[0] ?? null,
    album_type: 'mix',
    release_date: null,
    total_tracks: mix.tracks.length,
  };

  // A mix can be SAVED to the library (imported as a snapshot playlist), same
  // as a catalog playlist — the hero +/✓ then doubles as save / remove. Detect
  // an existing copy by name so a re-open shows ✓ instead of offering a dup.
  // Re-fetch on a library change so saving/removing the mix elsewhere keeps this
  // ✓ honest. (The per-track "in a playlist" ✓ can't refresh — a mix is ephemeral
  // Home-payload data with no catalog id to re-query; only a re-open rebuilds it.)
  const libTick = useLibraryChangeTick();
  const [savedCopyId, setSavedCopyId] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const want = mix.title.trim().toLowerCase();
    listPlaylists(token, activeProfileId)
      .then((rows) => {
        if (cancelled) return;
        setSavedCopyId(
          rows.find((r) => r.name.trim().toLowerCase() === want)?.id ?? null,
        );
      })
      .catch(() => {
        /* leave null — importer stays available */
      });
    return () => {
      cancelled = true;
    };
  }, [mix.title, token, activeProfileId, libTick]);
  const handleImport = async () => {
    if (mix.tracks.length === 0) return;
    const r = await importPlaylist(mix.title, mix.tracks, token, activeProfileId);
    // Remember the new id so the just-saved ✓ is immediately removable.
    setSavedCopyId(r.playlist_id);
  };

  return (
    <AlbumDetailModal
      token={token}
      album={synthetic}
      presetTracks={mix.tracks}
      disableFetch
      playlistStyle
      // Save/remove the mix as a snapshot playlist — the hero +/✓ (import when
      // new, a click-to-remove ✓ once saved), same as the catalog playlist page.
      importLabel="Add all to library"
      onImport={handleImport}
      savedCopyId={savedCopyId}
      coverUrls={coverUrls}
      kindLabel="Mix"
      onClose={onClose}
      onPickTrack={onPickTrack}
      onPlay={onPlay}
      onShowTrackMenu={onShowTrackMenu}
      onShowTrackSheet={onShowTrackSheet}
      onQueueTrack={onQueueTrack}
      onSaveTrack={onSaveTrack}
      onGoToArtist={onGoToArtist}
      onGoToAlbum={onGoToAlbum}
      isTrackCurrent={isTrackCurrent}
      isPlaying={isPlaying}
      onTogglePlay={onTogglePlay}
      playingPreviewUrl={playingPreviewUrl}
      onTogglePreview={onTogglePreview}
      inline={inline}
      activeProfileId={activeProfileId}
      pin={pin}
    />
  );
}

