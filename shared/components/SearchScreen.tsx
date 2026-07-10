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
  SCRIM,
  BOTTOM_SHEET,
  navPill,
  INPUT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CALLOUT_WARN,
  CALLOUT_ERROR,
  EYEBROW,
  EYEBROW_ON_ART,
} from '../ui';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from './ContextMenu';
import { CardPlayButton, Marquee } from './Marquee';
import { HeroWash } from './HeroWash';
import { CollageCover } from './CollageCover';
import { SwipeRow } from './SwipeRow';
import { audioStarted, registerAudioPauser } from '../audioCoordinator';
import {
  addRecentAlbum,
  addRecentArtist,
  addRecentQuery,
  addRecentTrack,
  clearRecentSearches,
  coverSrc,
  createPlaylist,
  getAlbumTracks,
  getArtistAlbums,
  getArtistBio,
  getArtistRelated,
  getArtistTopTracks,
  canPlayNow,
  deletePlaylist,
  friendlyError,
  getCatalogPlaylist,
  getRecentItems,
  getStats,
  importAlbum,
  importPlaylist,
  isHubReachable,
  isPlayable,
  listPlaylists,
  onHubReachability,
  patchTrackPlaylists,
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
} from '../api';
import { useHubReachable } from '../useHubReachable';
import { formatDuration } from '../format';
import { CondensedHeaderBar, useCondensedHeader } from './StickyHeader';
import { EqualizerBars } from './EqualizerBars';

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
   * Called when the user backs out of an artist/album page that was opened via
   * `openRequest` (i.e. from elsewhere in the app, like Home or the player bar)
   * rather than from a search the user typed here. Lets the host return to the
   * originating view instead of stranding the user on the bare Search screen.
   * Desktop-only; the phone leaves it undefined (its modals just close).
   */
  onExitDetail?: () => void;
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
   * Reports whether the overlay is currently showing anything (a committed
   * search, a detail page, or a pending open). Lets the host decide whether the
   * Back arrow should unwind the overlay or pop its own view history.
   */
  onOverlayActiveChange?: (active: boolean) => void;
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
  /** Desktop-only sidebar-pin controls, injected by the host. Omitted on the
   *  phone (no pinned sidebar) → the artist/album pages render no Pin button. */
  pin?: SidebarPinController;
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

/** Desktop-only sidebar-pin controls. Kept primitive so this shared file needn't
 *  import the desktop pin store; the host maps these to its `usePinStore`. */
export interface SidebarPinController {
  isArtistPinned: (key: string) => boolean;
  toggleArtist: (a: { key: string; name: string; art: string | null }) => void;
  isAlbumPinned: (album: string, artist: string | null) => boolean;
  toggleAlbum: (a: { album: string; artist: string | null; art: string | null }) => void;
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
 * The add operation is local-only on the host -- additions get a
 * `locally_added=1` flag so they survive future Spotify syncs.
 */
export function SearchScreen({
  token,
  onPlayTrack,
  pageMode,
  desktop,
  openRequest,
  onRequestHandled,
  resetSignal,
  activeProfileId,
  onExitDetail,
  barSlot,
  overlayMode,
  restore,
  onOverlayActiveChange,
  onOverlayPush,
  onOverlayBack,
  onSearchFocus,
  onOpenBrowse,
  pin,
  onAlbumGoToArtist,
  onAlbumAddToQueue,
  onAlbumSaveToLiked,
  onAlbumGoToAlbum,
  onShowTrackSheet,
  isTrackCurrent,
  isNowPlaying,
  onTogglePlay,
}: Props) {
  // Re-render this screen (and its inline handlers) when the hub drops/returns,
  // so canPlayNow gating in replayRecentTrack / applySuggestion stays live.
  useHubReachable();
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
      closeDropdown();
    },
    [stopPreview, closeDropdown],
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
      setMenu({ x, y, items });
    },
    [onAlbumSaveToLiked, onAlbumAddToQueue, onAlbumGoToArtist],
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
        // drop low-quality lookalike/tribute profiles, then drop artists that
        // only matched the query by typo distance.
        const cleaned = {
          ...r,
          artists: dropWeakArtistMatches(
            dropLookalikeArtists(dedupeArtists(r.artists)),
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
  }, [debounced, token]);

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
          const want = openRequest.name.trim().toLowerCase();
          const hit =
            r.artists.find((a) => a.name.trim().toLowerCase() === want) ??
            r.artists[0];
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
    } else {
      setQuery(snap.query);
      setDebounced(snap.query);
      setCommittedQuery(snap.query);
      setOpenArtist(snap.artist);
      setOpenAlbum(snap.album);
      setOpenPlaylist(snap.playlist ?? null);
      setOpenShowAll(snap.showAll ?? null);
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

  // Whether the overlay surface is showing anything. Reported up so the host's
  // Back arrow knows whether to unwind the overlay vs pop its view history.
  const overlayActive =
    !!committedQuery.trim() ||
    !!openArtist ||
    !!openAlbum ||
    !!openPlaylist ||
    navPending ||
    !!openRequest;
  useEffect(() => {
    onOverlayActiveChange?.(overlayActive);
  }, [overlayActive, onOverlayActiveChange]);

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

  // Overlay mode: the search surface floats over the main area and is shown
  // only when `overlayActive` (computed above). Idle ⇒ nothing, so the
  // underlying view shows through; the portaled top-bar input stays visible.
  return (
    <div
      className={
        overlayMode
          ? overlayActive
            ? showingPage
              ? // A drill-in page (artist/album) has a full-bleed hero, so it
                // owns its edges + top clearance — no container padding.
                'absolute inset-0 z-20 overflow-y-auto bg-neutral-950 pb-6'
              : 'absolute inset-0 z-20 overflow-y-auto bg-neutral-950 px-4 pt-6 pb-6'
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
        {!overlayMode && !showingPage && !navPending && (
          <h1 className="text-xl font-bold tracking-tight mb-3 px-1">Search</h1>
        )}
        {(overlayMode || (!showingPage && !navPending)) && (
      <div className="px-1 mb-3">
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
            // Phone: search is a screen you open, so focus it. Desktop: the bar
            // lives in the persistent top bar — don't grab focus (and pop the
            // recents dropdown) every time the app launches.
            autoFocus={!overlayMode}
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

      {!query.trim() && (
        <div className="px-1 pt-2">
          {/* Browse-by-genre tiles — a discovery launcher for the empty state,
              Spotify's "Browse all" idea adapted to our catalog search.
              (Recent searches live in the focus-state dropdown above the bar.) */}
          <div className="px-1">
            <h2 className={cn(EYEBROW, 'mb-2')}>
              Browse
            </h2>
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
      )}

      {showResultsPage && loading && !pageResults && (
        <div className="px-2 pt-2 text-sm text-neutral-500">Searching…</div>
      )}

      {pageResults && tab === 'all' && (
        <FederatedResults
          token={token}
          query={committedQuery}
          results={pageResults}
          played={played}
          onAdd={(t) => setPickerTrack(t)}
          onPlay={playTrack}
          onOpenArtist={openArtistPage}
          onOpenAlbum={openAlbumPage}
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
      {/* Playlists: a labeled shelf under the "All" results, or the full grid
          on its own tab. Tapping one opens the shared playlist page. */}
      {pageResults &&
        tab === 'all' &&
        (pageResults.playlists?.length ?? 0) > 0 && (
          <div className="mt-2">
            <div className={cn(EYEBROW, 'px-1 mb-2')}>
              Playlists
            </div>
            <PlaylistGrid
              playlists={pageResults.playlists ?? []}
              onOpen={openPlaylistPage}
            />
          </div>
        )}
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
                  // Backing out of a detail opened from elsewhere (no active
                  // search) returns to its origin view, not the bare Search.
                  if (!committedQuery.trim()) onExitDetail?.();
                }
          }
          onPickAlbum={(a) => setOpenAlbum(a)}
          onPickTrack={(t) => setPickerTrack(t)}
          onPlay={onPlayTrack}
          onPickArtist={(a) => {
            stopPreview();
            setOpenShowAll(null);
            setOpenArtist(a);
          }}
          onShowAll={(section) => setOpenShowAll(section)}
          // Phone: a show-all grid (or an album) can stack over this still-mounted
          // page; only the topmost layer should close on a single Escape.
          escapeActive={!openShowAll && !openAlbum}
          // Desktop now-playing: ⏸/▶ hero + sticky Play, highlighted current
          // Top-Songs row, persistent play on the playing album's card.
          isTrackCurrent={pageMode ? isTrackCurrent : undefined}
          isPlaying={pageMode ? isNowPlaying : undefined}
          onTogglePlay={pageMode ? onTogglePlay : undefined}
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
                  // No artist page underneath + no active search → return to the
                  // origin view; otherwise reveal the artist/results beneath.
                  if (!openArtist && !committedQuery.trim()) onExitDetail?.();
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
          // Desktop now-playing: highlight + equalizer on the current row, ⏸/▶
          // hero + sticky Play button (host wires it from its player store).
          isTrackCurrent={pageMode ? isTrackCurrent : undefined}
          isPlaying={pageMode ? isNowPlaying : undefined}
          onTogglePlay={pageMode ? onTogglePlay : undefined}
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
          onClose={
            overlayMode
              ? () => onOverlayBack?.()
              : () => {
                  stopPreview();
                  setOpenPlaylist(null);
                  // Nothing underneath + no active search → return to origin.
                  if (!committedQuery.trim()) onExitDetail?.();
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
          // Desktop now-playing: equalizer bars on the current row + a ⏸/▶ hero
          // that toggles (matching the album + library playlist pages). Desktop
          // only — the phone host doesn't wire these.
          isTrackCurrent={pageMode ? isTrackCurrent : undefined}
          isPlaying={pageMode ? isNowPlaying : undefined}
          onTogglePlay={pageMode ? onTogglePlay : undefined}
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

// Deezer preview clips are 30 seconds; the depleting ring runs for the
// same fixed duration. If a clip is a hair shorter, the audio `ended`
// event clears the ring, so the two stay visually in sync.
const PREVIEW_SECONDS = 30;

// Injected once by SearchScreen. Drives the Shazam-style countdown ring:
// stroke-dashoffset sweeps from 0 (full ring) to the circle's
// circumference (empty), so the arc visibly depletes as the clip plays.
// The circumference is read from a per-ring CSS custom property so one
// rule works for any ring size.
export const PREVIEW_RING_KEYFRAMES = `
@keyframes beetbot-preview-ring {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: var(--bb-ring-c); }
}
@keyframes beetbot-page-enter {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}`;

/**
 * Shazam-style countdown ring: a faint full circle with a brighter arc
 * on top that depletes over PREVIEW_SECONDS via the CSS keyframe above.
 * Pure CSS so it animates on the compositor — no per-frame React state,
 * even with a full page of results. Absolutely positioned to overlay
 * whatever it's dropped into (album art, a track-number badge).
 */
export function PreviewRing({
  size,
  strokeWidth = 3,
}: {
  size: number;
  strokeWidth?: number;
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0 m-auto -rotate-90 pointer-events-none"
      aria-hidden
    >
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="#34d399"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        style={{
          strokeDasharray: c,
          // Consumed by the keyframe's `to` value.
          ['--bb-ring-c' as string]: String(c),
          animation: `beetbot-preview-ring ${PREVIEW_SECONDS}s linear forwards`,
        }}
      />
    </svg>
  );
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
  showHoverPlay = true,
}: {
  artUrl: string | null;
  /** 30s preview auditioning this row → pause glyph + depleting ring. */
  playing: boolean;
  /** This row is the actual now-playing track (audible) → equalizer bars. */
  nowPlaying?: boolean;
  /** Show the ▶ hover overlay on the cover. Off when the row's # gutter carries
   *  the play/now-playing indicator instead (genre pages match the playlist). */
  showHoverPlay?: boolean;
}) {
  return (
    <div className="relative h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800">
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
      {playing ? <PreviewRing size={44} strokeWidth={3} /> : null}
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

/** Small grey "E" badge for explicit tracks (Spotify-style). */
function ExplicitBadge() {
  return (
    <span
      className="shrink-0 inline-grid place-items-center h-[15px] min-w-[15px] px-[3px] rounded-[3px] bg-neutral-700 text-neutral-300 text-[9px] font-bold leading-none"
      title="Explicit"
      aria-label="Explicit"
    >
      E
    </span>
  );
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
}: {
  item: RecentItem;
  playingPreviewUrl: string | null;
  onQuery: (text: string) => void;
  onTrack: (t: SearchTrackResult) => void;
  onArtist: (a: SearchArtistResult) => void;
  onAlbum: (a: SearchAlbumResult) => void;
}) {
  const rowCls =
    'w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-neutral-800 active:bg-neutral-800 text-left';
  if (item.kind === 'query') {
    return (
      <button type="button" onClick={() => onQuery(item.text)} className={rowCls}>
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
      </button>
    );
  }
  if (item.kind === 'track') {
    const t = item.track;
    const previewing = !!t.preview_url && playingPreviewUrl === t.preview_url;
    return (
      <button type="button" onClick={() => onTrack(t)} className={rowCls}>
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
      </button>
    );
  }
  if (item.kind === 'artist') {
    const a = item.artist;
    return (
      <button type="button" onClick={() => onArtist(a)} className={rowCls}>
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
      </button>
    );
  }
  const a = item.album;
  return (
    <button type="button" onClick={() => onAlbum(a)} className={rowCls}>
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
    </button>
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
        <RowChevron />
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
      <RowChevron />
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
  ...handlers
}: {
  token: string;
  query: string;
  results: SearchResults;
  played?: ReadonlyMap<string, number>;
} & FederatedHandlers) {
  const queryNorm = normalizeForMatch(query);
  const { top, rest } = useMemo(
    () => buildFederated(results, queryNorm, played),
    [results, queryNorm, played],
  );
  if (!top) {
    return <div className="px-2 pt-3 text-sm text-neutral-500">No results.</div>;
  }
  return (
    <div className="flex flex-col gap-5">
      <TopResultCard token={token} item={top} {...handlers} />
      {rest.length > 0 && (
        <div>
          <div className={cn(EYEBROW, 'px-1 mb-1')}>
            Results
          </div>
          <ul className="px-1 divide-y divide-white/5">
            {rest.map((it) => (
              <FederatedRow key={federatedKey(it)} item={it} {...handlers} />
            ))}
          </ul>
        </div>
      )}
    </div>
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
}: {
  tracks: SearchTrackResult[];
  onAdd: (t: SearchTrackResult) => void;
  // Passes the whole list + this row's index so the host seeds the play queue
  // from here and auto-advances down the list.
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  playingPreviewUrl: string | null;
  onTogglePreview: (url: string) => void;
  /** Now-playing (desktop): the current row highlights + shows equalizer bars
   *  over its cover, matching the playlist/album track rows. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isNowPlaying?: boolean;
  /** Desktop: open the per-song "⋯" overflow menu at a screen point. When set,
   *  each row shows a hover ⋯ (with "Add to playlist" etc.) INSTEAD of the bare
   *  + button, plus a small "in a playlist" ✓ next to Time — matching the album
   *  page. When absent, the row keeps the simple hover +. */
  onShowMenu?: (t: SearchTrackResult, x: number, y: number) => void;
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
    <div className="px-1">
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
      <ul className="divide-y divide-white/5 md:divide-y-0">
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
            className={`group flex items-center gap-3 min-w-0 px-2 py-2.5 md:grid ${cols} md:items-center md:gap-3 md:py-1.5 md:rounded-lg transition-colors ${
              current ? 'bg-neutral-800/40' : ''
            } ${interactive ? 'md:hover:bg-neutral-800/40' : 'opacity-60'}`}
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
                // Menu mode (genre): the # gutter shows the now-playing / hover
                // indicator, so the cover stays plain art — matching the playlist.
                nowPlaying={!hasMenu && current && !!isNowPlaying}
                showHoverPlay={!hasMenu}
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm ${
                    hasMenu ? 'md:text-base' : ''
                  } font-medium truncate ${current ? 'text-white' : ''}`}
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
              } text-neutral-600 tabular-nums w-10 md:w-auto text-right shrink-0`}
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

/** "55 min" / "1 hr 30 min" from a total milliseconds. */
function albumDurationLabel(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} hr ${m} min`;
}

/** Format a Deezer release_date ("YYYY-MM-DD", sometimes just a year) as a
 *  human "Month D, YYYY" — Spotify shows this under the album tracklist.
 *  Parses the parts directly to avoid a UTC-midnight timezone shift. */
function formatReleaseDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(iso.trim());
  if (!m) return '';
  const [, y, mo, d] = m;
  if (!mo || !d) return y; // year-only
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = MONTHS[Number(mo) - 1];
  if (!month) return y;
  return `${month} ${Number(d)}, ${y}`;
}

/** Pretty label for a Deezer `record_type`. */
function albumTypeLabel(t: string | null): string {
  switch ((t ?? '').toLowerCase()) {
    case 'album':
      return 'Album';
    case 'single':
      return 'Single';
    case 'ep':
      return 'EP';
    case 'compile':
      return 'Compilation';
    default:
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }
}

/** Card play buttons: fetch a collection's tracks and start playback from the
 *  first one, so a hovered album/artist card plays without opening its page.
 *  Shared by the search results, the "fans also like" shelf, and the artist /
 *  album detail surfaces. Declared at module scope so callers can pass a bound
 *  `onPlay` inline; failures leave the card untouched. */
export async function playAlbumCard(
  album: SearchAlbumResult,
  token: string,
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void,
) {
  try {
    const list = await getAlbumTracks(album.source_id, token);
    if (list.length) onPlay(list[0], list, 0);
  } catch {
    /* leave the card as-is on failure */
  }
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

export function AlbumGrid({
  albums,
  onOpen,
  onPlay,
  subtitleMode = 'default',
  layout = 'grid',
  activeAlbumName,
  isPlaying,
  onToggle,
}: {
  albums: SearchAlbumResult[];
  onOpen: (a: SearchAlbumResult) => void;
  /** When set, a white play button lifts in on the cover and plays the album
   *  (the card click still opens it) — the Home-card affordance. */
  onPlay?: (a: SearchAlbumResult) => void;
  /**
   * 'default'      → "Artist · 2016" (search / browse, where the artist
   *                  is useful context).
   * 'discography'  → "2016 • Album" (an artist's own page, where the
   *                  artist is redundant — Spotify-style).
   */
  subtitleMode?: 'default' | 'discography';
  /** 'grid' = wrapping grid (search/browse); 'row' = a single horizontal
   *  scroller (Apple-Music artist-page carousels). */
  layout?: 'grid' | 'row';
  /** Now-playing (desktop): the card whose album name matches shows a
   *  persistent play/pause button (Spotify-style), like the Home cards. */
  activeAlbumName?: string | null;
  isPlaying?: boolean;
  onToggle?: () => void;
}) {
  if (albums.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No albums matched.</div>
    );
  }
  const normName = (s: string) => s.trim().toLowerCase();
  const cards = albums.map((a) => {
        const year = a.release_date ? a.release_date.slice(0, 4) : '';
        const typeLabel =
          subtitleMode === 'discography' ? albumTypeLabel(a.album_type) : '';
        // This card is the active playback source → persistent play/pause.
        const albumActive =
          !!activeAlbumName && normName(a.name) === normName(activeAlbumName);
        return (
          <div
            key={`${a.source}:${a.source_id}`}
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
            className={`group relative cursor-pointer text-left transition active:scale-[0.98] ${
              layout === 'row' ? 'w-36 sm:w-40 shrink-0' : ''
            }`}
          >
            {/* Hover halo — the row carousels match the Home shelves exactly
                (generous -inset-3 rounded-2xl so the whole card lights up); the
                wrapping grid stays horizontal-only so stacked rows don't overlap
                their halos vertically. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute transition-colors duration-200 group-hover:bg-white/[0.06] ${
                layout === 'row'
                  ? '-inset-3 rounded-2xl'
                  : '-inset-x-2 inset-y-0 rounded-xl'
              }`}
            />
            <div className="relative">
              <div className="relative">
                <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
                  {a.cover_url ? (
                    <img
                      src={a.cover_url}
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
                  <CardPlayButton
                    label={`Play ${a.name}`}
                    onPlay={albumActive && onToggle ? onToggle : () => onPlay(a)}
                    persistent={albumActive}
                    playing={albumActive && !!isPlaying}
                  />
                ) : null}
              </div>
              <Marquee text={a.name} className="mt-2 text-sm font-medium" />
              <div className="truncate text-xs text-neutral-500">
                {subtitleMode === 'discography' ? (
                  <>
                    {year}
                    {year && typeLabel ? ' • ' : ''}
                    {typeLabel}
                  </>
                ) : (
                  <>
                    {a.artists.join(', ')}
                    {year ? <> · {year}</> : null}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      });
  if (layout === 'row') {
    // Mirror the Home shelves EXACTLY so the cards' -inset-3 hover halo has
    // vertical room instead of being clipped: the scroller keeps py-4 +
    // overflow-y-clip (clips without becoming a scroll container → arrows still
    // work, no stray vertical scroll), and the -my-4 sits on THIS outer wrapper,
    // never the scroller (a negative margin there collapses ShelfRow's arrow
    // box). The arrows' artClass gains mt-4 to re-center on the padded cover.
    return (
      <div className="-my-4">
        <ShelfRow
          artClass="mt-4 h-36 sm:h-40"
          scrollerClassName="flex gap-3 overflow-x-auto overflow-y-clip overscroll-x-contain py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {cards}
        </ShelfRow>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {cards}
    </div>
  );
}

/** A single artist card — circular avatar + name + "Artist · N albums".
 *  Shared by the wrapping `ArtistGrid` and the horizontal artist shelf on the
 *  Browse page. `className` lets the shelf pin a fixed width (`w-36 shrink-0`)
 *  while the grid stays fluid. */
export function ArtistCard({
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
          <div className="truncate text-xs text-neutral-500">
            Artist
            {a.total_albums ? ` · ${a.total_albums} albums` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ArtistGrid({
  artists,
  onOpen,
  onPlay,
  layout = 'grid',
}: {
  artists: SearchArtistResult[];
  onOpen: (a: SearchArtistResult) => void;
  /** Threaded to each card: hover play button that plays the artist's top tracks. */
  onPlay?: (a: SearchArtistResult) => void;
  /** 'grid' = wrapping grid; 'row' = horizontal scroller (artist-page carousel). */
  layout?: 'grid' | 'row';
}) {
  if (artists.length === 0) {
    return (
      <div className="px-2 pt-3 text-sm text-neutral-500">No artists matched.</div>
    );
  }
  // Same grid breakpoints as AlbumGrid so the search results read as
  // a single visual rhythm regardless of which tab you're on.
  if (layout === 'row') {
    return (
      <ShelfRow artClass="h-28 sm:h-32">
        {artists.map((a) => (
          <div
            key={`${a.source}:${a.source_id}`}
            className="w-28 sm:w-32 shrink-0"
          >
            <ArtistCard artist={a} onOpen={onOpen} onPlay={onPlay} />
          </div>
        ))}
      </ShelfRow>
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
   *  single vertical list of every track (the Top Songs show-all page). */
  layout?: 'carousel' | 'list';
  /** Now-playing (desktop): the current row highlights + shows equalizer bars. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
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
        className={`group flex items-center gap-3 rounded-lg px-2 -mx-2 py-1.5 border-b border-white/5 transition-colors ${
          current ? 'bg-white/[0.06]' : ''
        } ${interactive ? '' : 'opacity-60'}`}
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
            // Now playing (audible): equalizer bars over the cover, always shown.
            <span className="absolute inset-0 grid place-items-center bg-black/45">
              <EqualizerBars className="text-white" />
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
            <span className={`truncate text-sm font-medium ${current ? 'text-white' : 'text-neutral-100'}`}>
              {t.title}
            </span>
            {t.explicit ? <ExplicitBadge /> : null}
          </div>
          {t.album ? (
            <div className="truncate text-xs text-neutral-500">{t.album}</div>
          ) : null}
        </button>
        {/* In a playlist → a persistent white ✓ (Spotify-style) that opens the
            add-to-playlist picker to manage; otherwise a hover-revealed +. */}
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
      </div>
    );
  };

  // Show-all page: one long vertical list of every track.
  if (layout === 'list') {
    return <div className="flex flex-col">{tracks.map((t, idx) => renderRow(t, idx))}</div>;
  }

  // Artist page: columns of three on a horizontal shelf (with hover arrows).
  const columns: SearchTrackResult[][] = [];
  for (let i = 0; i < tracks.length; i += 3) columns.push(tracks.slice(i, i + 3));
  return (
    <ShelfRow scrollerClassName="flex gap-x-6 overflow-x-auto overscroll-x-contain pb-1 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {columns.map((col, ci) => (
        <div
          key={ci}
          className="flex flex-col shrink-0 w-[86%] lg:w-[calc(50%-0.75rem)] snap-start"
        >
          {col.map((t, ri) => renderRow(t, ci * 3 + ri))}
        </div>
      ))}
    </ShelfRow>
  );
}

/** A section title with an optional show-all affordance. Apple-Music-style: the
 *  TITLE itself is the link, with a › chevron right after the words (not a
 *  separate right-aligned "Show all"), so "Albums ›" opens the full-grid page. */
function SectionHeader({
  label,
  onShowAll,
}: {
  label: string;
  onShowAll?: () => void;
}) {
  if (!onShowAll) {
    return (
      <div className="px-1 mb-2 text-lg font-bold tracking-tight">
        {label}
      </div>
    );
  }
  return (
    <div className="px-1 mb-2">
      <button
        type="button"
        onClick={onShowAll}
        aria-label={`Show all ${label}`}
        className="group/sa inline-flex items-center gap-1 text-lg font-bold tracking-tight transition hover:text-white"
      >
        {label}
        <span
          aria-hidden="true"
          className="text-base leading-none text-neutral-500 transition-transform group-hover/sa:translate-x-0.5 group-hover/sa:text-neutral-200"
        >
          ›
        </span>
      </button>
    </div>
  );
}

const SHELF_SCROLLER =
  'flex gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

/** Apple-Music-style horizontal shelf: one scrollable row with a rounded
 *  ‹ › button on each side that fades in on hover and only appears when that
 *  direction can still scroll. `artClass` is the artwork's height (e.g.
 *  "h-36 sm:h-40" for albums) so the buttons center on the artwork, not the
 *  taller card; omit it to center on the full row height. `scrollerClassName`
 *  overrides the row's flex/gap. Hidden below `sm` — touch screens swipe.
 *  Exported so the Home shelves share the exact same arrow affordance. */
export function ShelfRow({
  artClass,
  scrollerClassName = SHELF_SCROLLER,
  children,
}: {
  artClass?: string;
  scrollerClassName?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 8,
      right: Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 8,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  const arrow = (dir: 1 | -1, show: boolean) => (
    <div
      className={`pointer-events-none absolute z-10 hidden items-center sm:flex ${
        artClass ? `top-0 ${artClass}` : 'inset-y-0'
      } ${dir < 0 ? 'left-0 justify-start pl-1' : 'right-0 justify-end pr-1'}`}
    >
      <button
        type="button"
        aria-label={dir < 0 ? 'Scroll left' : 'Scroll right'}
        tabIndex={-1}
        onClick={() => page(dir)}
        className={`grid h-16 w-10 place-items-center rounded-2xl bg-neutral-700/80 text-white shadow-xl ring-1 ring-white/10 backdrop-blur-md transition-opacity duration-200 ease-out hover:bg-neutral-600/90 ${
          show
            ? 'pointer-events-auto opacity-0 group-hover/shelf:opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
          aria-hidden
        >
          <path d={dir < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
        </svg>
      </button>
    </div>
  );

  return (
    // Named group ("shelf") so the arrows' group-hover/shelf doesn't collide
    // with the unnamed group-hover the song rows use for their own per-row hover
    // (an unnamed group-hover matches ANY ancestor .group, which would light up
    // every row at once when hovering anywhere in the shelf).
    <div className="group/shelf relative">
      <div ref={ref} className={scrollerClassName}>
        {children}
      </div>
      {arrow(-1, edges.left)}
      {arrow(1, edges.right)}
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
  playingPreviewUrl?: string | null;
  onTogglePreview?: (url: string) => void;
  /** Desktop: render as a full inline page instead of a modal overlay. */
  inline?: boolean;
  /** Whether this is the topmost surface and should answer Escape. On the phone
   *  this page can stack OVER the still-mounted artist page (and an album can
   *  stack over it); only the top layer should close on a single Escape, else
   *  one keypress collapses the whole stack. Defaults true. */
  escapeActive?: boolean;
}) {
  const wantAlbums = section === 'albums' || section === 'singles';
  const wantSongs = section === 'songs';
  const [albums, setAlbums] = useState<SearchAlbumResult[] | null>(null);
  const [related, setRelated] = useState<SearchArtistResult[] | null>(null);
  const [topTracks, setTopTracks] = useState<SearchTrackResult[] | null>(null);

  useEffect(() => {
    if (!wantAlbums) return;
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
  }, [wantAlbums, artist.source_id, artist.name, token]);

  useEffect(() => {
    if (section !== 'related') return;
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
  }, [section, artist.source_id, token]);

  useEffect(() => {
    if (!wantSongs) return;
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
  }, [wantSongs, artist.source_id, token]);

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
          : 'Similar Artists';

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

  return (
    <ModalShell
      title={title}
      subtitle={artist.name}
      onClose={onClose}
      wide
      inline={inline}
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
            layout="list"
            onAdd={(t) => onPickTrack?.(t)}
            onPlay={(t, list, index) => onPlay?.(t, list, index)}
            playingPreviewUrl={playingPreviewUrl ?? null}
            onTogglePreview={(url) => onTogglePreview?.(url)}
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
  isTrackCurrent,
  isPlaying,
  onTogglePlay,
}: {
  token: string;
  artist: SearchArtistResult;
  onClose: () => void;
  onPickAlbum: (a: SearchAlbumResult) => void;
  onPickTrack: (t: SearchTrackResult) => void;
  onPlay: (t: SearchTrackResult, list?: SearchTrackResult[], index?: number) => void;
  onPickArtist: (a: SearchArtistResult) => void;
  /** Open one section's full grid (the › chevron). Omitted ⇒ no chevrons. */
  onShowAll?: (section: ShowAllSection) => void;
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
  /** Now-playing awareness (desktop), so the artist page mirrors the album /
   *  playlist pages: a ⏸/▶ hero + sticky Play button, the current Top-Songs row
   *  highlights + shows equalizer bars, and the album card of the playing album
   *  shows a persistent pause. Omitted on the phone. */
  isTrackCurrent?: (t: SearchTrackResult) => boolean;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
}) {
  const [albums, setAlbums] = useState<SearchAlbumResult[] | null>(null);
  const [topTracks, setTopTracks] = useState<SearchTrackResult[] | null>(null);
  const [related, setRelated] = useState<SearchArtistResult[] | null>(null);
  const [bio, setBio] = useState<ArtistBio | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    setFeaturedCount(null);
    if (!featured) return;
    if (featured.total_tracks != null) {
      setFeaturedCount(featured.total_tracks);
      return;
    }
    let cancelled = false;
    getAlbumTracks(featured.source_id, token)
      .then((tracks) => {
        if (!cancelled) setFeaturedCount(tracks.length);
      })
      .catch(() => {
        /* leave null → falls back to the album-type label */
      });
    return () => {
      cancelled = true;
    };
  }, [featured, token]);

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
  }, [artist.source_id, token]);

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
      stickyBar={
        <CondensedHeaderBar
          condensed={condensed}
          title={artist.name}
          playing={contextPlaying}
          onPlay={headerPlay}
        />
      }
      hero={
        // Spotify playlist-header style: a full, uncropped square of the
        // artist photo on the left with the name + listener count written
        // out beside it, over a colour wash pulled from a blurred copy of
        // the same photo (so we don't need a colour-extraction step).
        <div className="relative overflow-hidden">
          <HeroWash coverUrl={artist.picture_url} />
          {/* Desktop card sits below the header (pt-6); the phone modal still
              bleeds up behind its bar via -mt-14, so it keeps pt-20. */}
          <div className={`relative flex items-end gap-4 sm:gap-5 px-5 sm:px-6 pb-5 sm:pb-6 ${inline ? 'pt-6' : 'pt-20'}`}>
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
              {/* Listeners live in the About section's stat column when there's
                  a bio; show them here only as a fallback so the banner isn't
                  redundant with About. */}
              {!bio && artist.total_fans ? (
                <div className="text-sm text-neutral-200 mt-3 font-medium drop-shadow">
                  {formatCompact(artist.total_fans)} listeners
                </div>
              ) : !bio && artist.total_albums ? (
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
                        const shuffled = [...topTracks].sort(() => Math.random() - 0.5);
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
                    Featured Album
                  </div>
                  {/* Cover + metadata side by side (Apple-Music style): the
                      cover is sized to roughly the 3-song Top Songs column and
                      the date / name / track count sit to its right. */}
                  <button
                    type="button"
                    onClick={() => onPickAlbum(featured)}
                    className="group flex items-center gap-4 text-left w-full"
                  >
                    <div className="aspect-square w-44 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center shadow-lg">
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
                    </div>
                    <div className="min-w-0">
                      {featured.release_date && (
                        <div className="text-xs text-neutral-400">
                          {formatReleaseDate(featured.release_date)}
                        </div>
                      )}
                      <div className="font-semibold line-clamp-2 group-hover:underline mt-1">
                        {featured.name}
                      </div>
                      <div className="text-sm text-neutral-400 mt-1">
                        {featuredCount != null
                          ? `${featuredCount} ${featuredCount === 1 ? 'song' : 'songs'}`
                          : albumTypeLabel(featured.album_type)}
                      </div>
                    </div>
                  </button>
                </div>
              ) : (
                <div className="hidden lg:block" />
              )}
              <div className="min-w-0">
                <SectionHeader
                  label="Top Songs"
                  onShowAll={
                    onShowAll && topTracks && topTracks.length > 6
                      ? () => onShowAll('songs')
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
                  />
                ) : null}
              </div>
            </div>
          );
        })()}

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
                        ? () => onShowAll(key)
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

        {/* About — Apple-style: "About <Name>" heading, the bio in a readable,
            constrained column, and a small stat column (listeners) on the right.
            A clean bordered card gives it clear separation. */}
        {bio ? (
          <div>
            <h2 className="text-lg font-bold tracking-tight px-1 mb-3">
              About {artist.name}
            </h2>
            <div className="rounded-xl bg-neutral-900/50 border border-white/5 px-6 py-5 flex flex-col md:flex-row gap-6 md:gap-12">
              <div className="flex-1 min-w-0">
                <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-300 whitespace-pre-line">
                  {bio.extract}
                </p>
                {bio.url ? (
                  <a
                    href={bio.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block mt-4 text-sm font-medium text-neutral-200 hover:text-white underline underline-offset-2"
                  >
                    Read more on Wikipedia →
                  </a>
                ) : null}
              </div>
              {artist.total_fans ? (
                <div className="shrink-0 md:w-40">
                  <div className="text-[11px] uppercase tracking-wide text-neutral-500">
                    Listeners
                  </div>
                  <div className="text-base text-neutral-100 mt-1">
                    {formatCompact(artist.total_fans)}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Similar Artists — related artists in a horizontal carousel (Apple
            Music's last section); tapping drills into one. */}
        {related && related.length > 0 ? (
          <div>
            <SectionHeader
              label="Similar Artists"
              onShowAll={
                onShowAll && related.length > 5
                  ? () => onShowAll('related')
                  : undefined
              }
            />
            <ArtistGrid
              artists={related}
              onOpen={onPickArtist}
              onPlay={(a) => playArtistCard(a, token, onPlay)}
              layout="row"
            />
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

/**
 * "Downloaded" indicator — a verified-style seal with a check, shown only for
 * catalog/album tracks whose audio is already on the device (`has_audio`). Its
 * absence means "not downloaded". Mirrors the desktop `TrackRow` badge, which
 * lives in a desktop-only module that can't be imported into this shared file,
 * so it's reimplemented inline here.
 */
function AlbumDownloadedBadge() {
  // Spotify-style "downloaded / available offline" mark — a green DOWN-ARROW
  // (not a check), so it reads distinctly from the green ✓ that means "in a
  // playlist": ↓ = on this device, ✓ = saved to a playlist.
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[17px] w-[17px] text-neutral-500"
      fill="currentColor"
      role="img"
      aria-label="Downloaded"
    >
      <title>Downloaded</title>
      <path d="M13 3a1 1 0 1 0-2 0v9.6l-3.3-3.3a1 1 0 0 0-1.4 1.4l5 5a1 1 0 0 0 1.4 0l5-5a1 1 0 0 0-1.4-1.4L13 12.6V3Z" />
      <path d="M5 19.5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z" />
    </svg>
  );
}

/**
 * Wraps a track row in the swipe-to-action gesture on phone (→ Queue, ← Save),
 * or renders it untouched everywhere else. Kept tiny so the row's children stay
 * in place (no duplication) regardless of which branch renders. The Queue/Save
 * labels + colors mirror the library playlist page so the gesture reads the
 * same across library and catalog.
 */
function MaybeSwipe({
  enabled,
  onQueue,
  onSave,
  children,
}: {
  enabled: boolean;
  onQueue: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <SwipeRow
      onSwipeRight={onQueue}
      onSwipeLeft={onSave}
      rightAction={{ label: 'Queue', bg: 'bg-neutral-800' }}
      leftAction={{ label: 'Save', bg: 'bg-neutral-100 text-neutral-950' }}
    >
      {children}
    </SwipeRow>
  );
}

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
  const [swipeToast, setSwipeToast] = useState<string | null>(null);
  const swipeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSwipeToast = useCallback((msg: string) => {
    setSwipeToast(msg);
    if (swipeToastTimer.current) clearTimeout(swipeToastTimer.current);
    swipeToastTimer.current = setTimeout(() => setSwipeToast(null), 1600);
  }, []);
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
  }, [album.source_id, album.name, album.cover_url, token, presetTracks, disableFetch]);

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
        await importAlbum(
          album.name,
          tracks,
          token,
          album.artists.join(', ') || null,
          activeProfileId,
        );
      }
      setImportState('done');
      // Refresh the app's sidebar/playlist list (the new copy should appear).
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('beetbot:library-changed'));
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
  // The library row a case-2 ✓ can remove: the imported-playlist copy wins
  // (explicit), else the shared saved-album id. Null ⇒ nothing to toggle off
  // (e.g. a not-yet-saved catalog item), so the ✓ stays a static indicator.
  const catalogRemoveId = savedCopyId ?? savedAlbumId;
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
      // Tell the app the library changed so the sidebar/playlist list refreshes
      // — otherwise the removed playlist lingers there and the remove reads as a
      // no-op even though it worked.
      if (typeof window !== 'undefined')
        window.dispatchEvent(new Event('beetbot:library-changed'));
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
    (savedCopyId != null || albumSavedInLibrary);
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
  const listPadX = inline ? 'px-4' : 'px-1';
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
                    className="rounded-lg px-3 py-2 text-neutral-300 hover:text-neutral-100 hover:bg-neutral-900 disabled:text-neutral-600 disabled:hover:bg-transparent transition"
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
                      className={`rounded-lg px-3 py-2 transition hover:bg-neutral-900 ${
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
                      className="grid place-items-center h-9 w-9 rounded-full bg-white hover:bg-neutral-200 text-neutral-950 transition"
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
            <ul className="divide-y divide-white/5">
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
                  roomy ? 'h-14' : 'py-2'
                } min-w-0 ${interactive ? '' : 'opacity-60'} ${
                  current ? 'bg-neutral-900/50' : ''
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
                          catalogInline ? 'h-10 w-10' : 'h-9 w-9'
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
                              playable
                                ? onPlay(t, tracks, i)
                                : onTogglePreview(t.preview_url as string);
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
                          current ? 'text-white' : ''
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
    {swipeToast ? (
      <div
        className="fixed left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-neutral-800 text-sm text-neutral-100 shadow-lg pointer-events-none"
        style={{ bottom: 'calc(var(--overlay-bottom, 146px) + 0.5rem)' }}
      >
        {swipeToast}
      </div>
    ) : null}
    </>
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
}) {
  const [detail, setDetail] = useState<CatalogPlaylist | null>(null);
  // Id of an existing library playlist that already matches this catalog
  // playlist (by name). Imports don't record the catalog source id, so name is
  // the only link we have — and it also covers copies imported before this
  // check existed. When set, the page shows "In your library" ✓ instead of the
  // "+" importer, so a playlist you've already added no longer reads as missing
  // (or invites a silent duplicate).
  const [savedCopyId, setSavedCopyId] = useState<number | null>(null);

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
  }, [playlist.source_id, token]);

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
  }, [playlist.title, token, activeProfileId]);

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
  }, [mix.title, token, activeProfileId]);
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
    />
  );
}

/**
 * Multi-select playlist manager. The list of playlists is shown with
 * a checkbox on each row, pre-filled from `track.in_playlist_ids`.
 * The user toggles freely and taps Done; we send a single PATCH with
 * the {add, remove} diff so the round-trip is one call regardless of
 * how many changes were made.
 *
 * Triggered from both the + button (no current memberships) and the ✓
 * button (already in N playlists) on search results — same component
 * both ways, the only difference is the initial checked set.
 */
export function AddToPlaylistModal({
  token,
  track,
  onClose,
  activeProfileId,
}: {
  token: string;
  track: SearchTrackResult;
  onClose: () => void;
  /** Active profile a newly-created playlist should belong to. */
  activeProfileId?: number | null;
}) {
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Initial = the server's snapshot at modal-open; current = the
  // user's working selection. Diff between them is what gets sent.
  const initialSelected = useMemo(
    () => new Set<number>(track.in_playlist_ids),
    [track.in_playlist_ids],
  );
  const [currentSelected, setCurrentSelected] = useState<Set<number>>(
    () => new Set<number>(track.in_playlist_ids),
  );
  // 'list' = the multi-select; 'create' = name-input for a new playlist.
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Scope the picker to the ACTIVE profile so you can only add to playlists
    // you own — without profile_id the hub falls back to the default profile
    // and lists another account's playlists.
    listPlaylists(token, activeProfileId)
      .then((rows) => {
        if (!cancelled) setPlaylists(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeProfileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'create') setMode('list');
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mode]);

  useEffect(() => {
    if (mode === 'create') {
      const id = window.setTimeout(() => nameRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [mode]);

  const filtered = useMemo(() => {
    if (!playlists) return null;
    const f = filter.trim().toLowerCase();
    // A saved album is NOT a playlist — you can't add arbitrary songs to it, so
    // it never appears as an add-target here (Spotify keeps albums and playlists
    // separate the same way).
    const addable = playlists.filter((p) => p.source !== 'album');
    const base = f
      ? addable.filter((p) => p.name.toLowerCase().includes(f))
      : addable;
    // Pin Liked Songs to the TOP (Spotify-style) so liking is one tap; a stable
    // sort keeps every other playlist in its original order.
    return [...base].sort(
      (a, b) => (a.source === 'liked' ? 0 : 1) - (b.source === 'liked' ? 0 : 1),
    );
  }, [playlists, filter]);

  // Diff is what powers the "Done" button label + enabled state.
  const { addIds, removeIds, hasChanges } = useMemo(() => {
    const add: number[] = [];
    const remove: number[] = [];
    for (const id of currentSelected) {
      if (!initialSelected.has(id)) add.push(id);
    }
    for (const id of initialSelected) {
      if (!currentSelected.has(id)) remove.push(id);
    }
    return { addIds: add, removeIds: remove, hasChanges: add.length > 0 || remove.length > 0 };
  }, [currentSelected, initialSelected]);

  const toggle = useCallback((playlistId: number) => {
    setCurrentSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playlistId)) next.delete(playlistId);
      else next.add(playlistId);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!hasChanges) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchTrackPlaylists(track, addIds, removeIds, token);
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }, [hasChanges, addIds, removeIds, track, token, onClose]);

  const handleCreatePlaylist = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setCreating(true);
      setError(null);
      try {
        const pl = await createPlaylist(name, token, activeProfileId);
        // Splice the new playlist into the local list with a 0 count,
        // then auto-check it so the next tap on Done adds the track
        // to it. The track-add itself happens on Save via the PATCH.
        setPlaylists((prev) => {
          const row: PlaylistRow = {
            id: pl.id,
            name: pl.name,
            track_count: 0,
            cover_url: null,
            source: 'local',
          };
          return prev ? [row, ...prev] : [row];
        });
        setCurrentSelected((prev) => {
          const next = new Set(prev);
          next.add(pl.id);
          return next;
        });
        setNewName('');
        setMode('list');
      } catch (err) {
        setError(friendlyError(err));
      } finally {
        setCreating(false);
      }
    },
    [newName, token, activeProfileId],
  );

  const doneLabel = saving
    ? 'Saving…'
    : !hasChanges
      ? 'Done'
      : `Done (${addIds.length} added${removeIds.length > 0 ? `, ${removeIds.length} removed` : ''})`;

  return (
    <ModalShell
      title={mode === 'create' ? 'New playlist' : 'Add to playlist'}
      subtitle={`${track.title} — ${track.artists.join(', ')}`}
      onClose={onClose}
      sheet
      footer={
        isHubReachable() && mode === 'list' ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={cn(BTN_PRIMARY, 'w-full py-2.5')}
          >
            {doneLabel}
          </button>
        ) : undefined
      }
    >
      {!isHubReachable() ? (
        <div className="px-5 pb-6 pt-1 text-center">
          <p className="text-sm text-neutral-200">
            Saving songs needs Beetbot on your computer.
          </p>
          <p className="text-xs text-neutral-500 mt-2">
            You&rsquo;re browsing on your phone&rsquo;s own connection. Reconnect
            to your computer to add this to a playlist.
          </p>
          <button
            type="button"
            onClick={onClose}
            className={cn(BTN_SECONDARY, 'mt-4')}
          >
            OK
          </button>
        </div>
      ) : mode === 'create' ? (
        <form
          onSubmit={handleCreatePlaylist}
          className="px-4 pb-4 flex flex-col gap-3"
        >
          <button
            type="button"
            onClick={() => setMode('list')}
            className="self-start inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200 active:opacity-60 -mt-1 mb-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to playlists
          </button>
          <label
            htmlFor="new-playlist-name"
            className={EYEBROW}
          >
            Playlist name
          </label>
          <input
            id="new-playlist-name"
            ref={nameRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={200}
            placeholder="e.g. Workout Mix"
            className={cn(INPUT, 'w-full text-base')}
            disabled={creating}
            autoCapitalize="words"
            autoCorrect="off"
          />
          {error && (
            <div className={cn(CALLOUT_ERROR, 'text-xs')}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className={cn(BTN_PRIMARY, 'w-full py-2.5')}
          >
            {creating ? 'Creating…' : 'Create playlist'}
          </button>
          <p className="text-xs text-neutral-500 px-1 text-center">
            The new playlist will be checked. Tap Done on the next
            screen to actually add this song to it.
          </p>
        </form>
      ) : (
        <div className="px-4 pb-4 flex flex-col gap-3">
          {/* "+ New playlist" — always at the top, above the filter,
              so the action is reachable even when the user has typed
              a filter string that would otherwise hide everything. */}
          <button
            type="button"
            onClick={() => setMode('create')}
            className="w-full py-2.5 px-2 flex items-center gap-3 text-left rounded-lg hover:bg-neutral-900 active:bg-neutral-900 transition"
          >
            <div className="h-10 w-10 shrink-0 rounded-lg bg-white/10 grid place-items-center text-neutral-200 leading-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-200">
                New playlist
              </div>
              <div className="text-xs text-neutral-500">
                Add this song to a brand-new playlist
              </div>
            </div>
          </button>

          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter playlists"
            className={cn(INPUT, 'w-full text-base')}
          />
          {error && (
            <div className={cn(CALLOUT_ERROR, 'text-xs')}>
              {error}
            </div>
          )}
          {!filtered && !error && (
            <div className="text-sm text-neutral-500 px-1">
              Loading playlists…
            </div>
          )}
          {filtered && filtered.length === 0 && (
            <div className="text-sm text-neutral-500 px-1">
              No playlists match.
            </div>
          )}
          {filtered && filtered.length > 0 && (
            <ul className="divide-y divide-white/5">
              {filtered.map((p) => {
                const checked = currentSelected.has(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => toggle(p.id)}
                      disabled={saving}
                      aria-pressed={checked}
                      className="w-full py-2.5 px-1 flex items-center gap-3 text-left rounded-lg hover:bg-white/5 active:bg-white/5 transition disabled:opacity-50"
                    >
                      <div className="h-10 w-10 shrink-0 rounded-lg overflow-hidden bg-neutral-800">
                        {p.cover_url ? (
                          <img
                            src={p.cover_url}
                            alt=""
                            className="h-full w-full object-cover"
                            draggable={false}
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-full grid place-items-center text-neutral-600">
                            {p.source === 'liked' ? '★' : '♪'}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {p.name}
                        </div>
                        <div className="text-xs text-neutral-500">
                          {p.track_count}{' '}
                          {p.track_count === 1 ? 'song' : 'songs'}
                        </div>
                      </div>
                      {/* Spotify-style ✓ in a filled green circle when
                          checked, hollow circle when not. */}
                      <div
                        className={`h-6 w-6 shrink-0 rounded-full grid place-items-center border ${
                          checked
                            ? 'bg-neutral-100 border-white/30 text-neutral-950'
                            : 'border-neutral-600 text-transparent'
                        }`}
                        aria-hidden
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
                        >
                          <path d="m5 12 5 5 9-11" />
                        </svg>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </ModalShell>
  );
}

/** Bottom-sheet-style modal shell shared by both pickers. */
function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  hero,
  stickyBar,
  condensed,
  onHeaderPlay,
  sheet,
  footer,
  // `wide` is accepted (callers still pass it) but no longer affects layout now
  // that the phone shell is a full-bleed page and the desktop shell is inline.
  inline,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Sheet mode: a pinned footer (e.g. a "Done" action) that stays visible
   *  below the scrolling body instead of scrolling off the bottom. */
  footer?: React.ReactNode;
  /** Optional full-bleed header (e.g. an artist banner). When provided,
   *  the default title bar is replaced; the hero renders at the top of
   *  the scrollable body and a floating close button is drawn over it. */
  hero?: React.ReactNode;
  /** Desktop only: a sticky element rendered BEFORE the hero (so it can pin
   *  to the top of the scroll as the hero scrolls away). */
  stickyBar?: React.ReactNode;
  /** Phone: whether the hero has scrolled past its title. Drives the phone's
   *  own unified top bar (which frosts + fades in the title/play), so the phone
   *  matches the library playlist page rather than the desktop CondensedHeaderBar. */
  condensed?: boolean;
  /** Phone: the header play button's action (fades in when condensed). */
  onHeaderPlay?: () => void;
  /** Picker mode: render as a scrimmed dialog (centered on desktop, bottom
   *  sheet on phone) rather than a full-bleed detail page. Used by the
   *  add-to-playlist / create-playlist pickers. */
  sheet?: boolean;
  /** Wider panel for page-like modals (the artist page). */
  wide?: boolean;
  /** Desktop: render as an inline full page (no overlay/backdrop) with a
   *  "Back" affordance instead of a floating modal. The parent content
   *  area provides the scroll. `onClose` becomes "go back". */
  inline?: boolean;
}) {
  // Lock body scroll only for the overlay modal — an inline page scrolls
  // with its parent and shouldn't freeze the document.
  useEffect(() => {
    if (inline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inline]);

  if (inline) {
    return (
      <div
        className="pb-6"
        // Gentle fade + rise so the page eases in rather than hard-cutting.
        // Replays whenever the shell remounts (e.g. drilling artist → artist,
        // which is keyed on the artist id).
        style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
      >
        {/* Condensed sticky bar pins to the top as the hero scrolls away. */}
        {stickyBar}
        {/* No inline Back button on desktop — the persistent top bar's global
            Back arrow unwinds these inline pages (search + Discover drill-ins).
            The phone's modal (non-inline branch below) keeps its own close. */}
        {hero ?? (
          <div className="px-1 mb-4 pt-6">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <div className="text-sm text-neutral-400 mt-0.5">{subtitle}</div>
            ) : null}
          </div>
        )}
        {children}
      </div>
    );
  }

  if (sheet) {
    // Picker mode: a scrimmed dialog — centered card on desktop, bottom sheet on
    // phone. (Detail drill-ins use the full-bleed page below instead.)
    return (
      <div
        className={cn(SCRIM, 'z-50 flex flex-col justify-end sm:justify-center sm:items-center')}
        onClick={onClose}
        role="presentation"
      >
        <div
          className={cn(BOTTOM_SHEET, 'relative w-full flex flex-col overflow-hidden sm:max-w-md')}
          // Cap the height so the picker doesn't stretch to nearly the full
          // window on desktop (it read as oversized); still tall enough for a
          // long playlist list, which scrolls inside the body.
          style={{
            maxHeight:
              'min(calc(100dvh - max(env(safe-area-inset-top, 0px), 3rem)), 40rem)',
          }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <div className="shrink-0 px-4 pt-4 pb-3 flex items-start justify-between gap-3 border-b border-white/5">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold truncate">{title}</h2>
              {subtitle ? (
                <div className="text-xs text-neutral-500 truncate">{subtitle}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 h-8 w-8 shrink-0 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 active:bg-white/10"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div
            className="overflow-y-auto overscroll-contain flex-1 min-h-0"
            style={footer ? undefined : { paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {hero}
            {children}
          </div>
          {footer ? (
            <div
              className="shrink-0 border-t border-white/5 px-4 pt-3 pb-4"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
            >
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Phone: a full-bleed PAGE (not a cover-everything sheet) at z-10 — it sits
  // UNDER the app's z-20 bar+nav wrapper, so the mini player and bottom nav stay
  // visible and tappable, exactly like an iOS push over the tab bar. The page
  // reserves the chrome's height (--overlay-bottom, published by App) so its
  // last row clears the bar+nav.
  return (
    <div
      className="fixed inset-0 z-10 overflow-y-auto overscroll-contain bg-neutral-950"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'var(--overlay-bottom, 146px)',
        animation: 'beetbot-page-enter 280ms ease-out both',
      }}
      role="region"
      aria-label={title}
    >
      {/* One unified top bar — identical to the library playlist page: a
          legibility gradient over the full-bleed hero at rest (just the back
          chevron), frosting + fading in the title + play once the hero scrolls
          past. Replaces the desktop CondensedHeaderBar (phone only). */}
      <div
        className={`sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-2 transition-colors duration-200 ${
          condensed
            ? 'bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/5'
            : 'bg-gradient-to-b from-black/50 to-transparent'
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-100 active:bg-white/10"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span
          className={`min-w-0 flex-1 truncate text-sm font-semibold transition-opacity duration-200 ${
            condensed ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {title}
        </span>
        {onHeaderPlay ? (
          <button
            type="button"
            onClick={onHeaderPlay}
            aria-label={`Play ${title}`}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 transition active:scale-95 ${
              condensed ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        ) : null}
      </div>
      {/* -mt-14 lifts the hero up behind the floating bar so the wash runs
          edge-to-edge to the top (no black band); the hero's own pt clears it. */}
      <div className="-mt-14">
        {hero ?? (
          <div className="px-4 pt-20 pb-4">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <div className="text-sm text-neutral-400 mt-0.5">{subtitle}</div>
            ) : null}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
