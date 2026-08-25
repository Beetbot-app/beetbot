import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wordmark } from '@shared/components/Wordmark';
import { ipc, type PlaylistSummary } from '@/lib/tauri';
import { isPinned, pinId, usePinStore, type Pin } from '@/lib/pins';
import {
  useSavedStore,
  savedArtistId,
  isStalePortraitMiss,
  type SavedArtist,
} from '@/lib/saved';
import { hasRealPortrait, isReplaceableArt, pickArtistForName } from '@shared/artistName';
import { ContextMenu, MenuGlyphs, type MenuState } from '@shared/components/ContextMenu';
import { useNavStore } from '@/lib/nav';
import { usePlayerStore } from '@/lib/store';
import { useSession } from '@/lib/session';
import {
  createPlaylist,
  getRecentlyPlayedPlaylists,
  searchCatalog,
} from '@shared/api';
import logoUrl from '../assets/logo.svg';
import { useRecentlyPlayedVersion } from '@shared/useRecentPlaylists';

const COLLAPSE_KEY = 'beetbot.sidebar_collapsed';

/** One row in the sidebar library list — a playlist/album or a saved artist.
 *  `recency`/`liked` are sort keys; the payload drives rendering + the menu. */
type SidebarRow =
  | {
      kind: 'playlist';
      key: string;
      recency: number;
      liked: boolean;
      playlist: PlaylistSummary;
    }
  | {
      kind: 'artist';
      key: string;
      recency: number;
      liked: false;
      artist: SavedArtist;
    };

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
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  // Spotify-style library type filter: All / Playlists / Albums / Artists.
  // Albums are whole-album imports (source==='album'); Artists are saved
  // artists (Library › Artists); everything else is a playlist.
  const [typeFilter, setTypeFilter] = useState<
    'all' | 'playlist' | 'album' | 'artist'
  >('all');
  // Saved artists live in the library too, so they show in this list (and get
  // their own filter chip). Same per-profile KV store the Library tab uses.
  const savedArtists = useSavedStore((s) => s.artists);
  const removeSavedArtist = useSavedStore((s) => s.removeArtist);
  const setArtwork = useSavedStore((s) => s.setArtwork);

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
  const hasArtists = savedArtists.length > 0;

  // Unified library list: playlists + saved artists, filtered by the type chip
  // and search, then ordered recently-touched-first (playlist play-recency /
  // artist save-time) with Liked Songs pinned to the very top. Ordering matches
  // the old playlist-only sort for playlists, with artists interleaved by when
  // they were saved.
  const recentsVersion = useRecentlyPlayedVersion();
  const visible = useMemo<SidebarRow[] | null>(() => {
    if (!playlists) return null;
    const f = filter.trim().toLowerCase();
    const recents = getRecentlyPlayedPlaylists();
    const rows: SidebarRow[] = [];
    if (typeFilter !== 'artist') {
      for (const p of playlists) {
        if (typeFilter === 'album' && p.source !== 'album') continue;
        if (typeFilter === 'playlist' && p.source === 'album') continue;
        if (f && !p.name.toLowerCase().includes(f)) continue;
        rows.push({
          kind: 'playlist',
          key: `p:${p.id}`,
          recency: recents.get(p.id) ?? 0,
          liked: p.source === 'liked',
          playlist: p,
        });
      }
    }
    if (typeFilter === 'all' || typeFilter === 'artist') {
      for (const a of savedArtists) {
        if (f && !a.name.toLowerCase().includes(f)) continue;
        rows.push({
          kind: 'artist',
          key: `a:${a.key}`,
          recency: a.savedAt ?? 0,
          liked: false,
          artist: a,
        });
      }
    }
    rows.sort((x, y) => {
      if (x.liked !== y.liked) return x.liked ? -1 : 1;
      return y.recency - x.recency;
    });
    return rows;
  // `recentsVersion` isn't read in the body on purpose: it's the signal that the
  // hub's shared recency merged in. Dropping it would silently stop the other
  // device's plays from ever reordering this list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, savedArtists, filter, typeFilter, recentsVersion]);

  // "+" new playlist — inline name row (Apple/Spotify-style), then jump into
  // the fresh playlist. Uses the same create path as the add-to-playlist modal.
  const { token: sessionToken } = useSession();

  // Portrait backfill: artists saved via the bulk "Add from your songs" seed (or
  // onboarding) carry an ALBUM cover, not the artist's photo — so they'd mismatch
  // their own page. Resolve the real Deezer portrait and cache it back into the
  // store, so the sidebar + Library tab match the artist page.
  //
  // Three subtleties, all learned the hard way:
  //   • Match by NAME + FANS, don't just take result [0]. Deezer's artist search
  //     ranks by relevance, not popularity, and floods same-name impostors and
  //     portrait-less phantom credits ahead of the real act (a 50-fan "Drake"
  //     and "Marshmello & Omar LinX" outrank the real ones) — so [0] caches the
  //     wrong, often portrait-less, entity. `pickArtistForName` fixes this.
  //   • Re-run for records stuck on a stand-in image — a blank or album cover.
  //   • ONE-TIME re-resolve of EVERY saved artist per profile (the `v2` flag),
  //     because an earlier result-[0] pass may have cached an impostor's own
  //     portrait — which looks like a valid portrait by URL, so the stand-in
  //     check alone can't catch it. Storing only a real portrait or null means
  //     this converges and never loops.
  //   • Re-check a resolved MISS once its answer goes stale. A null used to be
  //     final — `setArtwork(name, null)` marks `portrait`, and a null is not a
  //     stand-in, so nothing ever asked again. But a miss is Deezer's answer on
  //     one day, not a fact: a throttled search or a temporarily image-less
  //     entry got frozen in for good. Measured against this library, Deezer has
  //     a portrait for ~97% of artists, so most stored nulls are stale answers
  //     rather than real gaps. `isStalePortraitMiss` expires them on the same
  //     7-day clock the server uses for iTunes art misses; convergence still
  //     holds, since a miss costs at most one search per artist per week.
  const backfillTried = useRef<Set<string>>(new Set());
  const backfillProfile = useRef<number | null>(null);
  useEffect(() => {
    if (!sessionToken) return;
    const profileId = useSavedStore.getState().profileId;
    // Fresh "tried" set per profile — the effect re-fires as it writes art (and
    // on profile switch), and this both prevents re-query loops within a profile
    // and stops one profile's attempts from suppressing another's.
    if (backfillProfile.current !== profileId) {
      backfillProfile.current = profileId;
      backfillTried.current = new Set();
    }
    const v2Key = profileId != null ? `beetbot.portraits.v2.${profileId}` : null;
    let v2Done = true;
    try {
      v2Done = !v2Key || localStorage.getItem(v2Key) === '1';
    } catch {
      /* storage blocked — behave as if the one-time pass already ran */
    }
    const markV2Done = () => {
      if (v2Key && !v2Done) {
        try {
          localStorage.setItem(v2Key, '1');
        } catch {
          /* ignore */
        }
      }
    };
    const pending = useSavedStore
      .getState()
      .artists.filter(
        (a) =>
          // v2 pass: everyone once. Afterwards: stand-in (blank/cover) art, or
          // a resolved miss whose answer has aged out.
          (!v2Done || !a.portrait || isReplaceableArt(a.art) || isStalePortraitMiss(a)) &&
          !backfillTried.current.has(savedArtistId(a.name)),
      );
    if (pending.length === 0) {
      markV2Done();
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const a of pending) {
        if (cancelled) break;
        backfillTried.current.add(savedArtistId(a.name));
        try {
          const res = await searchCatalog(a.name, sessionToken, 'artist', 8);
          // Same relevance-not-popularity trap as onboarding: pick the real
          // artist by name + fans, not Deezer's result [0].
          const candidates = res.artists ?? [];
          const best = pickArtistForName(candidates, a.name);
          // Store a real portrait if we found one; else keep any real art we
          // already had, else null — NEVER re-persist a blank/cover, so this
          // can't loop.
          const next = hasRealPortrait(best?.picture_url)
            ? best!.picture_url
            : hasRealPortrait(a.art)
              ? a.art
              : null;
          // Only record a DEFINITIVE answer. A search that came back with no
          // artists at all is ambiguous — a throttled hub, a degraded
          // Deezer-direct fallback and a genuinely unknown name are
          // indistinguishable here — and writing null for it would start a
          // fresh 7-day silence on what may be a transient failure. Leaving it
          // unwritten costs one more search next session. Same rule the server
          // applies to iTunes art misses; a real answer (candidates existed,
          // none had a usable portrait) still gets stored and dated.
          if (next === null && candidates.length === 0) continue;
          if (!cancelled) setArtwork(a.name, next);
        } catch {
          /* leave unresolved → retried next session */
        }
      }
      if (!cancelled) markV2Done();
    })();
    return () => {
      cancelled = true;
    };
    // `savedArtists` in deps so the pass runs once the list (and its profile)
    // has loaded, and after a profile switch — not just on first mount. The
    // `backfillTried` guard + v2 flag keep this from re-querying resolved names.
  }, [sessionToken, setArtwork, savedArtists]);
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
      className={`group/side ${
        collapsed ? 'w-[72px]' : 'w-60'
      } rounded-2xl border border-white/10 overflow-hidden shrink-0 h-full flex flex-col bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 transition-[width] duration-200`}
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
        <div className="flex items-center px-3 pt-4 pb-1">
          {/* Collapse toggle sits to the LEFT of the brand and stays hidden
              until the sidebar is hovered — then it slides in from the left and
              nudges the brand right (Spotify-style). Zero width when hidden, so
              the logo starts flush-left with no reserved gap. */}
          <div className="shrink-0 overflow-hidden transition-all duration-200 ease-out w-0 -translate-x-2 opacity-0 group-hover/side:w-8 group-hover/side:translate-x-0 group-hover/side:opacity-100">
            <CollapseToggle collapsed={false} onClick={() => setCollapsed(true)} />
          </div>
          {/* Expanded: the full brand lockup — the beet mark + the two-tone
              wordmark (cream "beet", crimson "bot") in the display serif.
              Collapsed drops back to the mark alone (above). */}
          <div className="flex items-center px-1">
            {/* -2px is an OPTICAL choice, not a geometry fix. The artwork is
                centred in its own viewBox now, so items-center already centres
                it exactly — and exact reads a touch low beside the wordmark.
                Measuring the mark alone does not predict this: its mass centre
                and its ink centre agree within a unit, yet against lowercase
                text the beet still wants lifting. Judged by eye, against the
                shipped app, and kept because the shipped app looked better.
                The horizontal -ml stays: the beet art carries its own
                whitespace either side, so the wordmark is pulled left to halve
                the dead space between them. */}
            <Logo size={30} className="-translate-y-[2px]" />
            <Wordmark className="-ml-[2px]" />
          </div>
        </div>
      )}

      {/* No nav rows: like Spotify/Apple Music, the sidebar is pure library.
          Discover lives behind the search box (focus it) + Home's Browse. */}

      {/* Pinned (Daft-style) — shortcuts the user pinned from the library's
          right-click menus. Hidden until something is pinned. */}
      {pins.length > 0 ? (
        <div className={collapsed ? 'mt-2 px-1' : 'mt-2 px-2'}>
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
        <div className="mt-2 px-2">
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
          {hasAlbums || hasArtists ? (
            <div className="flex items-center gap-1.5 px-2 mt-1 mb-3 flex-wrap">
              <TypeChip
                label="Playlists"
                active={typeFilter === 'playlist'}
                onClick={() =>
                  setTypeFilter((v) => (v === 'playlist' ? 'all' : 'playlist'))
                }
              />
              {hasAlbums ? (
                <TypeChip
                  label="Albums"
                  active={typeFilter === 'album'}
                  onClick={() =>
                    setTypeFilter((v) => (v === 'album' ? 'all' : 'album'))
                  }
                />
              ) : null}
              {hasArtists ? (
                <TypeChip
                  label="Artists"
                  active={typeFilter === 'artist'}
                  onClick={() =>
                    setTypeFilter((v) => (v === 'artist' ? 'all' : 'artist'))
                  }
                />
              ) : null}
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
              {filter.trim()
                ? 'No matches.'
                : typeFilter === 'artist'
                  ? 'No saved artists yet.'
                  : 'No playlists yet.'}
            </div>
          ) : null
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((row) => {
              // Saved artist row: round avatar, opens the artist page; the
              // right-click menu removes it from the library or pins it.
              if (row.kind === 'artist') {
                const a = row.artist;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => openArtist(a.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const pin: Pin = {
                          kind: 'artist',
                          key: a.key,
                          name: a.name,
                          art: a.art,
                        };
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            {
                              label: 'Remove from your library',
                              icon: MenuGlyphs.check,
                              onClick: () => removeSavedArtist(a.name),
                            },
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
                      className={`w-full flex items-center px-2 py-1.5 rounded-lg text-left transition hover:bg-neutral-900 ${
                        collapsed ? 'justify-center' : 'gap-3'
                      }`}
                      title={a.name}
                    >
                      <div className="h-10 w-10 shrink-0 rounded-full overflow-hidden grid place-items-center bg-neutral-800">
                        {a.art ? (
                          <img
                            src={a.art}
                            alt=""
                            className="h-full w-full object-cover"
                            draggable={false}
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-neutral-600 text-xs">☺</span>
                        )}
                      </div>
                      {!collapsed ? (
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate text-neutral-200">
                            {a.name}
                          </div>
                          <div className="text-[11px] text-neutral-500 truncate">
                            Artist
                          </div>
                        </div>
                      ) : null}
                    </button>
                  </li>
                );
              }
              const p = row.playlist;
              return (
                <li key={row.key}>
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
              );
            })}
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

