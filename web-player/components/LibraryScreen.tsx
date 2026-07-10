import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPlaylist,
  evictAllAudio,
  friendlyError,
  getCachedTrackIds,
  getOfflinePlaylistIds,
  profileScopedKey,
  getPlaylist,
  getStorageEstimate,
  listPlaylists,
  offlineCacheAvailable,
  playlistArtUrl,
  prefetchPlaylistDetails,
  reconcileOfflinePlaylists,
  setOfflinePlaylistIds,
  sortPlaylistsByRecent,
  trackArtUrl,
  type PlaylistRow,
} from '@shared/api';
import {
  cn,
  navPill,
  SCRIM,
  BOTTOM_SHEET,
  BAR,
  BTN_PRIMARY,
  BTN_GHOST,
  BTN_GHOST_DANGER,
  CALLOUT_INFO,
  CALLOUT_ERROR,
  EYEBROW,
} from '@shared/ui';
import { useHubReachable } from '@shared/useHubReachable';

interface Props {
  token: string;
  onOpen: (id: number) => void;
  /** Active profile — scopes the library to this user. */
  profileId: number;
  /** Switch profiles (returns to the picker). */
  onSwitchProfile: () => void;
  /** Open the listening-stats ("Wrapped") screen. */
  onOpenStats: () => void;
}

type ViewMode = 'grid' | 'list';
type SortMode = 'recent' | 'alpha' | 'added';
// Client-side kind filter. Saved albums land in the same list as playlists
// (typed `source: 'album'`), so a chip row can split them without any new
// endpoint — it only appears when the library actually holds both kinds.
type LibFilter = 'all' | 'playlists' | 'albums';

const FILTER_LABEL: Record<LibFilter, string> = {
  all: 'All',
  playlists: 'Playlists',
  albums: 'Albums',
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

export function LibraryScreen({
  token,
  onOpen,
  profileId,
  onSwitchProfile,
  onOpenStats,
}: Props) {
  // Creating a playlist is a hub write, so gate the New-playlist buttons when
  // the desktop is unreachable (the connection banner explains why).
  const hubUp = useHubReachable();
  const [playlists, setPlaylists] = useState<PlaylistRow[] | null>(null);
  const [offlineIds, setOfflineIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [cachedCount, setCachedCount] = useState<number>(0);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(
    null,
  );
  const [view, setView] = useState<ViewMode>(() =>
    readPref(VIEW_KEY, ['grid', 'list'] as const, 'grid'),
  );
  const [sort, setSort] = useState<SortMode>(() =>
    readPref(SORT_KEY, ['recent', 'alpha', 'added'] as const, 'recent'),
  );
  const [filter, setFilter] = useState<LibFilter>('all');
  const [sortOpen, setSortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
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
    const [rows, ids, est] = await Promise.all([
      listPlaylists(token, profileId),
      getCachedTrackIds(),
      getStorageEstimate(),
    ]);
    // Store the raw rows; the active sort is applied in a useMemo so
    // changing sort order doesn't require a refetch.
    setPlaylists(rows);
    setCachedCount(ids.size);
    setStorage(est);
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
    (async () => {
      try {
        await refresh();
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const handleClearOffline = useCallback(async () => {
    if (!confirm('Remove all offline tracks from this device?')) return;
    await evictAllAudio();
    setOfflinePlaylistIds(new Set());
    await refresh();
  }, [refresh]);

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
  }, [playlists, sort, pinnedIds]);

  // Only offer the Playlists/Albums chips when the library actually holds both
  // — a playlists-only (or albums-only) library gets no clutter.
  const showFilters = useMemo(() => {
    if (!playlists) return false;
    return (
      playlists.some((p) => p.source === 'album') &&
      playlists.some((p) => p.source !== 'album')
    );
  }, [playlists]);

  const visible = useMemo(() => {
    if (!sorted) return null;
    if (!showFilters || filter === 'all') return sorted;
    return sorted.filter((p) =>
      filter === 'albums' ? p.source === 'album' : p.source !== 'album',
    );
  }, [sorted, filter, showFilters]);

  return (
    <div className="pb-6">
      {/* Sticky frosted header — same pattern as Settings/Playlist (Apple:
          pure blur + hairline). Always renders so error/skeleton/empty appear
          as the body beneath it. */}
      <div className={cn(BAR, 'sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b')}>
        <h1 className="text-xl font-bold tracking-tight">Your Library</h1>
        <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!hubUp}
          aria-label="New playlist"
          title={hubUp ? 'New playlist' : 'Needs your computer'}
          className="h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-neutral-800 disabled:opacity-40 disabled:pointer-events-none"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onOpenStats}
          aria-label="Your stats"
          title="Your stats"
          className="h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-neutral-800"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 3v18h18" />
            <rect x="7" y="11" width="3" height="6" />
            <rect x="12" y="7" width="3" height="10" />
            <rect x="17" y="13" width="3" height="4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onSwitchProfile}
          aria-label="Switch profile"
          title="Switch profile"
          className="h-9 w-9 grid place-items-center rounded-full text-neutral-400 active:bg-neutral-800"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 3 4 7l4 4" />
            <path d="M4 7h16" />
            <path d="m16 21 4-4-4-4" />
            <path d="M20 17H4" />
          </svg>
        </button>
        </div>
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
      {offlineCacheAvailable() && cachedCount > 0 && (
        <StorageBanner
          cachedCount={cachedCount}
          storage={storage}
          onClear={handleClearOffline}
        />
      )}

      {/* Kind filter chips (Apple/Spotify-style) — only when the library holds
          both playlists and saved albums, so a single-kind library stays clean. */}
      {showFilters && (
        <div className="flex items-center gap-2 mb-3 px-1 overflow-x-auto">
          {(['all', 'playlists', 'albums'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition active:bg-white/10',
                navPill(filter === f),
              )}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
      )}

      {/* Sort label (left) + list/grid toggle (right), Spotify-style. */}
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

      {pinnedIds.size === 0 && sorted.length > 4 && (
        <p className="px-1 mb-2 text-[11px] text-neutral-600">
          Tip: press and hold a playlist to pin it to the top.
        </p>
      )}

      {view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {(visible ?? []).map((p) => (
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
          {(visible ?? []).map((p) => (
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

function StorageBanner({
  cachedCount,
  storage,
  onClear,
}: {
  cachedCount: number;
  storage: { usage: number; quota: number } | null;
  onClear: () => void;
}) {
  return (
    <div className={cn(CALLOUT_INFO, 'mb-3 flex items-center gap-3')}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-neutral-400"
        aria-hidden
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      <div className="flex-1 min-w-0 text-xs text-neutral-300">
        <div>
          {cachedCount} {cachedCount === 1 ? 'song' : 'songs'} cached offline
          {storage ? <> · {formatBytes(storage.usage)} used</> : null}
        </div>
        {storage && storage.quota > 0 && (
          <div className="text-neutral-500 mt-0.5">
            {formatBytes(storage.quota - storage.usage)} free of{' '}
            {formatBytes(storage.quota)}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClear}
        className={cn(BTN_GHOST_DANGER, 'shrink-0 text-xs px-2 py-1 active:text-red-400')}
      >
        Clear all
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
