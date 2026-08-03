import { create } from 'zustand';
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from 'zustand/middleware';
import type { UseBoundStore, StoreApi } from 'zustand';

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * The player store shared by the desktop (Tauri) and phone (PWA) builds. Both
 * ran near-identical copies that quietly drifted (missing de-dupe, an
 * unguarded jump, one-off method names); this is the single source of truth.
 *
 * The two builds differ only in:
 *  - the track row type `T` (`PlaylistTrack` from Tauri IPC vs `StreamTrack`
 *    from the REST API);
 *  - how a row is judged playable (`canStream`, injected);
 *  - the persisted localStorage key / version / migrate (injected), so an
 *    upgrade never resets anyone's saved queue.
 *
 * `volume`/`buffering` live in the shared state for both builds. The phone has
 * no volume slider and never reads `buffering`, so they're harmless there — the
 * phone simply doesn't persist `volume` (see `persistVolume`).
 */
export interface PlayerState<T> {
  queue: T[];
  currentIndex: number;
  isPlaying: boolean;
  /** Stable key of the collection the queue was seeded from (e.g. `album:123`,
   *  `playlist:456`) so a Home card can render a persistent play/pause when it's
   *  the active source. Null when unknown (bare track / detail play); a queue
   *  advance keeps it, a fresh setQueue clears it (re-set by the card handler). */
  nowPlayingKey: string | null;
  setNowPlayingKey: (key: string | null) => void;
  /** The most recent track that crossed the "counts as a play" threshold (~20s)
   *  and was logged to play_events. Drives Home's live "Recently played" prepend
   *  so the optimistic shelf only ever shows what the server will actually keep —
   *  prepending at track START would surface sub-20s plays that then vanish on
   *  the next feed fetch. Null until the first play is logged this session. */
  lastLoggedTrack: T | null;
  markPlayLogged: (t: T) => void;
  /** True while the active <audio> is buffering/stalled. Lifted out of the bar
   *  so both the mini bar and the full Now Playing view can show a spinner.
   *  (Desktop-only in practice; the phone never sets it.) */
  buffering: boolean;
  setBuffering: (b: boolean) => void;
  currentTime: number;
  duration: number;
  /** 0..1. Desktop-only in practice (the phone uses the OS volume). Persisted
   *  only when `persistVolume` is set. */
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Shuffle pass plan: track ids not yet played this pass, front = next. A
   *  pass plays every queued track exactly once (Spotify-style permutation),
   *  then repeat 'all' reshuffles a new pass and 'off' stops — the old
   *  behavior (uniform random jumps) repeated songs early, starved others,
   *  and never ended. Ephemeral: rebuilt on toggle/seed/rehydrate. */
  shuffleUpcomingIds: number[];
  /** Ids in the order they actually played (most recent last) — makes prev()
   *  under shuffle return to what you really heard, not queue[index-1]. */
  shuffleHistoryIds: number[];
  /** The index next()/crossfadeAdvance would land on right now, or -1 (end of
   *  a repeat-off pass / empty queue / repeat-all reshuffle pending). Lets the
   *  crossfade pre-buffer and lyrics/audio prewarm target the TRUE next track
   *  under shuffle instead of assuming queue[currentIndex + 1]. */
  peekNextIndex: () => number;
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
  /** Crossfade overlap in seconds (0 = off). Persisted. */
  crossfadeSeconds: number;
  setCrossfadeSeconds: (n: number) => void;
  /** Advance to the next track at a specific position — used by the crossfade
   *  handoff so the incoming track resumes where its fade-in left off. */
  crossfadeAdvance: (positionSeconds: number) => void;

  setQueue: (tracks: T[], startAt?: number) => void;
  /** Clear the now-playing track, queue and playhead (keeps prefs like
   *  volume/repeat/shuffle). Called when switching profiles so one user's music
   *  doesn't carry into the next — the player store is a single global WebView
   *  localStorage, not per-profile. */
  reset: () => void;
  /** Take over a queue handed off from another device: load it at the given
   *  index + playhead, bypassing the playable filter (the source was already
   *  playing these; handed-off rows stream over HTTP by id, carrying no file). */
  adoptHandoff: (
    tracks: T[],
    index: number,
    position: number,
    playing: boolean,
  ) => void;
  playPause: () => void;
  play: () => void;
  pause: () => void;
  /** Append a single playable track to the end of the queue ("Add to queue").
   *  No-op if it's non-playable or already queued. */
  enqueue: (track: T) => void;
  /** Append a batch of playable tracks to the end of the queue (autoplay/radio).
   *  Filters non-playable + de-dupes against ids already queued. Returns the
   *  number actually appended. */
  appendToQueue: (tracks: T[]) => number;
  /** Remove the queue item at `index` (no-op for the currently-playing one). */
  removeAt: (index: number) => void;
  /** Jump to and play the queue item at `index`. */
  jumpTo: (index: number) => void;
  /** Move the queue item at `index` to play right after the current track. */
  playNext: (index: number) => void;
  /** Move the queue item from one index to another (drag-reorder). */
  moveItem: (from: number, to: number) => void;
  /** Reorder the shuffle PLAN (drag-reorder of "Up next" while shuffle is on):
   *  move the plan entry at position `from` to position `to`. The queue itself
   *  is untouched — under shuffle the plan IS the play order, so this is the
   *  edit the user means. No-op when shuffle is off. */
  movePlanItem: (from: number, to: number) => void;
  /** Remove every track after the current one ("Clear queue" / clear up-next). */
  clearUpcoming: () => void;
  next: () => void;
  prev: () => void;
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setVolume: (v: number) => void;
  /** Mute (drop volume to 0, remembering the level) or unmute (restore it).
   *  Muted state is simply `volume === 0`; the pre-mute level is kept in the
   *  store closure so the M hotkey and the speaker button stay in sync. */
  toggleMute: () => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  handleTrackEnded: () => void;
}

export interface PlayerStoreConfig<T> {
  /** Whether a row can be played on this build (has a local file / is streamable). */
  canStream: (t: T) => boolean;
  /** localStorage key — bumping the suffix resets everyone's persisted state. */
  persistName: string;
  /** Persist schema version; `migrate` runs when a stored blob predates it. */
  persistVersion: number;
  /** Persist `volume` too (desktop). The phone omits it — no volume slider. */
  persistVolume?: boolean;
}

/** Fisher-Yates a one-pass shuffle plan (track ids) over `queue`. The
 *  currently-playing id is excluded — it's already playing this pass. Ids are
 *  used instead of indices so the plan survives queue edits (enqueue, remove,
 *  drag-reorder); a queue holding duplicate ids collapses to the first copy,
 *  which plays the same audio either way. */
function buildShufflePlan<T extends { id: number }>(
  queue: T[],
  excludeId?: number,
): number[] {
  const ids = queue.filter((t) => t.id !== excludeId).map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/**
 * Queue indices in TRUE play order for the "Up next" UIs — sequential mode is
 * simply everything after the current index; shuffle mode maps the plan's ids
 * back to queue positions (first unused match, so duplicate ids each keep a
 * turn). Items absent from the plan (already played this pass) are not
 * upcoming and don't appear. Pure so components can useMemo it off the store
 * fields instead of re-deriving on every currentTime tick.
 */
export function upcomingQueueIndices<T extends { id: number }>(
  queue: T[],
  currentIndex: number,
  shuffle: boolean,
  plan: number[],
): number[] {
  if (!shuffle) {
    const out: number[] = [];
    for (let i = currentIndex + 1; i < queue.length; i++) out.push(i);
    return out;
  }
  const used = new Set<number>([currentIndex]);
  const out: number[] = [];
  for (const id of plan) {
    const idx = queue.findIndex((t, i) => t.id === id && !used.has(i));
    if (idx >= 0) {
      used.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/**
 * The "up next" a device publishes on its heartbeat, in TRUE play order.
 *
 * Both shells build it here rather than each rolling its own: the phone and
 * the desktop have to agree on what "next" means, and the answer isn't the raw
 * array — under shuffle it's the plan. Capped so a 5,000-track queue doesn't
 * ride a 2-second heartbeat; `total` carries the real remaining count so the
 * reader can still say how much it isn't showing.
 */
export function heartbeatQueue<
  T extends { id: number; title: string; artists: string[] },
>(
  queue: T[],
  currentIndex: number,
  shuffle: boolean,
  plan: number[],
  max: number,
): { items: { id: number; title: string; artists: string[] }[]; total: number } {
  const upcoming = upcomingQueueIndices(queue, currentIndex, shuffle, plan);
  return {
    items: upcoming.slice(0, max).map((i) => ({
      id: queue[i].id,
      title: queue[i].title,
      artists: queue[i].artists,
    })),
    total: upcoming.length,
  };
}

/** Bounded push for the shuffle history — enough for any realistic "hold
 *  previous" session without letting a day-long queue grow it unbounded. */
const SHUFFLE_HISTORY_CAP = 200;
function pushHistory(hist: number[], id: number | undefined): number[] {
  if (id == null) return hist;
  const next = [...hist, id];
  return next.length > SHUFFLE_HISTORY_CAP
    ? next.slice(next.length - SHUFFLE_HISTORY_CAP)
    : next;
}

/**
 * Build a player store bound to a concrete track type. Both builds' stores are
 * thin wrappers over this — see src/lib/store.ts and web-player/store.ts.
 */
export function createPlayerStore<T extends { id: number }>(
  config: PlayerStoreConfig<T>,
): UseBoundStore<StoreApi<PlayerState<T>>> {
  const { canStream, persistName, persistVersion, persistVolume = false } =
    config;

  return create<PlayerState<T>>()(
    persist(
      (set, get) => {
        /** Volume to restore when unmuting. Lives in the factory closure (not
         *  persisted, not in state) so it survives across mute/unmute regardless
         *  of whether the trigger was the M hotkey or the speaker button. */
        let preMuteVolume = 1;

        /** Advance to whatever should play next — the ONE implementation
         *  behind next() (position 0) and crossfadeAdvance (mid-fade offset).
         *  Sequential mode steps the index; shuffle mode consumes the plan,
         *  reshuffling a fresh pass on repeat 'all' and stopping on 'off'
         *  exactly like a sequential queue reaching its end. */
        const advance = (position: number): void => {
          const s = get();
          const { queue, currentIndex, shuffle, repeat } = s;
          if (queue.length === 0) return;
          if (!shuffle) {
            if (currentIndex + 1 < queue.length) {
              set({
                currentIndex: currentIndex + 1,
                currentTime: position,
                isPlaying: true,
              });
            } else if (repeat === 'all') {
              set({ currentIndex: 0, currentTime: position, isPlaying: true });
            } else {
              set({ isPlaying: false, currentTime: 0 });
            }
            return;
          }
          const curId = queue[currentIndex]?.id;
          // Consume the plan front-to-back, skipping ids that left the queue
          // (removed / profile reset raced) or turned unplayable.
          const plan = s.shuffleUpcomingIds.slice();
          let idx = -1;
          while (plan.length > 0 && idx < 0) {
            const id = plan.shift() as number;
            const found = queue.findIndex(
              (t, i) => t.id === id && i !== currentIndex,
            );
            if (found >= 0 && canStream(queue[found])) idx = found;
          }
          if (idx < 0) {
            // Pass complete — every queued track has played once.
            if (repeat === 'all') {
              // New pass over EVERYTHING (the just-finished track included —
              // it gets a turn like any other), only demoted out of the lead
              // slot so it can't play twice back-to-back (single-track queues
              // legitimately replay, like sequential).
              const fresh = buildShufflePlan(queue, undefined);
              if (fresh.length > 1 && fresh[0] === curId) {
                const j = 1 + Math.floor(Math.random() * (fresh.length - 1));
                [fresh[0], fresh[j]] = [fresh[j], fresh[0]];
              }
              const id = fresh.shift();
              const found =
                id == null ? -1 : queue.findIndex((t) => t.id === id);
              if (found >= 0) {
                set({
                  currentIndex: found,
                  currentTime: position,
                  isPlaying: true,
                  shuffleUpcomingIds: fresh,
                  shuffleHistoryIds: pushHistory(s.shuffleHistoryIds, curId),
                });
                return;
              }
            }
            set({ isPlaying: false, currentTime: 0, shuffleUpcomingIds: [] });
            return;
          }
          set({
            currentIndex: idx,
            currentTime: position,
            isPlaying: true,
            shuffleUpcomingIds: plan,
            shuffleHistoryIds: pushHistory(s.shuffleHistoryIds, curId),
          });
        };

        return {
        queue: [],
        currentIndex: 0,
        isPlaying: false,
        nowPlayingKey: null,
        lastLoggedTrack: null,
        buffering: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        // Default OFF so a finished queue rolls into autoplay-radio (similar
        // songs) instead of looping. Toggle to 'all'/'one' to loop.
        repeat: 'off',
        shuffle: false,
        shuffleUpcomingIds: [],
        shuffleHistoryIds: [],
        autoplay: true,
        sleepTimerEndsAt: null,
        sleepAtTrackEnd: false,
        crossfadeSeconds: 0,

        setAutoplay: (on) => set({ autoplay: on }),

        setCrossfadeSeconds: (n) =>
          set({ crossfadeSeconds: Math.max(0, Math.min(12, Math.round(n))) }),

        crossfadeAdvance: (positionSeconds) => {
          // Repeat-one: "next" is this track again, at the fade-in offset.
          if (get().repeat === 'one') {
            set({ currentTime: Math.max(0, positionSeconds), isPlaying: true });
            return;
          }
          // Same advance as next(), but the incoming track resumes where its
          // fade-in left off — shuffle-aware via the shared advance().
          advance(Math.max(0, positionSeconds));
        },

        setSleepTimer: (opt) => {
          if (opt === 'off') {
            set({ sleepTimerEndsAt: null, sleepAtTrackEnd: false });
          } else if (opt === 'track') {
            set({ sleepAtTrackEnd: true, sleepTimerEndsAt: null });
          } else {
            set({
              sleepTimerEndsAt: Date.now() + opt * 60_000,
              sleepAtTrackEnd: false,
            });
          }
        },

        setQueue: (tracks, startAt = 0) => {
          // Map the tapped index by POSITION, not by id: two catalog rows
          // sharing an ISRC resolve to the same library track_id, so a seeded
          // queue can hold duplicate ids — an id-based findIndex would start on
          // the earlier duplicate (the wrong song).
          const kept = tracks
            .map((t, origIdx) => ({ t, origIdx }))
            .filter(({ t }) => canStream(t));
          if (kept.length === 0) return;
          // First playable row at/after the tapped position (falls through to
          // the next playable one if the tapped row was filtered out, instead
          // of restarting at the top).
          let idx = kept.findIndex(({ origIdx }) => origIdx >= startAt);
          if (idx < 0) idx = 0;
          const tracks2 = kept.map(({ t }) => t);
          set({
            queue: tracks2,
            currentIndex: idx,
            isPlaying: true,
            // Cleared on every fresh seed; the Home card handler re-sets it
            // right after (via setNowPlayingKey) when the play came from a card.
            nowPlayingKey: null,
            currentTime: 0,
            // Fresh queue = fresh shuffle pass (sequential mode ignores these).
            shuffleUpcomingIds: get().shuffle
              ? buildShufflePlan(tracks2, tracks2[idx].id)
              : [],
            shuffleHistoryIds: [],
          });
        },

        reset: () =>
          set({
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            // Everything the previous person's session left behind, not just the
            // queue. `lastLoggedTrack` is what Home reads to put a song at the
            // top of "Recently played" — left set across a switch, the outgoing
            // person's last song is prepended to the INCOMING person's shelf and
            // written into their profile-scoped cache, where it survives a
            // relaunch. `nowPlayingKey` is milder (a card drawn as playing that
            // isn't) but it's the same stale identity.
            lastLoggedTrack: null,
            nowPlayingKey: null,
            shuffleUpcomingIds: [],
            shuffleHistoryIds: [],
          }),

        adoptHandoff: (tracks, index, position, playing) => {
          if (tracks.length === 0) return;
          const idx = Math.max(0, Math.min(index, tracks.length - 1));
          set({
            queue: tracks,
            currentIndex: idx,
            currentTime: Math.max(0, position),
            isPlaying: playing,
            shuffleUpcomingIds: get().shuffle
              ? buildShufflePlan(tracks, tracks[idx].id)
              : [],
            shuffleHistoryIds: [],
          });
        },

        playPause: () => set((s) => ({ isPlaying: !s.isPlaying })),
        setNowPlayingKey: (key) => set({ nowPlayingKey: key }),
        markPlayLogged: (t) => set({ lastLoggedTrack: t }),
        setBuffering: (b) => set({ buffering: b }),
        play: () => set({ isPlaying: true }),
        pause: () => set({ isPlaying: false }),

        enqueue: (track) => {
          if (!canStream(track)) return;
          const { queue, shuffle, shuffleUpcomingIds } = get();
          if (queue.some((q) => q.id === track.id)) return; // already queued
          set({
            queue: [...queue, track],
            // An explicit "Add to queue" means play SOON — under shuffle it
            // takes the front of the plan (Spotify semantics), not a random
            // slot it might never reach this pass.
            ...(shuffle
              ? { shuffleUpcomingIds: [track.id, ...shuffleUpcomingIds] }
              : {}),
          });
        },

        appendToQueue: (tracks) => {
          const { queue, shuffle, shuffleUpcomingIds } = get();
          const seen = new Set(queue.map((q) => q.id));
          const add: T[] = [];
          for (const t of tracks) {
            if (!canStream(t) || seen.has(t.id)) continue;
            seen.add(t.id);
            add.push(t);
          }
          if (add.length === 0) return 0;
          set({
            queue: [...queue, ...add],
            // Autoplay/radio extension: fold the new ids into the tail of the
            // current pass, themselves shuffled.
            ...(shuffle
              ? {
                  shuffleUpcomingIds: [
                    ...shuffleUpcomingIds,
                    ...buildShufflePlan(add),
                  ],
                }
              : {}),
          });
          return add.length;
        },

        removeAt: (index) => {
          const { queue, currentIndex, shuffleUpcomingIds } = get();
          if (index < 0 || index >= queue.length || index === currentIndex)
            return;
          // Drop ONE plan occurrence of the removed id (queues can hold
          // duplicate ids; the other copy keeps its turn).
          const removedId = queue[index].id;
          const k = shuffleUpcomingIds.indexOf(removedId);
          set({
            queue: queue.slice(0, index).concat(queue.slice(index + 1)),
            // Keep currentIndex pointing at the same track after the splice.
            currentIndex: index < currentIndex ? currentIndex - 1 : currentIndex,
            ...(k >= 0
              ? {
                  shuffleUpcomingIds: shuffleUpcomingIds
                    .slice(0, k)
                    .concat(shuffleUpcomingIds.slice(k + 1)),
                }
              : {}),
          });
        },

        jumpTo: (index) => {
          const { queue, currentIndex, shuffle, shuffleUpcomingIds } = get();
          if (index < 0 || index >= queue.length || !canStream(queue[index]))
            return;
          // A manual pick counts as this pass's turn for that track: pull it
          // from the plan and record where we came from for prev().
          const target = queue[index].id;
          const k = shuffleUpcomingIds.indexOf(target);
          set({
            currentIndex: index,
            currentTime: 0,
            isPlaying: true,
            ...(shuffle
              ? {
                  shuffleUpcomingIds:
                    k >= 0
                      ? shuffleUpcomingIds
                          .slice(0, k)
                          .concat(shuffleUpcomingIds.slice(k + 1))
                      : shuffleUpcomingIds,
                  shuffleHistoryIds: pushHistory(
                    get().shuffleHistoryIds,
                    queue[currentIndex]?.id,
                  ),
                }
              : {}),
          });
        },

        playNext: (index) => {
          const { queue, currentIndex, shuffle, shuffleUpcomingIds } = get();
          if (index < 0 || index >= queue.length || index === currentIndex)
            return;
          const item = queue[index];
          const without = queue.slice(0, index).concat(queue.slice(index + 1));
          // Where the current track sits after removing `index`, then insert
          // right after it.
          const curAfter = index < currentIndex ? currentIndex - 1 : currentIndex;
          const insertAt = curAfter + 1;
          // Under shuffle "play next" is a plan edit too: move the id to the
          // front (removing its existing turn, wherever it was).
          const k = shuffleUpcomingIds.indexOf(item.id);
          const planless =
            k >= 0
              ? shuffleUpcomingIds
                  .slice(0, k)
                  .concat(shuffleUpcomingIds.slice(k + 1))
              : shuffleUpcomingIds;
          set({
            queue: without.slice(0, insertAt).concat([item], without.slice(insertAt)),
            currentIndex: curAfter,
            ...(shuffle ? { shuffleUpcomingIds: [item.id, ...planless] } : {}),
          });
        },

        movePlanItem: (from, to) =>
          set((s) => {
            const p = s.shuffleUpcomingIds;
            if (
              !s.shuffle ||
              from === to ||
              from < 0 ||
              from >= p.length ||
              to < 0 ||
              to >= p.length
            )
              return {};
            const q = p.slice();
            const [id] = q.splice(from, 1);
            q.splice(to, 0, id);
            return { shuffleUpcomingIds: q };
          }),

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
          // Follow the currently-playing track to wherever the splice moved it
          // (queue entries are distinct object refs, so identity lookup is exact).
          const newIndex = q.indexOf(curRef);
          set({ queue: q, currentIndex: newIndex >= 0 ? newIndex : currentIndex });
        },

        clearUpcoming: () => {
          const { queue, currentIndex } = get();
          // Nothing after the current track → no-op.
          if (currentIndex >= queue.length - 1) return;
          // Keep the current track (and any history before it); drop the tail.
          // "Clear up next" clears the shuffle plan too — nothing is upcoming.
          set({
            queue: queue.slice(0, currentIndex + 1),
            shuffleUpcomingIds: [],
          });
        },

        next: () => advance(0),

        peekNextIndex: () => {
          const s = get();
          const { queue, currentIndex, shuffle, repeat } = s;
          if (queue.length === 0) return -1;
          if (!shuffle) {
            if (currentIndex + 1 < queue.length) return currentIndex + 1;
            return repeat === 'all' ? 0 : -1;
          }
          for (const id of s.shuffleUpcomingIds) {
            const found = queue.findIndex(
              (t, i) => t.id === id && i !== currentIndex,
            );
            if (found >= 0 && canStream(queue[found])) return found;
          }
          // Pass exhausted — a repeat-'all' reshuffle hasn't happened yet, so
          // the next pick is unknowable here.
          return -1;
        },

        prev: () => {
          const s = get();
          const { queue, currentIndex, currentTime, shuffle } = s;
          // Common UX: if past the 3s mark, restart current; otherwise go back.
          if (currentTime > 3) {
            set({ currentTime: 0 });
            return;
          }
          if (shuffle) {
            // Walk back through what actually PLAYED, skipping ids that left
            // the queue since. queue[index-1] is meaningless mid-shuffle.
            const hist = s.shuffleHistoryIds.slice();
            let idx = -1;
            while (hist.length > 0 && idx < 0) {
              const id = hist.pop() as number;
              const found = queue.findIndex(
                (t, i) => t.id === id && i !== currentIndex,
              );
              if (found >= 0 && canStream(queue[found])) idx = found;
            }
            if (idx < 0) {
              set({ currentTime: 0 });
              return;
            }
            const curId = queue[currentIndex]?.id;
            set({
              currentIndex: idx,
              currentTime: 0,
              shuffleHistoryIds: hist,
              // Forward after back revisits where we just were (symmetric
              // back/forward, like every player's history navigation).
              shuffleUpcomingIds:
                curId == null
                  ? s.shuffleUpcomingIds
                  : [curId, ...s.shuffleUpcomingIds],
            });
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
        toggleMute: () => {
          const v = get().volume;
          if (v > 0) {
            preMuteVolume = v;
            set({ volume: 0 });
          } else {
            set({ volume: preMuteVolume > 0 ? preMuteVolume : 1 });
          }
        },

        toggleRepeat: () =>
          set((s) => ({
            repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
          })),
        toggleShuffle: () =>
          set((s) => {
            const on = !s.shuffle;
            return {
              shuffle: on,
              // Every ON starts a fresh pass over the current queue; OFF
              // discards the plan (sequential mode never consults it).
              shuffleUpcomingIds: on
                ? buildShufflePlan(s.queue, s.queue[s.currentIndex]?.id)
                : [],
              shuffleHistoryIds: [],
            };
          }),

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
        };
      },
      {
        name: persistName,
        version: persistVersion,
        storage: createJSONStorage(() => localStorage as unknown as StateStorage),
        // On an older stored blob, flip a persisted 'all' (the old loop default)
        // to 'off' so a finished queue rolls into autoplay-radio. One-time; an
        // explicit repeat choice persists after this.
        migrate: (persisted, fromVersion) => {
          const s = (persisted ?? {}) as Partial<PlayerState<T>>;
          if (fromVersion < persistVersion && s.repeat === 'all') s.repeat = 'off';
          return s as PlayerState<T>;
        },
        // Persist only what should survive a reload. isPlaying is excluded so
        // opening the app never auto-starts playback; duration is re-derived
        // from the audio element. `volume` is desktop-only (see persistVolume).
        partialize: (state) => ({
          queue: state.queue,
          currentIndex: state.currentIndex,
          currentTime: state.currentTime,
          repeat: state.repeat,
          shuffle: state.shuffle,
          autoplay: state.autoplay,
          crossfadeSeconds: state.crossfadeSeconds,
          ...(persistVolume ? { volume: state.volume } : {}),
        }),
        // Force playback paused on rehydrate. User taps play to resume — Spotify
        // and Apple Music behave the same way. The shuffle plan/history are
        // deliberately NOT persisted (partialize above) — a reload starts a
        // fresh pass so the plan can never disagree with a queue edited on
        // another surface meanwhile.
        onRehydrateStorage: () => (state) => {
          if (state) {
            state.isPlaying = false;
            if (state.shuffle) {
              state.shuffleUpcomingIds = buildShufflePlan(
                state.queue ?? [],
                state.queue?.[state.currentIndex]?.id,
              );
              state.shuffleHistoryIds = [];
            }
          }
        },
      },
    ),
  );
}

/** The active track for a store state (queue[currentIndex]). */
export function currentTrackOf<T>(state: PlayerState<T>): T | undefined {
  return state.queue[state.currentIndex];
}
