import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cn,
  INPUT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CALLOUT_ERROR,
  EYEBROW,
} from '../../ui';
import {
  createPlaylist,
  friendlyError,
  getTrackPlaylistIds,
  isHubReachable,
  listPlaylists,
  patchTrackPlaylists,
  type PlaylistRow,
  type SearchTrackResult,
} from '../../api';
import { ModalShell } from './ModalShell';
import { notifyLibraryChanged } from '../../libraryChanged';

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
  // The track's ACTUAL memberships. Desktop callers pass them in via
  // `track.in_playlist_ids`; the phone can't (its stream→result adapter has no
  // membership), so we (re)fetch them on open below and use the result as the
  // diff baseline — otherwise the phone's picker opened with nothing pre-ticked.
  const [serverIds, setServerIds] = useState<number[]>(track.in_playlist_ids);
  // The user has started toggling → don't clobber their selection when the
  // membership fetch lands.
  const touched = useRef(false);
  // Initial = the server's snapshot at modal-open; current = the
  // user's working selection. Diff between them is what gets sent.
  const initialSelected = useMemo(() => new Set<number>(serverIds), [serverIds]);
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

  // Fetch the track's authoritative memberships on open so the picker pre-ticks
  // the right rows. Desktop callers already pass them in `in_playlist_ids`; the
  // phone can't, so without this its picker always opened blank. Adopt them as
  // the diff baseline (serverIds) and, unless the user already toggled, as the
  // working selection too.
  useEffect(() => {
    const lid = track.local_track_id;
    if (lid == null) return;
    let cancelled = false;
    getTrackPlaylistIds(lid, token, activeProfileId)
      .then((ids) => {
        if (cancelled) return;
        setServerIds(ids);
        if (!touched.current) setCurrentSelected(new Set(ids));
      })
      .catch(() => {
        /* keep the caller-provided fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [track.local_track_id, token, activeProfileId]);

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
    touched.current = true;
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
      // The sidebar + Home quick-access refetch on this, so a track added to (or
      // removed from) Favorites / a playlist here shows without a navigation.
      notifyLibraryChanged();
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
        // A brand-new playlist should appear in the sidebar + Home right away.
        notifyLibraryChanged();
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
