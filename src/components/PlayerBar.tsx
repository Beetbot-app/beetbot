import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatDuration } from '@/lib/format';
import { canStream, currentTrack, usePlayerStore } from '@/lib/store';
import { heartbeatQueue } from '@shared/playerStore';
import { useNativeEngine } from '@/lib/nativeEngine';
import { useAppearanceStore } from '@/lib/appearance';
import { useAudioFxStore, LOUDNESS_TARGET_LUFS } from '@/lib/audiofx';
import { useNavStore } from '@/lib/nav';
import { ConnectIcon, LyricsIcon, QueueIcon } from '@/components/PlayerIcons';
import { ipc, type PlaylistTrack } from '@/lib/tauri';
import {
  castControl,
  castStart,
  castStop,
  ensureSession,
  getCastStatus,
  getTrackPlaylistIds,
  listCastDevices,
  listDevices,
  pollHandoff,
  pollRemoteCommands,
  postHandoff,
  postRemoteCommand,
  requestHandoff,
  sendHeartbeat,
  setApiBase,
  HEARTBEAT_QUEUE_MAX,
  type CastDevice,
  type HandoffPayload,
  type RemoteAction,
  type RemoteDevice,
  type SearchTrackResult,
} from '@shared/api';
import { cn, CALLOUT_ERROR } from '@shared/ui';
import { useConnectStore } from '@/lib/connect';
import { Marquee } from '@shared/components/Marquee';
import { LikeButton } from '@shared/components/LikeButton';
import { useAddAudio } from '@/lib/addAudio';
import { useDownloadsStore, trackHasFile } from '@/lib/downloads';
import { useCapabilitiesStore } from '@/lib/capabilities';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import {
  ContextMenu,
  MenuGlyphs,
  fileMenuItems,
  sleepTimerMenuItems,
  sleepTimerMenuLabel,
  type MenuState,
} from '@shared/components/ContextMenu';
import { playlistTrackToSearch } from '@/lib/trackAdapter';
import {
  useSleepTimer,
  useAutoplayRadio,
  usePlayLogging,
  useCompletionSignal,
} from '@shared/playerHooks';
import { useProfileStore } from '@/lib/profile';
import { useLikesStore } from '@/lib/likes';
import { audioStarted, registerAudioPauser } from '@shared/audioCoordinator';
import { useUiStore } from '@/lib/ui';

// The shared HTTP client needs to know where the local streaming
// server is; SearchPage already calls this at module load, but
// PlayerBar can mount before any Search page does, so set it here too.
// setApiBase is idempotent (last writer wins to the same value).
setApiBase('http://127.0.0.1:47823');

/// Fixed-height (80px) audio control + a hidden &lt;audio&gt; element that drives
/// it. Mounted once at the App level so playback survives page navigation.
export function PlayerBar() {
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
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const handleTrackEnded = usePlayerStore((s) => s.handleTrackEnded);
  const adoptHandoff = usePlayerStore((s) => s.adoptHandoff);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const queue = usePlayerStore((s) => s.queue);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const crossfadeAdvance = usePlayerStore((s) => s.crossfadeAdvance);

  // ---- Crossfade (default off). The idle element (fadeRef) plays the
  // incoming track and ramps up while the active one ramps down; at the end
  // we just SWAP which element is active (ping-pong) so the incoming track is
  // never reloaded — no gap. Gated on crossfadeSeconds > 0 && !casting.
  const cfStateRef = useRef<'idle' | 'fading'>('idle');
  const cfRafRef = useRef<number | null>(null);

  // Playback error recovery (mirrors the phone player). A streamed /live resolve
  // that momentarily fails — the engine re-minting a session, a stale URL after
  // sleep — recovers on a retry, so we retry the SAME track a few times with
  // backoff rather than skipping a song that would have played. `retryRef` counts
  // those retries; `goneRef` caps skips through 404 (gone) / undecodable tracks
  // so a dead queue stops with a message instead of looping. Both reset when a
  // track actually starts. `errorMsg` surfaces the failure in a small banner —
  // the desktop used to die silently with the bar stuck paused.
  const retryRef = useRef<{ count: number; timer: number }>({
    count: 0,
    timer: 0,
  });
  const goneRef = useRef(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sleep timer, play-logging, completion signal, and autoplay-radio are shared
  // with the phone player via hooks (see shared/playerHooks.ts).
  useSleepTimer(usePlayerStore);

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
  const [castActive, setCastActive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [castError, setCastError] = useState<string | null>(null);
  // True while warming a streamed track's /live temp file before hand-off.
  const [castPreparing, setCastPreparing] = useState(false);

  // ---- Liked Songs (heart) ----
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  // Liked state is shared with the full Now Playing view (which covers the bar),
  // so a like in either surface shows in the other.
  const likedIds = useLikesStore((s) => s.likedIds);
  const toggleLike = useLikesStore((s) => s.toggle);
  const refreshLikes = useLikesStore((s) => s.refresh);
  useEffect(() => {
    const reload = () => void refreshLikes(activeProfileId);
    reload();
    // Re-derive the star from the server on ANY library change — so un-liking
    // the current track from somewhere else (e.g. removing it from the
    // Favorites playlist page) clears the bar's star live, not just on the
    // next mount. The store's own toggle already awaits the server before it
    // fires this, so the refetch reflects the committed state (no flicker).
    window.addEventListener('beetbot:library-changed', reload);
    return () =>
      window.removeEventListener('beetbot:library-changed', reload);
  }, [activeProfileId, refreshLikes]);

  // Autoplay-radio (maps radio StreamTracks → desktop PlaylistTracks; only
  // status 'downloaded' rows survive appendToQueue's canStream filter).
  useAutoplayRadio({
    store: usePlayerStore,
    getToken: ensureSession,
    profileId: activeProfileId,
    buildRadioTracks: (more) =>
      more.map((m) => ({
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
      })),
  });

  usePlayLogging({
    store: usePlayerStore,
    token: castToken,
    profileId: activeProfileId,
  });

  // Latest position of the current track, refreshed each timeupdate (snapped to
  // full length on natural end); reported for the OUTGOING track on track change.
  const lastTickRef = useRef<{ id: number; ms: number; durMs: number } | null>(
    null,
  );
  useCompletionSignal({
    store: usePlayerStore,
    token: castToken,
    profileId: activeProfileId,
    lastTickRef,
  });

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
          track: playlistTrackToSearch(t, { inPlaylistIds: inIds }),
        });
      });
  }, [track, castToken, activeProfileId]);
  const closeAddToPlaylist = useCallback(() => {
    setAddToPlaylist(null);
    // The picker may have added/removed the track from Liked Songs — refresh so
    // the heart fill reflects it.
    void refreshLikes(activeProfileId);
  }, [refreshLikes, activeProfileId]);
  // The bar's ⋯ opens the SAME menu as the fullscreen Now Playing (Add to
  // playlist · Go to artist · Go to album · Sleep timer) — it used to jump
  // straight into the playlist picker, so the same-looking control did two
  // different things depending on the surface.
  const [trackMenu, setTrackMenu] = useState<MenuState | null>(null);
  // The duration picker the menu's "Sleep timer" row opens — separate state so
  // the first menu's onClose (which fires right after the row's onClick)
  // can't wipe it.
  const [sleepMenu, setSleepMenu] = useState<MenuState | null>(null);
  const openTrackMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      const t = track;
      const pid = activeProfileId; // captured for the download actions' closures
      setTrackMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Add to playlist',
            icon: MenuGlyphs.addToPlaylist,
            onClick: openAddToPlaylist,
          },
          {
            label: 'Go to artist',
            icon: MenuGlyphs.artist,
            onClick: () => openArtistPage(t.artists[0]),
            disabled: !t.artists[0],
          },
          {
            label: 'Go to album',
            icon: MenuGlyphs.album,
            onClick: () => openAlbumPage(t.album!, t.artists[0] ?? null),
            disabled: !t.album,
          },
          // Save offline / remove / attach-a-file — the shared file actions, so
          // every ⋯ menu offers the same set. Save and remove appear only on a
          // build that can acquire.
          ...fileMenuItems({
            hasFile: trackHasFile(t),
            downloading:
              useDownloadsStore.getState().byTrack[t.id] !== undefined,
            canDownload: useCapabilitiesStore.getState().canDownload,
            onDownload:
              pid != null
                ? () => void useDownloadsStore.getState().download(t.id, pid)
                : undefined,
            onRemove:
              pid != null
                ? () => void useDownloadsStore.getState().remove(t.id, pid)
                : undefined,
            onAddAudio: () => useAddAudio.getState().openForTrack(t),
          }),
          {
            label: sleepTimerMenuLabel(sleepTimerEndsAt, sleepAtTrackEnd),
            icon: MenuGlyphs.sleep,
            separator: true,
            onClick: () =>
              setSleepMenu({
                x: e.clientX,
                y: e.clientY,
                items: sleepTimerMenuItems(
                  sleepTimerEndsAt,
                  sleepAtTrackEnd,
                  setSleepTimer,
                ),
              }),
          },
        ],
      });
    },
    [
      track,
      openAddToPlaylist,
      openArtistPage,
      openAlbumPage,
      sleepTimerEndsAt,
      sleepAtTrackEnd,
      setSleepTimer,
    ],
  );
  // Two now-playing surfaces: the artwork opens the FULL-window view (takes over
  // the app); the lyrics / queue buttons open the docked right bar.
  const nowPlayingFull = useUiStore((s) => s.nowPlayingFull);
  const toggleFullNowPlaying = useUiStore((s) => s.toggleFullNowPlaying);
  const rightBar = useUiStore((s) => s.rightBar);
  const toggleRightBar = useUiStore((s) => s.toggleRightBar);

  // ---- Playback handoff (control the computer's playback from the phone,
  // and hand a queue back and forth). Other online devices we can hand to:
  const [handoffDevices, setHandoffDevices] = useState<RemoteDevice[]>([]);

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
  // The TRUE next track — shuffle-aware via the store's plan (peekNextIndex),
  // so the crossfade/gapless pre-buffer loads what will actually play, not
  // queue[currentIndex + 1]. Selector form keeps it reactive to plan changes.
  const nextTrack = usePlayerStore((s) => {
    const i = s.peekNextIndex();
    return i >= 0 ? s.queue[i] : null;
  });
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

  // Pre-warm the next 1–2 queue tracks while the current one plays, so an
  // auto-advance or skip is instant instead of cold-starting the transition.
  // The win is streamed (/live) tracks: a tiny range request makes the host
  // resolve + remux the source into its temp cache NOW (that resolve is the
  // "few seconds" you'd otherwise wait for at the boundary). Downloaded/local
  // tracks load from disk instantly, so we skip them. Mirrors the phone's
  // prefetch. Staggered so neither warm competes with the current track's own
  // buffer fill; aborts on track change so we never resolve tracks we skip past.
  // Skipped while casting (the receiver owns its buffer) or on the native engine
  // (it preloads the next itself via nextSource).
  useEffect(() => {
    if (!track || castActive || nativeActive) return;
    const { queue: q, currentIndex: idx } = usePlayerStore.getState();
    const upcoming = [q[idx + 1], q[idx + 2]].filter(
      (t): t is PlaylistTrack => !!t && canStream(t),
    );
    if (upcoming.length === 0) return;
    const ctrl = new AbortController();
    const timers: number[] = [];
    const warm = (t: PlaylistTrack, delay: number) => {
      timers.push(
        window.setTimeout(() => {
          const url = srcFor(t);
          // Only server-streamed URLs benefit; a local file (convertFileSrc)
          // needs no resolve. We don't keep the bytes — the server-side prep is
          // the point.
          if (!url.startsWith('http')) return;
          void fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-1' },
            cache: 'no-store',
            signal: ctrl.signal,
          })
            .then((r) => r.arrayBuffer())
            .catch(() => {});
        }, delay),
      );
    };
    warm(upcoming[0], 2000);
    if (upcoming[1]) warm(upcoming[1], 6000);
    return () => {
      ctrl.abort();
      timers.forEach((id) => clearTimeout(id));
    };
    // Re-warm only when the CURRENT track changes (id), not on every object ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, castActive, nativeActive, srcFor]);

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
    // Shuffle-aware: fade into the store's actual next pick, matching what
    // crossfadeAdvance will commit to (both read the same plan).
    const ni = usePlayerStore.getState().peekNextIndex();
    const next = ni >= 0 ? queue[ni] : undefined;
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
    if (rightBar !== 'connect' || !castToken) return;
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
  }, [rightBar, castToken]);

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
    // Castable = a downloaded file OR a live-streamable track; a streamed
    // next-track is warmed server-side inside cast_start before the receiver
    // LOADs it (a cold one adds a short gap; an already-warm one is instant).
    if (!castActive || !castToken || !track) return;
    if (!canStream(track)) return;
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
      // What we play next, in true (shuffle-aware) order, so another device's
      // "Up next" for us matches what will actually happen.
      const up = heartbeatQueue(
        st.queue,
        st.currentIndex,
        st.shuffle,
        st.shuffleUpcomingIds,
        HEARTBEAT_QUEUE_MAX,
      );
      const np = cur
        ? {
            title: cur.title,
            artists: cur.artists,
            album_art_url: cur.album_art_url,
            album: cur.album ?? null,
            is_playing: st.isPlaying,
            position_ms: Math.round((st.currentTime ?? 0) * 1000),
            duration_ms: cur.duration_ms,
            // The id, not a URL: the reader signs its own art request.
            track_id: cur.id,
            queue: up.items,
            queue_len: up.total,
          }
        : null;
      // Scope presence to the active profile (read live so a profile switch
      // takes effect next tick) — accounts must not see each other's devices.
      const pid = useProfileStore.getState().activeProfileId;
      void sendHeartbeat(castToken, null, 'desktop', np, pid);
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
      if (!track || !castToken) return;
      if (!canStream(track)) {
        setCastError("This track can't be cast yet.");
        return;
      }
      setCastError(null);
      // Streamed (not-downloaded) track → warm its /live temp file BEFORE
      // handing the Chromecast the URL, so the receiver gets a ready, seekable
      // stream and never times out cold. Usually instant (we're likely already
      // playing it); a genuinely cold track blocks a few seconds here, shown
      // as "Preparing…". A 0-1 range is enough — the hub remuxes the whole
      // file before serving any bytes.
      const isLive = !track.local_path && track.status !== 'downloaded';
      try {
        // Carry the local playhead over so the receiver picks up
        // where the listener was. Read the <audio> element directly
        // since it's the most accurate; fall back to the store if
        // the element isn't around for some reason.
        const localPos =
          audioRef.current?.currentTime ??
          usePlayerStore.getState().currentTime ??
          0;
        if (isLive) {
          setCastPreparing(true);
          try {
            await fetch(
              `http://127.0.0.1:47823/stream/${track.id}/live?t=${encodeURIComponent(castToken)}`,
              { headers: { Range: 'bytes=0-1' }, cache: 'no-store' },
            );
          } catch {
            /* cast_start also warms server-side; a failed pre-warm isn't fatal */
          } finally {
            setCastPreparing(false);
          }
        }
        const res = await castStart(device.id, track.id, castToken, localPos);
        // Remember what we LOADed so the track-change effect doesn't
        // fire a redundant castStart.
        castedTrackIdRef.current = track.id;
        setCastActive({ id: res.device_id, name: res.device_name });
        // Chromecast starts immediately on LOAD; mirror that in the
        // store so the play/pause button shows Pause.
        usePlayerStore.setState({ isPlaying: true });
      } catch (e) {
        setCastPreparing(false);
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
  // The active OUTPUT of THIS session — only a Chromecast we're casting to.
  // Another Beetbot device playing (remoteActive) is an INDEPENDENT session,
  // not our output: it gets the awareness strip above the bar, never a
  // takeover of the local player (both can play at once — household model).
  const connectedName = castActive?.name ?? null;

  // Publish the connect snapshot for the RightBar's Connect panel (it renders
  // elsewhere in the tree; PlayerBar stays the single owner of the cast and
  // handoff machinery — see src/lib/connect.ts).
  useEffect(() => {
    useConnectStore.setState({
      castDevices,
      castActive,
      handoffDevices,
      remotePlayingId: remoteActive?.device_id ?? null,
      error: castError,
      preparing: castPreparing,
      onPickCast: handleStartCast,
      onStopCast: handleStopCast,
      onPickHandoff: handleHandoff,
    });
  }, [
    castDevices,
    castActive,
    handoffDevices,
    remoteActive,
    castError,
    castPreparing,
    handleStartCast,
    handleStopCast,
    handleHandoff,
  ]);

  return (
    <>
      {errorMsg ? (
        <button
          type="button"
          onClick={() => setErrorMsg(null)}
          className={cn(
            CALLOUT_ERROR,
            'fixed bottom-[88px] left-1/2 z-50 -translate-x-1/2 max-w-[90vw] rounded-lg px-3 py-2 text-xs shadow-lg',
          )}
          title="Dismiss"
        >
          {errorMsg}
        </button>
      ) : null}
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
              retryRef.current.count = 0;
              goneRef.current = 0;
              setErrorMsg(null);
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
            setBuffering(false);
            const failedSrc = e.currentTarget.currentSrc;
            const isStreamError =
              err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
              err.code === MediaError.MEDIA_ERR_NETWORK;
            // Streamed (/live) failure: probe the URL. 404 ⇒ the track's gone,
            // skip it (capped by queue length). Anything else ⇒ transient (the
            // engine is re-minting a session, a stale URL after sleep) — retry
            // the SAME track a few times with backoff instead of skipping a song
            // that would have played, then surface a banner if it truly won't.
            if (failedSrc && isStreamError) {
              const STREAM_RETRY_MAX = 4;
              const r = retryRef.current;
              const scheduleRetry = () => {
                if (r.count >= STREAM_RETRY_MAX) {
                  setErrorMsg(
                    "Couldn't play this track — press play to try again.",
                  );
                  usePlayerStore.getState().pause();
                  return;
                }
                r.count += 1;
                setBuffering(true);
                window.clearTimeout(r.timer);
                r.timer = window.setTimeout(() => {
                  setErrorMsg(null);
                  const el = audioRef.current;
                  if (el) {
                    el.load(); // re-fetch the SAME src (resume from metadata)
                    el.play().catch(() => {});
                  }
                  usePlayerStore.setState({ isPlaying: true });
                }, Math.min(700 * r.count, 4000));
              };
              void fetch(failedSrc, {
                method: 'GET',
                cache: 'no-store',
                headers: { Range: 'bytes=0-0' },
              })
                .then((res) => {
                  if (res.status === 404) {
                    const store = usePlayerStore.getState();
                    const cap = Math.max(store.queue.length, 1);
                    goneRef.current += 1;
                    r.count = 0;
                    if (goneRef.current > cap) {
                      // Whole queue skipped, nothing played — stop and show a
                      // persistent banner so the silence is explained.
                      goneRef.current = 0;
                      setErrorMsg('Song source not available');
                      store.pause();
                      return;
                    }
                    // A single dead row: skip on silently. Desktop is the library
                    // host, so an unavailable track is rare here — not worth a
                    // per-skip banner. Only the all-dead case above surfaces one.
                    setErrorMsg(null);
                    store.next();
                  } else {
                    scheduleRetry();
                  }
                })
                .catch(() => scheduleRetry());
              return;
            }
            // Non-stream error (a corrupt/undecodable local file): skip past it,
            // capped by queue length so a run of bad rows can't loop forever.
            const store = usePlayerStore.getState();
            const cap = Math.max(store.queue.length, 1);
            goneRef.current += 1;
            if (goneRef.current > cap) {
              goneRef.current = 0;
              setErrorMsg("Couldn't play this track.");
              store.pause();
              return;
            }
            store.next();
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
      {/* Slim remote-awareness strip — IN FLOW just above the player bar, so
          it never covers Home and never replaces the local player. The two
          players stay independent (the household model: this computer and a
          phone can both play at once) — this is awareness + control of the
          OTHER device, with a one-tap "Play here" to pull its queue over. */}
      {remoteActive?.now_playing && (
        <div className="relative z-30 shrink-0 mx-2 mb-1 flex items-center gap-3 rounded-xl border border-white/10 bg-neutral-950/45 backdrop-blur-2xl px-3 py-1.5">
          <div className="h-8 w-8 shrink-0 rounded overflow-hidden bg-neutral-800 grid place-items-center">
            {remoteActive.now_playing.album_art_url ? (
              <img src={remoteActive.now_playing.album_art_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-neutral-600 text-xs">♪</span>
            )}
          </div>
          <div className="min-w-0 flex-1 flex items-baseline gap-2">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-accent shrink-0">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
              Playing on {remoteActive.label}
            </span>
            <span className="text-xs text-neutral-200 truncate">
              {remoteActive.now_playing.title}
              {remoteActive.now_playing.artists.length > 0 && (
                <span className="text-neutral-500"> · {remoteActive.now_playing.artists.join(', ')}</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 text-neutral-300">
            <button type="button" onClick={() => sendRemote('prev')} aria-label={`Previous on ${remoteActive.label}`} className="hover:text-neutral-100">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19 20 9 12l10-8z" /><rect x="5" y="4" width="2" height="16" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => sendRemote(remoteActive.now_playing!.is_playing ? 'pause' : 'play')}
              aria-label={remoteActive.now_playing.is_playing ? `Pause on ${remoteActive.label}` : `Play on ${remoteActive.label}`}
              className="hover:text-neutral-100"
            >
              {remoteActive.now_playing.is_playing ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
            <button type="button" onClick={() => sendRemote('next')} aria-label={`Next on ${remoteActive.label}`} className="hover:text-neutral-100">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M5 4l10 8-10 8z" /><rect x="17" y="4" width="2" height="16" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() =>
                castToken && void requestHandoff(castToken, remoteActive.device_id)
              }
              className="ml-1 text-xs text-neutral-300 hover:text-neutral-100 rounded-lg px-2 py-1 hover:bg-neutral-900 transition"
              title="Bring that queue to this computer and continue here"
            >
              Play here
            </button>
          </div>
        </div>
      )}
      {!isEmpty && (
        <footer
          className="relative z-30 h-20 shrink-0 bg-neutral-950/45 backdrop-blur-2xl backdrop-saturate-150 px-4 grid grid-cols-[1fr_2fr_1fr] gap-4 items-center mx-2 mb-2 rounded-2xl border border-white/10"
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
                onClick={openTrackMenu}
                aria-label="More"
                title="More"
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
                // Active = accent icon PLUS a tinted chip, so on/off reads at a
                // glance even when the artwork accent is near-white (icon-color
                // alone was ambiguous). Matches the phone's queue-pill recipe.
                className={`h-8 w-8 grid place-items-center rounded-full transition ${
                  shuffle
                    ? 'text-accent'
                    : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
                }`}
                style={
                  shuffle
                    ? {
                        backgroundColor:
                          'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                      }
                    : undefined
                }
                title="Shuffle (S)"
                aria-label="Shuffle"
                aria-pressed={shuffle}
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
                title="Previous (⇧←)"
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
                title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
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
                title="Next (⇧→)"
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
                className={`relative h-8 w-8 grid place-items-center rounded-full transition ${
                  repeat !== 'off'
                    ? 'text-accent'
                    : 'text-neutral-400 hover:text-neutral-100 hover:bg-white/5'
                }`}
                style={
                  repeat !== 'off'
                    ? {
                        backgroundColor:
                          'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                      }
                    : undefined
                }
                title={`Repeat: ${repeat} (R)`}
                aria-label="Repeat"
                aria-pressed={repeat !== 'off'}
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
                title="Seek (← / →)"
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
              <LyricsIcon />
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
              <QueueIcon />
            </button>
            {/* One persistent "Connect" button — always present, so the toolbar
                never shifts. Toggles the RightBar's Connect tab (This computer /
                Chromecasts / other Beetbot devices), matching how Lyrics and
                Up next open; accent + device name while casting. */}
            <button
              type="button"
              onClick={() => toggleRightBar('connect')}
              aria-label={
                connectedName ? `Connected to ${connectedName}` : 'Connect to a device'
              }
              title={
                connectedName ? `Playing on ${connectedName}` : 'Connect to a device'
              }
              // Icon-only (Spotify-style): the accent tint says "connected";
              // the device NAME lives in the tooltip + Connect panel. An inline
              // name chip overflowed into the volume slider at narrow widths.
              className={`h-8 w-8 grid place-items-center rounded-lg transition ${
                connectedName
                  ? 'text-accent bg-white/10'
                  : rightBar === 'connect'
                    ? 'text-neutral-100 bg-white/10'
                    : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <ConnectIcon />
            </button>
            {/* Speaker doubles as a mute toggle (same action as the M hotkey):
                click to drop to 0 and show the muted glyph, click again to
                restore the pre-mute level. Muted == volume 0. */}
            <button
              type="button"
              onClick={toggleMute}
              aria-label={volume === 0 ? 'Unmute' : 'Mute'}
              title={volume === 0 ? 'Unmute (M)' : 'Mute (M)'}
              className="h-8 w-8 grid place-items-center rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900 transition"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
                {volume === 0 ? (
                  <>
                    <path d="m16 9 5 6" />
                    <path d="m21 9-5 6" />
                  </>
                ) : (
                  <>
                    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                  </>
                )}
              </svg>
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              title="Volume (↑ / ↓) · M to mute"
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
      {trackMenu && (
        <ContextMenu state={trackMenu} onClose={() => setTrackMenu(null)} />
      )}
      {sleepMenu && (
        <ContextMenu state={sleepMenu} onClose={() => setSleepMenu(null)} />
      )}
    </>
  );
}
