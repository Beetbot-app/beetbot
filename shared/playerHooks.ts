import { useEffect, useRef, type MutableRefObject } from 'react';
import type { UseBoundStore, StoreApi } from 'zustand';
import { currentTrackOf, type PlayerState } from './playerStore';
import {
  logPlay,
  logPlayFinish,
  fetchRadioStreamTracks,
  type StreamTrack,
} from './api';

/**
 * Player-behavior effects shared by the desktop (PlayerBar) and phone (Player)
 * surfaces. These four effects were duplicated near-verbatim and had drifted —
 * most dangerously the autoplay-radio resume predicate, which was algebraically
 * equal but textually different, so the two could diverge silently. Each hook
 * takes the platform's store (the `createPlayerStore<T>` instance) plus the few
 * genuinely platform-specific bits (token, profile, radio-row mapping).
 */
type PlayerStoreHook<T> = UseBoundStore<StoreApi<PlayerState<T>>>;

/** Snapshot of a track's latest playback position, refreshed on each timeupdate
 *  (snapped to full length on natural end) by the component's audio handlers. */
export type PlaybackTick = { id: number; ms: number; durMs: number };

/** Sleep timer: pause when the scheduled epoch-ms arrives. (The "end of track"
 *  variant is handled in the store's handleTrackEnded.) */
export function useSleepTimer<T extends { id: number }>(
  store: PlayerStoreHook<T>,
): void {
  const sleepTimerEndsAt = store((s) => s.sleepTimerEndsAt);
  useEffect(() => {
    if (sleepTimerEndsAt == null) return;
    const fire = () => {
      store.getState().pause();
      store.getState().setSleepTimer('off');
    };
    const ms = sleepTimerEndsAt - Date.now();
    if (ms <= 0) {
      fire();
      return;
    }
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  }, [sleepTimerEndsAt, store]);
}

/**
 * Autoplay / radio: keep the queue flowing past its end. When you reach the end
 * with repeat OFF and autoplay ON, fetch songs similar to the current track and
 * append them, so a single song / finished playlist rolls into a radio instead
 * of stopping. Fires while the last/second-to-last track plays so the appended
 * songs are ready before this one ends.
 */
export function useAutoplayRadio<
  T extends { id: number; artists: string[]; title: string },
>({
  store,
  getToken,
  profileId,
  buildRadioTracks,
}: {
  store: PlayerStoreHook<T>;
  /** Desktop bootstraps a session token async (ensureSession); the phone has one
   *  as a prop. Called inside the fetch, so it isn't an effect dependency. */
  getToken: () => Promise<string> | string;
  profileId: number | null;
  /** Map the radio's StreamTracks into the platform's queue-row type (desktop:
   *  PlaylistTrack; phone: identity). appendToQueue's canStream filter drops
   *  non-playable picks. */
  buildRadioTracks: (more: StreamTrack[]) => T[];
}): void {
  const isPlaying = store((s) => s.isPlaying);
  const autoplay = store((s) => s.autoplay);
  const shuffle = store((s) => s.shuffle);
  const repeat = store((s) => s.repeat);
  const track = store(currentTrackOf);
  const queueLength = store((s) => s.queue.length);
  const currentIndex = store((s) => s.currentIndex);
  const radioKeyRef = useRef('');
  const radioInFlightRef = useRef(false);
  useEffect(() => {
    if (!isPlaying || !autoplay || shuffle || repeat !== 'off' || !track) return;
    const upcoming = queueLength - 1 - currentIndex; // tracks queued after current
    if (upcoming > 1) return; // still plenty ahead
    const seed = track.artists?.[0];
    if (!seed) return;
    // De-dupe identical triggers (same queue length + seed) so we fetch once per
    // tail; after appending, queueLength changes and a new tail can re-trigger.
    const key = `${queueLength}:${track.id}`;
    if (radioInFlightRef.current || radioKeyRef.current === key) return;
    radioKeyRef.current = key;
    radioInFlightRef.current = true;
    void (async () => {
      try {
        const tok = await getToken();
        const more = await fetchRadioStreamTracks(seed, tok, {
          title: track.title,
          limit: 30,
          profileId,
        });
        if (!more.length) return;
        const rows = buildRadioTracks(more);
        // Capture the length BEFORE appending, then key the resume off it — a
        // robust invariant regardless of appendToQueue's return semantics.
        const before = store.getState().queue.length;
        const n = store.getState().appendToQueue(rows);
        // If the track already ended while this fetch was in flight (queue ran
        // dry and playback stopped at the tail), roll into the fresh radio.
        if (n > 0) {
          const s = store.getState();
          if (!s.isPlaying && s.currentTime === 0 && s.currentIndex === before - 1) {
            s.jumpTo(s.currentIndex + 1);
          }
        }
      } finally {
        radioInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, repeat, shuffle, isPlaying, track?.id, queueLength, currentIndex, profileId]);
}

/** Listening stats: log a play once the current track passes ~20s (once per
 *  play; a restart re-arms it). `token` may be null on desktop until the session
 *  bootstraps — logging waits for it. */
export function usePlayLogging<T extends { id: number }>({
  store,
  token,
  profileId,
}: {
  store: PlayerStoreHook<T>;
  token: string | null;
  profileId: number | null;
}): void {
  const track = store(currentTrackOf);
  const currentTime = store((s) => s.currentTime);
  const playLoggedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!track || !token) return;
    if (currentTime < 1 && playLoggedRef.current === track.id) {
      playLoggedRef.current = null; // track restarted — allow a fresh log
    } else if (currentTime >= 20 && playLoggedRef.current !== track.id) {
      playLoggedRef.current = track.id;
      void logPlay(token, track.id, profileId);
      // Same threshold the server uses to record a play: surface it to Home so
      // the live "Recently played" prepend only shows tracks the feed will keep.
      store.getState().markPlayLogged(track);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, track?.id, token, profileId]);
}

/**
 * Completion signal (finished vs skipped). The component owns `lastTickRef`
 * (its audio handlers write the latest position); this hook reports the OUTGOING
 * track's final position when the track changes (or the player unmounts). `token`
 * null (desktop pre-session) suppresses the report.
 */
export function useCompletionSignal<T extends { id: number }>({
  store,
  token,
  profileId,
  lastTickRef,
}: {
  store: PlayerStoreHook<T>;
  token: string | null;
  profileId: number | null;
  lastTickRef: MutableRefObject<PlaybackTick | null>;
}): void {
  const track = store(currentTrackOf);
  const reportFinishRef = useRef<(p: PlaybackTick) => void>(() => {});
  reportFinishRef.current = (p) => {
    if (p.ms < 5000 || !token) return; // ignore accidental taps
    const completed = p.durMs > 0 && p.ms >= 0.85 * p.durMs;
    void logPlayFinish(token, p.id, p.ms, completed, profileId);
  };
  useEffect(() => {
    const myId = track?.id;
    // Cleanup runs when track.id changes (or the player unmounts), with the
    // outgoing track's last tick still in the ref. Refs keep this effect from
    // re-firing on token/profile changes.
    return () => {
      const p = lastTickRef.current;
      if (p && p.id === myId) reportFinishRef.current(p);
    };
  }, [track?.id]);
}
