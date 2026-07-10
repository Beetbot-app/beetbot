import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { canLiveStream } from '@shared/api';
import type { PlaylistTrack } from '@/lib/tauri';

export type RepeatMode = 'off' | 'all' | 'one';

/// A track is playable iff it has a local audio file: a `local_path` on this
/// device, OR status 'downloaded' — a catalog/handed-off row built for the
/// queue with no in-memory local_path, whose file the hub still has and
/// streams by id via /stream/{id}. On the full build ANY track is also playable:
/// the engine resolves (matching on the fly if needed) + remuxes its source on
/// demand via /stream/{id}/live. Only the open build (no engine) gates on a file.
export function canStream(t: PlaylistTrack): boolean {
  // `t.id > 0` guards the catalog rows that failed to resolve to a library id
  // (sentinel id 0) — those can't be streamed even on the full build. The
  // title guard drops corrupt metadata-less rows: the engine matches by
  // title+artist, so an empty title can never live-resolve — offering it as
  // playable just produces a silent failed stream.
  return (
    t.local_path != null ||
    t.status === 'downloaded' ||
    (canLiveStream() && t.id > 0 && t.title.trim() !== '')
  );
}

interface PlayerState {
  queue: PlaylistTrack[];
  currentIndex: number;
  isPlaying: boolean;
  /// Stable key of the collection the queue was seeded from (e.g. `album:123`,
  /// `playlist:456`) so a Home card can render a persistent play/pause when it's
  /// the active source. Null when unknown (bare track / detail play); a queue
  /// advance keeps it, a fresh setQueue clears it (re-set by the card handler).
  nowPlayingKey: string | null;
  setNowPlayingKey: (key: string | null) => void;
  /// The most recent track that CROSSED the "counts as a play" threshold (~20s)
  /// and was logged to play_events. Drives Home's live "Recently played" prepend
  /// so the optimistic shelf only ever shows what the server will actually keep —
  /// prepending at track START would surface sub-20s plays that then vanish on
  /// the next feed fetch. Null until the first play is logged this session.
  lastLoggedTrack: PlaylistTrack | null;
  markPlayLogged: (t: PlaylistTrack) => void;
  /// True while the active <audio> is buffering/stalled. Lifted out of the bar
  /// so both the mini bar and the full Now Playing view can show a spinner.
  buffering: boolean;
  setBuffering: (b: boolean) => void;
  currentTime: number;
  duration: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /// Autoplay/radio: when the queue runs dry and repeat is off, append songs
  /// similar to what just played so playback keeps going (matches the phone).
  /// Persisted.
  autoplay: boolean;
  setAutoplay: (on: boolean) => void;
  /// Append tracks to the END of the queue (used by autoplay radio). Returns how
  /// many playable rows were actually added.
  appendToQueue: (tracks: PlaylistTrack[]) => number;
  /// Sleep timer: epoch-ms at which to pause, or null. Ephemeral (not persisted).
  sleepTimerEndsAt: number | null;
  /// Sleep timer: pause when the current track ends (vs. a fixed time).
  sleepAtTrackEnd: boolean;
  /// 'off' clears it, 'track' = stop after this song, a number = minutes from now.
  setSleepTimer: (opt: 'off' | 'track' | number) => void;
  /// Crossfade overlap in seconds (0 = off). Persisted.
  crossfadeSeconds: number;
  setCrossfadeSeconds: (n: number) => void;
  /// Advance to the next track at a specific position — used by the crossfade
  /// handoff so the incoming track resumes where its fade-in left off.
  crossfadeAdvance: (positionSeconds: number) => void;

  setQueue: (tracks: PlaylistTrack[], startAt?: number) => void;
  /// Clear the now-playing track, queue and playhead (keeps prefs like
  /// volume/repeat/shuffle). Called when switching profiles so one user's
  /// music doesn't carry into the next — the player store is a single global
  /// WebView localStorage, not per-profile.
  reset: () => void;
  /// Take over a queue handed off from another device: load it at the given
  /// index + playhead, bypassing the local_path filter (handed-off rows stream
  /// over HTTP by id, so they carry no local_path).
  adoptHandoff: (
    tracks: PlaylistTrack[],
    index: number,
    position: number,
    playing: boolean,
  ) => void;
  /// Jump to a specific index in the current queue (from the Queue panel).
  playAt: (index: number) => void;
  /// Drop a track from the queue by index, keeping the current track
  /// playing (indices shift as needed).
  removeFromQueue: (index: number) => void;
  /// Move a queued track to play right after the current one ("Play next").
  playNext: (index: number) => void;
  /// Drag-reorder the queue; the currently-playing track follows its row.
  moveItem: (from: number, to: number) => void;
  /// Drop everything after the current track ("Clear" the up-next list).
  clearUpcoming: () => void;
  playPause: () => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setVolume: (v: number) => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  /// Called from <audio>'s onEnded — advances per repeat/shuffle rules.
  handleTrackEnded: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
  queue: [],
  currentIndex: 0,
  isPlaying: false,
  nowPlayingKey: null,
  lastLoggedTrack: null,
  buffering: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  // Default OFF so a finished queue rolls into autoplay-radio (similar songs)
  // instead of looping — matches the phone. Toggle to 'all'/'one' to loop.
  repeat: 'off',
  shuffle: false,
  autoplay: true,
  sleepTimerEndsAt: null,
  sleepAtTrackEnd: false,
  crossfadeSeconds: 0,

  setAutoplay: (on) => set({ autoplay: on }),

  appendToQueue: (tracks) => {
    const add = tracks.filter(canStream);
    if (add.length === 0) return 0;
    set((s) => ({ queue: [...s.queue, ...add] }));
    return add.length;
  },

  setCrossfadeSeconds: (n) =>
    set({ crossfadeSeconds: Math.max(0, Math.min(12, Math.round(n))) }),

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
    // Keep playable rows with their original positions so we can map the tapped
    // index by POSITION, not by id. (Two catalog rows sharing an ISRC resolve to
    // the same library track_id, so a queue can hold duplicate ids — id-based
    // findIndex would start playback on the earlier duplicate, the wrong song.)
    const kept = tracks
      .map((t, origIdx) => ({ t, origIdx }))
      .filter(({ t }) => canStream(t));
    if (kept.length === 0) return;
    // First playable row at or after the tapped position — so if the tapped row
    // itself was filtered out, playback falls through to the next playable one
    // instead of jumping back to the top.
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

  playAt: (index) => {
    const { queue } = get();
    if (index < 0 || index >= queue.length) return;
    set({ currentIndex: index, currentTime: 0, isPlaying: true });
  },

  removeFromQueue: (index) => {
    const { queue, currentIndex } = get();
    if (index < 0 || index >= queue.length) return;
    // Don't allow removing the track that's currently playing — simplest
    // safe behavior (Spotify also keeps the now-playing row).
    if (index === currentIndex) return;
    const next = queue.filter((_, i) => i !== index);
    // Keep the same track playing: shift currentIndex left if we removed
    // something before it.
    const nextIndex = index < currentIndex ? currentIndex - 1 : currentIndex;
    set({ queue: next, currentIndex: Math.max(0, nextIndex) });
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
    if (from === to || from < 0 || from >= queue.length || to < 0 || to >= queue.length)
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

  setBuffering: (b) => set({ buffering: b }),

  playPause: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setNowPlayingKey: (key) => set({ nowPlayingKey: key }),
  markPlayLogged: (t) => set({ lastLoggedTrack: t }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),

  next: () => {
    const { queue, currentIndex, shuffle, repeat } = get();
    if (queue.length === 0) return;
    if (shuffle) {
      // Pick any other index than the current one.
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
    // Common UX: if past the 3s mark, restart current; otherwise go back.
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
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),

  toggleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
    })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),

  handleTrackEnded: () => {
    const { repeat } = get();
    if (repeat === 'one') {
      set({ currentTime: 0, isPlaying: true });
      return;
    }
    get().next();
  },
    }),
    {
      // localStorage key — the Tauri WebView has its own localStorage
      // that persists across app restarts, so this picks up the same
      // queue / position on next launch. Bumping the suffix would
      // reset everyone's persisted state.
      name: 'beetbot.desktop.player-v1',
      storage: createJSONStorage(() => localStorage),
      // v1 → v2: the old default repeat 'all' looped a single played song
      // forever (no continuation). Switch such persisted state to 'off' so a
      // finished queue rolls into autoplay-radio. One-time; a user who set
      // 'all'/'one' deliberately can just toggle it back.
      version: 2,
      migrate: (persisted, fromVersion) => {
        const s = (persisted ?? {}) as Partial<PlayerState>;
        if (fromVersion < 2 && s.repeat === 'all') s.repeat = 'off';
        return s as PlayerState;
      },
      // Persist the bits that should survive a quit. isPlaying is
      // intentionally excluded — opening the app shouldn't auto-start
      // playback. duration is re-derived from the audio element.
      partialize: (state) => ({
        queue: state.queue,
        currentIndex: state.currentIndex,
        currentTime: state.currentTime,
        volume: state.volume,
        repeat: state.repeat,
        shuffle: state.shuffle,
        autoplay: state.autoplay,
        crossfadeSeconds: state.crossfadeSeconds,
      }),
      // Force playback paused on rehydrate. User taps play to resume.
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isPlaying = false;
        }
      },
    },
  ),
);

export function currentTrack(state: PlayerState): PlaylistTrack | undefined {
  return state.queue[state.currentIndex];
}
