import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ipc, type PlaylistTrack } from '@/lib/tauri';
import { usePlayerStore } from '@/lib/store';

/**
 * Drive the native Rust audio engine (src-tauri/src/engine) from the player
 * store when `active` — i.e. the "Native audio engine (beta)" flag is on AND
 * we're not casting. It handles both downloaded files and streamed `/live`
 * tracks (fetched into the engine over loopback). It mirrors what the two
 * `<audio>` element effects do (load / play-pause / volume / seek / crossfade /
 * EQ+Normalize+mono), but over Tauri commands, and feeds the engine's tick /
 * ended / error events back into the store. When inactive it stops the engine,
 * so the webview player owns playback.
 *
 * Repeat-one loops in the engine itself (the track id doesn't change on a loop,
 * so a frontend reload wouldn't fire) via `engineSetRepeatOne`; repeat off/all
 * advance through the track-id change like the webview path.
 */

interface TickPayload {
  position: number;
  duration: number;
}

interface BufferingPayload {
  active: boolean;
}

interface AdvancedPayload {
  position: number;
}

export function useNativeEngine({
  active,
  track,
  source,
  isPlaying,
  volume,
  currentTime,
  crossfadeSeconds,
  nextSource,
  nextDurationMs,
  eqEnabled,
  eqGains,
  mono,
  normalize,
  loudnessTarget,
  repeatOne,
}: {
  active: boolean;
  track: PlaylistTrack | null;
  /** Local file path or http stream URL the engine should load. */
  source: string | null;
  isPlaying: boolean;
  volume: number;
  currentTime: number;
  /** Crossfade length (seconds); 0 = off. */
  crossfadeSeconds: number;
  /** Source of the NEXT queued track, preloaded for a gapless crossfade. */
  nextSource: string | null;
  nextDurationMs: number;
  /** EQ + mono + Normalize effects applied to the native engine. */
  eqEnabled: boolean;
  eqGains: number[];
  mono: boolean;
  normalize: boolean;
  /** Normalize target in LUFS (e.g. -14). */
  loudnessTarget: number;
  /** Repeat-one: the engine loops the current track natively. */
  repeatOne: boolean;
}) {
  const activeRef = useRef(active);
  activeRef.current = active;
  // The position the engine last reported. A store `currentTime` that diverges
  // from it means the USER seeked (not just an engine-tick echo).
  const lastTickRef = useRef(0);
  // Track id currently loaded into the engine (null = nothing loaded).
  const loadedIdRef = useRef<number | null>(null);

  const trackId = track?.id ?? null;
  const durationMs = track?.duration_ms ?? 0;

  // Load on (de)activation + track change.
  useEffect(() => {
    if (!active || !source || trackId == null) {
      if (loadedIdRef.current !== null) {
        loadedIdRef.current = null;
        void ipc.engineStop().catch(() => {});
      }
      return;
    }
    if (loadedIdRef.current === trackId) return;
    loadedIdRef.current = trackId;
    const s = usePlayerStore.getState();
    lastTickRef.current = s.currentTime;
    // Snap the total to this track up front (the engine will confirm it via the
    // tick) so a normal track change never flashes the previous song's length.
    if (durationMs > 0) s.setDuration(durationMs / 1000);
    void ipc.engineLoad(source, durationMs, s.currentTime, s.isPlaying).catch(() => {});
  }, [active, source, trackId, durationMs]);

  // Play / pause.
  useEffect(() => {
    if (!active) return;
    if (isPlaying) void ipc.enginePlay().catch(() => {});
    else void ipc.enginePause().catch(() => {});
  }, [active, isPlaying]);

  // Volume.
  useEffect(() => {
    if (!active) return;
    void ipc.engineSetVolume(volume).catch(() => {});
  }, [active, volume]);

  // Seek: a store currentTime that jumped away from the last engine tick is a
  // user drag (the natural per-tick echo lands within the 1 s threshold).
  useEffect(() => {
    if (!active) return;
    if (Math.abs(currentTime - lastTickRef.current) > 1) {
      lastTickRef.current = currentTime;
      void ipc.engineSeek(currentTime).catch(() => {});
    }
  }, [active, currentTime]);

  // Crossfade duration → engine.
  useEffect(() => {
    if (!active) return;
    void ipc.engineSetCrossfade(crossfadeSeconds).catch(() => {});
  }, [active, crossfadeSeconds]);

  // Repeat-one → engine (it loops the current track itself).
  useEffect(() => {
    if (!active) return;
    void ipc.engineSetRepeatOne(repeatOne).catch(() => {});
  }, [active, repeatOne]);

  // Preload the next track for a gapless crossfade (the engine handles the
  // ramp timing and emits engine://advanced when it promotes the deck).
  useEffect(() => {
    if (!active || crossfadeSeconds <= 0 || !nextSource) return;
    void ipc.enginePreloadNext(nextSource, nextDurationMs).catch(() => {});
  }, [active, crossfadeSeconds, nextSource, nextDurationMs]);

  // EQ / mono / Normalize → engine (lock-free; applies to both decks live).
  useEffect(() => {
    if (!active) return;
    void ipc.engineSetFx(eqEnabled, eqGains, mono, normalize, loudnessTarget).catch(() => {});
  }, [active, eqEnabled, eqGains, mono, normalize, loudnessTarget]);

  // Engine events → store. Set up once; gated by activeRef so a stray event
  // after deactivation is ignored.
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    void listen<TickPayload>('engine://tick', (e) => {
      if (!activeRef.current) return;
      lastTickRef.current = e.payload.position;
      const store = usePlayerStore.getState();
      store.setCurrentTime(e.payload.position);
      // The engine is the source of truth for duration in native mode: the
      // <audio> element is kept src-less, so its onDurationChange never runs.
      // Without this the store keeps a stale length — e.g. a crossfade advances
      // the track but the total stays on the previous (or a persisted) song's
      // time. Only write on a real change to avoid per-tick churn.
      const d = e.payload.duration;
      if (d > 0 && Math.abs(store.duration - d) > 0.5) {
        store.setDuration(d);
      }
    }).then((u) => unlisten.push(u));
    void listen<BufferingPayload>('engine://buffering', (e) => {
      if (!activeRef.current) return;
      usePlayerStore.getState().setBuffering(e.payload.active);
    }).then((u) => unlisten.push(u));
    void listen<AdvancedPayload>('engine://advanced', (e) => {
      if (!activeRef.current) return;
      usePlayerStore.getState().crossfadeAdvance(e.payload.position);
      // The engine already promoted deck B; mark it loaded so the load effect
      // doesn't reload it, and re-anchor the seek baseline.
      const s = usePlayerStore.getState();
      loadedIdRef.current = s.queue[s.currentIndex]?.id ?? null;
      lastTickRef.current = e.payload.position;
      // Snap the total to the promoted track immediately (crossfadeAdvance moves
      // the index but not the duration; the tick would otherwise correct it a
      // beat later).
      const dur = s.queue[s.currentIndex]?.duration_ms;
      if (dur && dur > 0) s.setDuration(dur / 1000);
    }).then((u) => unlisten.push(u));
    void listen('engine://ended', () => {
      if (!activeRef.current) return;
      loadedIdRef.current = null;
      usePlayerStore.getState().handleTrackEnded();
    }).then((u) => unlisten.push(u));
    void listen('engine://error', () => {
      if (!activeRef.current) return;
      loadedIdRef.current = null;
      usePlayerStore.getState().next();
    }).then((u) => unlisten.push(u));
    return () => unlisten.forEach((u) => u());
  }, []);
}
