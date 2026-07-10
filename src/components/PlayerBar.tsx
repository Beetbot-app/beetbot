import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatDuration } from '@/lib/format';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { useNativeEngine } from '@/lib/nativeEngine';
import { useAppearanceStore } from '@/lib/appearance';
import { useAudioFxStore, LOUDNESS_TARGET_LUFS } from '@/lib/audiofx';
import { useNavStore } from '@/lib/nav';
import { ipc, type PlaylistTrack } from '@/lib/tauri';
import {
  castControl,
  castStart,
  castStop,
  ensureSession,
  fetchRadioStreamTracks,
  getCastStatus,
  getTrackPlaylistIds,
  logPlay,
  logPlayFinish,
  listCastDevices,
  listDevices,
  pollHandoff,
  pollRemoteCommands,
  postHandoff,
  postRemoteCommand,
  requestHandoff,
  sendHeartbeat,
  setApiBase,
  type CastDevice,
  type HandoffPayload,
  type RemoteAction,
  type RemoteDevice,
  type SearchTrackResult,
} from '@shared/api';
import { CastPicker } from '@shared/components/CastPicker';
import { Marquee } from '@shared/components/Marquee';
import { SleepTimerButton } from '@shared/components/SleepTimerButton';
import { LikeButton } from '@shared/components/LikeButton';
import { AddToPlaylistModal } from '@shared/components/SearchScreen';
import { useProfileStore } from '@/lib/profile';
import { useLikesStore } from '@/lib/likes';
import { RemoteNowPlaying } from '@shared/components/RemoteNowPlaying';
import { audioStarted, registerAudioPauser } from '@shared/audioCoordinator';
import { useUiStore } from '@/lib/ui';

// The shared HTTP client needs to know where the local streaming
// server is; SearchPage already calls this at module load, but
// PlayerBar can mount before any Search page does, so set it here too.
// setApiBase is idempotent (last writer wins to the same value).
setApiBase('http://127.0.0.1:47823');

/// Fixed-height (80px) audio control + a hidden &lt;audio&gt; element that drives
/// it. Mounted once at the App level so playback survives page navigation.
export function PlayerBar({ floating = false }: { floating?: boolean }) {
  // Two <audio> elements that ping-pong: `audioRef` is the active one,
  // `fadeRef` the idle/crossfade one. They swap on each crossfade so the
  // incoming track is never reloaded at the boundary (no gap). With crossfade
  // off, A stays active forever and this behaves exactly like one element.
  const aRef = useRef<HTMLAudioElement>(null);
  const bRef = useRef<HTMLAudioElement>(null);
  const [activeIsA, setActiveIsA] = useState(true);
  const audioRef = activeIsA ? aRef : bRef;
  const fadeRef = activeIsA ? bRef : aRef;
  // Set at a crossfade flip so the imperative-src effect leaves the freshly-
  // promoted element's src alone (it's already playing the incoming track).
  const justFlippedRef = useRef(false);

  const track = usePlayerStore(currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const nativeEngine = useAppearanceStore((s) => s.nativeEngine);
  const eqEnabled = useAudioFxStore((s) => s.eqEnabled);
  const eqGains = useAudioFxStore((s) => s.eqGains);
  const monoFx = useAudioFxStore((s) => s.mono);
  const normalizeFx = useAudioFxStore((s) => s.normalize);
  const loudnessFx = useAudioFxStore((s) => s.loudness);
  const repeat = usePlayerStore((s) => s.repeat);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const queueLength = usePlayerStore((s) => s.queue.length);

  const playPause = usePlayerStore((s) => s.playPause);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const handleTrackEnded = usePlayerStore((s) => s.handleTrackEnded);
  const adoptHandoff = usePlayerStore((s) => s.adoptHandoff);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const appendToQueue = usePlayerStore((s) => s.appendToQueue);
  const playAt = usePlayerStore((s) => s.playAt);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const crossfadeAdvance = usePlayerStore((s) => s.crossfadeAdvance);

  // ---- Crossfade (default off). The idle element (fadeRef) plays the
  // incoming track and ramps up while the active one ramps down; at the end
  // we just SWAP which element is active (ping-pong) so the incoming track is
  // never reloaded — no gap. Gated on crossfadeSeconds > 0 && !casting.
  const cfStateRef = useRef<'idle' | 'fading'>('idle');
  const cfRafRef = useRef<number | null>(null);

  // Consecutive failed-load counter for the onError skip: a track whose
  // stream/live-resolve fails advances to the next one, but after 3 failures
  // in a row we stop instead of skip-looping a whole queue through a broken
  // backend. Reset whenever a track actually starts playing.
  const errorSkipRef = useRef(0);

  // Sleep timer: pause when the scheduled time arrives. (The "end of track"
  // variant is handled in the store's handleTrackEnded.)
  useEffect(() => {
    if (sleepTimerEndsAt == null) return;
    const fire = () => {
      usePlayerStore.getState().pause();
      usePlayerStore.getState().setSleepTimer('off');
    };
    const ms = sleepTimerEndsAt - Date.now();
    if (ms <= 0) {
      fire();
      return;
    }
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  }, [sleepTimerEndsAt]);

  // Click-through from the now-playing bar to the artist / album pages.
  const openArtistPage = useNavStore((s) => s.openArtist);
  const openAlbumPage = useNavStore((s) => s.openAlbum);

  // Mutual exclusion with the 30-second preview clips: when a preview starts,
  // pause the full-track player. (The reverse is announced from <audio onPlay>.)
  useEffect(
    () => registerAudioPauser('main', () => usePlayerStore.getState().pause()),
    [],
  );

  // Push current track metadata to the OS Now Playing widget via the
  // standard Web MediaSession API. On macOS the WKWebView claims the
  // AVAudioSession when our hidden <audio> plays, so MPNowPlayingInfoCenter
  // listens to *this* API, not to souvlaki's private-framework writes.
  // We still call the Rust IPC -- it logs and stays useful for Linux /
  // Windows once we ship those -- but MediaSession is what makes Control
  // Center actually render on macOS.
  useEffect(() => {
    if (!track) return;
    void ipc
      .mediaSetTrack(
        track.title,
        track.artists.join(', '),
        track.album,
        track.album_art_url,
        Math.round(track.duration_ms / 1000),
      )
      .catch(() => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artists.join(', '),
        album: track.album ?? undefined,
        artwork: track.album_art_url
          ? [{ src: track.album_art_url, sizes: '640x640', type: 'image/jpeg' }]
          : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // Push play / pause. Read currentTime non-reactively so we are not pinging
  // every onTimeUpdate tick.
  useEffect(() => {
    if (!track) return;
    const pos = usePlayerStore.getState().currentTime;
    void ipc.mediaSetPlayback(isPlaying, pos).catch(() => {});
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, track?.id]);

  // Hook the MediaSession action handlers up once. These fire from media
  // keys, headphone buttons, AirPods, and the Control Center buttons on
  // macOS via the WKWebView -> MediaPlayer.framework bridge.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const store = usePlayerStore.getState;
    ms.setActionHandler('play', () => store().play());
    ms.setActionHandler('pause', () => store().pause());
    ms.setActionHandler('previoustrack', () => store().prev());
    ms.setActionHandler('nexttrack', () => store().next());
    ms.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        store().setCurrentTime(details.seekTime);
      }
    });
    return () => {
      for (const a of [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekto',
      ] as MediaSessionAction[]) {
        ms.setActionHandler(a, null);
      }
    };
  }, []);

  // Tell MediaSession about the current playback position so the Control
  // Center scrubber tracks. Cheap call -- bag it whenever currentTime
  // changes significantly.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: duration || track.duration_ms / 1000,
        playbackRate: 1,
        position: Math.min(currentTime, duration || track.duration_ms / 1000),
      });
    } catch {
      // setPositionState throws if values are inconsistent (e.g. duration 0).
    }
  }, [track, currentTime, duration]);

  // ---- Chromecast (server-side) ---------------------------------------
  //
  // The Beetbot Rust backend speaks the Cast V2 protocol to nearby
  // Chromecasts directly (see src-tauri/src/cast/). When `castActive`
  // is non-null, this component shifts into "remote control" mode:
  // the local <audio> stays paused, and transport buttons route to
  // /api/cast/control instead. Declared above the audio-drive effect
  // because that effect needs to read `castActive` to know whether
  // to even start the local element.
  //
  // Session token: we need one to call /api/cast/*; bootstrap on
  // mount via ensureSession() and cache for the lifetime of the bar.
  const [castToken, setCastToken] = useState<string | null>(null);
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  const [castPickerOpen, setCastPickerOpen] = useState(false);
  const [castActive, setCastActive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [castError, setCastError] = useState<string | null>(null);

  // ---- Liked Songs (heart) ----
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  // Liked state is shared with the full Now Playing view (which covers the bar),
  // so a like in either surface shows in the other.
  const likedIds = useLikesStore((s) => s.likedIds);
  const toggleLike = useLikesStore((s) => s.toggle);
  const refreshLikes = useLikesStore((s) => s.refresh);
  useEffect(() => {
    void refreshLikes(activeProfileId);
  }, [activeProfileId, refreshLikes]);

  // ---- Autoplay / radio: keep the queue flowing past its end ----
  // When you reach the end of the queue with repeat OFF and autoplay ON, fetch
  // songs similar to the current track and append them — so a single searched
  // song (or a finished playlist) rolls into a radio of similar music instead of
  // stopping. Fires while the last/second-to-last track plays so the appended
  // songs are ready before this one ends. Mirrors the phone player.
  const radioKeyRef = useRef('');
  const radioInFlightRef = useRef(false);
  useEffect(() => {
    if (!isPlaying || !autoplay || shuffle || repeat !== 'off' || !track) return;
    const upcoming = queue.length - 1 - currentIndex; // tracks queued after current
    if (upcoming > 1) return; // still plenty ahead
    const seed = track.artists?.[0];
    if (!seed) return;
    // De-dupe identical triggers (same queue length + seed) so we fetch once per
    // tail; after appending, queue.length changes and a new tail can re-trigger.
    const key = `${queue.length}:${track.id}`;
    if (radioInFlightRef.current || radioKeyRef.current === key) return;
    radioKeyRef.current = key;
    radioInFlightRef.current = true;
    void (async () => {
      try {
        const tok = await ensureSession();
        const more = await fetchRadioStreamTracks(seed, tok, {
          title: track.title,
          limit: 30,
          profileId: activeProfileId,
        });
        if (!more.length) return;
        // Map radio StreamTracks → desktop PlaylistTracks (the queue's row shape).
        // Only rows with an audio file (status 'downloaded') survive the queue's
        // canStream filter; non-audio radio picks are dropped by appendToQueue.
        const rows: PlaylistTrack[] = more.map((m) => ({
          id: m.id,
          spotify_id: '',
          title: m.title,
          artists: m.artists,
          album: m.album ?? null,
          album_art_url: m.album_art_url ?? null,
          duration_ms: m.duration_ms,
          isrc: null,
          status: m.status,
          failure_reason: null,
          local_path: null,
          position: 0,
          added_at: null,
        }));
        const before = usePlayerStore.getState().queue.length;
        const n = appendToQueue(rows);
        // If the track already ended while this fetch was in flight (queue ran
        // dry and playback stopped at the tail), roll into the fresh radio.
        if (n > 0) {
          const s = usePlayerStore.getState();
          if (!s.isPlaying && s.currentTime === 0 && s.currentIndex === before - 1) {
            playAt(s.currentIndex + 1);
          }
        }
      } finally {
        radioInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, repeat, shuffle, isPlaying, track?.id, queue.length, currentIndex, activeProfileId]);

  // ---- Listening stats: log a play once a track passes ~20s ----
  const playLoggedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!track || !castToken) return;
    if (currentTime < 1 && playLoggedRef.current === track.id) {
      playLoggedRef.current = null;
    } else if (currentTime >= 20 && playLoggedRef.current !== track.id) {
      playLoggedRef.current = track.id;
      void logPlay(castToken, track.id, activeProfileId);
      // Same threshold the server uses to record a play: surface it to Home so
      // the live "Recently played" prepend only shows tracks the feed will keep.
      usePlayerStore.getState().markPlayLogged(track);
    }
  }, [currentTime, track?.id, castToken, activeProfileId]);

  // ---- Phase 0: completion signal (finished vs skipped) ----
  // Latest position of the current track, refreshed each timeupdate (snapped to
  // full length on natural end); reported for the OUTGOING track on track change.
  const lastTickRef = useRef<{ id: number; ms: number; durMs: number } | null>(
    null,
  );
  const reportFinishRef = useRef<
    (p: { id: number; ms: number; durMs: number }) => void
  >(() => {});
  reportFinishRef.current = (p) => {
    if (p.ms < 5000 || !castToken) return; // ignore accidental taps
    const completed = p.durMs > 0 && p.ms >= 0.85 * p.durMs;
    void logPlayFinish(castToken, p.id, p.ms, completed, activeProfileId);
  };
  useEffect(() => {
    const myId = track?.id;
    return () => {
      const p = lastTickRef.current;
      if (p && p.id === myId) reportFinishRef.current(p);
    };
  }, [track?.id]);

  const trackLiked = track ? likedIds.has(track.id) : false;
  // The heart opens a Spotify-style "Add to playlist" picker (Liked Songs pinned
  // to the top) instead of a bare like-toggle — so the now-playing song can go
  // into any playlist, and liking is just the first row. We carry the resolved
  // token alongside the built SearchTrackResult so the modal can save.
  const [addToPlaylist, setAddToPlaylist] = useState<{
    track: SearchTrackResult;
    token: string;
  } | null>(null);
  const openAddToPlaylist = useCallback(() => {
    if (!track || !castToken) return;
    const t = track;
    const tok = castToken;
    // Pre-check the playlists this track is already in (incl. Liked Songs) so the
    // picker opens with the right rows ticked.
    void getTrackPlaylistIds(t.id, tok, activeProfileId)
      .catch(() => [] as number[])
      .then((inIds) => {
        setAddToPlaylist({
          token: tok,
          // source 'local' + source_id = the library track id makes the hub link
          // this existing row rather than upsert a duplicate (see patch handler).
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
      });
  }, [track, castToken, activeProfileId]);
  const closeAddToPlaylist = useCallback(() => {
    setAddToPlaylist(null);
    // The picker may have added/removed the track from Liked Songs — refresh so
    // the heart fill reflects it.
    void refreshLikes(activeProfileId);
  }, [refreshLikes, activeProfileId]);
  // Two now-playing surfaces: the artwork opens the FULL-window view (takes over
  // the app); the lyrics / queue buttons open the docked right bar.
  const nowPlayingFull = useUiStore((s) => s.nowPlayingFull);
  const toggleFullNowPlaying = useUiStore((s) => s.toggleFullNowPlaying);
  const rightBar = useUiStore((s) => s.rightBar);
  const toggleRightBar = useUiStore((s) => s.toggleRightBar);

  // ---- Playback handoff (control the computer's playback from the phone,
  // and hand a queue back and forth). Other online devices we can hand to:
  const [handoffDevices, setHandoffDevices] = useState<RemoteDevice[]>([]);
  const [handoffMenuOpen, setHandoffMenuOpen] = useState(false);

  // Buffering: true while the active <audio> is loading/stalled, so the UI can
  // show a spinner instead of looking frozen. Lives in the store so the full
  // Now Playing view can show the same spinner.
  const buffering = usePlayerStore((s) => s.buffering);
  const setBuffering = usePlayerStore((s) => s.setBuffering);

  // Local file when we have it. Otherwise a handed-off / catalog row (status
  // 'downloaded' but no local path on this device) streams the library file by
  // id (/stream/{id}). A track with no file at all isn't playable and never
  // reaches the player. Frozen per track id so the URL is stable for the song.
  const audioSrc = useMemo(() => {
    if (!track) return '';
    if (track.local_path) return convertFileSrc(track.local_path);
    if (!castToken) return '';
    const t = encodeURIComponent(castToken);
    const base = `http://127.0.0.1:47823/stream/${track.id}`;
    // Downloaded on the hub → its file by id; matched-but-not-downloaded → the
    // engine resolves + remuxes the source on demand via /live (full build).
    const url = track.status === 'downloaded' ? base : `${base}/live`;
    return `${url}?t=${t}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze on id+status+token
  }, [track?.id, track?.status, castToken]);

  // Same source resolution as audioSrc, for an arbitrary (next) track.
  const srcFor = useCallback(
    (t: { id: number; local_path: string | null; status?: string }): string => {
      if (t.local_path) return convertFileSrc(t.local_path);
      if (!castToken) return '';
      const base = `http://127.0.0.1:47823/stream/${t.id}`;
      const url = t.status === 'downloaded' ? base : `${base}/live`;
      return `${url}?t=${encodeURIComponent(castToken)}`;
    },
    [castToken],
  );

  // Ping-pong handoff: the incoming (fade) element is already playing the next
  // track at full volume, so we simply promote it to "active" and retire the
  // outgoing element. No reload, no seek, no gap — the incoming audio just
  // keeps going. `justFlippedRef` tells the imperative-src effect to leave the
  // promoted element's src alone (it already has the right track loaded).
  const finishCrossfade = useCallback(() => {
    const outgoing = audioRef.current;
    const incoming = fadeRef.current;
    if (cfRafRef.current != null) {
      cancelAnimationFrame(cfRafRef.current);
      cfRafRef.current = null;
    }
    cfStateRef.current = 'idle';
    if (!outgoing || !incoming) return;
    incoming.muted = false;
    incoming.volume = volume;
    const pos = incoming.currentTime;
    justFlippedRef.current = true;
    setActiveIsA((v) => !v);
    crossfadeAdvance(pos);
    // The incoming track's metadata loaded while it was the (ignored) fade
    // element, so onDurationChange never reached the store. Push its decoded
    // length now — otherwise the progress bar stays pinned to the OUTGOING
    // track's duration and currentTime climbs past it. Infinity (live-streamed,
    // un-downloaded tracks) → 0 so the display falls back to the catalog length.
    const d = incoming.duration;
    setDuration(Number.isFinite(d) ? d : 0);
    outgoing.pause();
    outgoing.volume = volume; // reset for its next turn as the fade element
  }, [volume, crossfadeAdvance, setDuration, audioRef, fadeRef]);

  // Begin the overlap: start the next track silently and ramp the two volumes
  // over the remaining time.
  const startCrossfade = useCallback(
    (next: { id: number; local_path: string | null }, remaining: number) => {
      const mainEl = audioRef.current;
      const fadeEl = fadeRef.current;
      if (!mainEl || !fadeEl) return;
      const target = volume;
      cfStateRef.current = 'fading';
      fadeEl.src = srcFor(next);
      fadeEl.volume = 0;
      try {
        fadeEl.currentTime = 0;
      } catch {
        /* ignore */
      }
      fadeEl.play().catch(() => {});
      const startT = performance.now();
      const durMs = Math.max(250, remaining * 1000);
      const step = () => {
        if (cfStateRef.current !== 'fading') return;
        const p = Math.min(1, (performance.now() - startT) / durMs);
        mainEl.volume = target * (1 - p);
        fadeEl.volume = target * p;
        if (p < 1) {
          cfRafRef.current = requestAnimationFrame(step);
        } else {
          finishCrossfade();
        }
      };
      cfRafRef.current = requestAnimationFrame(step);
    },
    [volume, srcFor, finishCrossfade, audioRef, fadeRef],
  );

  // Native audio engine (beta): drive downloaded/local tracks through the Rust
  // engine instead of the <audio> element. Streamed (/live) tracks and casting
  // stay on the webview path for now (Phase 2 extends the engine to /live).
  // What the native engine should load: the raw local path when downloaded,
  // else the same /stream/{id}[/live] URL (with token) the webview uses.
  const engineSrcFor = useCallback(
    (t: PlaylistTrack | null): string | null => {
      if (!t) return null;
      if (t.local_path) return t.local_path;
      if (!castToken) return null;
      const tok = encodeURIComponent(castToken);
      const base = `http://127.0.0.1:47823/stream/${t.id}`;
      const url = t.status === 'downloaded' ? base : `${base}/live`;
      return `${url}?t=${tok}`;
    },
    [castToken],
  );
  const engineSource = useMemo(
    () => engineSrcFor(track ?? null),
    [engineSrcFor, track?.id, track?.local_path, track?.status],
  );
  const nextTrack = queue[currentIndex + 1] ?? null;
  const nextSource = useMemo(
    () => engineSrcFor(nextTrack),
    [engineSrcFor, nextTrack?.id, nextTrack?.local_path, nextTrack?.status],
  );
  const nativeActive = nativeEngine && !castActive && !!engineSource;
  useNativeEngine({
    active: nativeActive,
    track: track ?? null,
    source: engineSource,
    isPlaying,
    volume,
    currentTime,
    crossfadeSeconds,
    nextSource,
    nextDurationMs: nextTrack?.duration_ms ?? 0,
    eqEnabled,
    eqGains,
    mono: monoFx,
    normalize: normalizeFx,
    loudnessTarget: LOUDNESS_TARGET_LUFS[loudnessFx],
    repeatOne: repeat === 'one',
  });

  // Arm the crossfade once the current track is within crossfadeSeconds of the
  // end. Off entirely when crossfadeSeconds is 0, while casting, or on native.
  useEffect(() => {
    if (crossfadeSeconds <= 0 || castActive || nativeActive || !isPlaying || !track) return;
    // A hidden/occluded WKWebView pauses requestAnimationFrame, which drives the
    // crossfade ramp + deck flip — so a crossfade started in the background would
    // stall (incoming stuck at volume 0, no advance) and go silent until the
    // window is refocused. While hidden, skip the crossfade entirely and let the
    // rAF-free onEnded handler advance at the true track end. (Re-runs on each
    // timeupdate, so it re-arms the moment the window comes back to the front.)
    if (document.hidden) return;
    if (cfStateRef.current !== 'idle') return;
    if (!(duration > 0)) return;
    const next = queue[currentIndex + 1];
    if (!next) return;
    const remaining = duration - currentTime;
    if (remaining > 0.2 && remaining <= crossfadeSeconds) {
      startCrossfade(next, remaining);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, duration, crossfadeSeconds, castActive, isPlaying, track?.id]);

  // Clean up any in-flight ramp on unmount.
  useEffect(
    () => () => {
      if (cfRafRef.current != null) cancelAnimationFrame(cfRafRef.current);
    },
    [],
  );

  // If the window is hidden/occluded while a crossfade is already fading, the
  // rAF ramp is now frozen — the incoming track would sit at partial/zero volume
  // and the deck would never flip (silence until refocus). Finish the crossfade
  // immediately: promote the incoming element to full volume and advance. The
  // outgoing tail (already fading out) is cut a beat early, but playback
  // continues seamlessly in the background instead of going silent.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && cfStateRef.current === 'fading') finishCrossfade();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [finishCrossfade]);

  // Drive play/pause from store. We catch the autoplay-policy rejection so a
  // first user gesture is required exactly once on most macOS WKWebView
  // setups; subsequent toggles work freely.
  //
  // While `castActive` is set the receiver is the source of truth and the
  // local element must stay paused — otherwise we get two copies of the
  // same track playing simultaneously (one through the laptop speakers,
  // one on the Chromecast). The status poller mirrors the receiver's
  // PLAYING state into `isPlaying`, so without this gate the first
  // PLAYING tick would re-fire `el.play()` here.
  // Bind the active element's source imperatively (instead of a reactive
  // `src=` prop) so a crossfade flip can promote the already-loaded incoming
  // element without React ever resetting its src — which is what makes the
  // ping-pong gapless. Skipped for one render right after a flip.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // Native engine owns this (local) track — keep the element silent + src-less
    // so its own metadata/timeupdate/ended events never fight the engine.
    if (nativeActive) {
      if (el.getAttribute('src')) {
        el.removeAttribute('src');
        el.load();
      }
      return;
    }
    if (justFlippedRef.current) {
      justFlippedRef.current = false;
      return;
    }
    if ((el.getAttribute('src') ?? '') === audioSrc) return;
    if (audioSrc) {
      el.src = audioSrc;
      el.load();
    } else {
      el.removeAttribute('src');
      el.load();
    }
  }, [audioSrc, activeIsA, nativeActive]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (nativeActive || castActive) {
      el.pause();
      return;
    }
    if (isPlaying) {
      el.play().catch(() => {
        // Browser refused autoplay; flip store back so UI reflects truth.
        usePlayerStore.getState().pause();
      });
    } else {
      el.pause();
    }
  }, [isPlaying, audioSrc, castActive, activeIsA, nativeActive]);

  // Drive volume. While a crossfade is fading the controller owns the ramp, so
  // leave the element volume alone until it returns to idle.
  useEffect(() => {
    const el = audioRef.current;
    if (el && cfStateRef.current === 'idle') el.volume = volume;
  }, [volume, activeIsA]);

  // Seek when the store's currentTime drifts far from the element's
  // currentTime (i.e. user dragged the seek bar). We use a 1-second
  // threshold so the natural onTimeUpdate echo doesn't trigger a re-seek.
  //
  // CRITICAL: skip this entirely while casting. The cast status poller
  // mirrors the receiver's currentTime into the store every second. If
  // we let that propagate into el.currentTime, the (paused) <audio>
  // element seeks to a position likely past its buffered range, gets
  // clamped to 0 or to the buffered tail, and then fires onTimeUpdate
  // with the clamped value — which overwrites the store back to 0 and
  // the scrubber sits at zero forever.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || castActive) return;
    if (Math.abs(el.currentTime - currentTime) > 1) {
      el.currentTime = currentTime;
    }
  }, [currentTime, castActive, activeIsA]);

  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then((t) => {
        if (!cancelled) setCastToken(t);
      })
      .catch((e) => {
        // Cast button just stays hidden if we can't get a token —
        // not a fatal condition for the rest of the player.
        console.warn('[beetbot] cast token bootstrap failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the device list while the picker is open. 2s cadence is
  // gentle on the network and snappy enough to catch a device
  // coming online mid-search.
  useEffect(() => {
    if (!castPickerOpen || !castToken) return;
    let cancelled = false;
    const refresh = () => {
      listCastDevices(castToken)
        .then((d) => {
          if (!cancelled) setCastDevices(d);
        })
        .catch((e) => {
          if (!cancelled)
            setCastError(e instanceof Error ? e.message : String(e));
        });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castPickerOpen, castToken]);

  // Mute the local element while a cast is active. Otherwise we'd
  // have two sources of the same audio playing in parallel.
  useEffect(() => {
    if (castActive) audioRef.current?.pause();
  }, [castActive]);

  // Tracks the track id the receiver currently has loaded. Used as
  // a guard so the track-change effect below doesn't fire a duplicate
  // castStart for a track already playing on the device.
  const castedTrackIdRef = useRef<number | null>(null);

  // Poll /api/cast/status every 1s while casting. Mirrors the
  // receiver's currentTime + player_state into the store, and
  // detects IDLE+FINISHED so we can advance the queue. Same logic
  // as the phone — see web-player/components/Player.tsx for the
  // long-form comments on why these jobs each matter.
  useEffect(() => {
    if (!castActive || !castToken) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const out = await getCastStatus(castToken);
        if (cancelled) return;
        if (!out.active) {
          setCastActive(null);
          usePlayerStore.setState({ isPlaying: false });
          return;
        }
        const s = out.status;
        if (typeof s.current_time === 'number') {
          usePlayerStore.setState({ currentTime: s.current_time });
        }
        if (s.player_state === 'PLAYING' || s.player_state === 'BUFFERING') {
          usePlayerStore.setState({ isPlaying: true });
        } else if (s.player_state === 'PAUSED') {
          usePlayerStore.setState({ isPlaying: false });
        }
        if (s.player_state === 'IDLE' && s.idle_reason === 'FINISHED') {
          // Don't clear castedTrackIdRef here — store.next() about to
          // run will change track.id, which the track-change effect
          // below will then compare against the ref. Clearing here
          // would cause a redundant castStart for the new track.
          // The track-change effect handles the new LOAD on its own.
          usePlayerStore.getState().next();
        }
        // NOTE: we intentionally do NOT mirror s.track_id back into
        // castedTrackIdRef. The ref tracks what *we* most recently
        // asked the backend to LOAD; if it drifts from the receiver's
        // reported track (e.g. transiently during a session swap on
        // the backend), the track-change effect below will reconcile
        // by firing a new castStart. Mirroring server state in here
        // creates a feedback loop where transient server states cause
        // duplicate LOADs.
      } catch (e) {
        if (!cancelled) console.warn('[beetbot] cast status poll failed', e);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castActive, castToken]);

  // When the store's current track changes while casting, LOAD the
  // new track onto the receiver. Guard against re-LOADing the track
  // that's already playing.
  useEffect(() => {
    // A 'downloaded'-status row may carry a null in-memory local_path (a catalog
    // row built for the queue) — the hub still has the file and castStart
    // resolves the path from the DB by id, so it's castable.
    if (!castActive || !castToken || !track) return;
    if (!track.local_path && track.status !== 'downloaded') return;
    if (castedTrackIdRef.current === track.id) return;
    castedTrackIdRef.current = track.id;
    castStart(castActive.id, track.id, castToken)
      .then(() => {
        usePlayerStore.setState({ isPlaying: true, currentTime: 0 });
      })
      .catch((e) => {
        console.warn('[beetbot] cast LOAD-next failed', e);
      });
  }, [castActive, castToken, track]);

  // Heartbeat so other devices can see this one (as a handoff target) and what
  // it's playing (for their "playing on Computer" banner), and keep our own
  // device list fresh. The desktop is labelled "Computer".
  useEffect(() => {
    if (!castToken) return;
    let cancelled = false;
    const beat = () => {
      const st = usePlayerStore.getState();
      const cur = st.queue[st.currentIndex];
      const np = cur
        ? {
            title: cur.title,
            artists: cur.artists,
            album_art_url: cur.album_art_url,
            is_playing: st.isPlaying,
          }
        : null;
      // Scope presence to the active profile (read live so a profile switch
      // takes effect next tick) — accounts must not see each other's devices.
      const pid = useProfileStore.getState().activeProfileId;
      void sendHeartbeat(castToken, 'Computer', 'desktop', np, pid);
      listDevices(castToken, pid)
        .then((d) => {
          if (!cancelled) setHandoffDevices(d);
        })
        .catch(() => {});
    };
    beat();
    const id = window.setInterval(beat, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castToken]);

  // Apply transport commands another device sent to this computer (its "playing
  // on Computer" banner buttons).
  useEffect(() => {
    if (!castToken) return;
    let cancelled = false;
    const tick = async () => {
      const cmds = await pollRemoteCommands(castToken);
      if (cancelled || cmds.length === 0) return;
      const s = usePlayerStore.getState();
      for (const c of cmds) {
        if (c === 'play') s.play();
        else if (c === 'pause') s.pause();
        else if (c === 'next') s.next();
        else if (c === 'prev') s.prev();
        else if (c.startsWith('handoff:')) {
          // Another device asked to pull our queue over to itself. Reply with a
          // handoff snapshot, then pause here (playback moved).
          const requesterId = c.slice('handoff:'.length);
          const st = usePlayerStore.getState();
          if (requesterId && st.queue.length > 0) {
            void postHandoff(castToken, requesterId, {
              source_label: 'Computer',
              tracks: st.queue.map((t) => ({
                id: t.id,
                title: t.title,
                artists: t.artists,
                album: t.album,
                album_art_url: t.album_art_url,
                duration_ms: t.duration_ms,
              })),
              index: st.currentIndex,
              position: audioRef.current?.currentTime ?? st.currentTime ?? 0,
              playing: true,
            });
            st.pause();
          }
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castToken]);

  // Poll for a queue handed to us from another device; adopt it (load the
  // queue, seek to the handed-off position, resume) and take playback local.
  useEffect(() => {
    if (!castToken) return;
    let cancelled = false;
    const tick = async () => {
      const h = await pollHandoff(castToken);
      if (cancelled || !h || h.tracks.length === 0) return;
      // Map the neutral handoff tracks into the desktop's PlaylistTrack shape.
      // No local_path → the <audio> streams them over HTTP by id.
      const tracks = h.tracks.map((t, i) => ({
        id: t.id,
        spotify_id: '',
        title: t.title,
        artists: t.artists,
        album: t.album,
        album_art_url: t.album_art_url,
        duration_ms: t.duration_ms,
        isrc: null,
        status: 'downloaded',
        failure_reason: null,
        local_path: null,
        position: i,
        added_at: null,
      }));
      // If we were casting, bring playback back to this machine.
      if (castActive) {
        castStop(castToken).catch(() => {});
        setCastActive(null);
        castedTrackIdRef.current = null;
      }
      adoptHandoff(tracks, h.index, h.position, h.playing);
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castToken, castActive, adoptHandoff]);

  // Hand the current queue + playhead to another device, then pause here.
  const handleHandoff = useCallback(
    async (device: RemoteDevice) => {
      if (!castToken) return;
      const st = usePlayerStore.getState();
      if (st.queue.length === 0) return;
      const payload: HandoffPayload = {
        source_label: 'Computer',
        tracks: st.queue.map((t) => ({
          id: t.id,
          title: t.title,
          artists: t.artists,
          album: t.album,
          album_art_url: t.album_art_url,
          duration_ms: t.duration_ms,
        })),
        index: st.currentIndex,
        position: audioRef.current?.currentTime ?? st.currentTime ?? 0,
        playing: true,
      };
      setHandoffMenuOpen(false);
      try {
        await postHandoff(castToken, device.device_id, payload);
        usePlayerStore.setState({ isPlaying: false });
      } catch (e) {
        console.warn('[beetbot] handoff failed', e);
      }
    },
    [castToken],
  );

  const handleStartCast = useCallback(
    async (device: CastDevice) => {
      if (!track || (!track.local_path && track.status !== 'downloaded') || !castToken) {
        setCastError("Track isn't downloaded yet.");
        return;
      }
      setCastError(null);
      try {
        // Carry the local playhead over so the receiver picks up
        // where the listener was. Read the <audio> element directly
        // since it's the most accurate; fall back to the store if
        // the element isn't around for some reason.
        const localPos =
          audioRef.current?.currentTime ??
          usePlayerStore.getState().currentTime ??
          0;
        const res = await castStart(device.id, track.id, castToken, localPos);
        // Remember what we LOADed so the track-change effect doesn't
        // fire a redundant castStart.
        castedTrackIdRef.current = track.id;
        setCastActive({ id: res.device_id, name: res.device_name });
        // Chromecast starts immediately on LOAD; mirror that in the
        // store so the play/pause button shows Pause.
        usePlayerStore.setState({ isPlaying: true });
        setCastPickerOpen(false);
      } catch (e) {
        setCastError(e instanceof Error ? e.message : String(e));
      }
    },
    [track, castToken],
  );

  const handleStopCast = useCallback(async () => {
    if (castToken) {
      try {
        await castStop(castToken);
      } catch (e) {
        console.warn('[beetbot] cast stop failed', e);
      }
    }
    setCastActive(null);
    castedTrackIdRef.current = null;
    setCastPickerOpen(false);
    usePlayerStore.setState({ isPlaying: false });
  }, [castToken]);

  // Wraps the store's playPause so taps route to Cast while a
  // session is active.
  const handlePlayPause = useCallback(() => {
    if (castActive && castToken) {
      const nextPlaying = !isPlaying;
      usePlayerStore.setState({ isPlaying: nextPlaying });
      castControl(nextPlaying ? 'play' : 'pause', undefined, castToken).catch(
        (e) => {
          console.warn('[beetbot] cast play/pause failed', e);
          usePlayerStore.setState({ isPlaying: !nextPlaying });
        },
      );
    } else {
      playPause();
    }
  }, [castActive, castToken, isPlaying, playPause]);

  // When casting, the seek slider routes to /api/cast/control with
  // an absolute seconds value; the existing store-driven local
  // element seek is harmless (element is paused), but we want the
  // Chromecast to follow the scrubber.
  const handleSeek = useCallback(
    (seconds: number) => {
      setCurrentTime(seconds);
      if (castActive && castToken) {
        castControl('seek', seconds, castToken).catch((e) => {
          console.warn('[beetbot] cast seek failed', e);
        });
      }
    },
    [castActive, castToken, setCurrentTime],
  );

  const isEmpty = queueLength === 0 || !track;
  // Seek track length + fill %, shared by the mini scrubber's max/value and its
  // gradient fill.
  const seekMax = duration || (track?.duration_ms ?? 0) / 1000;
  const seekPct = seekMax > 0 ? (Math.min(currentTime, seekMax) / seekMax) * 100 : 0;

  // Another device that's actively playing — show its now-playing banner with
  // remote transport controls. The two players stay independent (awareness +
  // control, not unified playback). A short grace window keeps the banner up
  // for ~15s after the remote pauses, so you can resume it from here.
  const [remoteActive, setRemoteActive] = useState<RemoteDevice | null>(null);
  const remoteGraceRef = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    const playing =
      handoffDevices.find((d) => d.now_playing && d.now_playing.is_playing) ??
      null;
    if (playing) {
      remoteGraceRef.current = { id: playing.device_id, at: Date.now() };
      setRemoteActive(playing);
      return;
    }
    const g = remoteGraceRef.current;
    if (g && Date.now() - g.at < 15000) {
      setRemoteActive(
        handoffDevices.find((d) => d.device_id === g.id && d.now_playing) ??
          null,
      );
    } else {
      setRemoteActive(null);
    }
  }, [handoffDevices]);
  const sendRemote = (action: RemoteAction) => {
    if (remoteActive && castToken)
      void postRemoteCommand(castToken, remoteActive.device_id, action);
  };

  return (
    <>
      {remoteActive && remoteActive.now_playing && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 ml-[22px] z-50 w-[28rem] max-w-[44vw]">
          {/* Sits just below the top bar (h-14), lined up with the search
              input: same 28rem width, shifted +22px to match the input's
              centre (it's offset right of viewport-centre by half the Home
              button + gap in the top bar's centred group). */}
          <RemoteNowPlaying
            label={remoteActive.label}
            nowPlaying={remoteActive.now_playing}
            onPlayPause={() =>
              sendRemote(remoteActive.now_playing!.is_playing ? 'pause' : 'play')
            }
            onPrev={() => sendRemote('prev')}
            onNext={() => sendRemote('next')}
            onSync={() =>
              castToken && void requestHandoff(castToken, remoteActive.device_id)
            }
          />
        </div>
      )}
      {/* Two ping-pong audio elements. Only the active one (=== audioRef.current)
          drives the store; the other is idle, or the crossfade incoming. src is
          managed imperatively (see the effect above), never via a `src=` prop,
          so a flip never reloads the promoted element. */}
      {[aRef, bRef].map((r, i) => (
        <audio
          key={i}
          ref={r}
          preload="auto"
          onPlay={() => audioStarted('main')}
          onWaiting={(e) => {
            if (e.currentTarget === audioRef.current) setBuffering(true);
          }}
          onStalled={(e) => {
            if (e.currentTarget === audioRef.current) setBuffering(true);
          }}
          onLoadStart={(e) => {
            if (e.currentTarget === audioRef.current) setBuffering(true);
          }}
          onPlaying={(e) => {
            if (e.currentTarget === audioRef.current) {
              setBuffering(false);
              errorSkipRef.current = 0;
            }
          }}
          onCanPlay={(e) => {
            if (e.currentTarget === audioRef.current) setBuffering(false);
          }}
          onError={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            const err = e.currentTarget.error;
            // ABORTED routinely fires when we swap src mid-load (track
            // changes) — the next load recovers on its own; not an error.
            if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) return;
            // While casting the receiver owns playback; a local-element error
            // is meaningless.
            if (castActive) return;
            // A failed load (bad file, or a /live resolve the engine can't
            // match) used to die HERE silently — no message, bar stuck paused,
            // which reads as "clicking the song does nothing". Skip to the
            // next track instead (mirrors the phone player's handler), capped
            // by the consecutive-failure counter above.
            setBuffering(false);
            errorSkipRef.current += 1;
            if (errorSkipRef.current <= 3) {
              usePlayerStore.getState().next();
            }
          }}
          onTimeUpdate={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            // While casting, the cast status poller owns currentTime.
            if (castActive) return;
            setCurrentTime(e.currentTarget.currentTime);
            if (track) {
              lastTickRef.current = {
                id: track.id,
                ms: e.currentTarget.currentTime * 1000,
                durMs: track.duration_ms,
              };
            }
          }}
          onDurationChange={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            // A live-transcoded (un-downloaded) track streams as length-less ADTS
            // and reports Infinity here; store 0 so the displays fall back to the
            // catalog length (track.duration_ms) instead of "Infinity:NaN:NaN".
            const d = e.currentTarget.duration;
            setDuration(Number.isFinite(d) ? d : 0);
          }}
          onLoadedMetadata={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            const a = e.currentTarget;
            // Restore a rehydrated position (reopened mid-song) once metadata
            // is loaded, so playback doesn't restart from 0 on launch.
            const t = usePlayerStore.getState().currentTime;
            if (t > 1 && Number.isFinite(a.duration) && t < a.duration - 1) {
              try {
                a.currentTime = t;
              } catch {
                /* swallow — onTimeUpdate echo will reconcile */
              }
            }
          }}
          onEnded={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            // A crossfade flip already advanced; don't double-fire.
            if (cfStateRef.current !== 'idle') return;
            // Natural end = completed: snap the tick to full length so the
            // track-change report records this as a finished play.
            if (track) {
              lastTickRef.current = {
                id: track.id,
                ms: track.duration_ms,
                durMs: track.duration_ms,
              };
            }
            handleTrackEnded();
          }}
        />
      ))}
      {!isEmpty && (
        <footer
          className={`relative z-30 h-20 shrink-0 bg-neutral-950/45 backdrop-blur-2xl backdrop-saturate-150 px-4 grid grid-cols-[1fr_2fr_1fr] gap-4 items-center ${
            floating
              ? 'mx-2 mb-2 rounded-2xl border border-white/10'
              : 'border-t border-white/5'
          }`}
        >
          {/* Left: now-playing */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={toggleFullNowPlaying}
              aria-label="Now playing view"
              title="Now playing view"
              className={`group relative h-12 w-12 shrink-0 rounded bg-neutral-800 overflow-hidden ${
                nowPlayingFull ? 'ring-1 ring-white/50' : ''
              }`}
            >
              {track.album_art_url ? (
                <img
                  src={track.album_art_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full grid place-items-center text-neutral-600">
                  ♪
                </div>
              )}
              {/* Hover affordance — diagonal "expand" glyph. */}
              <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 group-hover:opacity-100 transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
              </span>
              {/* Buffering spinner while the audio loads. */}
              {buffering && isPlaying && !castActive && (
                <span className="absolute inset-0 grid place-items-center bg-black/55">
                  <svg className="h-4 w-4 animate-spin text-white" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                </span>
              )}
            </button>
            <div className="group min-w-0">
              {/* Song title → opens the album it came from. Falls back to
                  plain (non-link) text when the track has no album name. Long
                  titles marquee-scroll while the hovering the now-playing text. */}
              {track.album ? (
                <button
                  type="button"
                  onClick={() =>
                    openAlbumPage(track.album!, track.artists[0] ?? null)
                  }
                  className="block max-w-full text-sm font-medium text-left hover:underline"
                  title={`Go to album: ${track.album}`}
                >
                  <Marquee text={track.title} />
                </button>
              ) : (
                <div className="text-sm font-medium" title={track.title}>
                  <Marquee text={track.title} />
                </div>
              )}
              {/* Each artist name → opens that artist's page. */}
              <div
                className="text-xs text-neutral-500 truncate"
                title={track.artists.join(', ')}
              >
                {track.artists.length > 0
                  ? track.artists.map((a, i) => (
                      <span key={`${a}-${i}`}>
                        {i > 0 ? ', ' : ''}
                        <button
                          type="button"
                          onClick={() => openArtistPage(a)}
                          className="text-left hover:underline hover:text-neutral-300"
                          title={`Go to artist: ${a}`}
                        >
                          {a}
                        </button>
                      </span>
                    ))
                  : '—'}
              </div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <LikeButton
                liked={trackLiked}
                onToggle={() => track && toggleLike(track.id, activeProfileId)}
                label={trackLiked ? 'Remove from Favorites' : 'Add to Favorites'}
                size={18}
                className="h-8 w-8"
              />
              <button
                type="button"
                onClick={openAddToPlaylist}
                aria-label="Add to playlist"
                title="Add to playlist"
                className="h-8 w-8 grid place-items-center rounded-full text-neutral-400 hover:text-neutral-100 hover:bg-white/10"
              >
                <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
            </div>
          </div>

          {/* Center: controls + seek */}
          <div className="flex flex-col items-center justify-center gap-1">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={toggleShuffle}
                className={
                  shuffle
                    ? 'text-accent'
                    : 'text-neutral-400 hover:text-neutral-100'
                }
                title="Shuffle"
                aria-label="Shuffle"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="m15 15 6 6" />
                  <path d="m4 4 5 5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={prev}
                className="text-neutral-300 hover:text-neutral-100"
                aria-label="Previous"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M19 20 9 12l10-8z" />
                  <rect x="5" y="4" width="2" height="16" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handlePlayPause}
                className="grid place-items-center h-9 w-9 rounded-full bg-neutral-100 text-neutral-950 hover:bg-white hover:scale-105 transition"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={next}
                className="text-neutral-300 hover:text-neutral-100"
                aria-label="Next"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M5 4l10 8-10 8z" />
                  <rect x="17" y="4" width="2" height="16" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                onClick={toggleRepeat}
                className={`relative ${
                  repeat !== 'off'
                    ? 'text-accent'
                    : 'text-neutral-400 hover:text-neutral-100'
                }`}
                title={`Repeat: ${repeat}`}
                aria-label="Repeat"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m17 2 4 4-4 4" />
                  <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                  <path d="m7 22-4-4 4-4" />
                  <path d="M21 13v1a4 4 0 0 1-4 4H3" />
                </svg>
                {repeat === 'one' ? (
                  <span className="absolute -top-1 -right-1.5 text-[9px] font-bold leading-none bg-neutral-950 rounded-full px-0.5">
                    1
                  </span>
                ) : null}
              </button>
            </div>
            <div className="flex items-center gap-2 w-full max-w-xl">
              <span className="text-[10px] text-neutral-500 tabular-nums w-10 text-right">
                {formatDuration(currentTime * 1000)}
              </span>
              <input
                type="range"
                min={0}
                max={seekMax}
                step={0.5}
                value={Math.min(currentTime, seekMax)}
                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                aria-label="Seek"
                className="flex-1 h-1 appearance-none rounded-full cursor-pointer [--sf:rgba(255,255,255,0.8)] [--st:rgba(255,255,255,0.18)] [--sth:transparent] hover:[--sf:rgba(255,255,255,0.98)] hover:[--st:rgba(255,255,255,0.28)] hover:[--sth:#ffffff] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--sth)] [&::-webkit-slider-thumb]:transition-colors [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--sth)]"
                style={{
                  // Tint the progress fill with the artwork accent while playing
                  // (the White pillar's white fill remains the paused default).
                  ...(isPlaying
                    ? {
                        ['--sf' as string]:
                          'color-mix(in srgb, var(--color-accent) 85%, white)',
                      }
                    : {}),
                  background: `linear-gradient(to right, var(--sf) ${seekPct}%, var(--st) ${seekPct}%)`,
                }}
              />
              <span className="text-[10px] text-neutral-500 tabular-nums w-10">
                {formatDuration((duration || (track?.duration_ms ?? 0) / 1000) * 1000)}
              </span>
            </div>
          </div>

          {/* Right: cast picker + volume. "Casting" banner sits to
              the left of the cast button when an active session
              exists — tap to stop. Inline monochrome SVGs match
              the rest of the bar's grayscale chrome. */}
          <div className="flex items-center justify-end gap-2 text-neutral-500">
            <SleepTimerButton
              sleepTimerEndsAt={sleepTimerEndsAt}
              sleepAtTrackEnd={sleepAtTrackEnd}
              onPick={setSleepTimer}
              placement="top"
            />
            <button
              type="button"
              onClick={() => toggleRightBar('lyrics')}
              aria-label="Lyrics"
              title="Lyrics"
              className={`h-8 w-8 grid place-items-center rounded-lg transition ${
                rightBar === 'lyrics'
                  ? 'text-neutral-100 bg-white/10'
                  : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 7h16" />
                <path d="M4 12h10" />
                <path d="M4 17h13" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => toggleRightBar('queue')}
              aria-label="Queue"
              title="Queue"
              className={`h-8 w-8 grid place-items-center rounded-lg transition ${
                rightBar === 'queue'
                  ? 'text-neutral-100 bg-white/10'
                  : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h11" />
                <path d="M3 12h11" />
                <path d="M3 18h7" />
                <circle cx="18" cy="16" r="3" />
                <path d="M21 16V7l-3 1" />
              </svg>
            </button>
            {/* Hand the queue to another device ("Play on Phone"). Shown only
                when another device is online. One target → one-tap; several → a
                small menu. */}
            {handoffDevices.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (handoffDevices.length === 1)
                      void handleHandoff(handoffDevices[0]);
                    else setHandoffMenuOpen((v) => !v);
                  }}
                  aria-label="Play on another device"
                  title={
                    handoffDevices.length === 1
                      ? `Play on ${handoffDevices[0].label}`
                      : 'Play on another device'
                  }
                  className="h-8 w-8 grid place-items-center rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition"
                >
                  {/* Transfer / swap-arrows glyph — "move playback elsewhere". */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7 16V4m0 0L3 8m4-4 4 4" />
                    <path d="M17 8v12m0 0 4-4m-4 4-4-4" />
                  </svg>
                </button>
                {handoffMenuOpen && handoffDevices.length > 1 && (
                  <div className="absolute bottom-full right-0 mb-2 w-44 rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl overflow-hidden z-50">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
                      Play on
                    </div>
                    {handoffDevices.map((d) => (
                      <button
                        key={d.device_id}
                        type="button"
                        onClick={() => void handleHandoff(d)}
                        className="w-full text-left px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {castActive && (
              <button
                type="button"
                onClick={handleStopCast}
                className="text-xs text-neutral-200 hover:text-neutral-200 truncate max-w-[12rem]"
                title={`Stop casting to ${castActive.name}`}
              >
                <span className="text-neutral-100">●</span>{' '}
                {castActive.name}
              </button>
            )}
            <button
              type="button"
              // Casting needs a file on the hub. Every queued track has one
              // (local or 'downloaded'); this just guards an empty slot. Stays
              // enabled while a cast is active so you can still manage it.
              disabled={
                !castActive && !track?.local_path && track?.status !== 'downloaded'
              }
              onClick={() => setCastPickerOpen(true)}
              aria-label={
                castActive
                  ? `Casting to ${castActive.name}`
                  : 'Cast to device'
              }
              title={
                castActive
                  ? `Playing on ${castActive.name}`
                  : 'Cast to a Chromecast on your network'
              }
              className={`h-8 w-8 grid place-items-center rounded-lg transition disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500 ${
                castActive
                  ? 'text-neutral-100 bg-white/10'
                  : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              {/* Material Design "cast" icon — filled. */}
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
              >
                <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.37 7.07 10 1 10zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
              </svg>
            </button>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              <path d="M18.5 5.5a9 9 0 0 1 0 13" />
            </svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              aria-label="Volume"
              className="w-28 h-1.5 appearance-none rounded-full cursor-pointer [--vf:rgba(255,255,255,0.45)] [--vt:rgba(255,255,255,0.13)] [--vth:transparent] hover:[--vf:rgba(255,255,255,0.95)] hover:[--vt:rgba(255,255,255,0.28)] hover:[--vth:#ffffff] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--vth)] [&::-webkit-slider-thumb]:transition-colors [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--vth)]"
              style={{
                background: `linear-gradient(to right, var(--vf) ${volume * 100}%, var(--vt) ${volume * 100}%)`,
              }}
            />
          </div>
        </footer>
      )}
      {addToPlaylist && (
        <AddToPlaylistModal
          token={addToPlaylist.token}
          track={addToPlaylist.track}
          activeProfileId={activeProfileId}
          onClose={closeAddToPlaylist}
        />
      )}
      {castPickerOpen && (
        <CastPicker
          devices={castDevices}
          activeId={castActive?.id ?? null}
          error={castError}
          onPick={handleStartCast}
          onStop={handleStopCast}
          onClose={() => {
            setCastPickerOpen(false);
            setCastError(null);
          }}
        />
      )}
    </>
  );
}
