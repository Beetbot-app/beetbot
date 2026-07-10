import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PlaylistCard } from '@/components/PlaylistCard';
import { CardPlayButton } from '@shared/components/Marquee';
import { ContextMenu, MenuGlyphs, type MenuItem, type MenuState } from '@shared/components/ContextMenu';
import { formatDuration } from '@/lib/format';
import { cn, POPOVER } from '@shared/ui';
import { canStream, usePlayerStore } from '@/lib/store';
import { useProfileStore } from '@/lib/profile';
import { useNavStore } from '@/lib/nav';
import { isPinned, usePinStore, type Pin } from '@/lib/pins';
import {
  ipc,
  type LibraryAlbum,
  type LibraryArtist,
  type PlaylistSummary,
  type PlaylistTrack,
} from '@/lib/tauri';
import {
  ensureSession,
  getTrackPlaylistIds,
  sortPlaylistsByRecent,
  type SearchTrackResult,
} from '@shared/api';
import { AddToPlaylistModal } from '@shared/components/SearchScreen';
import {
  ShareDialog,
  spotifyTrackId,
  type ShareTarget,
} from '@/components/ShareDialog';

interface Props {
  onOpenPlaylist: (id: number) => void;
  onOpenSettings: () => void;
}

type Tab = 'playlists' | 'artists' | 'albums' | 'songs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'playlists', label: 'Playlists' },
  { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' },
  { id: 'songs', label: 'Songs' },
];

const SORTS: Record<Tab, { id: string; label: string }[]> = {
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
  playlists: 'recent',
  songs: 'title',
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
  playlists: 'grid',
  albums: 'grid',
  artists: 'grid',
  songs: 'list',
};

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
  const [tab, setTab] = useState<Tab>('playlists');
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [songs, setSongs] = useState<PlaylistTrack[] | null>(null);
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [artists, setArtists] = useState<LibraryArtist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<string>('recent');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
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
    setAlbums(null);
    setArtists(null);
  }, [activeProfileId]);

  // Lazy-load each library view the first time its tab is opened.
  useEffect(() => {
    if (tab === 'songs' && songs === null) {
      ipc
        .listLibrarySongs(activeProfileId)
        .then(setSongs)
        .catch((e) => setError(String(e)));
    } else if (tab === 'albums' && albums === null) {
      ipc
        .listLibraryAlbums(activeProfileId)
        .then(setAlbums)
        .catch((e) => setError(String(e)));
    } else if (tab === 'artists' && artists === null) {
      ipc
        .listLibraryArtists(activeProfileId)
        .then(setArtists)
        .catch((e) => setError(String(e)));
    }
  }, [tab, songs, albums, artists, activeProfileId]);

  // A fresh tab starts unfiltered with that tab's default sort.
  useEffect(() => {
    setFilter('');
    setSortBy(DEFAULT_SORT[tab]);
  }, [tab]);

  const f = filter.trim().toLowerCase();

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
  }, [playlists, f, sortBy]);

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
              track: {
                source: 'local',
                source_id: String(t.id),
                title: t.title,
                artists: t.artists ?? [],
                album: t.album ?? null,
                album_art_url: t.album_art_url ?? null,
                duration_ms: t.duration_ms ?? 0,
                isrc: t.isrc ?? null,
                local_track_id: t.id,
                in_playlist_ids: inIds,
                has_audio: t.local_path != null,
                preview_url: null,
                explicit: false,
              },
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
    return [
      { label: 'Open artist', onClick: () => openArtist(a.name) },
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

  const count =
    tab === 'playlists'
      ? playlists.length
      : tab === 'songs'
        ? (songs?.length ?? null)
        : tab === 'albums'
          ? (albums?.length ?? null)
          : (artists?.length ?? null);
  const noun =
    tab === 'playlists'
      ? 'playlist'
      : tab === 'songs'
        ? 'song'
        : tab === 'albums'
          ? 'album'
          : 'artist';

  return (
    <div className="h-full overflow-auto px-8 pb-8 pt-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Library</h1>
          {count != null && (
            <span className="text-sm text-neutral-500">
              {count} {count === 1 ? noun : `${noun}s`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* Trigger shows just the current sort value + a sort glyph (the
                "Sort by" title lives inside the popover, Spotify-style). The
                value sits in a fixed-width, right-aligned slot so the button —
                and the filter beside it — don't shift as the label changes. */}
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
              <span className="w-28 text-right truncate">
                {SORTS[tab].find((s) => s.id === sortBy)?.label ??
                  SORTS[tab][0].label}
              </span>
              {/* The trailing icon mirrors the CURRENT view mode (list/grid),
                  like Spotify — so the button reflects what's shown. */}
              <span className="shrink-0 text-neutral-400">
                {VIEW_MODES.find((v) => v.id === viewMode)?.icon}
              </span>
            </button>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${noun}s…`}
              className="w-60 rounded-lg bg-neutral-900 border border-neutral-800 px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-400"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-1">
          {TABS.map((t) => (
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
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {tab === 'playlists' &&
        (playlists.length === 0 ? (
          <EmptyLibrary onOpenSettings={onOpenSettings} />
        ) : viewMode === 'list' ? (
          <div className="flex flex-col">
            {visiblePlaylists.map((p) => (
              <LibRow
                key={p.id}
                art={p.cover_url}
                title={p.name}
                subtitle={`Playlist · ${p.track_count} ${
                  p.track_count === 1 ? 'song' : 'songs'
                }`}
                onOpen={() => onOpenPlaylist(p.id)}
                onContext={(e) => openMenu(e, playlistMenu(p))}
              />
            ))}
          </div>
        ) : (
          <Grid>
            {visiblePlaylists.map((p) => (
              <div key={p.id} onContextMenu={(e) => openMenu(e, playlistMenu(p))}>
                <PlaylistCard
                  playlist={p}
                  onOpen={onOpenPlaylist}
                  onPlay={playPlaylist}
                />
              </div>
            ))}
          </Grid>
        ))}

      {tab === 'songs' &&
        (visibleSongs === null ? (
          <RowsSkeleton />
        ) : visibleSongs.length === 0 ? (
          <Hint>{f ? 'No matches.' : 'No songs in your library yet.'}</Hint>
        ) : viewMode === 'grid' ? (
          <Grid>
            {visibleSongs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPlaySong(t, visibleSongs ?? [])}
                onContextMenu={(e) => openMenu(e, songMenu(t))}
                className="group text-left"
              >
                <div className="aspect-square w-full overflow-hidden rounded-lg bg-neutral-800 grid place-items-center ring-1 ring-white/5 transition-shadow group-hover:shadow-2xl group-hover:shadow-black/50">
                  {t.album_art_url ? (
                    <img
                      src={t.album_art_url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-3xl text-neutral-600">♪</span>
                  )}
                </div>
                <div className="mt-2 truncate text-sm font-medium text-neutral-100">
                  {t.title}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {t.artists.join(', ') || '—'}
                </div>
              </button>
            ))}
          </Grid>
        ) : (
          <SongList
            songs={visibleSongs}
            onPlay={onPlaySong}
            onContext={(t, e) => openMenu(e, songMenu(t))}
          />
        ))}

      {tab === 'albums' &&
        (visibleAlbums === null ? (
          <GridSkeleton />
        ) : visibleAlbums.length === 0 ? (
          <Hint>{f ? 'No matches.' : 'No albums in your library yet.'}</Hint>
        ) : (
          <>
            {multiAlbums && multiAlbums.length > 0 && (
              viewMode === 'list' ? (
                <div className="flex flex-col">
                  {multiAlbums.map((a) => (
                    <LibRow
                      key={`${a.album} ${a.artist ?? ''}`}
                      art={a.album_art_url}
                      title={a.album}
                      subtitle={`${a.artist ?? 'Album'} · ${a.track_count} ${
                        a.track_count === 1 ? 'song' : 'songs'
                      }`}
                      onOpen={() => openAlbum(a.album, a.artist)}
                      onContext={(e) => openMenu(e, albumMenu(a))}
                    />
                  ))}
                </div>
              ) : (
                <Grid>
                  {multiAlbums.map((a) => (
                    <AlbumCard
                      key={`${a.album} ${a.artist ?? ''}`}
                      album={a}
                      onOpen={() => openAlbum(a.album, a.artist)}
                      onPlay={() => playAlbum(a)}
                      onContext={(e) => openMenu(e, albumMenu(a))}
                    />
                  ))}
                </Grid>
              )
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
                {singlesOpen &&
                  (viewMode === 'list' ? (
                    <div className="flex flex-col">
                      {singleAlbums.map((a) => (
                        <LibRow
                          key={`${a.album} ${a.artist ?? ''}`}
                          art={a.album_art_url}
                          title={a.album}
                          subtitle={`${a.artist ?? 'Single'} · ${a.track_count} ${
                            a.track_count === 1 ? 'song' : 'songs'
                          }`}
                          onOpen={() => openAlbum(a.album, a.artist)}
                          onContext={(e) => openMenu(e, albumMenu(a))}
                        />
                      ))}
                    </div>
                  ) : (
                    <Grid>
                      {singleAlbums.map((a) => (
                        <AlbumCard
                          key={`${a.album} ${a.artist ?? ''}`}
                          album={a}
                          onOpen={() => openAlbum(a.album, a.artist)}
                          onPlay={() => playAlbum(a)}
                          onContext={(e) => openMenu(e, albumMenu(a))}
                        />
                      ))}
                    </Grid>
                  ))}
              </section>
            )}
          </>
        ))}

      {tab === 'artists' &&
        (visibleArtists === null ? (
          <GridSkeleton />
        ) : visibleArtists.length === 0 ? (
          <Hint>{f ? 'No matches.' : 'No artists in your library yet.'}</Hint>
        ) : viewMode === 'list' ? (
          <div className="flex flex-col">
            {visibleArtists.map((a) => (
              <LibRow
                key={a.key}
                round
                art={a.album_art_url}
                title={a.name}
                subtitle={`Artist · ${a.track_count} ${
                  a.track_count === 1 ? 'song' : 'songs'
                }`}
                onOpen={() => openArtist(a.name)}
                onContext={(e) => openMenu(e, artistMenu(a))}
              />
            ))}
          </div>
        ) : (
          <Grid>
            {visibleArtists.map((a) => (
              <ArtistCard
                key={a.key}
                artist={a}
                onOpen={() => openArtist(a.name)}
                onPlay={() => playArtist(a)}
                onContext={(e) => openMenu(e, artistMenu(a))}
              />
            ))}
          </Grid>
        ))}

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
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {children}
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

function SongList({
  songs,
  onPlay,
  onContext,
}: {
  songs: PlaylistTrack[];
  onPlay: (clicked: PlaylistTrack, list: PlaylistTrack[]) => void;
  onContext: (t: PlaylistTrack, e: React.MouseEvent) => void;
}) {
  return (
    <ul className="divide-y divide-neutral-800 border border-neutral-800 rounded-lg overflow-hidden">
      {songs.map((t) => {
        const playable = canStream(t);
        return (
          <li
            key={t.id}
            onClick={() => playable && onPlay(t, songs)}
            onContextMenu={(e) => onContext(t, e)}
            className={`flex items-center gap-3 p-3 ${
              playable ? 'cursor-pointer hover:bg-neutral-900/40' : 'opacity-60'
            }`}
          >
            <div className="h-12 w-12 shrink-0 rounded bg-neutral-800 overflow-hidden">
              {t.album_art_url ? (
                <img
                  src={t.album_art_url}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full grid place-items-center text-neutral-600">
                  ♪
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{t.title}</div>
              <div className="text-sm text-neutral-500 truncate">
                {t.artists.join(', ') || '—'}
                {t.album ? ` · ${t.album}` : ''}
              </div>
            </div>
            <div className="text-sm text-neutral-500 tabular-nums">
              {formatDuration(t.duration_ms)}
            </div>
            {!playable && (
              <span className="text-xs text-neutral-500 ml-2">not downloaded</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EmptyLibrary({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-lg border border-neutral-800 p-12 text-center">
      <div className="text-5xl mb-3">♪</div>
      <h2 className="text-lg font-medium mb-1">No music yet</h2>
      <p className="text-sm text-neutral-500 mb-5 max-w-md mx-auto">
        Get music in from Settings: connect Spotify, import an Exportify CSV,
        or paste an Apple Music playlist link.
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
