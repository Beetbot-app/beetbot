import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPlaylist,
  friendlyError,
  getCachedTrackIds,
  getOfflinePlaylistIds,
  profileScopedKey,
  getPlaylist,
  listLibrarySongs,
  listPlaylists,
  offlineCacheAvailable,
  playlistArtUrl,
  prefetchPlaylistDetails,
  reconcileOfflinePlaylists,
  sortPlaylistsByRecent,
  trackArtUrl,
  type PlaylistRow,
  type StreamTrack,
} from '@shared/api';
import {
  cn,
  navPill,
  SCRIM,
  BOTTOM_SHEET,
  BTN_PRIMARY,
  BTN_GHOST,
  CALLOUT_ERROR,
  EYEBROW,
} from '@shared/ui';
import {
  useActiveProfile,
  SettingsAvatar,
  STICKY_FROST,
} from '@shared/components/PhoneTopBar';
import { useHubReachable } from '@shared/useHubReachable';
import { useSavedStore, type SavedArtist } from '@/lib/saved';
import { canStream, useCatalogNav, usePlayerStore } from '../store';
import { useRecentlyPlayedVersion } from '@shared/useRecentPlaylists';
import { notifyLibraryChanged } from '@shared/libraryChanged';
import { SongsList } from './SongsList';

interface Props {
  token: string;
  onOpen: (id: number) => void;
  /** Active profile — scopes the library to this user. */
  profileId: number;
  /** Open Settings — the header avatar leads here (same as the Home avatar). */
  onOpenSettings: () => void;
}

type ViewMode = 'grid' | 'list';
type SortMode = 'recent' | 'alpha' | 'added';
// Client-side kind filter. Saved albums land in the same list as playlists
// (typed `source: 'album'`), so a chip row can split them without any new
// endpoint — it only appears when the library actually holds both kinds.
type LibFilter = 'all' | 'playlists' | 'songs' | 'albums' | 'artists' | 'offline';

const FILTER_LABEL: Record<LibFilter, string> = {
  all: 'All',
  playlists: 'Playlists',
  songs: 'Songs',
  albums: 'Albums',
  artists: 'Artists',
  // "Offline", not "Downloaded": on the phone *downloaded* already means the
  // hub holds the file (what the playlist header counts), while *offline*
  // means the bytes are on THIS device. The desktop's Downloaded tab is the
  // other meaning; keeping the words apart keeps both honest.
  offline: 'Offline',
};

const VIEW_KEY = 'beetbot.library_view';
const SORT_KEY = 'beetbot.library_sort';
const PINNED_KEY = 'beetbot.library_pinned';

function readPinned(profileId: number | null): Set<number> {
  try {
    const v = localStorage.getItem(profileScopedKey(PINNED_KEY, profileId));
    if (v) return new Set((JSON.parse(v) as number[]).filter((n) => typeof n === 'number'));
  } catch {
    /* private mode / bad JSON — fall through */
  }
  return new Set();
}

const SORT_LABEL: Record<SortMode, string> = {
  recent: 'Recently played',
  alpha: 'Alphabetical',
  added: 'Recently added',
};

function readPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* private mode — fall through */
  }
  return fallback;
}

/** "Playlist · 24 songs" / "Favorites · 50 songs" / "Album · Artist". */
function subtitleFor(p: PlaylistRow): string {
  if (p.source === 'album') {
    return p.owner ? `Album · ${p.owner}` : 'Album';
  }
  const type = p.source === 'liked' ? 'Favorites' : 'Playlist';
  return `${type} · ${p.track_count} ${p.track_count === 1 ? 'song' : 'songs'}`;
}

/** Saved-artists view for the phone library — round avatars, tap opens the
 *  artist page. Data comes straight from the saved store (no endpoint). */
function ArtistsGrid({
  artists,
  view,
  onOpen,
}: {
  artists: SavedArtist[];
  view: ViewMode;
  onOpen: (name: string) => void;
}) {
  if (view === 'grid') {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {artists.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => onOpen(a.name)}
            className="group relative flex flex-col text-left transition active:scale-[0.98]"
          >
            <span className="pointer-events-none absolute -inset-2 rounded-xl transition-colors group-hover:bg-white/[0.06]" />
            <div className="relative aspect-square w-full overflow-hidden rounded-full bg-neutral-800">
              {a.art && (
                <img src={a.art} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="pt-2 px-0.5 min-w-0 text-center">
              <div className="text-sm font-medium truncate">{a.name}</div>
              <div className="text-xs text-neutral-500 truncate">Artist</div>
            </div>
          </button>
        ))}
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {artists.map((a) => (
        <li key={a.key}>
          <button
            type="button"
            onClick={() => onOpen(a.name)}
            className="w-full flex items-center gap-3 py-2 px-1 rounded-lg hover:bg-neutral-900 active:bg-neutral-900 text-left"
          >
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-neutral-800">
              {a.art && (
                <img src={a.art} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{a.name}</div>
              <div className="text-xs text-neutral-500 truncate">Artist</div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LibraryScreen({
  token,
  onOpen,
  profileId,
  onOpenSettings,
}: Props) {
  // Creating a playlist is a hub write, so gate the New-playlist buttons when
  // the desktop is unreachable (the connection banner explains why).
  const hubUp = useHubReachable();
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(null);
  const [offlineIds, setOfflineIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The ids, not just a count: they are what makes the offline set browsable.
  const [cachedIds, setCachedIds] = useState<Set<number>>(() => new Set());
  const [view, setView] = useState<ViewMode>(() =>
    readPref(VIEW_KEY, ['grid', 'list'] as const, 'list'),
  );
  const [sort, setSort] = useState<SortMode>(() =>
    readPref(SORT_KEY, ['recent', 'alpha', 'added'] as const, 'recent'),
  );
  const [filter, setFilter] = useState<LibFilter>('all');
  // Within-library text filter (matches the desktop). Collapses to a magnifier;
  // expands to a field that narrows the current list by name.
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // Flat library-songs list (Library › Songs), lazy-loaded the first time the
  // Songs chip is opened. Fetched over the new /api/library/songs endpoint.
  const [songs, setSongs] = useState<StreamTrack[] | null>(null);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const [sortOpen, setSortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // The active profile drives the header avatar; tapping it opens Settings
  // (same destination as the Home avatar), where Switch profile / Listening
  // stats live.
  const profile = useActiveProfile(token, profileId);
  // Pinned playlists float to the top (below Liked) regardless of sort.
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(() => readPinned(profileId));

  const togglePin = useCallback(
    (id: number) => {
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(
            profileScopedKey(PINNED_KEY, profileId),
            JSON.stringify([...next]),
          );
        } catch {
          /* private mode — pin just won't persist */
        }
        return next;
      });
    },
    [profileId],
  );

  // Long-press (≈500ms hold, no drift) toggles a pin — works on both grid
  // cards and list rows (a horizontal swipe is awkward on a 2-col grid). A
  // shared timer is fine: only one press happens at a time on touch. `lpFired`
  // lets the tap handler ignore the click that follows a long-press.
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const clearLp = () => {
    if (lpTimer.current != null) {
      window.clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  };
  const pinHandlers = (id: number) => ({
    onTouchStart: (e: React.TouchEvent) => {
      lpFired.current = false;
      const t = e.touches[0];
      lpStart.current = { x: t.clientX, y: t.clientY };
      clearLp();
      lpTimer.current = window.setTimeout(() => {
        lpFired.current = true;
        togglePin(id);
      }, 500);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = lpStart.current;
      if (!s) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - s.x) > 10 || Math.abs(t.clientY - s.y) > 10) {
        clearLp(); // moved → it's a scroll, not a long-press
      }
    },
    onTouchEnd: clearLp,
  });
  // Guard a card's open-on-tap so it doesn't fire right after a long-press pin.
  const tapAfterPress = (open: () => void) => {
    if (lpFired.current) {
      lpFired.current = false;
      return;
    }
    open();
  };

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);
  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* ignore */
    }
  }, [sort]);

  const refresh = useCallback(async () => {
    const [rows, ids] = await Promise.all([
      listPlaylists(token, profileId),
      getCachedTrackIds(),
    ]);
    // Store the raw rows; the active sort is applied in a useMemo so
    // changing sort order doesn't require a refetch.
    setPlaylists(rows);
    setCachedIds(ids);
    // Warm the SW cache for every playlist's detail. Without this, a
    // playlist the user hasn't yet visited online wouldn't be cached
    // and would show a TypeError when tapped offline. Fire-and-forget;
    // the SW handles the response either way (online -> cache, offline
    // -> no-op).
    if (navigator.onLine && rows.length > 0) {
      void prefetchPlaylistDetails(
        rows.map((p) => p.id),
        token,
      );
    }
    // Reconcile the "Available offline" badges against the actual
    // audio cache. If the audio cache got wiped (cache-version bump,
    // user evict-all, browser storage purge) we want to stop
    // promising offline for playlists whose bytes are gone. Fetch
    // each marked-offline playlist's track list (cheap — SW cache
    // hit after the prefetch above) and check if any track id is
    // still cached. We only do this when online so a cold-offline
    // boot doesn't tear down badges for the user's actual cached
    // playlists due to transient network errors.
    const offlineFlag = getOfflinePlaylistIds();
    if (navigator.onLine && offlineFlag.size > 0) {
      try {
        const details = await Promise.all(
          [...offlineFlag].map(async (id) => {
            try {
              const d = await getPlaylist(id, token);
              return { id, trackIds: d.tracks.map((t) => t.id) };
            } catch {
              return null;
            }
          }),
        );
        const cleaned = await reconcileOfflinePlaylists(
          details.filter((d): d is { id: number; trackIds: number[] } => d != null),
        );
        setOfflineIds(cleaned);
      } catch {
        setOfflineIds(offlineFlag);
      }
    } else {
      setOfflineIds(offlineFlag);
    }
  }, [token, profileId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await refresh();
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      }
    };
    void run();
    // Refetch when the library changes elsewhere (a like, an add/remove, a
    // delete) so this screen's list + counts stay live while it's open.
    const onChanged = () => void run();
    window.addEventListener('beetbot:library-changed', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('beetbot:library-changed', onChanged);
    };
  }, [refresh]);

  const recentsVersion = useRecentlyPlayedVersion();
  const sorted = useMemo(() => {
    if (!playlists) return null;
    let base: PlaylistRow[];
    if (sort === 'alpha') {
      base = [...playlists].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
    } else if (sort === 'added') {
      // Higher id ⇒ created later. A good proxy for "recently added"
      // without a dedicated timestamp column.
      base = [...playlists].sort((a, b) => b.id - a.id);
    } else {
      // 'recent' — most-recently-opened-on-this-device first.
      base = sortPlaylistsByRecent(playlists);
    }
    // Cluster to the top regardless of sort: Liked Songs first, then pinned
    // playlists, then everything else. Array.sort is stable, so the base order
    // is preserved within each cluster.
    const rank = (p: PlaylistRow) =>
      p.source === 'liked' ? 0 : pinnedIds.has(p.id) ? 1 : 2;
    return base.sort((a, b) => rank(a) - rank(b));
  // `recentsVersion` isn't read in the body on purpose: it's the signal that the
  // hub's shared recency merged in. Dropping it would silently stop the other
  // device's plays from ever reordering this list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, sort, pinnedIds, recentsVersion]);

  // Saved artists (Library › Artists) come straight from the KV store — no
  // endpoint needed, and they sync with the desktop.
  const savedArtists = useSavedStore((s) => s.artists);
  const openArtist = useCatalogNav((s) => s.openArtist);
  const sortedArtists = useMemo(
    () =>
      [...savedArtists].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [savedArtists],
  );

  // Which kind-filter chips to offer. Albums appear only when the library holds
  // album-imports; Artists only when some are saved — no clutter otherwise.
  const filters = useMemo<LibFilter[]>(() => {
    const out: LibFilter[] = ['all', 'playlists'];
    if (playlists && playlists.length > 0) out.push('songs');
    if (playlists?.some((p) => p.source === 'album')) out.push('albums');
    if (savedArtists.length > 0) out.push('artists');
    if (offlineCacheAvailable() && cachedIds.size > 0) out.push('offline');
    return out;
  }, [playlists, savedArtists, cachedIds]);
  const showFilters = filters.length > 2;

  // If the active filter's chip disappears (e.g. the last saved artist was
  // removed), fall back to All.
  useEffect(() => {
    if (!filters.includes(filter)) setFilter('all');
  }, [filters, filter]);

  const visible = useMemo(() => {
    if (!sorted) return null;
    if (!showFilters || filter === 'all') return sorted;
    return sorted.filter((p) =>
      filter === 'albums' ? p.source === 'album' : p.source !== 'album',
    );
  }, [sorted, filter, showFilters]);

  // Apply the within-library text filter on top of the kind filter + sort.
  const q = query.trim().toLowerCase();
  const shownPlaylists = useMemo(() => {
    if (!visible) return null;
    if (!q) return visible;
    return visible.filter((p) => p.name.toLowerCase().includes(q));
  }, [visible, q]);
  const shownArtists = useMemo(
    () =>
      q
        ? sortedArtists.filter((a) => a.name.toLowerCase().includes(q))
        : sortedArtists,
    [sortedArtists, q],
  );

  // Lazy-load the flat songs list the first time it's needed: when the Songs
  // chip is opened, OR when there's a query on the "All" tab (so an "All" search
  // matches song titles too, not just playlist/album/artist names).
  useEffect(() => {
    const needSongs =
      filter === 'songs' || filter === 'offline' || (filter === 'all' && !!q);
    if (!needSongs || songs !== null) return;
    let cancelled = false;
    listLibrarySongs(token, profileId)
      .then((rows) => {
        if (!cancelled) setSongs(rows);
      })
      .catch(() => {
        if (!cancelled) setSongs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, q, songs, token, profileId]);

  const shownSongs = useMemo(() => {
    if (!songs) return null;
    if (!q) return songs;
    return songs.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artists.some((a) => a.toLowerCase().includes(q)),
    );
  }, [songs, q]);

  // Exactly the tracks whose audio sits in this device's cache — the set
  // behind "N songs cached offline", finally browsable. Ordered by the songs
  // list (title-sorted) so it reads like the rest of the library.
  const shownOffline = useMemo(() => {
    if (!shownSongs) return null;
    return shownSongs.filter((t) => cachedIds.has(t.id));
  }, [shownSongs, cachedIds]);

  // Tapping a song plays it and queues the whole (filtered) songs list from
  // that point — only the playable rows, matching the desktop's behavior.
  const playSong = (song: StreamTrack) => {
    const playable = (shownSongs ?? []).filter(canStream);
    const idx = playable.findIndex((t) => t.id === song.id);
    if (idx >= 0) setQueue(playable, idx);
  };
  // Queue only what is actually on this device: the point of the Offline view
  // is that it plays with no hub and no signal, so its queue must not trail
  // off into tracks that would need the network.
  const playOffline = (song: StreamTrack) => {
    const list = shownOffline ?? [];
    const idx = list.findIndex((t) => t.id === song.id);
    if (idx >= 0) setQueue(list, idx);
  };

  return (
    <div className="pb-6">
      {/* Sticky frosted header (Apple: pure blur + hairline). Row 1 is the
          account avatar (→ Settings) + title + new-playlist; rows 2–4 (kind
          filters / find-in-library / sort) pin WITH the bar so a long library
          can be re-filtered without scrolling back to the top. Always renders
          so error/skeleton/empty appear as the body beneath it. */}
      <div className={cn(STICKY_FROST, 'sticky top-0 z-20 border-b border-white/5')}>
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">Your Library</h1>
          <div className="flex items-center gap-1">
            {/* Find-in-library — sits next to New playlist (Spotify-style);
                toggles the search field below the chips. */}
            {sorted && sorted.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setSearchOpen((v) => {
                    if (v) setQuery('');
                    return !v;
                  })
                }
                aria-label={searchOpen ? 'Close search' : 'Find in Your Library'}
                // -my-1: keep the 36px hit area but let the row measure 28px, so
                // this bar's title + avatar land on the same baseline as Home's
                // and Search's (which have no icons to stretch them).
                className={`-my-1 h-9 w-9 grid place-items-center rounded-full transition ${
                  searchOpen
                    ? 'bg-neutral-900 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100 active:bg-neutral-900'
                }`}
              >
                <SearchIcon />
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={!hubUp}
              aria-label="New playlist"
              title={hubUp ? 'New playlist' : 'Needs your computer'}
              className="-my-1 h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-neutral-800 disabled:opacity-40 disabled:pointer-events-none"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {/* Trailing item, same as Home/Search — ml-1.5 because the avatar's
                own tap padding already supplies part of the gap to the icon
                before it. */}
            <SettingsAvatar
              className="ml-1.5"
              profile={profile}
              token={token}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </div>

        {/* Kind filters + within-library search — pinned with the bar so a
            long library can be re-filtered/searched without scrolling to the
            top. Sort + view toggle scroll with the content (in the body). */}
        {sorted && sorted.length > 0 && (showFilters || searchOpen) && (
          <div className="px-4 pb-2">
            {/* Kind filter chips — only when the library holds more than one
                kind, so a single-kind library stays clean. */}
            {showFilters && (
              // Chip row scrolls without a scrollbar, like every other
              // horizontal scroller in the app.
              <div className="flex items-center gap-2 px-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    // px-4/py-2 at text-sm puts these near 36px tall. They were
                    // a 28px xs chip, which is a small target for a thumb and
                    // read as secondary next to the same filters in the apps
                    // people compare us to.
                    className={cn(
                      'shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:bg-white/10',
                      navPill(filter === f),
                    )}
                  >
                    {FILTER_LABEL[f]}
                  </button>
                ))}
              </div>
            )}

            {/* Within-library search — the top-bar magnifier expands this field,
                which narrows the current list by name (matches the desktop). */}
            {searchOpen && (
              <div className="mt-2 px-1">
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => {
                    if (!query.trim()) setSearchOpen(false);
                  }}
                  placeholder="Find in Your Library"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-400 focus:outline-none"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {error ? (
        <div className={cn(CALLOUT_ERROR, 'm-4')}>{error}</div>
      ) : !sorted ? (
        // Pulsing grid placeholders (matches Home's skeleton pattern).
        <div className="px-4 pt-3 grid grid-cols-2 gap-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-square w-full rounded-lg bg-neutral-800/80" />
              <div className="mt-2 h-3.5 w-3/4 rounded bg-neutral-800/80" />
              <div className="mt-1.5 h-3 w-1/2 rounded bg-neutral-800/80" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="px-6 pt-16 flex flex-col items-center text-center gap-4">
          <p className="text-sm text-neutral-500">
            No playlists yet. Create one to get started.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={!hubUp}
            className={cn(BTN_PRIMARY)}
          >
            New playlist
          </button>
        </div>
      ) : (
      <div className="px-4 pt-3">
      {/* Sort (left) + list/grid toggle (right) — scrolls with the content
          (not pinned), Spotify-style. */}
      <div className="flex items-center justify-between px-1 mb-3">
        <button
          type="button"
          onClick={() => setSortOpen(true)}
          className="flex items-center gap-1.5 text-sm text-neutral-300 hover:text-neutral-100 active:text-neutral-100"
        >
          <SortIcon />
          <span>{SORT_LABEL[sort]}</span>
        </button>
        <button
          type="button"
          onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
          aria-label={view === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          className="h-8 w-8 grid place-items-center rounded-full text-neutral-300 hover:text-neutral-100 hover:bg-neutral-900 active:bg-neutral-900"
        >
          {/* Show the icon for the view you'd switch TO, like Spotify. */}
          {view === 'grid' ? <ListIcon /> : <GridIcon />}
        </button>
      </div>

      {filter === 'songs' ? (
        <SongsList
          songs={shownSongs}
          hasQuery={!!q}
          query={query.trim()}
          onPlay={playSong}
        />
      ) : filter === 'offline' ? (
        <SongsList
          songs={shownOffline}
          hasQuery={!!q}
          query={query.trim()}
          emptyLabel="Nothing is saved on this device yet."
          onPlay={playOffline}
        />
      ) : q &&
      (filter === 'artists'
        ? shownArtists.length === 0
        : filter === 'all'
          ? // "All" matches playlists/albums AND songs — only truly empty when
            // both miss (and the songs list has finished loading).
            (shownPlaylists?.length ?? 0) === 0 &&
            shownSongs !== null &&
            shownSongs.length === 0
          : (shownPlaylists?.length ?? 0) === 0) ? (
        <div className="px-2 py-8 text-center text-sm text-neutral-500">
          No matches for “{query.trim()}”.
        </div>
      ) : filter === 'artists' ? (
        <ArtistsGrid artists={shownArtists} view={view} onOpen={openArtist} />
      ) : (
      <>
      {view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {(shownPlaylists ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => tapAfterPress(() => onOpen(p.id))}
              {...pinHandlers(p.id)}
              className="group relative flex flex-col text-left transition active:scale-[0.98]"
            >
              <span className="pointer-events-none absolute -inset-2 rounded-xl transition-colors group-hover:bg-white/[0.06]" />
              <div className="relative aspect-square w-full">
                <PlaylistCover p={p} token={token} />
                {offlineIds.has(p.id) && <OfflineBadge />}
                {pinnedIds.has(p.id) && p.source !== 'liked' && <PinBadge />}
              </div>
              <div className="pt-2 px-0.5 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-xs text-neutral-500 truncate">
                  {subtitleFor(p)}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col">
          {(shownPlaylists ?? []).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => tapAfterPress(() => onOpen(p.id))}
                {...pinHandlers(p.id)}
                className="w-full flex items-center gap-3 py-2 px-1 rounded-lg hover:bg-neutral-900 active:bg-neutral-900 text-left"
              >
                <div className="relative h-12 w-12 shrink-0">
                  <PlaylistCover p={p} token={token} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate flex items-center gap-1.5">
                    {pinnedIds.has(p.id) && p.source !== 'liked' && (
                      <PinGlyph className="h-3 w-3 shrink-0 text-neutral-400" />
                    )}
                    <span className="truncate">{p.name}</span>
                  </div>
                  <div className="text-xs text-neutral-500 truncate">
                    {subtitleFor(p)}
                  </div>
                </div>
                {offlineIds.has(p.id) && (
                  <span
                    className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-white/90 text-neutral-950 shrink-0"
                    title="Cached for offline"
                  >
                    Offline
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* In "All", a query also matches song titles (loaded on demand). Show the
          hits under a "Songs" heading below the matching playlists/albums. */}
      {filter === 'all' && q && (shownSongs === null || shownSongs.length > 0) && (
        <div className="mt-6">
          <div className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Songs
          </div>
          <SongsList
            songs={shownSongs}
            hasQuery
            query={query.trim()}
            onPlay={playSong}
          />
        </div>
      )}
      </>
      )}
      </div>
      )}

      {sortOpen && (
        <SortSheet
          value={sort}
          onPick={(s) => {
            setSort(s);
            setSortOpen(false);
          }}
          onClose={() => setSortOpen(false)}
        />
      )}
      {createOpen && (
        <CreatePlaylistSheet
          onCreate={async (name) => {
            const pl = await createPlaylist(name, token, profileId);
            // Without this the library's cached list has no idea the playlist
            // exists, so coming back from it shows a library without it.
            notifyLibraryChanged();
            setCreateOpen(false);
            onOpen(pl.id);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Playlist tile art: a 2×2 mosaic when the playlist has at least 4
 * distinct album arts, else the single effective cover, else a glyph.
 * Fills its parent box (sized by the caller — square tile or 48px row
 * thumbnail).
 */
function PlaylistCover({ p, token }: { p: PlaylistRow; token: string }) {
  const ids = p.cover_track_ids ?? [];
  if (ids.length >= 4) {
    return (
      <div className="grid grid-cols-2 grid-rows-2 w-full h-full overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5">
        {ids.slice(0, 4).map((id) => (
          <img
            key={id}
            src={trackArtUrl(id, token)}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="w-full h-full overflow-hidden rounded-lg bg-neutral-800 grid place-items-center ring-1 ring-white/5">
      {p.cover_url ? (
        <img
          // Route through the same-origin proxy so the SW caches the
          // bytes — p.cover_url is a CDN URL that can't be cached
          // cross-origin.
          src={playlistArtUrl(p.id, token)}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          loading="lazy"
        />
      ) : (
        <span className="text-2xl text-neutral-600">
          {p.source === 'liked' ? '★' : '♪'}
        </span>
      )}
    </div>
  );
}

function OfflineBadge() {
  return (
    <span
      className="absolute top-1.5 right-1.5 text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-white/90 text-neutral-950"
      title="Cached for offline"
    >
      Offline
    </span>
  );
}

function PinGlyph({ className }: { className?: string }) {
  // A simple filled push-pin.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M14 2 9.5 6.5 5 8l-1.5 1.5L8 14l-5 7 7-5 4.5 4.5L16 19l1.5-4.5L22 10z" />
    </svg>
  );
}

function PinBadge() {
  return (
    <span
      className="absolute top-1.5 left-1.5 h-5 w-5 grid place-items-center rounded-full bg-white/90 text-neutral-950"
      title="Pinned"
    >
      <PinGlyph className="h-3 w-3" />
    </span>
  );
}

/** Bottom-sheet sort picker. */
/** Bottom sheet with a single name field — the mobile "New playlist" flow.
 *  Same frosted shell as the other sheets. */
function CreatePlaylistSheet({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(n);
    } catch {
      setError("Couldn't create the playlist. Try again.");
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(SCRIM, 'z-50 flex flex-col justify-end sm:justify-center sm:items-center')}
      onClick={onClose}
      role="presentation"
    >
      <form
        className={cn(BOTTOM_SHEET, 'w-full sm:max-w-sm overflow-hidden px-4 pt-4')}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="New playlist"
      >
        <div className={cn(EYEBROW, 'pb-2')}>
          New playlist
        </div>
        {/* Maps to INPUT, but kept inline: py-2.5 (a larger touch target than
            INPUT's py-2) would be overridden by INPUT's py-2 via source order. */}
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Playlist name"
          disabled={busy}
          className="w-full rounded-lg bg-neutral-900 border border-neutral-800 px-3 py-2.5 text-base text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-400 disabled:opacity-60"
        />
        {error && (
          <div className={cn(CALLOUT_ERROR, 'mt-2 text-xs')}>
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={cn(BTN_GHOST, 'active:bg-white/5')}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className={cn(BTN_PRIMARY)}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SortSheet({
  value,
  onPick,
  onClose,
}: {
  value: SortMode;
  onPick: (s: SortMode) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const opts: SortMode[] = ['recent', 'alpha', 'added'];
  return (
    <div
      className={cn(SCRIM, 'z-50 flex flex-col justify-end sm:justify-center sm:items-center')}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={cn(BOTTOM_SHEET, 'w-full sm:max-w-sm overflow-hidden')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className={cn(EYEBROW, 'px-4 pt-4 pb-2')}>
          Sort by
        </div>
        <ul className="pb-2">
          {opts.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-neutral-900 active:bg-neutral-900"
              >
                <span
                  className={`text-sm ${
                    value === s
                      ? 'text-neutral-100 font-medium'
                      : 'text-neutral-200'
                  }`}
                >
                  {SORT_LABEL[s]}
                </span>
                {value === s && (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-neutral-100"
                    aria-hidden
                  >
                    <path d="m5 12 5 5 9-11" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SortIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m3 16 4 4 4-4" />
      <path d="M7 20V4" />
      <path d="m21 8-4-4-4 4" />
      <path d="M17 4v16" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
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
  );
}

function ListIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

