import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { isPlayable, type StreamTrack, type CatalogOpenRequest } from '@shared/api';

export type RepeatMode = 'off' | 'all' | 'one';

/** Playable iff the hub has an audio file (`has_audio`) OR, on the full build,
 *  the track is matched to a source the hub can stream on demand via
 *  `/stream/{id}/live`. Unmatched tracks aren't playable from the phone. */
export function canStream(t: StreamTrack): boolean {
  return isPlayable(t);
}

interface PlayerState {
  queue: StreamTrack[];
  currentIndex: number;
  isPlaying: boolean;
  /** Stable key of the collection the queue was seeded from (e.g. `album:123`,
   *  `playlist:456`) so a Home card can render a persistent play/pause when it's
   *  the active source. Null when unknown; a queue advance keeps it, a fresh
   *  setQueue clears it (re-set by the card handler). */
  nowPlayingKey: string | null;
  setNowPlayingKey: (key: string | null) => void;
  currentTime: number;
  duration: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Autoplay/radio: when the queue runs dry and repeat is off, append songs
   *  similar to what just played so playback keeps going. Persisted. */
  autoplay: boolean;
  setAutoplay: (on: boolean) => void;
  /** Sleep timer: epoch-ms at which to pause, or null. Ephemeral (not persisted). */
  sleepTimerEndsAt: number | null;
  /** Sleep timer: pause when the current track ends (vs. a fixed time). */
  sleepAtTrackEnd: boolean;
  /** 'off' clears it, 'track' = stop after this song, a number = minutes from now. */
  setSleepTimer: (opt: 'off' | 'track' | number) => void;
  /** Crossfade overlap in seconds (0 = off). Persisted. Experimental on the
   *  phone: only fades while the app is foregrounded (see Player). */
  crossfadeSeconds: number;
  setCrossfadeSeconds: (n: number) => void;
  /** Advance to the next track at a specific position — used by the crossfade
   *  handoff so the incoming track resumes where its fade-in left off. */
  crossfadeAdvance: (positionSeconds: number) => void;

  setQueue: (tracks: StreamTrack[], startAt?: number) => void;
  /** Clear the now-playing track, queue and playhead (keeps prefs). Called on a
   *  profile switch so one user's music doesn't carry into the next. */
  reset: () => void;
  /** Take over a queue handed off from another device: load it at the given
   *  index + playhead, bypassing the has_audio filter (the source was already
   *  playing these). */
  adoptHandoff: (
    tracks: StreamTrack[],
    index: number,
    position: number,
    playing: boolean,
  ) => void;
  playPause: () => void;
  play: () => void;
  pause: () => void;
  /** Append a playable track to the end of the queue ("Add to queue"). */
  enqueue: (track: StreamTrack) => void;
  /** Append a batch of playable tracks to the end of the queue (autoplay/radio).
   *  Filters non-playable + de-dupes against ids already queued. Returns the
   *  number actually appended. */
  appendToQueue: (tracks: StreamTrack[]) => number;
  /** Remove the queue item at `index` (no-op for the currently-playing one). */
  removeAt: (index: number) => void;
  /** Jump to and play the queue item at `index`. */
  jumpTo: (index: number) => void;
  /** Move the queue item at `index` to play right after the current track. */
  playNext: (index: number) => void;
  /** Move the queue item from one index to another (drag-reorder). */
  moveItem: (from: number, to: number) => void;
  /** Remove every track after the current one ("Clear queue" / clear up-next). */
  clearUpcoming: () => void;
  next: () => void;
  prev: () => void;
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  handleTrackEnded: () => void;
}

/**
 * Mirrors the desktop player store but operates on `StreamTrack` rows from
 * the REST API instead of `PlaylistTrack` from Tauri IPC. Key difference:
 * the desktop store filters to tracks with `local_path`; here we filter to
 * tracks with `has_audio` (server-computed, same meaning).
 */
export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
  queue: [],
  currentIndex: 0,
  isPlaying: false,
  nowPlayingKey: null,
  currentTime: 0,
  duration: 0,
  // Default is no-repeat so a finished single/playlist flows into Autoplay
  // radio (similar songs) instead of looping. Set repeat to 'all' to loop.
  repeat: 'off',
  shuffle: false,
  autoplay: true,
  sleepTimerEndsAt: null,
  sleepAtTrackEnd: false,
  crossfadeSeconds: 0,

  setCrossfadeSeconds: (n) =>
    set({ crossfadeSeconds: Math.max(0, Math.min(12, Math.round(n))) }),

  setAutoplay: (on) => set({ autoplay: on }),

  crossfadeAdvance: (positionSeconds) => {
    const { queue, currentIndex } = get();
    if (currentIndex + 1 < queue.length) {
      set({
        currentIndex: currentIndex + 1,
        currentTime: Math.max(0, positionSeconds),
        isPlaying: true,
      });
    } else {
      // Last track — fall back to the normal end-of-queue behavior.
      get().handleTrackEnded();
    }
  },

  setSleepTimer: (opt) => {
    if (opt === 'off') {
      set({ sleepTimerEndsAt: null, sleepAtTrackEnd: false });
    } else if (opt === 'track') {
      set({ sleepAtTrackEnd: true, sleepTimerEndsAt: null });
    } else {
      set({ sleepTimerEndsAt: Date.now() + opt * 60_000, sleepAtTrackEnd: false });
    }
  },

  setQueue: (tracks, startAt = 0) => {
    // Map the tapped index by POSITION, not by id: two catalog rows sharing an
    // ISRC resolve to the same library track_id, so a seeded queue can contain
    // duplicate ids — id-based findIndex would start on the earlier duplicate.
    const kept = tracks
      .map((t, origIdx) => ({ t, origIdx }))
      .filter(({ t }) => canStream(t));
    if (kept.length === 0) return;
    // First playable row at/after the tapped position (falls through if the
    // tapped row was filtered out, instead of restarting at the top).
    let idx = kept.findIndex(({ origIdx }) => origIdx >= startAt);
    if (idx < 0) idx = 0;
    set({
      queue: kept.map(({ t }) => t),
      currentIndex: idx,
      isPlaying: true,
      // Cleared on every fresh seed; the Home card handler re-sets it right
      // after (via setNowPlayingKey) when the play came from a card.
      nowPlayingKey: null,
      currentTime: 0,
    });
  },

  reset: () =>
    set({ queue: [], currentIndex: 0, isPlaying: false, currentTime: 0, duration: 0 }),

  adoptHandoff: (tracks, index, position, playing) => {
    if (tracks.length === 0) return;
    const idx = Math.max(0, Math.min(index, tracks.length - 1));
    set({
      queue: tracks,
      currentIndex: idx,
      currentTime: Math.max(0, position),
      isPlaying: playing,
    });
  },

  playPause: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setNowPlayingKey: (key) => set({ nowPlayingKey: key }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),

  enqueue: (track) => {
    if (!canStream(track)) return;
    const { queue } = get();
    if (queue.some((q) => q.id === track.id)) return; // already queued
    set({ queue: [...queue, track] });
  },

  appendToQueue: (tracks) => {
    const { queue } = get();
    const seen = new Set(queue.map((q) => q.id));
    const add: StreamTrack[] = [];
    for (const t of tracks) {
      if (!canStream(t) || seen.has(t.id)) continue;
      seen.add(t.id);
      add.push(t);
    }
    if (add.length === 0) return 0;
    set({ queue: [...queue, ...add] });
    return add.length;
  },

  removeAt: (index) => {
    const { queue, currentIndex } = get();
    if (index < 0 || index >= queue.length || index === currentIndex) return;
    set({
      queue: queue.slice(0, index).concat(queue.slice(index + 1)),
      // Keep currentIndex pointing at the same track after the splice.
      currentIndex: index < currentIndex ? currentIndex - 1 : currentIndex,
    });
  },

  jumpTo: (index) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length || !canStream(queue[index])) return;
    set({ currentIndex: index, currentTime: 0, isPlaying: true });
  },

  playNext: (index) => {
    const { queue, currentIndex } = get();
    if (index < 0 || index >= queue.length || index === currentIndex) return;
    const item = queue[index];
    const without = queue.slice(0, index).concat(queue.slice(index + 1));
    // Where the current track sits after removing `index`, then insert right
    // after it.
    const curAfter = index < currentIndex ? currentIndex - 1 : currentIndex;
    const insertAt = curAfter + 1;
    set({
      queue: without.slice(0, insertAt).concat([item], without.slice(insertAt)),
      currentIndex: curAfter,
    });
  },

  moveItem: (from, to) => {
    const { queue, currentIndex } = get();
    if (
      from === to ||
      from < 0 ||
      from >= queue.length ||
      to < 0 ||
      to >= queue.length
    )
      return;
    const curRef = queue[currentIndex];
    const q = queue.slice();
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    // Follow the currently-playing track to wherever the splice moved it (queue
    // entries are distinct object refs, so identity lookup is exact).
    const newIndex = q.indexOf(curRef);
    set({ queue: q, currentIndex: newIndex >= 0 ? newIndex : currentIndex });
  },

  clearUpcoming: () => {
    const { queue, currentIndex } = get();
    // Nothing after the current track → no-op.
    if (currentIndex >= queue.length - 1) return;
    // Keep the current track (and any history before it); drop the tail.
    set({ queue: queue.slice(0, currentIndex + 1) });
  },

  next: () => {
    const { queue, currentIndex, shuffle, repeat } = get();
    if (queue.length === 0) return;
    if (shuffle) {
      let i = currentIndex;
      while (queue.length > 1 && i === currentIndex) {
        i = Math.floor(Math.random() * queue.length);
      }
      set({ currentIndex: i, currentTime: 0, isPlaying: true });
      return;
    }
    if (currentIndex + 1 < queue.length) {
      set({ currentIndex: currentIndex + 1, currentTime: 0, isPlaying: true });
    } else if (repeat === 'all') {
      set({ currentIndex: 0, currentTime: 0, isPlaying: true });
    } else {
      set({ isPlaying: false, currentTime: 0 });
    }
  },

  prev: () => {
    const { currentIndex, currentTime } = get();
    if (currentTime > 3) {
      set({ currentTime: 0 });
      return;
    }
    if (currentIndex > 0) {
      set({ currentIndex: currentIndex - 1, currentTime: 0 });
    } else {
      set({ currentTime: 0 });
    }
  },

  setCurrentTime: (t) => set({ currentTime: t }),
  setDuration: (d) => set({ duration: d }),

  toggleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
    })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

  handleTrackEnded: () => {
    // Sleep timer set to "end of track" — stop here instead of advancing.
    if (get().sleepAtTrackEnd) {
      set({ isPlaying: false, currentTime: 0, sleepAtTrackEnd: false });
      return;
    }
    const { repeat } = get();
    if (repeat === 'one') {
      set({ currentTime: 0, isPlaying: true });
      return;
    }
    get().next();
  },
    }),
    {
      // localStorage key. Bumping the suffix (-v1 -> -v2) would
      // reset everyone's persisted queue on next deploy; keep stable
      // unless we make a breaking change to the shape below.
      name: 'beetbot.player-v1',
      version: 1,
      // v0 -> v1: the default repeat changed from 'all' (loop) to 'off' so a
      // finished queue flows into Autoplay radio. Flip installs still on the
      // old 'all' default once; an explicit repeat choice persists after this.
      migrate: (persisted, fromVersion) => {
        const s = (persisted as Record<string, unknown>) ?? {};
        if (fromVersion < 1 && s.repeat === 'all') {
          s.repeat = 'off';
        }
        return s as unknown as PlayerState;
      },
      storage: createJSONStorage(() => localStorage),
      // Only persist the bits that should survive a reload. isPlaying
      // and duration are intentionally excluded — playback shouldn't
      // auto-resume on app open (user taps play to start), and
      // duration is re-derived from the audio element's metadata.
      partialize: (state) => ({
        queue: state.queue,
        currentIndex: state.currentIndex,
        currentTime: state.currentTime,
        repeat: state.repeat,
        shuffle: state.shuffle,
        autoplay: state.autoplay,
        crossfadeSeconds: state.crossfadeSeconds,
      }),
      // On rehydrate, force playback paused. Users find it
      // jarring when an app starts playing music the moment they
      // open it; Spotify / Apple Music behave the same way —
      // resume the queue position, but wait for an explicit tap.
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isPlaying = false;
        }
      },
    },
  ),
);

export function currentTrack(state: PlayerState): StreamTrack | undefined {
  return state.queue[state.currentIndex];
}

/**
 * Phone-side catalog navigation. Things rendered OUTSIDE a screen (the Now
 * Playing overlay's "Go to artist / album") write an open-request here; App
 * watches it, switches to the Search tab, and hands the request to
 * SearchScreen, which resolves the name to a catalog hit and drills into the
 * artist/album modal. Mirrors the desktop's useNavStore (src/lib/nav.ts).
 */
interface CatalogNavState {
  request: CatalogOpenRequest | null;
  openArtist: (name: string) => void;
  openAlbum: (name: string, artist?: string | null) => void;
  clear: () => void;
}

export const useCatalogNav = create<CatalogNavState>((set) => ({
  request: null,
  openArtist: (name) => set({ request: { kind: 'artist', name } }),
  openAlbum: (name, artist) =>
    set({ request: { kind: 'album', name, artist: artist ?? null } }),
  clear: () => set({ request: null }),
}));
