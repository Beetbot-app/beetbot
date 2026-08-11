import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PlaylistCard } from '@/components/PlaylistCard';
import { CardPlayButton } from '@shared/components/Marquee';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from '@shared/components/ContextMenu';
import { useCanDownload } from '@/lib/capabilities';
import { useDownloadsStore } from '@/lib/downloads';
import { formatDuration } from '@/lib/format';
import { cn, CALLOUT_ERROR, POPOVER } from '@shared/ui';
import { useLibraryChangeTick } from '@shared/useLibraryChange';
import { canStream, currentTrack, usePlayerStore } from '@/lib/store';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { useProfileStore } from '@/lib/profile';
import { useNavStore } from '@/lib/nav';
import { isPinned, usePinStore, type Pin } from '@/lib/pins';
import { isArtistSaved, useSavedStore } from '@/lib/saved';
import {
  ipc,
  type LibraryAlbum,
  type LibraryArtist,
  type PlaylistSummary,
  type PlaylistTrack,
} from '@/lib/tauri';
import {
  ensureSession,
  getRecentlyPlayedPlaylists,
  getTrackPlaylistIds,
  sortPlaylistsByRecent,
  type SearchTrackResult,
} from '@shared/api';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { playlistTrackToSearch } from '@/lib/trackAdapter';
import {
  ShareDialog,
  spotifyTrackId,
  type ShareTarget,
} from '@/components/ShareDialog';
import { useRecentlyPlayedVersion } from '@shared/useRecentPlaylists';

interface Props {
  onOpenPlaylist: (id: number) => void;
  onOpenSettings: () => void;
}

type Tab = 'all' | 'playlists' | 'artists' | 'albums' | 'songs' | 'downloaded';

/** One entry in the mixed "All" view. `name`/`recent` are the sort keys; the
 *  kind-specific payload drives rendering + context menus. */
type AllItem =
  | { kind: 'playlist'; key: string; name: string; recent: number; playlist: PlaylistSummary }
  | { kind: 'album'; key: string; name: string; recent: number; album: LibraryAlbum }
  | { kind: 'artist'; key: string; name: string; recent: number; artist: LibraryArtist };

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' },
  { id: 'songs', label: 'Songs' },
  // Shown only when this build can download (gated in the render below).
  { id: 'downloaded', label: 'Downloaded' },
];

const SORTS: Record<Tab, { id: string; label: string }[]> = {
  all: [
    { id: 'recent', label: 'Recents' },
    { id: 'name', label: 'Alphabetical' },
  ],
  playlists: [
    { id: 'recent', label: 'Recents' },
    { id: 'added', label: 'Recently Added' },
    { id: 'name', label: 'Alphabetical' },
  ],
  songs: [
    { id: 'title', label: 'Title' },
    { id: 'artist', label: 'Artist' },
    { id: 'recent', label: 'Recently added' },
    { id: 'duration', label: 'Duration' },
  ],
  downloaded: [
    { id: 'title', label: 'Title' },
    { id: 'artist', label: 'Artist' },
    { id: 'recent', label: 'Recently added' },
    { id: 'duration', label: 'Duration' },
  ],
  albums: [
    { id: 'title', label: 'Title' },
    { id: 'artist', label: 'Artist' },
    { id: 'count', label: 'Songs' },
  ],
  artists: [
    { id: 'name', label: 'Name' },
    { id: 'count', label: 'Songs' },
  ],
};
const DEFAULT_SORT: Record<Tab, string> = {
  all: 'recent',
  playlists: 'recent',
  songs: 'title',
  downloaded: 'title',
  albums: 'title',
  artists: 'name',
};

type ViewMode = 'list' | 'grid';
const VIEW_MODES: { id: ViewMode; label: string; icon: ReactNode }[] = [
  {
    id: 'list',
    label: 'List',
    icon: (
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
        <circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none" />
        <path d="M9 6h11M9 12h11M9 18h11" />
      </svg>
    ),
  },
  {
    id: 'grid',
    label: 'Grid',
    icon: (
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
      </svg>
    ),
  },
];
const DEFAULT_VIEW: Record<Tab, ViewMode> = {
  all: 'grid',
  playlists: 'grid',
  albums: 'grid',
  artists: 'grid',
  songs: 'list',
  downloaded: 'list',
};

/** List-row subtitle for a playlist, matching the sidebar: album imports read
 *  "Album · {artist}", everything else "Playlist · N songs". */
function playlistSubtitle(p: PlaylistSummary): string {
  if (p.source === 'album') return p.owner ? `Album · ${p.owner}` : 'Album';
  return `Playlist · ${p.track_count} ${p.track_count === 1 ? 'song' : 'songs'}`;
}

/** A compact library list row: art (square or round) + title + subtitle.
 *  Shared by the Playlists / Albums / Artists list views. */
function LibRow({
  art,
  round,
  title,
  subtitle,
  onOpen,
  onContext,
}: {
  art: string | null;
  round?: boolean;
  title: string;
  subtitle: string;
  onOpen: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onContext}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5 transition"
    >
      <div
        className={`h-12 w-12 shrink-0 overflow-hidden bg-neutral-800 grid place-items-center ${
          round ? 'rounded-full' : 'rounded-md'
        }`}
      >
        {art ? (
          <img
            src={art}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
          />
        ) : (
          <span className="text-neutral-600 text-lg">{round ? '☺' : '♪'}</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-neutral-100">
          {title}
        </div>
        <div className="truncate text-xs text-neutral-500">{subtitle}</div>
      </div>
    </button>
  );
}

/**
 * Library page — Daft-style. The playlist grid lives in its own tab (so nothing
 * existing is lost), alongside Artists / Albums / Songs views derived from the
 * whole shared library. Per-view filter + sort, and right-click context menus
 * (play, add to playlist, go to artist/album, pin to sidebar).
 */
export function LibraryPage({ onOpenPlaylist, onOpenSettings }: Props) {
  // Download affordances (full build only — false on the open-core/OSS build).
  const canDownload = useCanDownload();
  const startDownload = useDownloadsStore((s) => s.download);
  const removeDownload = useDownloadsStore((s) => s.remove);
  const [tab, setTab] = useState<Tab>('all');
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [songs, setSongs] = useState<PlaylistTrack[] | null>(null);
  const [downloadedSongs, setDownloadedSongs] = useState<PlaylistTrack[] | null>(null);
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [artists, setArtists] = useState<LibraryArtist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Search collapses to an icon and expands inline (Spotify-style) so it can
  // share the chip row without permanently eating width.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Sort is PER TAB and persisted (each tab remembers its own sort across
  // sessions), mirroring the per-tab view mode below.
  const [sortByTab, setSortByTab] = useState<Record<Tab, string>>(() => {
    try {
      const raw = localStorage.getItem('beetbot.library.sort');
      if (raw) return { ...DEFAULT_SORT, ...JSON.parse(raw) };
    } catch {
      /* fall through */
    }
    return DEFAULT_SORT;
  });
  useEffect(() => {
    try {
      localStorage.setItem('beetbot.library.sort', JSON.stringify(sortByTab));
    } catch {
      /* private mode — ignore */
    }
  }, [sortByTab]);
  const sortBy = sortByTab[tab];
  const setSortBy = (v: string) => setSortByTab((s) => ({ ...s, [tab]: v }));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sort/view popover (custom, so it can hold a "Sort by" header + a "View as"
  // icon row — more than the flat ContextMenu can). Position captured on open.
  const [sortOpen, setSortOpen] = useState(false);
  const [sortPos, setSortPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });
  // View mode is PER TAB (each remembers its own list/grid choice, with a
  // sensible default: grid for the art-forward tabs, list for songs).
  const [viewByTab, setViewByTab] = useState<Record<Tab, ViewMode>>(() => {
    try {
      const raw = localStorage.getItem('beetbot.library.views');
      if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) };
    } catch {
      /* fall through */
    }
    return DEFAULT_VIEW;
  });
  useEffect(() => {
    try {
      localStorage.setItem('beetbot.library.views', JSON.stringify(viewByTab));
    } catch {
      /* private mode — ignore */
    }
  }, [viewByTab]);
  const viewMode = viewByTab[tab];
  const setViewMode = (v: ViewMode) =>
    setViewByTab((s) => ({ ...s, [tab]: v }));
  useEffect(() => {
    if (!sortOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSortOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sortOpen]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  const [addToPlaylist, setAddToPlaylist] = useState<{
    track: SearchTrackResult;
    token: string;
  } | null>(null);
  const [share, setShare] = useState<ShareTarget | null>(null);

  const setPlayerQueue = usePlayerStore((s) => s.setQueue);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const openArtist = useNavStore((s) => s.openArtist);
  const openAlbum = useNavStore((s) => s.openAlbum);
  const pins = usePinStore((s) => s.pins);
  const togglePin = usePinStore((s) => s.toggle);
  const savedArtists = useSavedStore((s) => s.artists);
  const toggleSavedArtist = useSavedStore((s) => s.toggleArtist);
  const addSavedArtists = useSavedStore((s) => s.addArtists);
  // Artists/Albums tabs default to what you've *saved*; a toggle flips back to
  // the exhaustive "everything in your songs" derived view.
  const [showAllArtists, setShowAllArtists] = useState(false);
  const [showAllAlbums, setShowAllAlbums] = useState(false);
  // Bulk "Add from your songs" seed sheet (artists).
  const [seedOpen, setSeedOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (activeProfileId == null) return;
    try {
      const pls = await ipc.listPlaylists(activeProfileId);
      setPlaylists(sortPlaylistsByRecent(pls));
    } catch (e) {
      setError(String(e));
    }
  }, [activeProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Each profile's Library is its own saved music (the catalog + audio files
  // stay shared, so playback is still instant for everyone) — clear the cached
  // views when the profile changes so they re-load scoped to the new profile.
  useEffect(() => {
    setSongs(null);
    setDownloadedSongs(null);
    setAlbums(null);
    setArtists(null);
  }, [activeProfileId]);

  // Lazy-load each library view the first time its tab is opened. The "All"
  // tab mixes playlists (already loaded) with albums + artists, so it warms
  // both of those lists.
  useEffect(() => {
    const wantAlbums = (tab === 'albums' || tab === 'all') && albums === null;
    const wantArtists = (tab === 'artists' || tab === 'all') && artists === null;
    if (tab === 'songs' && songs === null) {
      ipc
        .listLibrarySongs(activeProfileId)
        .then(setSongs)
        .catch((e) => setError(String(e)));
    }
    if (tab === 'downloaded' && downloadedSongs === null && activeProfileId != null) {
      ipc
        .listDownloadedSongs(activeProfileId)
        .then(setDownloadedSongs)
        .catch((e) => setError(String(e)));
    }
    if (wantAlbums) {
      ipc
        .listLibraryAlbums(activeProfileId)
        .then(setAlbums)
        .catch((e) => setError(String(e)));
    }
    if (wantArtists) {
      ipc
        .listLibraryArtists(activeProfileId)
        .then(setArtists)
        .catch((e) => setError(String(e)));
    }
  }, [tab, songs, downloadedSongs, albums, artists, activeProfileId]);

  // Re-fetch the loaded library lists when the library changes elsewhere —
  // un-saving an album (or adding a track that enters the library) from the
  // floating overlay that sits over this still-mounted page would otherwise
  // leave the grid stale until you switch tabs. Refetch in place (no null flash);
  // the Saved-artists view stays on the reactive useSavedStore. On mount the
  // lists are null, so this is a no-op until a real change fires.
  const libTick = useLibraryChangeTick();
  useEffect(() => {
    if (albums !== null)
      void ipc.listLibraryAlbums(activeProfileId).then(setAlbums).catch(() => {});
    if (songs !== null)
      void ipc.listLibrarySongs(activeProfileId).then(setSongs).catch(() => {});
    if (downloadedSongs !== null && activeProfileId != null)
      void ipc.listDownloadedSongs(activeProfileId).then(setDownloadedSongs).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch on a library change only
  }, [libTick]);

  // Switching tabs clears the filter + collapses search. The sort is NOT reset
  // here — each tab keeps its own persisted sort (sortByTab above).
  useEffect(() => {
    setFilter('');
    setSearchOpen(false);
  }, [tab]);

  const f = filter.trim().toLowerCase();

  const recentsVersion = useRecentlyPlayedVersion();
  const visiblePlaylists = useMemo(() => {
    let out = f
      ? playlists.filter((p) => p.name.toLowerCase().includes(f))
      : playlists;
    if (sortBy === 'name')
      out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'added')
      out = [...out].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    else out = sortPlaylistsByRecent(out); // 'recent'
    return out;
  // `recentsVersion` isn't read in the body on purpose: it's the signal that the
  // hub's shared recency merged in. Dropping it would silently stop the other
  // device's plays from ever reordering this list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, f, sortBy, recentsVersion]);

  const visibleSongs = useMemo(() => {
    if (!songs) return null;
    let out = !f
      ? songs
      : songs.filter(
          (s) =>
            s.title.toLowerCase().includes(f) ||
            (s.album ?? '').toLowerCase().includes(f) ||
            s.artists.some((a) => a.toLowerCase().includes(f)),
        );
    out = [...out].sort((a, b) => {
      if (sortBy === 'artist')
        return (a.artists[0] ?? '').localeCompare(b.artists[0] ?? '');
      if (sortBy === 'recent') return (b.added_at ?? 0) - (a.added_at ?? 0);
      if (sortBy === 'duration') return a.duration_ms - b.duration_ms;
      return a.title.localeCompare(b.title);
    });
    return out;
  }, [songs, f, sortBy]);

  // Same filter/sort for the Downloaded tab (its own device-wide, per-profile
  // source rather than the library-songs list).
  const visibleDownloaded = useMemo(() => {
    if (!downloadedSongs) return null;
    let out = !f
      ? downloadedSongs
      : downloadedSongs.filter(
          (s) =>
            s.title.toLowerCase().includes(f) ||
            (s.album ?? '').toLowerCase().includes(f) ||
            s.artists.some((a) => a.toLowerCase().includes(f)),
        );
    out = [...out].sort((a, b) => {
      if (sortBy === 'artist')
        return (a.artists[0] ?? '').localeCompare(b.artists[0] ?? '');
      if (sortBy === 'recent') return (b.added_at ?? 0) - (a.added_at ?? 0);
      if (sortBy === 'duration') return a.duration_ms - b.duration_ms;
      return a.title.localeCompare(b.title);
    });
    return out;
  }, [downloadedSongs, f, sortBy]);

  const visibleAlbums = useMemo(() => {
    if (!albums) return null;
    let out = !f
      ? albums
      : albums.filter(
          (a) =>
            a.album.toLowerCase().includes(f) ||
            (a.artist ?? '').toLowerCase().includes(f),
        );
    out = [...out].sort((a, b) => {
      if (sortBy === 'artist')
        return (a.artist ?? '').localeCompare(b.artist ?? '');
      if (sortBy === 'count') return b.track_count - a.track_count;
      return a.album.localeCompare(b.album);
    });
    return out;
  }, [albums, f, sortBy]);

  // Albums tab split: real (multi-track) albums up top; 1-track entries — the
  // long tail of saved loosies whose canonical "album" is mostly noise (~94%
  // of groups) — collapse behind a "Singles" section so the grid reads as
  // albums, not a wall of singles. An active filter auto-expands it so search
  // never hides matches.
  const [showSingles, setShowSingles] = useState(false);
  const multiAlbums = useMemo(
    () => visibleAlbums?.filter((a) => a.track_count >= 2) ?? null,
    [visibleAlbums],
  );
  const singleAlbums = useMemo(
    () => visibleAlbums?.filter((a) => a.track_count < 2) ?? null,
    [visibleAlbums],
  );
  const singlesOpen = showSingles || Boolean(f);

  // Saved albums = the albums you deliberately imported (source='album'
  // playlists), as opposed to every album derived from your songs. They stay
  // playlists under the hood, so they open + play by playlist id.
  const savedAlbums = useMemo(() => {
    let out = playlists.filter((p) => p.source === 'album');
    if (f)
      out = out.filter(
        (p) =>
          p.name.toLowerCase().includes(f) ||
          (p.owner ?? '').toLowerCase().includes(f),
      );
    out = [...out].sort((a, b) => {
      if (sortBy === 'artist') return (a.owner ?? '').localeCompare(b.owner ?? '');
      if (sortBy === 'count') return b.track_count - a.track_count;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [playlists, f, sortBy]);

  const visibleArtists = useMemo(() => {
    if (!artists) return null;
    let out = !f
      ? artists
      : artists.filter((a) => a.name.toLowerCase().includes(f));
    out = [...out].sort((a, b) => {
      if (sortBy === 'count') return b.track_count - a.track_count;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [artists, f, sortBy]);

  // The saved-artists view: the ones deliberately kept, rendered as LibraryArtist
  // cards. Song counts + a fresher cover are joined from the derived list (which
  // the Artists tab loads anyway); a saved artist with no songs shows 0.
  const savedArtistCards = useMemo<LibraryArtist[] | null>(() => {
    if (artists === null) return null; // still loading — need counts to render
    const byName = new Map(artists.map((a) => [a.name.toLowerCase(), a]));
    let out: LibraryArtist[] = savedArtists.map((s) => {
      const d = byName.get(s.name.toLowerCase());
      return {
        key: d?.key ?? s.key,
        name: s.name,
        album_art_url: d?.album_art_url ?? s.art,
        track_count: d?.track_count ?? 0,
      };
    });
    if (f) out = out.filter((a) => a.name.toLowerCase().includes(f));
    out = [...out].sort((a, b) => {
      if (sortBy === 'count') return b.track_count - a.track_count;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [savedArtists, artists, f, sortBy]);

  // "All" view — one Spotify-style list mixing playlists + albums + artists so
  // the page opens on everything you actually touch, no tab-hopping. Singles
  // (1-track "albums") are left out so the mix reads as real records, not the
  // long tail of loosies. Recency only exists for playlists (recently-played),
  // so on "Recents" those float up and the rest follows alphabetically.
  const visibleAll = useMemo(() => {
    const recents = getRecentlyPlayedPlaylists();
    const items: AllItem[] = [];
    // An imported album is both an album-source playlist AND a derived library
    // album — key the playlist form so the derived one can be skipped (no dupes).
    const albumPlaylistKeys = new Set(
      playlists
        .filter((p) => p.source === 'album')
        .map((p) => `${p.name.toLowerCase()}:${(p.owner ?? '').toLowerCase()}`),
    );
    for (const p of playlists) {
      if (f && !p.name.toLowerCase().includes(f)) continue;
      items.push({
        kind: 'playlist',
        key: `p:${p.id}`,
        name: p.name,
        recent: recents.get(p.id) ?? 0,
        playlist: p,
      });
    }
    for (const a of albums ?? []) {
      if (a.track_count < 2) continue; // singles → belong under the Albums tab
      if (
        albumPlaylistKeys.has(
          `${a.album.toLowerCase()}:${(a.artist ?? '').toLowerCase()}`,
        )
      )
        continue; // already shown as its saved album-playlist
      if (
        f &&
        !a.album.toLowerCase().includes(f) &&
        !(a.artist ?? '').toLowerCase().includes(f)
      )
        continue;
      items.push({
        kind: 'album',
        key: `al:${a.album}:${a.artist ?? ''}`,
        name: a.album,
        recent: 0,
        album: a,
      });
    }
    for (const a of artists ?? []) {
      if (f && !a.name.toLowerCase().includes(f)) continue;
      items.push({
        kind: 'artist',
        key: `ar:${a.key}`,
        name: a.name,
        recent: 0,
        artist: a,
      });
    }
    items.sort((x, y) => {
      if (sortBy === 'name') return x.name.localeCompare(y.name);
      if (y.recent !== x.recent) return y.recent - x.recent; // 'recent'
      return x.name.localeCompare(y.name);
    });
    return items;
  // `recentsVersion` isn't read in the body on purpose: it's the signal that the
  // hub's shared recency merged in. Dropping it would silently stop the other
  // device's plays from ever reordering this list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, albums, artists, f, sortBy, recentsVersion]);

  const onPlaySong = useCallback(
    (clicked: PlaylistTrack, list: PlaylistTrack[]) => {
      const playable = list.filter(canStream);
      const idx = playable.findIndex((t) => t.id === clicked.id);
      if (idx < 0) return;
      setPlayerQueue(playable, idx);
    },
    [setPlayerQueue],
  );

  // Card play buttons. Albums/artists are just groups of the library's songs, so
  // a card plays the matching downloaded tracks. `songs` is lazy-loaded (only
  // when the Songs tab is opened), so on the Albums/Artists tabs it's usually
  // null — fetch the list on demand and warm the cache so it's a no-op next time.
  const ensureSongs = useCallback(async (): Promise<PlaylistTrack[]> => {
    if (songs) return songs;
    const all = await ipc.listLibrarySongs(activeProfileId);
    setSongs(all);
    return all;
  }, [songs, activeProfileId]);
  const playAlbum = useCallback(
    (a: LibraryAlbum) => {
      void ensureSongs()
        .then((all) => {
          const list = all.filter(
            (t) =>
              (t.album ?? '') === a.album &&
              (a.artist == null || t.artists.includes(a.artist)),
          );
          const playable = list.filter(canStream);
          if (playable.length) setPlayerQueue(playable, 0);
        })
        .catch(() => {
          /* leave the card as-is on failure */
        });
    },
    [ensureSongs, setPlayerQueue],
  );
  const playArtist = useCallback(
    (a: LibraryArtist) => {
      void ensureSongs()
        .then((all) => {
          const list = all.filter((t) => t.artists.includes(a.name));
          const playable = list.filter(canStream);
          if (playable.length) setPlayerQueue(playable, 0);
        })
        .catch(() => {
          /* leave the card as-is on failure */
        });
    },
    [ensureSongs, setPlayerQueue],
  );
  const playPlaylist = useCallback(
    (p: PlaylistSummary) => {
      void ipc
        .listTracks(p.id)
        .then((list) => {
          const playable = list.filter(canStream);
          if (playable.length) setPlayerQueue(playable, 0);
        })
        .catch(() => {
          /* leave the card as-is on failure */
        });
    },
    [setPlayerQueue],
  );

  // Spotify-style "Add to playlist" picker (Liked Songs pinned), reusing the
  // shared modal — same path the player bar uses for the now-playing track.
  const openAddToPlaylist = useCallback(
    (t: PlaylistTrack) => {
      void ensureSession().then((tok) =>
        getTrackPlaylistIds(t.id, tok, activeProfileId)
          .catch(() => [] as number[])
          .then((inIds) => {
            setAddToPlaylist({
              token: tok,
              track: playlistTrackToSearch(t, { inPlaylistIds: inIds }),
            });
          }),
      );
    },
    [activeProfileId],
  );

  const openMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  // ---- Context-menu item builders ----
  const songMenu = (t: PlaylistTrack): MenuItem[] => {
    const artist = t.artists[0] ?? null;
    const pid = activeProfileId; // captured for the download actions' closures
    const pin: Pin = {
      kind: 'song',
      id: t.id,
      title: t.title,
      artist,
      art: t.album_art_url,
    };
    return [
      {
        label: 'Play',
        icon: MenuGlyphs.play,
        disabled: !t.local_path,
        onClick: () => onPlaySong(t, visibleSongs ?? []),
      },
      {
        label: 'Add to playlist…',
        icon: MenuGlyphs.addToPlaylist,
        onClick: () => openAddToPlaylist(t),
      },
      ...(canDownload && pid != null && !(t.local_path != null || t.status === 'downloaded')
        ? [
            {
              label: 'Download',
              icon: MenuGlyphs.download,
              onClick: () => {
                void startDownload(t.id, pid);
              },
            },
          ]
        : []),
      ...(canDownload && pid != null && (t.local_path != null || t.status === 'downloaded')
        ? [
            {
              label: 'Remove download',
              icon: MenuGlyphs.download,
              onClick: () => {
                void removeDownload(t.id, pid);
              },
            },
          ]
        : []),
      ...(t.local_path
        ? [
            {
              label: 'Show in Finder',
              icon: MenuGlyphs.folder,
              onClick: () => {
                void ipc.revealInFinder(t.local_path!).catch(() => {});
              },
            },
          ]
        : []),
      ...(artist
        ? [
            {
              label: 'Go to artist',
              icon: MenuGlyphs.artist,
              onClick: () => openArtist(artist),
            },
          ]
        : []),
      ...(t.album
        ? [
            {
              label: 'Go to album',
              icon: MenuGlyphs.album,
              onClick: () => openAlbum(t.album!, artist),
            },
          ]
        : []),
      {
        label: 'Share…',
        icon: MenuGlyphs.share,
        separator: true,
        onClick: () =>
          setShare({
            title: t.title,
            artist,
            spotifyId: spotifyTrackId(t.spotify_id),
            art: t.album_art_url,
          }),
      },
      {
        label: isPinned(pins, pin) ? 'Unpin from sidebar' : 'Pin to sidebar',
        icon: MenuGlyphs.pin,
        onClick: () => togglePin(pin),
      },
    ];
  };
  const albumMenu = (a: LibraryAlbum): MenuItem[] => {
    const pin: Pin = {
      kind: 'album',
      album: a.album,
      artist: a.artist,
      art: a.album_art_url,
    };
    return [
      { label: 'Open album', onClick: () => openAlbum(a.album, a.artist) },
      ...(a.artist
        ? [
            {
              label: 'Go to artist',
              icon: MenuGlyphs.artist,
              onClick: () => openArtist(a.artist!),
            },
          ]
        : []),
      {
        label: isPinned(pins, pin) ? 'Unpin from sidebar' : 'Pin to sidebar',
        icon: MenuGlyphs.pin,
        onClick: () => togglePin(pin),
      },
    ];
  };
  const artistMenu = (a: LibraryArtist): MenuItem[] => {
    const pin: Pin = {
      kind: 'artist',
      key: a.key,
      name: a.name,
      art: a.album_art_url,
    };
    const saved = isArtistSaved(savedArtists, a.name);
    return [
      { label: 'Open artist', onClick: () => openArtist(a.name) },
      {
        label: saved ? 'Remove from your library' : 'Save to your library',
        icon: saved ? MenuGlyphs.check : MenuGlyphs.plus,
        onClick: () =>
          toggleSavedArtist({ key: a.key, name: a.name, art: a.album_art_url }),
      },
      {
        label: isPinned(pins, pin) ? 'Unpin from sidebar' : 'Pin to sidebar',
        icon: MenuGlyphs.pin,
        onClick: () => togglePin(pin),
      },
    ];
  };
  const playlistMenu = (p: PlaylistSummary): MenuItem[] => {
    const pin: Pin = {
      kind: 'playlist',
      id: p.id,
      name: p.name,
      art: p.cover_url,
      source: p.source,
    };
    return [
      { label: 'Open', onClick: () => onOpenPlaylist(p.id) },
      {
        label: isPinned(pins, pin) ? 'Unpin from sidebar' : 'Pin to sidebar',
        icon: MenuGlyphs.pin,
        onClick: () => togglePin(pin),
      },
    ];
  };

  const searchPlaceholder =
    tab === 'all'
      ? 'Search your library…'
      : tab === 'playlists'
        ? 'Filter playlists…'
        : tab === 'songs'
          ? 'Filter songs…'
          : tab === 'downloaded'
            ? 'Filter downloaded…'
            : tab === 'albums'
              ? 'Filter albums…'
              : 'Filter artists…';

  return (
    // The header sits OUTSIDE the scroller, and only the list scrolls. It
    // was a sticky header inside it, which pinned the controls correctly but
    // left the scrollbar running the full height of the card — a track and
    // thumb beside a header that never moves. Chrome above, scrollport
    // below: the scrollbar now measures exactly what it scrolls.
    <div className="h-full flex flex-col max-w-6xl mx-auto">
      {/* The tab chips, sort and search are how you steer a long library,
          so they stay put — scrolling used to carry them away, and
          narrowing a list meant scrolling back to the top first. */}
      <header className="shrink-0 border-b border-white/5 px-8 pt-6 pb-4">
        <h1 className="text-3xl font-bold tracking-tight">Library</h1>
        {/* Chips (type filters) on the left; sort/view + search share the row on
            the right, so the controls sit next to what they act on. */}
        <div className="mt-3 flex items-center gap-1">
          {TABS.filter((t) => t.id !== 'downloaded' || canDownload).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-full text-sm transition ${
                tab === t.id
                  ? 'bg-white/10 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {/* Trigger shows just the current sort value + a glyph mirroring the
                current view mode (list/grid); the "Sort by" title lives inside
                the popover, Spotify-style. The value sits in a fixed-width,
                right-aligned slot so the button doesn't shift as it changes. */}
            <button
              ref={sortBtnRef}
              type="button"
              aria-label="Sort and view options"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={() => {
                const r = sortBtnRef.current?.getBoundingClientRect();
                if (r)
                  setSortPos({
                    top: r.bottom + 6,
                    right: window.innerWidth - r.right,
                  });
                setSortOpen((o) => !o);
              }}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-neutral-300 hover:text-neutral-100 hover:bg-white/5 transition"
            >
              <span className="max-w-28 truncate">
                {SORTS[tab].find((s) => s.id === sortBy)?.label ??
                  SORTS[tab][0].label}
              </span>
              <span className="shrink-0 text-neutral-400">
                {VIEW_MODES.find((v) => v.id === viewMode)?.icon}
              </span>
            </button>
            {/* Search collapses to an icon; clicking expands an inline field,
                which snaps back to the icon once it's emptied + blurred. */}
            {searchOpen ? (
              <input
                ref={searchRef}
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onBlur={() => {
                  if (!filter.trim()) setSearchOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setFilter('');
                    setSearchOpen(false);
                  }
                }}
                placeholder={searchPlaceholder}
                className="w-56 rounded-lg bg-neutral-900 border border-neutral-800 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-400"
              />
            ) : (
              <button
                type="button"
                aria-label="Search library"
                onClick={() => setSearchOpen(true)}
                className="grid h-9 w-9 place-items-center rounded-lg text-neutral-300 hover:text-neutral-100 hover:bg-white/5 transition"
              >
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </header>
      {/* `relative` stays on the scroller: the virtualizers read
          `listRef.offsetTop` for their scrollMargin, which has to be
          measured against the element that actually scrolls. */}
      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-auto px-8 pt-6 pb-8">

      {error && (
        <div className={cn(CALLOUT_ERROR, 'mb-4')}>
          {error}
        </div>
      )}

      {tab === 'all' &&
        (albums === null || artists === null ? (
          <GridSkeleton />
        ) : visibleAll.length === 0 ? (
          f ? (
            <Hint>No matches.</Hint>
          ) : (
            <EmptyLibrary onOpenSettings={onOpenSettings} />
          )
        ) : (
          <VirtualCards
            items={visibleAll}
            grid={viewMode === 'grid'}
            scrollRef={scrollRef}
            keyOf={(it) => it.key}
            renderRow={(it) =>
              it.kind === 'playlist' ? (
                <LibRow
                  art={it.playlist.cover_url}
                  title={it.playlist.name}
                  subtitle={playlistSubtitle(it.playlist)}
                  onOpen={() => onOpenPlaylist(it.playlist.id)}
                  onContext={(e) => openMenu(e, playlistMenu(it.playlist))}
                />
              ) : it.kind === 'album' ? (
                <LibRow
                  art={it.album.album_art_url}
                  title={it.album.album}
                  subtitle={`Album · ${it.album.artist ?? 'Various'}`}
                  onOpen={() => openAlbum(it.album.album, it.album.artist)}
                  onContext={(e) => openMenu(e, albumMenu(it.album))}
                />
              ) : (
                <LibRow
                  round
                  art={it.artist.album_art_url}
                  title={it.artist.name}
                  subtitle={`Artist · ${it.artist.track_count} ${
                    it.artist.track_count === 1 ? 'song' : 'songs'
                  }`}
                  onOpen={() => openArtist(it.artist.name)}
                  onContext={(e) => openMenu(e, artistMenu(it.artist))}
                />
              )
            }
            renderCard={(it) =>
              it.kind === 'playlist' ? (
                <div
                  onContextMenu={(e) => openMenu(e, playlistMenu(it.playlist))}
                >
                  <PlaylistCard
                    playlist={it.playlist}
                    onOpen={onOpenPlaylist}
                    onPlay={playPlaylist}
                  />
                </div>
              ) : it.kind === 'album' ? (
                <AlbumCard
                  album={it.album}
                  onOpen={() => openAlbum(it.album.album, it.album.artist)}
                  onPlay={() => playAlbum(it.album)}
                  onContext={(e) => openMenu(e, albumMenu(it.album))}
                />
              ) : (
                <ArtistCard
                  artist={it.artist}
                  onOpen={() => openArtist(it.artist.name)}
                  onPlay={() => playArtist(it.artist)}
                  onContext={(e) => openMenu(e, artistMenu(it.artist))}
                />
              )
            }
          />
        ))}

      {tab === 'playlists' &&
        (playlists.length === 0 ? (
          <EmptyLibrary onOpenSettings={onOpenSettings} />
        ) : (
          <VirtualCards
            items={visiblePlaylists}
            grid={viewMode === 'grid'}
            scrollRef={scrollRef}
            keyOf={(p) => String(p.id)}
            renderRow={(p) => (
              <LibRow
                art={p.cover_url}
                title={p.name}
                subtitle={playlistSubtitle(p)}
                onOpen={() => onOpenPlaylist(p.id)}
                onContext={(e) => openMenu(e, playlistMenu(p))}
              />
            )}
            renderCard={(p) => (
              <div onContextMenu={(e) => openMenu(e, playlistMenu(p))}>
                <PlaylistCard
                  playlist={p}
                  onOpen={onOpenPlaylist}
                  onPlay={playPlaylist}
                />
              </div>
            )}
          />
        ))}

      {tab === 'songs' &&
        (visibleSongs === null ? (
          <RowsSkeleton />
        ) : visibleSongs.length === 0 ? (
          <Hint>{f ? 'No matches.' : 'No songs in your library yet.'}</Hint>
        ) : (
          <VirtualSongs
            songs={visibleSongs}
            grid={viewMode === 'grid'}
            scrollRef={scrollRef}
            onPlay={onPlaySong}
            onContext={(t, e) => openMenu(e, songMenu(t))}
          />
        ))}

      {tab === 'downloaded' &&
        (visibleDownloaded === null ? (
          <RowsSkeleton />
        ) : visibleDownloaded.length === 0 ? (
          <Hint>
            {f
              ? 'No matches.'
              : 'No downloaded songs yet. Open a song’s ⋯ menu and choose Download.'}
          </Hint>
        ) : (
          <VirtualSongs
            songs={visibleDownloaded}
            grid={viewMode === 'grid'}
            scrollRef={scrollRef}
            onPlay={onPlaySong}
            onContext={(t, e) => openMenu(e, songMenu(t))}
          />
        ))}

      {tab === 'albums' &&
        (() => {
          const toggle = (
            <SourceToggle
              showAll={showAllAlbums}
              onChange={setShowAllAlbums}
              savedLabel="Saved albums"
            />
          );
          // Default: albums you saved (album-imports). They're playlists under
          // the hood, so they open + play by id.
          if (!showAllAlbums) {
            if (savedAlbums.length === 0 && !f) {
              return (
                <>
                  {toggle}
                  <SavedEmpty
                    kind="album"
                    onBrowseAll={() => setShowAllAlbums(true)}
                  />
                </>
              );
            }
            return (
              <>
                {toggle}
                {savedAlbums.length === 0 ? (
                  <Hint>No matches.</Hint>
                ) : (
                  <VirtualCards
                    items={savedAlbums}
                    grid={viewMode === 'grid'}
                    scrollRef={scrollRef}
                    keyOf={(p) => String(p.id)}
                    renderRow={(p) => (
                      <LibRow
                        art={p.cover_url}
                        title={p.name}
                        subtitle={`Album · ${p.owner ?? 'Various'}`}
                        onOpen={() => onOpenPlaylist(p.id)}
                        onContext={(e) => openMenu(e, playlistMenu(p))}
                      />
                    )}
                    renderCard={(p) => (
                      <AlbumCard
                        album={{
                          album: p.name,
                          artist: p.owner,
                          album_art_url: p.cover_url,
                          track_count: p.track_count,
                        }}
                        onOpen={() => onOpenPlaylist(p.id)}
                        onPlay={() => playPlaylist(p)}
                        onContext={(e) => openMenu(e, playlistMenu(p))}
                      />
                    )}
                  />
                )}
              </>
            );
          }
          // Toggle: every album derived from your songs.
          return (
            <>
              {toggle}
              {visibleAlbums === null ? (
                <GridSkeleton />
              ) : visibleAlbums.length === 0 ? (
                <Hint>{f ? 'No matches.' : 'No albums in your library yet.'}</Hint>
              ) : (
                <>
                  {multiAlbums && multiAlbums.length > 0 && (
              <VirtualCards
                items={multiAlbums}
                grid={viewMode === 'grid'}
                scrollRef={scrollRef}
                keyOf={(a) => `${a.album} ${a.artist ?? ''}`}
                renderRow={(a) => (
                  <LibRow
                    art={a.album_art_url}
                    title={a.album}
                    subtitle={`${a.artist ?? 'Album'} · ${a.track_count} ${
                      a.track_count === 1 ? 'song' : 'songs'
                    }`}
                    onOpen={() => openAlbum(a.album, a.artist)}
                    onContext={(e) => openMenu(e, albumMenu(a))}
                  />
                )}
                renderCard={(a) => (
                  <AlbumCard
                    album={a}
                    onOpen={() => openAlbum(a.album, a.artist)}
                    onPlay={() => playAlbum(a)}
                    onContext={(e) => openMenu(e, albumMenu(a))}
                  />
                )}
              />
            )}
            {singleAlbums && singleAlbums.length > 0 && (
              <section
                className={
                  multiAlbums && multiAlbums.length > 0 ? 'mt-8' : undefined
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    // While a filter is active the section is force-expanded;
                    // flipping the hidden state then would just leave it stuck
                    // open after the filter clears.
                    if (f) return;
                    setShowSingles((v) => !v);
                  }}
                  aria-expanded={singlesOpen}
                  className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-300 hover:text-white transition"
                >
                  <svg
                    className={`transition-transform ${singlesOpen ? 'rotate-90' : ''}`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  Singles
                  <span className="font-normal text-neutral-500">
                    {singleAlbums.length}
                  </span>
                </button>
                {singlesOpen && (
                  <VirtualCards
                    items={singleAlbums}
                    grid={viewMode === 'grid'}
                    scrollRef={scrollRef}
                    keyOf={(a) => `${a.album} ${a.artist ?? ''}`}
                    renderRow={(a) => (
                      <LibRow
                        art={a.album_art_url}
                        title={a.album}
                        subtitle={`${a.artist ?? 'Single'} · ${a.track_count} ${
                          a.track_count === 1 ? 'song' : 'songs'
                        }`}
                        onOpen={() => openAlbum(a.album, a.artist)}
                        onContext={(e) => openMenu(e, albumMenu(a))}
                      />
                    )}
                    renderCard={(a) => (
                      <AlbumCard
                        album={a}
                        onOpen={() => openAlbum(a.album, a.artist)}
                        onPlay={() => playAlbum(a)}
                        onContext={(e) => openMenu(e, albumMenu(a))}
                      />
                    )}
                  />
                )}
              </section>
            )}
                </>
              )}
            </>
          );
        })()}

      {tab === 'artists' &&
        (() => {
          // Default: artists you saved. Toggle: everyone in your songs.
          const cards = showAllArtists ? visibleArtists : savedArtistCards;
          if (cards === null) return <GridSkeleton />;
          const emptySaved = !showAllArtists && savedArtists.length === 0;
          return (
            <>
              <div className="flex items-center justify-between gap-3">
                <SourceToggle
                  showAll={showAllArtists}
                  onChange={setShowAllArtists}
                  savedLabel="Saved artists"
                />
                {!showAllArtists && savedArtists.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSeedOpen(true)}
                    className="mb-5 shrink-0 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] text-neutral-300 transition hover:border-neutral-400 hover:text-white"
                  >
                    + Add from your songs
                  </button>
                )}
              </div>
              {emptySaved ? (
                <SavedEmpty
                  kind="artist"
                  onSeed={() => setSeedOpen(true)}
                  onBrowseAll={() => setShowAllArtists(true)}
                />
              ) : cards.length === 0 ? (
                <Hint>{f ? 'No matches.' : 'No artists in your library yet.'}</Hint>
              ) : (
                <VirtualCards
                  items={cards}
                  grid={viewMode === 'grid'}
                  scrollRef={scrollRef}
                  keyOf={(a) => a.key}
                  renderRow={(a) => (
                    <LibRow
                      round
                      art={a.album_art_url}
                      title={a.name}
                      subtitle={`Artist · ${a.track_count} ${
                        a.track_count === 1 ? 'song' : 'songs'
                      }`}
                      onOpen={() => openArtist(a.name)}
                      onContext={(e) => openMenu(e, artistMenu(a))}
                    />
                  )}
                  renderCard={(a) => (
                    <ArtistCard
                      artist={a}
                      onOpen={() => openArtist(a.name)}
                      onPlay={() => playArtist(a)}
                      onContext={(e) => openMenu(e, artistMenu(a))}
                    />
                  )}
                />
              )}
            </>
          );
        })()}

      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
      {/* Sort + View-as popover (custom: a "Sort by" header, radio options, and
          a "View as" icon row — richer than the flat ContextMenu). */}
      {sortOpen && (
        <>
          <div
            className="fixed inset-0 z-[55]"
            onClick={() => setSortOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className={cn(POPOVER, 'fixed z-[60] w-56 py-1.5')}
            style={{ top: sortPos.top, right: sortPos.right }}
          >
            <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Sort by
            </div>
            {SORTS[tab].map((s) => {
              const on = s.id === sortBy;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    setSortBy(s.id);
                    setSortOpen(false);
                  }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-white/5 transition"
                >
                  <span className={on ? 'text-accent font-medium' : 'text-neutral-200'}>
                    {s.label}
                  </span>
                  {on && (
                    <svg
                      width={16}
                      height={16}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-accent"
                      aria-hidden
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
            <div className="my-1.5 border-t border-white/10" />
            <div className="px-3 pt-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              View as
            </div>
            <div className="flex gap-1 px-2 pb-1">
              {VIEW_MODES.map((v) => {
                const on = viewMode === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    title={v.label}
                    aria-label={v.label}
                    aria-pressed={on}
                    onClick={() => {
                      setViewMode(v.id);
                      setSortOpen(false);
                    }}
                    className={`flex-1 grid place-items-center h-9 rounded-lg transition ${
                      on
                        ? 'bg-white/10 text-accent'
                        : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                    }`}
                  >
                    {v.icon}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      {addToPlaylist && (
        <AddToPlaylistModal
          token={addToPlaylist.token}
          track={addToPlaylist.track}
          activeProfileId={activeProfileId}
          onClose={() => setAddToPlaylist(null)}
        />
      )}
      {share && (
        <ShareDialog target={share} onClose={() => setShare(null)} />
      )}
      {seedOpen && (
        <SeedArtistsSheet
          artists={(artists ?? [])
            .filter((a) => !isArtistSaved(savedArtists, a.name))
            .sort((a, b) => b.track_count - a.track_count)}
          onAdd={(picked) =>
            addSavedArtists(
              picked.map((a) => ({
                key: a.key,
                name: a.name,
                art: a.album_art_url,
              })),
            )
          }
          onClose={() => setSeedOpen(false)}
        />
      )}
      </div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 p-8 text-center text-neutral-500 text-sm">
      {children}
    </div>
  );
}

/** "Saved" ⇄ "From your songs" segmented toggle for the Artists/Albums tabs. */
function SourceToggle({
  showAll,
  onChange,
  savedLabel,
}: {
  showAll: boolean;
  onChange: (v: boolean) => void;
  savedLabel: string;
}) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: savedLabel },
    { v: true, label: 'From your songs' },
  ];
  return (
    <div className="mb-5 inline-flex items-center gap-0.5 rounded-full bg-white/5 p-0.5 text-[13px]">
      {opts.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={showAll === o.v}
          className={`rounded-full px-3 py-1 transition ${
            showAll === o.v
              ? 'bg-white/10 text-neutral-100'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Empty state for the saved Artists/Albums view — invites saving, with a
 *  one-tap escape hatch to the exhaustive "from your songs" view. */
function SavedEmpty({
  kind,
  onBrowseAll,
  onSeed,
}: {
  kind: 'artist' | 'album';
  onBrowseAll: () => void;
  /** Artists only: opens the bulk "pick from your songs" seed sheet. */
  onSeed?: () => void;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 p-10 text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-white/5 text-xl text-neutral-400">
        {kind === 'artist' ? '☺' : '♪'}
      </div>
      <h2 className="mb-1 text-base font-medium text-neutral-100">
        {kind === 'artist'
          ? 'Artists you save show up here'
          : 'Albums you save show up here'}
      </h2>
      <p className="mx-auto mb-5 max-w-sm text-sm text-neutral-500">
        {kind === 'artist'
          ? 'Open any artist and tap Save to keep them here — separate from every artist across your songs.'
          : 'Save an album to your library and it lands here — separate from every album across your songs.'}
      </p>
      {onSeed ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onSeed}
            className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white"
          >
            Add from your songs
          </button>
          <button
            type="button"
            onClick={onBrowseAll}
            className="text-sm text-neutral-400 transition hover:text-neutral-100"
          >
            or just browse them
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onBrowseAll}
          className="rounded-full bg-white/10 px-4 py-2 text-sm text-neutral-100 transition hover:bg-white/15"
        >
          Show all from your songs
        </button>
      )}
    </div>
  );
}

/** Bulk seed sheet — pick artists from your songs to save into the library in
 *  one pass. Lists every derived artist NOT yet saved, multi-select, then adds
 *  them all via the store's addArtists. */
function SeedArtistsSheet({
  artists,
  onAdd,
  onClose,
}: {
  artists: LibraryArtist[];
  onAdd: (picked: LibraryArtist[]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ql = q.trim().toLowerCase();
  const shown = ql
    ? artists.filter((a) => a.name.toLowerCase().includes(ql))
    : artists;
  const toggle = (key: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allShownPicked = shown.length > 0 && shown.every((a) => picked.has(a.key));
  const toggleAllShown = () =>
    setPicked((s) => {
      const next = new Set(s);
      if (allShownPicked) shown.forEach((a) => next.delete(a.key));
      else shown.forEach((a) => next.add(a.key));
      return next;
    });
  const commit = () => {
    const byKey = new Map(artists.map((a) => [a.key, a]));
    onAdd([...picked].map((k) => byKey.get(k)).filter(Boolean) as LibraryArtist[]);
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Add artists from your songs"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-base font-semibold text-neutral-100">
            Add from your songs
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2 px-5 pb-3">
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter artists…"
            className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={toggleAllShown}
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] text-neutral-300 hover:bg-white/5 hover:text-white"
          >
            {allShownPicked ? 'Clear' : 'Select all'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {shown.length === 0 ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              {artists.length === 0
                ? 'Every artist in your songs is already saved.'
                : 'No matches.'}
            </div>
          ) : (
            shown.map((a) => {
              const on = picked.has(a.key);
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => toggle(a.key)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5"
                >
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border transition ${
                      on
                        ? 'border-accent bg-accent text-neutral-950'
                        : 'border-neutral-600'
                    }`}
                  >
                    {on && (
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-neutral-800">
                    {a.album_art_url && (
                      <img src={a.album_art_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-100">
                      {a.name}
                    </span>
                    <span className="block truncate text-xs text-neutral-500">
                      {a.track_count} {a.track_count === 1 ? 'song' : 'songs'}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-neutral-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-400 transition hover:text-neutral-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={picked.size === 0}
            className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add {picked.size > 0 ? picked.size : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pulsing placeholders while a tab's rows load (matches Home's skeletons). */
function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4" aria-hidden>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-square w-full rounded-lg bg-neutral-800/80" />
          <div className="mt-2 h-3.5 w-3/4 rounded bg-neutral-800/80" />
          <div className="mt-1.5 h-3 w-1/2 rounded bg-neutral-800/80" />
        </div>
      ))}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2 animate-pulse">
          <div className="h-10 w-10 rounded-lg bg-neutral-800/80 shrink-0" />
          <div className="flex-1">
            <div className="h-3.5 w-1/3 rounded bg-neutral-800/80" />
            <div className="mt-1.5 h-3 w-1/4 rounded bg-neutral-800/80" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AlbumCard({
  album,
  onOpen,
  onPlay,
  onContext,
}: {
  album: LibraryAlbum;
  onOpen: () => void;
  /** Hover play button — plays this album's downloaded songs. */
  onPlay?: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card root answers keys — a bubbled Enter/Space from the
        // nested play button must NOT also open the card.
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onContext}
      className="group relative cursor-pointer text-left transition active:scale-[0.98]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className="relative">
          <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {album.album_art_url ? (
              <img
                src={album.album_art_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-neutral-600 text-2xl">♪</span>
            )}
          </div>
          {onPlay ? (
            <CardPlayButton label={`Play ${album.album}`} onPlay={onPlay} />
          ) : null}
        </div>
        <div className="mt-2 truncate text-sm font-medium">{album.album}</div>
        <div className="truncate text-xs text-neutral-500">
          {album.artist ?? 'Various'} · {album.track_count}{' '}
          {album.track_count === 1 ? 'song' : 'songs'}
        </div>
      </div>
    </div>
  );
}

function ArtistCard({
  artist,
  onOpen,
  onPlay,
  onContext,
}: {
  artist: LibraryArtist;
  onOpen: () => void;
  /** Hover play button — plays this artist's downloaded songs. */
  onPlay?: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card root answers keys — a bubbled Enter/Space from the
        // nested play button must NOT also open the card.
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onContext}
      className="group relative cursor-pointer text-center transition active:scale-[0.98]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        {/* Circular avatar; the play button hugs the circle's bottom-right. */}
        <div className="relative mx-auto w-full">
          <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-full bg-neutral-800 ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {artist.album_art_url ? (
              <img
                src={artist.album_art_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-neutral-600 text-2xl">♪</span>
            )}
          </div>
          {onPlay ? (
            <CardPlayButton label={`Play ${artist.name}`} onPlay={onPlay} />
          ) : null}
        </div>
        <div className="mt-2 truncate text-sm font-medium">{artist.name}</div>
        <div className="truncate text-xs text-neutral-500">
          {artist.track_count} {artist.track_count === 1 ? 'song' : 'songs'}
        </div>
      </div>
    </div>
  );
}

/** Library "Songs" list — one row per track, styled to match the album /
 *  playlist track rows exactly: a number gutter that swaps to a ▶ hint on hover
 *  (bouncing equalizer bars while this row is the one playing), a PLAIN cover
 *  (no darkening scrim), a subtle row highlight, and a hover-revealed ⋯ menu.
 *  Same look and hover experience as `TrackRow` — just without the File column,
 *  since the Library page has no per-track "add audio file" flow. */
/** Responsive column count — mirrors the Tailwind grid breakpoints used by
 *  `Grid` (2 / sm:3 / md:4 / lg:5), which key off the viewport width. */
function colsForWidth(w: number): number {
  if (w >= 1024) return 5;
  if (w >= 768) return 4;
  if (w >= 640) return 3;
  return 2;
}

function useViewportWidth(active: boolean): number {
  const [w, setW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );
  useEffect(() => {
    if (!active) return;
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active]);
  return w;
}

const SONG_ROW_H = 56; // h-14
const GRID_GAP = 16; // gap-4

/** One song as a grid card — same hover treatment as the album/artist cards. */
function SongCard({
  track,
  list,
  onPlay,
  onContext,
}: {
  track: PlaylistTrack;
  list: PlaylistTrack[];
  onPlay: (t: PlaylistTrack, list: PlaylistTrack[]) => void;
  onContext: (t: PlaylistTrack, e: React.MouseEvent) => void;
}) {
  const playable = canStream(track);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => playable && onPlay(track, list)}
      onKeyDown={(e) => {
        // Only the card root answers keys — a bubbled Enter/Space from the
        // nested play button must NOT also fire play twice.
        if (
          e.target === e.currentTarget &&
          playable &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onPlay(track, list);
        }
      }}
      onContextMenu={(e) => onContext(track, e)}
      className={`group relative text-left transition active:scale-[0.98] ${
        playable ? 'cursor-pointer' : 'opacity-60'
      }`}
    >
      {/* Padded hover highlight behind the whole card — matches the album /
          artist cards' Spotify-style lift. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-xl transition-colors duration-200 group-hover:bg-white/[0.06]"
      />
      <div className="relative">
        <div className="relative">
          <div className="aspect-square w-full overflow-hidden rounded-lg bg-neutral-800 grid place-items-center ring-1 ring-white/5 transition-shadow duration-200 group-hover:shadow-2xl group-hover:shadow-black/50">
            {track.album_art_url ? (
              <img
                src={track.album_art_url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
            ) : (
              <span className="text-3xl text-neutral-600">♪</span>
            )}
          </div>
          {playable ? (
            <CardPlayButton
              label={`Play ${track.title}`}
              onPlay={() => onPlay(track, list)}
            />
          ) : null}
        </div>
        <div className="mt-2 truncate text-sm font-medium text-neutral-100">
          {track.title}
        </div>
        <div className="truncate text-xs text-neutral-500">
          {track.artists.join(', ') || '—'}
        </div>
      </div>
    </div>
  );
}

/** One song as a list row — styled to match the album/playlist track rows. */
function SongRow({
  track,
  index,
  list,
  current,
  playing,
  last,
  onPlay,
  onContext,
}: {
  track: PlaylistTrack;
  index: number;
  list: PlaylistTrack[];
  current: boolean;
  playing: boolean;
  last: boolean;
  onPlay: (t: PlaylistTrack, list: PlaylistTrack[]) => void;
  onContext: (t: PlaylistTrack, e: React.MouseEvent) => void;
}) {
  const playable = canStream(track);
  return (
    <div
      onClick={() => playable && onPlay(track, list)}
      onContextMenu={(e) => onContext(track, e)}
      className={`group grid grid-cols-[2.5rem_3rem_1fr_1fr_5rem_2.5rem] items-center gap-3 h-14 px-4 transition-colors ${
        last ? '' : 'border-b border-white/5'
      } ${
        playable
          ? `cursor-pointer text-neutral-100 hover:bg-neutral-900/40 ${
              current ? 'bg-neutral-900/50' : ''
            }`
          : 'text-neutral-500'
      }`}
    >
      {/* # → play triangle on hover (equalizer bars while playing). */}
      <span className="relative grid h-full w-full place-items-center text-sm tabular-nums">
        <span
          className={`${current ? 'text-neutral-100' : 'text-neutral-500'} ${
            !playing && playable ? 'group-hover:opacity-0' : ''
          }`}
        >
          {playing ? <EqualizerBars /> : index + 1}
        </span>
        {playable && !playing ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-neutral-100 opacity-0 group-hover:opacity-100">
            <svg className="h-4 w-4 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        ) : null}
      </span>
      {/* Plain cover — no scrim. */}
      <div className="h-10 w-10 rounded-lg bg-neutral-800 overflow-hidden grid place-items-center">
        {track.album_art_url ? (
          <img
            src={track.album_art_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-neutral-600 text-xs">♪</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium" title={track.title}>
          {track.title}
        </div>
        <div className="truncate text-sm text-neutral-500" title={track.artists.join(', ')}>
          {track.artists.join(', ') || '—'}
        </div>
      </div>
      <div className="truncate text-sm text-neutral-400" title={track.album ?? ''}>
        {track.album ?? '—'}
      </div>
      <div className="text-right text-sm text-neutral-500 tabular-nums">
        {formatDuration(track.duration_ms)}
      </div>
      {/* Hover-reveal ⋯ menu — parity with playlist rows (was right-click only). */}
      <div className="grid place-items-center">
        <button
          type="button"
          aria-label={`More options for ${track.title}`}
          title="More options"
          onClick={(e) => {
            e.stopPropagation();
            onContext(track, e);
          }}
          className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * The Library "Songs" tab — grid OR list — VIRTUALIZED. The library can hold
 * thousands of songs; rendering them all at once left a huge DOM that made the
 * whole app's transitions (even the sidebar) stutter while this page was open.
 * We window the rows off the page's scroll container (`scrollRef`), rendering
 * only what's on screen. Grid mode packs `columns` cards per virtual row.
 */
function VirtualSongs({
  songs,
  grid,
  scrollRef,
  onPlay,
  onContext,
}: {
  songs: PlaylistTrack[];
  grid: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onPlay: (t: PlaylistTrack, list: PlaylistTrack[]) => void;
  onContext: (t: PlaylistTrack, e: React.MouseEvent) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const nowPlaying = usePlayerStore(currentTrack);
  const audible = usePlayerStore((s) => s.isPlaying);

  const vw = useViewportWidth(grid);
  const columns = grid ? colsForWidth(vw) : 1;

  // Estimated grid-row height (square art + title/artist + row gap). The
  // virtualizer measures each row too, so this only needs to be close enough
  // to avoid scroll jumps before measurement.
  const estRow = useMemo(() => {
    if (!grid) return SONG_ROW_H;
    const content = Math.min(vw, 1152) - 64; // max-w-6xl minus px-8 * 2
    const card = (content - (columns - 1) * GRID_GAP) / columns;
    return Math.round(card + 44 + GRID_GAP); // + title/artist + gap-4
  }, [grid, vw, columns]);

  const rowCount = Math.ceil(songs.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estRow,
    overscan: 6,
    scrollMargin,
  });

  // The songs list sits below the page header/chips, so tell the virtualizer
  // how far down it starts (its offset within the positioned scroll container).
  useLayoutEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [grid, columns, songs.length]);

  // Re-measure when the estimate changes (viewport resize / mode switch).
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [estRow, virtualizer]);

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const start = vi.index * columns;
        const rowSongs = songs.slice(start, start + columns);
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start - scrollMargin}px)`,
            }}
          >
            {grid ? (
              <div
                className="grid gap-4 pb-4"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {rowSongs.map((t) => (
                  <SongCard
                    key={t.id}
                    track={t}
                    list={songs}
                    onPlay={onPlay}
                    onContext={onContext}
                  />
                ))}
              </div>
            ) : (
              rowSongs.map((t) => (
                <SongRow
                  key={t.id}
                  track={t}
                  index={start}
                  list={songs}
                  current={nowPlaying?.id === t.id}
                  playing={nowPlaying?.id === t.id && audible}
                  last={start === songs.length - 1}
                  onPlay={onPlay}
                  onContext={onContext}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Generic virtualized card/row list — the album & artist tabs' equivalent of
 * VirtualSongs. Windows a FLAT array of items off the page's scroll container,
 * rendering only what's on screen (grid packs `columns` cards per virtual row).
 * Callers supply per-item render functions so the same windowing serves albums
 * (AlbumCard / LibRow) and artists (ArtistCard / round LibRow).
 */
function VirtualCards<T>({
  items,
  grid,
  scrollRef,
  keyOf,
  renderCard,
  renderRow,
  listRowH = 64,
}: {
  items: T[];
  grid: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  keyOf: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  renderRow: (item: T) => ReactNode;
  /** Estimated list-row height (LibRow ≈ 64px); measured per-row after mount. */
  listRowH?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const vw = useViewportWidth(grid);
  const columns = grid ? colsForWidth(vw) : 1;

  const estRow = useMemo(() => {
    if (!grid) return listRowH;
    const content = Math.min(vw, 1152) - 64; // max-w-6xl minus px-8 * 2
    const card = (content - (columns - 1) * GRID_GAP) / columns;
    return Math.round(card + 44 + GRID_GAP); // + title/subtitle + gap-4
  }, [grid, vw, columns, listRowH]);

  const rowCount = Math.ceil(items.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estRow,
    overscan: 6,
    scrollMargin,
  });

  useLayoutEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [grid, columns, items.length]);
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [estRow, virtualizer]);

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const start = vi.index * columns;
        const rowItems = items.slice(start, start + columns);
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start - scrollMargin}px)`,
            }}
          >
            {grid ? (
              <div
                className="grid gap-4 pb-4"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {rowItems.map((it) => (
                  <div key={keyOf(it)}>{renderCard(it)}</div>
                ))}
              </div>
            ) : (
              rowItems.map((it) => <div key={keyOf(it)}>{renderRow(it)}</div>)
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyLibrary({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-lg border border-neutral-800 p-12 text-center">
      <div className="text-5xl mb-3">♪</div>
      <h2 className="text-lg font-medium mb-1">No music yet</h2>
      <p className="text-sm text-neutral-500 mb-5 max-w-md mx-auto">
        Get music in from Settings: import from Spotify, Apple Music,
        SoundCloud, or a CSV.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="rounded-lg px-4 py-2 bg-neutral-100 hover:bg-white text-neutral-950 font-medium transition"
      >
        Open Settings
      </button>
    </div>
  );
}
