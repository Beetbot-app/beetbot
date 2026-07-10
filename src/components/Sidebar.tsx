import { useCallback, useEffect, useMemo, useState } from 'react';
import { ipc, type PlaylistSummary } from '@/lib/tauri';
import { isPinned, pinId, usePinStore, type Pin } from '@/lib/pins';
import { ContextMenu, MenuGlyphs, type MenuState } from '@shared/components/ContextMenu';
import { useNavStore } from '@/lib/nav';
import { usePlayerStore } from '@/lib/store';
import { useSession } from '@/lib/session';
import { createPlaylist, sortPlaylistsByRecent } from '@shared/api';
import logoUrl from '../assets/logo.svg';

const COLLAPSE_KEY = 'beetbot.sidebar_collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Persistent left sidebar — Spotify-style "Your Library". The library
 * lives here (there's no separate Library nav button or page that
 * duplicates it): a clickable "Your Library" header, a built-in name
 * filter, and the scrollable playlist list. The header opens the fuller
 * grid view (which also has full-text search across your downloaded
 * songs). Collapsible (persisted) to a slim icon/cover rail.
 */
export function Sidebar({
  active,
  onOpenPlaylist,
  onOpenLibrary,
  currentPlaylistId,
  refreshSignal,
  profileId,
  floating = false,
}: {
  /** Current top-level view name (so the matching item highlights). */
  active: string;
  onOpenPlaylist: (id: number) => void;
  /** Open the fuller library grid + "search your songs" view. */
  onOpenLibrary: () => void;
  currentPlaylistId: number | null;
  /** Any value that changes when playlists may have changed; refetches. */
  refreshSignal: unknown;
  /** Active profile — scopes the library to this user. */
  profileId: number;
  /** Floating-shell layout: render as a rounded, gap-separated panel instead
   *  of a flush bar with a hard right divider. */
  floating?: boolean;
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  // Spotify-style library type filter: All / Playlists / Albums. Albums are
  // whole-album imports (source==='album'); everything else is a playlist.
  const [typeFilter, setTypeFilter] = useState<'all' | 'playlist' | 'album'>(
    'all',
  );

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    let cancelled = false;
    ipc
      .listPlaylists(profileId)
      .then((rows) => {
        if (!cancelled) setPlaylists(rows);
      })
      .catch(() => {
        /* sidebar just shows empty if the DB read fails */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal, profileId]);

  // Whether any imported albums exist — gates whether we bother showing the
  // type-filter chips at all (no point offering "Albums" if there are none).
  const hasAlbums = useMemo(
    () => !!playlists && playlists.some((p) => p.source === 'album'),
    [playlists],
  );

  const visible = useMemo(() => {
    if (!playlists) return null;
    const f = filter.trim().toLowerCase();
    const filtered = playlists.filter((p) => {
      if (typeFilter === 'album' && p.source !== 'album') return false;
      if (typeFilter === 'playlist' && p.source === 'album') return false;
      if (f && !p.name.toLowerCase().includes(f)) return false;
      return true;
    });
    // Recently-played first (same recency signal as Home/mobile Library),
    // with Liked Songs pinned to the very top, Spotify-style.
    return sortPlaylistsByRecent(filtered).sort(
      (a, b) =>
        (a.source === 'liked' ? 0 : 1) - (b.source === 'liked' ? 0 : 1),
    );
  }, [playlists, filter, typeFilter]);

  // "+" new playlist — inline name row (Apple/Spotify-style), then jump into
  // the fresh playlist. Uses the same create path as the add-to-playlist modal.
  const { token: sessionToken } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const submitCreate = async () => {
    const name = createName.trim();
    if (!name || !sessionToken || creating) return;
    setCreating(true);
    try {
      const pl = await createPlaylist(name, sessionToken, profileId);
      setCreateOpen(false);
      setCreateName('');
      onOpenPlaylist(pl.id);
    } catch {
      /* keep the input open so the user can retry */
    } finally {
      setCreating(false);
    }
  };

  // Sidebar pins (Daft-style): jump straight to a pinned artist/album/song/
  // playlist. Songs resolve their file by id before playing.
  const pins = usePinStore((s) => s.pins);
  const unpin = usePinStore((s) => s.unpin);
  const togglePin = usePinStore((s) => s.toggle);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openArtist = useNavStore((s) => s.openArtist);
  const openAlbum = useNavStore((s) => s.openAlbum);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const openPin = useCallback(
    (p: Pin) => {
      switch (p.kind) {
        case 'artist':
          openArtist(p.name);
          break;
        case 'album':
          openAlbum(p.album, p.artist);
          break;
        case 'playlist':
          onOpenPlaylist(p.id);
          break;
        case 'song':
          void ipc.getTrack(p.id).then((t) => {
            if (t?.local_path) setQueue([t], 0);
          });
          break;
      }
    },
    [openArtist, openAlbum, onOpenPlaylist, setQueue],
  );

  return (
    <aside
      className={`${collapsed ? 'w-[72px]' : 'w-60'} ${
        // Floating card sits BELOW the header now; the brand row's own pt-4 is
        // the inner inset (no extra card padding). Legacy non-floating overlaps
        // the absolute header → clear it (pt-14).
        floating
          ? 'rounded-2xl border border-white/10 overflow-hidden'
          : 'border-r border-white/5 pt-14'
      } shrink-0 h-full flex flex-col bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 transition-[width] duration-200`}
    >
      {/* Anchor all content to a fixed-width column — the collapsed rail width
          when collapsed, the full width when expanded — pinned to the LEFT. As
          the panel's width animates, the content stays put and the empty space
          collapses away on the RIGHT, so the sidebar closes right→left instead
          of the content drifting/re-centering. overflow-hidden on the aside
          clips the wider (expanded) column while the panel is mid-width. */}
      <div
        className={`${
          collapsed ? 'w-[72px]' : 'w-60'
        } flex flex-col flex-1 min-h-0`}
      >
      {/* Brand + collapse control. When collapsed the logo IS the expand
          button (Spotify-style): it shows the beet normally and swaps to a
          »-expand chevron on hover, so there's no separate toggle stacked
          beneath it. */}
      {collapsed ? (
        <div className="flex flex-col items-center pt-4 pb-3">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="group h-10 w-10 grid place-items-center rounded-lg hover:bg-neutral-900 transition"
          >
            <span className="group-hover:hidden">
              <Logo size={30} />
            </span>
            <span className="hidden group-hover:grid place-items-center text-neutral-200">
              <svg {...svgProps} width={18} height={18}>
                <path d="m13 17 5-5-5-5" />
                <path d="m6 17 5-5-5-5" />
              </svg>
            </span>
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 pt-4 pb-1">
          {/* Expanded: the full brand lockup — the beet mark + the two-tone
              wordmark (cream "beet", crimson "bot") in the display serif.
              Collapsed drops back to the mark alone (above). */}
          <div className="flex items-center px-1">
            {/* Nudge the mark up slightly: its visual mass (the round root) sits
                below the artwork's geometric center, so plain items-center leaves
                the body reading low against the wordmark. The beet art has its own
                ~5px of whitespace inside its square box, so pull the wordmark left
                (-ml) to about halve the dead space between them. */}
            <Logo size={30} className="-translate-y-[3px]" />
            <Wordmark className="-ml-[2px]" />
          </div>
          <CollapseToggle collapsed={false} onClick={() => setCollapsed(true)} />
        </div>
      )}

      {/* No nav rows: like Spotify/Apple Music, the sidebar is pure library.
          Discover lives behind the search box (focus it) + Home's Browse. */}

      {/* Pinned (Daft-style) — shortcuts the user pinned from the library's
          right-click menus. Hidden until something is pinned. */}
      {pins.length > 0 ? (
        <div className={collapsed ? 'mt-2 px-1' : 'mt-5 px-2'}>
          {!collapsed ? (
            // Same uppercase tracked eyebrow the content surfaces use for
            // section labels (Home's "BASED ON…"), so the sidebar sections
            // read as headings — and match Apple Music's sidebar idiom.
            <div className="px-2 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Pinned
            </div>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {pins.map((p) => (
              <li key={pinId(p)}>
                <PinRow
                  pin={p}
                  collapsed={collapsed}
                  onOpen={() => openPin(p)}
                  onUnpin={() => unpin(pinId(p))}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Your Library — same quiet eyebrow style + indent as "Pinned", so the
          sidebar reads as one uniform list (Apple-style). Still clickable. */}
      {!collapsed ? (
        <div className="mt-5 px-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <button
              type="button"
              onClick={onOpenLibrary}
              className={`px-2 text-[11px] font-semibold uppercase tracking-wide transition ${
                active === 'library'
                  ? 'text-neutral-200'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Your Library
            </button>
            <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setCreateOpen((v) => !v)}
              aria-label="New playlist"
              title="New playlist"
              className={`h-6 w-6 grid place-items-center rounded-full transition ${
                createOpen
                  ? 'text-neutral-100 bg-neutral-800'
                  : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterOpen((v) => {
                  if (v) setFilter('');
                  return !v;
                });
              }}
              aria-label="Search in Your Library"
              title="Search in Your Library"
              className={`h-6 w-6 grid place-items-center rounded-full transition ${
                filterOpen
                  ? 'text-neutral-100 bg-neutral-800'
                  : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </button>
            </div>
          </div>
          {createOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
            >
              <input
                autoFocus
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setCreateOpen(false);
                    setCreateName('');
                  }
                }}
                disabled={creating}
                placeholder="New playlist name"
                className="w-[calc(100%-1rem)] mx-2 mb-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-400 disabled:opacity-60"
              />
            </form>
          ) : null}
          {filterOpen ? (
            <input
              autoFocus
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find in Your Library"
              className="w-[calc(100%-1rem)] mx-2 mb-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-400"
            />
          ) : null}
          {hasAlbums ? (
            <div className="flex items-center gap-1.5 px-2 mt-1 mb-3">
              <TypeChip
                label="Playlists"
                active={typeFilter === 'playlist'}
                onClick={() =>
                  setTypeFilter((v) => (v === 'playlist' ? 'all' : 'playlist'))
                }
              />
              <TypeChip
                label="Albums"
                active={typeFilter === 'album'}
                onClick={() =>
                  setTypeFilter((v) => (v === 'album' ? 'all' : 'album'))
                }
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 mx-3 mb-1 border-t border-white/5" />
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3 min-h-0">
        {!visible ? (
          !collapsed ? (
            <div aria-hidden>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-1.5 animate-pulse">
                  <div className="h-10 w-10 rounded-lg bg-neutral-800/80 shrink-0" />
                  <div className="flex-1">
                    <div className="h-3 w-2/3 rounded bg-neutral-800/80" />
                    <div className="mt-1.5 h-2.5 w-1/3 rounded bg-neutral-800/80" />
                  </div>
                </div>
              ))}
            </div>
          ) : null
        ) : visible.length === 0 ? (
          !collapsed ? (
            <div className="px-2 py-1 text-xs text-neutral-600">
              {filter.trim() ? 'No matches.' : 'No playlists yet.'}
            </div>
          ) : null
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpenPlaylist(p.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const pin: Pin = {
                      kind: 'playlist',
                      id: p.id,
                      name: p.name,
                      art: p.cover_url,
                      source: p.source,
                    };
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          label: isPinned(pins, pin)
                            ? 'Unpin from sidebar'
                            : 'Pin to sidebar',
                          icon: MenuGlyphs.pin,
                          onClick: () => togglePin(pin),
                        },
                      ],
                    });
                  }}
                  className={`w-full flex items-center px-2 py-1.5 rounded-lg text-left transition ${
                    collapsed ? 'justify-center' : 'gap-3'
                  } ${
                    currentPlaylistId === p.id
                      ? 'bg-neutral-900'
                      : 'hover:bg-neutral-900'
                  }`}
                  title={p.name}
                >
                  <div
                    className={`h-10 w-10 shrink-0 rounded overflow-hidden grid place-items-center ${
                      currentPlaylistId === p.id && collapsed
                        ? 'ring-2 ring-white/60'
                        : 'bg-neutral-800'
                    }`}
                  >
                    {p.cover_url ? (
                      <img
                        src={p.cover_url}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                        loading="lazy"
                      />
                    ) : (
                      <span className="text-neutral-600 text-xs">
                        {p.source === 'liked' ? '★' : '♪'}
                      </span>
                    )}
                  </div>
                  {!collapsed ? (
                    <div className="min-w-0 flex-1">
                      <div
                        className={`text-sm truncate ${
                          currentPlaylistId === p.id
                            ? 'text-neutral-100'
                            : 'text-neutral-200'
                        }`}
                      >
                        {p.name}
                      </div>
                      <div className="text-[11px] text-neutral-500 truncate">
                        {subtitleFor(p)}
                      </div>
                    </div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/** Library row subtitle, Spotify-style: "Album · Artist" for whole-album
 *  imports, "Playlist · N songs" for everything else. */
function subtitleFor(p: PlaylistSummary): string {
  if (p.source === 'album') {
    return p.owner ? `Album · ${p.owner}` : 'Album';
  }
  const songs = `${p.track_count} ${p.track_count === 1 ? 'song' : 'songs'}`;
  return `Playlist · ${songs}`;
}

/** Pill toggle for the All / Playlists / Albums library type filter. */
function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition ${
        active
          ? 'bg-white/10 text-neutral-100'
          : 'bg-white/5 text-neutral-300 hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

/** A pinned shortcut row in the sidebar (artist/album/song/playlist). */
function PinRow({
  pin,
  collapsed,
  onOpen,
  onUnpin,
}: {
  pin: Pin;
  collapsed: boolean;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const label =
    pin.kind === 'album'
      ? pin.album
      : pin.kind === 'song'
        ? pin.title
        : pin.name;
  const sub =
    pin.kind === 'artist'
      ? 'Artist'
      : pin.kind === 'album'
        ? (pin.artist ?? 'Album')
        : pin.kind === 'song'
          ? (pin.artist ?? 'Song')
          : pin.source === 'album'
            ? 'Album'
            : 'Playlist';
  const round = pin.kind === 'artist' ? 'rounded-full' : 'rounded';
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        title={label}
        className={`w-full flex items-center px-2 py-1.5 rounded-lg text-left hover:bg-neutral-900 transition ${
          collapsed ? 'justify-center' : 'gap-3'
        }`}
      >
        <div
          className={`h-10 w-10 shrink-0 overflow-hidden grid place-items-center bg-neutral-800 ${round}`}
        >
          {pin.art ? (
            <img
              src={pin.art}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span className="text-neutral-600 text-xs">♪</span>
          )}
        </div>
        {!collapsed ? (
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate text-neutral-200">{label}</div>
            <div className="text-[11px] text-neutral-500 truncate">{sub}</div>
          </div>
        ) : null}
      </button>
      {!collapsed ? (
        <button
          type="button"
          onClick={onUnpin}
          aria-label="Unpin"
          title="Unpin"
          className="opacity-0 group-hover:opacity-100 transition absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 bg-neutral-900/90"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** The Beetbot wordmark — "beet" in cream + "bot" in beet-pop crimson, set in
 *  the brand display serif (Fraunces / Playfair Display, Georgia fallback),
 *  bold italic. Matches logo/beetbot-wordmark.svg. Shown only when the sidebar
 *  is expanded; decorative, so hidden from assistive tech (the app is labelled
 *  elsewhere). */
function Wordmark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`select-none text-[24px] font-extrabold italic leading-none tracking-[-0.03em] ${className ?? ''}`}
      style={{ fontFamily: '"Fraunces", "Playfair Display", Georgia, serif' }}
    >
      <span style={{ color: '#F7EDF0' }}>beet</span>
      <span style={{ color: '#FF3D7F' }}>bot</span>
    </span>
  );
}

/** The Beetbot mark (inlined from the app icon: a red beet root with
 *  green leaves on a dark tile). */
function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className={`shrink-0 ${className ?? ''}`}
    />
  );
}

function CollapseToggle({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="h-8 w-8 grid place-items-center rounded-lg text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900"
    >
      <svg {...svgProps} width={18} height={18}>
        {collapsed ? (
          <>
            <path d="m13 17 5-5-5-5" />
            <path d="m6 17 5-5-5-5" />
          </>
        ) : (
          <>
            <path d="m11 17-5-5 5-5" />
            <path d="m18 17-5-5 5-5" />
          </>
        )}
      </svg>
    </button>
  );
}

const svgProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

