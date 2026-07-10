import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { currentTrack, usePlayerStore, useCatalogNav } from '../store';
import {
  cacheKeyFor,
  castControl,
  castStart,
  castStop,
  getCastStatus,
  getLikedTrackIds,
  getLyrics,
  fetchRadioStreamTracks,
  logPlay,
  logPlayFinish,
  setTrackLiked,
  listCastDevices,
  listDevices,
  pollHandoff,
  pollRemoteCommands,
  postHandoff,
  postRemoteCommand,
  requestHandoff,
  sendHeartbeat,
  playbackUrl,
  canPlayNow,
  isPlayable,
  trackArtUrl,
  notifyUnauthorized,
  type CastDevice,
  type HandoffPayload,
  type Lyrics,
  type RemoteAction,
  type RemoteDevice,
  type SearchTrackResult,
  type StreamTrack,
} from '@shared/api';
import { AddToPlaylistModal } from '@shared/components/SearchScreen';
import { useHubReachable } from '@shared/useHubReachable';
import { cn, SCRIM, CALLOUT_ERROR, EYEBROW_ON_ART } from '@shared/ui';
import { useAccentColor } from '@shared/useAccent';
import { TrackActionSheet } from './TrackActionSheet';
import { LyricsView } from '@shared/components/LyricsView';
import { Marquee } from '@shared/components/Marquee';
import { LikeButton } from '@shared/components/LikeButton';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { RemoteNowPlaying } from '@shared/components/RemoteNowPlaying';
import { audioStarted, registerAudioPauser } from '@shared/audioCoordinator';
import { formatDuration } from '@shared/format';
import {
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
} from './Icons';

interface Props {
  token: string;
  profileId: number | null;
  /** Whether this bar is the bottom-most element (no nav below it). When false,
   *  the nav already reserves the home-indicator inset, so the bar must not —
   *  doubling it leaves dead space between the bar and the nav. */
  bottomInset?: boolean;
  /** Square the mini-bar's TOP corners so a docked connection banner sitting
   *  flush above it completes one rounded card (banner = tinted header). */
  flushTop?: boolean;
}

/**
 * Small indeterminate spinner rendered inside the play button while
 * `<audio>` is buffering (after a tap to play, or mid-track network
 * stall). Matches the play/pause icon size so the button doesn't
 * resize when the spinner swaps in/out. `animate-spin` is a Tailwind
 * utility that applies a 1s linear rotation.
 */
function Spinner({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Translate an `<audio>` `MediaError.code` into something a human can read.
 * iOS Safari just hands us the bare error code with no message, so we keep
 * the mapping here. Surfacing this to the UI turns a silent "nothing
 * happens" into a diagnosable bug report.
 */
/**
 * Read a Blob as a data: URL string. Wraps FileReader in a Promise
 * so callers can `await` instead of nesting event handlers. Used for
 * artwork inlining (see the `artworkDataUrlsRef` comment in Player).
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('FileReader returned non-string'));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function describeAudioError(err: MediaError | null): string {
  if (!err) return 'Unknown playback error';
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Playback aborted';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Network error while streaming';
    case MediaError.MEDIA_ERR_DECODE:
      return 'Browser couldn’t decode this file (codec mismatch?)';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Audio format not supported by this browser';
    default:
      return `Audio error (code ${err.code})`;
  }
}

/**
 * Persistent <audio> element + the bottom transport bar.
 *
 * The <audio> tag lives at the React tree root so swapping queues doesn't
 * tear it down. Source URL is `/stream/<id>?t=<token>` -- ServeFile on the
 * Rust side handles Range requests, so seeking is a server round-trip per
 * scrub, not a full re-download.
 *
 * Mobile gotcha: iOS won't auto-play without a user gesture. Our flows
 * always start playback in response to a tap, so the very first <audio>.play()
 * call comes inside a user-initiated handler. After that, autoplay is
 * unlocked for this origin until the tab is closed.
 */
// A tiny silent WAV. Played once (muted) on the fade element during a user
// gesture to "bless" it, so later programmatic play() during a crossfade is
// allowed by the browser's autoplay policy.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/** Track the OS "Reduce Motion" setting so we can swap slide/scale transitions
 *  for instant cross-fades (Apple replaces zoom transitions with a fade under
 *  Reduce Motion; the web equivalent is this media query). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Horizontal swipe → prev/next. Gestures are accelerators, never the only
 *  path — callers keep their visible prev/next buttons. Returns touch handlers
 *  plus a `swiped` ref so the element's onClick can ignore the tap that follows
 *  a swipe (e.g. the mini-bar's tap-to-expand). */
function useSwipeNav(onNext: () => void, onPrev: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      start.current = null;
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
    swiped.current = false;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // Decisive horizontal swipe only — ignore taps and vertical drags (which
    // belong to scrolling / swipe-down-to-dismiss).
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped.current = true;
      if (dx < 0) onNext();
      else onPrev();
    }
  };
  return { handlers: { onTouchStart, onTouchEnd }, swiped };
}

/** Pull a representative vibrant color out of album art (for the Now Playing
 *  backdrop). Reads pixels from a downscaled canvas; returns null if the image
 *  is cross-origin-tainted (getImageData throws) or has no usable color, so the
 *  caller falls back to the plain dark background. Deezer's CDN sends
 *  Access-Control-Allow-Origin:* and local/offline art is same-origin/data-URL,
 *  so this works across sources. Prefers saturated mid-tone pixels (an actual
 *  accent) over a muddy whole-image average. */
function extractVibrant(img: HTMLImageElement): string | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // cross-origin taint
  }
  let vr = 0,
    vg = 0,
    vb = 0,
    vn = 0; // saturated mid-tone pixels
  let ar = 0,
    ag = 0,
    ab = 0,
    an = 0; // overall average (fallback)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    ar += r;
    ag += g;
    ab += b;
    an++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > 0.35 && light > 40 && light < 225) {
      vr += r;
      vg += g;
      vb += b;
      vn++;
    }
  }
  if (vn > 0)
    return `rgb(${Math.round(vr / vn)}, ${Math.round(vg / vn)}, ${Math.round(vb / vn)})`;
  if (an > 0)
    return `rgb(${Math.round(ar / an)}, ${Math.round(ag / an)}, ${Math.round(ab / an)})`;
  return null;
}

/** Resolve album art to a backdrop accent color, re-running when the art URL
 *  changes. Null while loading / on failure (caller shows the default dark bg). */
function useArtworkColor(artUrl: string | null | undefined): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    setColor(null);
    if (!artUrl) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!cancelled) setColor(extractVibrant(img));
    };
    // onerror: leave color null → default background. No-op handler needed so a
    // failed cross-origin load doesn't surface as an unhandled image error.
    img.onerror = () => {};
    img.src = artUrl;
    return () => {
      cancelled = true;
    };
  }, [artUrl]);
  return color;
}

/** Build the SearchTrackResult shape AddToPlaylistModal expects from the
 *  now-playing StreamTrack. Mirrors HomeScreen's statToTrack for a local row:
 *  `source: 'local'` + `source_id` = the track id makes the host's
 *  patch_track_playlists LINK the existing library row to the chosen playlists
 *  (via its `source == 'local'` guard) rather than insert a duplicate. */
export function streamToSearchResult(t: StreamTrack): SearchTrackResult {
  return {
    source: 'local',
    source_id: String(t.id),
    title: t.title,
    artists: t.artists,
    album: t.album ?? null,
    album_art_url: t.album_art_url ?? null,
    duration_ms: t.duration_ms,
    isrc: null,
    local_track_id: t.id,
    in_playlist_ids: [],
    has_audio: t.has_audio,
    preview_url: null,
    explicit: false,
  };
}

export function Player({ token, profileId, bottomInset = true, flushTop = false }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Crossfade (experimental, opt-in): a throwaway second <audio> plays the
  // OUTGOING track's tail while the primary fades IN the next track. iOS
  // ignores element.volume, so both are routed through Web Audio GainNodes.
  // None of this is created unless crossfadeSeconds > 0.
  const fadeRef = useRef<HTMLAudioElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const primaryGainRef = useRef<GainNode | null>(null);
  const fadeGainRef = useRef<GainNode | null>(null);
  const cfStateRef = useRef<'idle' | 'fading'>('idle');
  const cfCleanupRef = useRef<number | null>(null);
  const fadePrimedRef = useRef(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  // While the user is dragging the scrubber, the visible thumb position
  // tracks this local state instead of the store's currentTime. Only on
  // pointer release do we commit the new position to the audio element
  // (or the Chromecast). Without this every drag pixel would call
  // audio.currentTime = t and trigger a Range-request flush — visibly
  // laggy in iOS Safari.
  const [scrubbingTime, setScrubbingTime] = useState<number | null>(null);
  const [sourceMode, setSourceMode] = useState<'streaming' | 'offline'>('streaming');
  // Whether the full-screen "Now Playing" overlay is open. Tapping the
  // mini bar's track info area opens it; the chevron-down inside closes it.
  const [expanded, setExpanded] = useState(false);
  // Whether the "Add to playlist" modal (opened from the Now Playing overflow
  // menu) is showing. Rendered at the Player level so it layers above the
  // overlay (ModalShell is z-50, the overlay z-40) and survives it.
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);
  // Track the active blob URL so we can revoke it when the track changes.
  // Without revocation each cached track adds a megabytes-sized leak.
  const blobUrlRef = useRef<string | null>(null);
  // ---- MediaSession artwork as inline data URL ----------------------
  //
  // When the audio track auto-advances while the PWA is backgrounded
  // (lock screen, app switcher), iOS Safari fetches the MediaSession
  // artwork URL via its *own* URLSession — NOT through this page's
  // service worker. With the Beetbot host (the user's desktop)
  // asleep, that fetch hangs / fails, and empirically iOS gates the
  // new track's audio session on it: lock-screen scrubber animates,
  // metadata updates, but no sound. This even affects offline-cached
  // tracks (the audio bytes are local, but iOS still tries to fetch
  // artwork).
  //
  // Workaround: pre-fetch the artwork bytes through *our* fetch (so
  // the SW serves cached on cache hit), convert to a data: URL, and
  // hand iOS that inlined URL via MediaMetadata. iOS doesn't need
  // any network to resolve a data: URL — the bytes are already in
  // the URL itself — so the audio session can't get stuck on it.
  // Cached per-track-id so the next-track transition is instant.
  const artworkDataUrlsRef = useRef<Map<number, string>>(new Map());
  const [currentArtworkDataUrl, setCurrentArtworkDataUrl] = useState<
    string | null
  >(null);
  // Cap the inline artwork cache so a long listening session with
  // many distinct tracks doesn't leak memory. ~50 entries × ~50 KB
  // base64 artwork ≈ 2.5 MB — well within budget on iOS.
  const ARTWORK_CACHE_LIMIT = 50;
  const prefetchArtworkDataUrl = useCallback(
    async (trackId: number) => {
      if (artworkDataUrlsRef.current.has(trackId)) return;
      try {
        const res = await fetch(trackArtUrl(trackId, token));
        if (!res.ok) return;
        const blob = await res.blob();
        // Skip tiny/empty bodies that snuck through (e.g. 200 with a
        // 0-byte placeholder during a backend hiccup).
        if (blob.size < 256) return;
        const dataUrl = await blobToDataUrl(blob);
        const map = artworkDataUrlsRef.current;
        // Simple LRU: if we're at the cap, drop the first key (the
        // Map iteration order matches insertion, so the first key is
        // the oldest).
        if (map.size >= ARTWORK_CACHE_LIMIT) {
          const firstKey = map.keys().next().value;
          if (firstKey !== undefined) map.delete(firstKey);
        }
        map.set(trackId, dataUrl);
      } catch {
        /* swallow — falling back to network URL is fine */
      }
    },
    [token],
  );
  const track = usePlayerStore(currentTrack);
  // Re-render when hub reachability changes so the play control on a
  // non-downloaded current track dims the moment the hub becomes unreachable.
  useHubReachable();
  // Can the current track START playing right now? Downloaded tracks always
  // can (local file); a non-downloaded track needs a reachable hub for /live.
  const canPlayCurrent = !track ? false : canPlayNow(track);
  useAccentColor(track?.album_art_url ? trackArtUrl(track.id, token) : null);
  // Extracted the SAME way as the Now Playing screen's backdrop, so the mini bar
  // can wear the same album tinge (see miniBarBg near the render).
  const barVibrant = useArtworkColor(
    track?.album_art_url ? trackArtUrl(track.id, token) : null,
  );
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const handleTrackEnded = usePlayerStore((s) => s.handleTrackEnded);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  // Swipe the mini bar left/right to skip tracks (tap still expands).
  const miniSwipe = useSwipeNav(next, prev);
  const playPause = usePlayerStore((s) => s.playPause);
  const repeat = usePlayerStore((s) => s.repeat);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const appendToQueue = usePlayerStore((s) => s.appendToQueue);
  const adoptHandoff = usePlayerStore((s) => s.adoptHandoff);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  // Phone crossfade is DISABLED. Crossfading requires routing the <audio>
  // element through Web Audio (iOS makes element.volume read-only), but iOS
  // SUSPENDS the AudioContext when the app is backgrounded / the screen
  // locks — which stops playback. Background playback matters far more than
  // crossfade, so we force it off here (the engine below never activates,
  // the audio element is never routed through Web Audio) and keep crossfade
  // desktop-only. The persisted setting is ignored.
  const crossfadeSeconds = 0;
  const crossfadeAdvance = usePlayerStore((s) => s.crossfadeAdvance);

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

  // ---- Liked Songs (heart) ----
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void getLikedTrackIds(token, profileId).then((s) => {
      if (!cancelled) setLikedIds(s);
    });
    return () => {
      cancelled = true;
    };
  }, [token, profileId]);

  // ---- Listening stats: log a play once a track passes ~20s ----
  const playLoggedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!track) return;
    if (currentTime < 1 && playLoggedRef.current === track.id) {
      playLoggedRef.current = null; // track restarted — allow a fresh log
    } else if (currentTime >= 20 && playLoggedRef.current !== track.id) {
      playLoggedRef.current = track.id;
      void logPlay(token, track.id, profileId);
      // Same threshold the server uses to record a play: surface it to Home so
      // the live "Recently played" prepend only shows tracks the feed will keep.
      usePlayerStore.getState().markPlayLogged(track);
    }
  }, [currentTime, track?.id, token, profileId]);

  // ---- Phase 0: completion signal (finished vs skipped) ----
  // Latest playback position of the CURRENT track, refreshed on each timeupdate
  // (and snapped to full length on natural end); reported for the OUTGOING track
  // when the track changes. Feeds completion-weighted recommendations later.
  const lastTickRef = useRef<{ id: number; ms: number; durMs: number } | null>(
    null,
  );
  const reportFinishRef = useRef<
    (p: { id: number; ms: number; durMs: number }) => void
  >(() => {});
  reportFinishRef.current = (p) => {
    if (p.ms < 5000) return; // ignore accidental taps
    const completed = p.durMs > 0 && p.ms >= 0.85 * p.durMs;
    void logPlayFinish(token, p.id, p.ms, completed, profileId);
  };
  useEffect(() => {
    const myId = track?.id;
    // Cleanup runs when track.id changes (or the player unmounts), with the
    // outgoing track's last tick still in the ref (the new track hasn't ticked
    // yet). Refs keep this effect from re-firing on token/profile changes.
    return () => {
      const p = lastTickRef.current;
      if (p && p.id === myId) reportFinishRef.current(p);
    };
  }, [track?.id]);

  const trackLiked = track ? likedIds.has(track.id) : false;
  const applyLike = useCallback(
    (id: number, next: boolean) => {
      setLikedIds((prev) => {
        const s = new Set(prev);
        if (next) s.add(id);
        else s.delete(id);
        return s;
      });
      void setTrackLiked(token, id, next, profileId).catch(() => {
        setLikedIds((prev) => {
          const s = new Set(prev);
          if (next) s.delete(id);
          else s.add(id);
          return s;
        });
      });
    },
    [token, profileId],
  );
  const toggleLike = useCallback(() => {
    if (track) applyLike(track.id, !likedIds.has(track.id));
  }, [track, likedIds, applyLike]);
  // Double-tap the art only ever *adds* to Liked (Spotify-style), never removes.
  const likeFromArt = useCallback(() => {
    if (track && !likedIds.has(track.id)) applyLike(track.id, true);
  }, [track, likedIds, applyLike]);

  // Lyrics for the current track (LRCLIB via the hub), refetched on track change.
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  useEffect(() => {
    if (!track) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    setLyrics(null);
    setLyricsLoading(true);
    getLyrics(token, {
      title: track.title,
      artist: track.artists[0] ?? '',
      album: track.album,
      durationMs: track.duration_ms,
    })
      .then((l) => {
        if (!cancelled) setLyrics(l);
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, token]);

  // Prefetch the NEXT queued track's lyrics so they're cached the instant the
  // song rolls over. Fire-and-forget; keyed on the next track's id.
  const nextLyricsTrack = usePlayerStore((s) => s.queue[s.currentIndex + 1] ?? null);
  useEffect(() => {
    if (!token || !nextLyricsTrack) return;
    void getLyrics(token, {
      title: nextLyricsTrack.title,
      artist: nextLyricsTrack.artists[0] ?? '',
      album: nextLyricsTrack.album,
      durationMs: nextLyricsTrack.duration_ms,
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, nextLyricsTrack?.id]);

  // Clear any prior error whenever the track changes.
  useEffect(() => {
    setErrorMsg(null);
  }, [track?.id]);

  // ---- Autoplay / radio: keep the queue flowing past its end ----
  // When you reach the end of the queue with repeat OFF and autoplay ON, fetch
  // songs similar to the current track's artist and append them — so a single
  // track (or a finished playlist) rolls into a radio of similar music instead
  // of stopping. Triggered while the last/second-to-last track plays so the
  // appended songs are ready before this one ends (no audible gap).
  const radioKeyRef = useRef('');
  const radioInFlightRef = useRef(false);
  useEffect(() => {
    // Only while actually playing toward the end, repeat off, not shuffling
    // (shuffle replays forever, never runs dry). The isPlaying gate avoids a
    // speculative fetch on cold-open when parked at the tail.
    if (!isPlaying || !autoplay || shuffle || repeat !== 'off' || !track) return;
    const upcoming = queueLength - 1 - currentIndex; // tracks queued after current
    if (upcoming > 1) return; // still plenty ahead
    const seed = track.artists[0];
    if (!seed) return;
    // De-dupe identical triggers (same queue length + seed) so we fetch once
    // per tail; after appending, queueLength changes and a new tail can trigger.
    const key = `${queueLength}:${track.id}`;
    if (radioInFlightRef.current || radioKeyRef.current === key) return;
    radioKeyRef.current = key;
    radioInFlightRef.current = true;
    void (async () => {
      try {
        const more = await fetchRadioStreamTracks(seed, token, {
          title: track.title,
          limit: 30,
          profileId,
        });
        const n = more.length ? appendToQueue(more) : 0;
        // If the track already ended while this fetch was in flight (the queue
        // ran dry and playback stopped at the tail), roll into the freshly-
        // appended radio instead of staying stopped. The currentTime===0 +
        // tail-index checks distinguish this from a deliberate mid-track pause.
        if (n > 0) {
          const s = usePlayerStore.getState();
          if (
            !s.isPlaying &&
            s.currentTime === 0 &&
            s.currentIndex === s.queue.length - n - 1
          ) {
            s.jumpTo(s.currentIndex + 1);
          }
        }
      } finally {
        radioInFlightRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, repeat, shuffle, isPlaying, track?.id, queueLength, currentIndex, token, profileId]);

  // Mutual exclusion with the 30-second preview clips: when a preview starts,
  // this pauses the full-track player. (The reverse — starting playback pauses
  // a running preview — is announced from the <audio> onPlay handler below.)
  useEffect(
    () => registerAudioPauser('main', () => usePlayerStore.getState().pause()),
    [],
  );

  // ---- AirPlay (iOS Safari) ----------------------------------------------
  //
  // iOS Safari exposes prefixed webkit APIs on <audio> elements that drive
  // the AirPlay route picker:
  //   - `webkitShowPlaybackTargetPicker()` opens the OS sheet listing
  //     AirPods / HomePod / Apple TV / etc.
  //   - The `webkitplaybacktargetavailabilitychanged` event tells us
  //     whether *any* AirPlay-capable device is currently on the network.
  //     Hide the button when there's nothing to cast to so we don't
  //     advertise a dead-end action.
  //   - `webkitCurrentPlaybackTargetIsWireless` reflects whether audio is
  //     currently routed to an external target; we mirror that into the
  //     button's appearance so the user can tell at a glance.
  //
  // Non-Safari browsers don't implement any of this. The `available` state
  // stays false there, so the button never renders.
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [airPlayActive, setAirPlayActive] = useState(false);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    // The events + methods live behind the webkit prefix.
    type AirPlayEl = HTMLAudioElement & {
      webkitShowPlaybackTargetPicker?: () => void;
      webkitCurrentPlaybackTargetIsWireless?: boolean;
    };
    const el = a as AirPlayEl;
    if (typeof el.webkitShowPlaybackTargetPicker !== 'function') return;

    const onAvailability = (evt: Event & { availability?: string }) => {
      setAirPlayAvailable(evt.availability === 'available');
    };
    const onTargetChange = () => {
      setAirPlayActive(!!el.webkitCurrentPlaybackTargetIsWireless);
    };
    a.addEventListener(
      'webkitplaybacktargetavailabilitychanged' as keyof HTMLMediaElementEventMap,
      onAvailability as EventListener,
    );
    a.addEventListener(
      'webkitcurrentplaybacktargetiswirelesschanged' as keyof HTMLMediaElementEventMap,
      onTargetChange,
    );
    // Seed the "active" state once — iOS doesn't fire the changed event
    // on element mount, only on transitions.
    onTargetChange();
    // Polling fallback. iOS Safari frequently misses firing
    // `webkitcurrentplaybacktargetiswirelesschanged` — most reliably
    // on the AirPlay -> iPhone Speaker transition (when the user
    // picks "iPhone Speaker" in the OS picker to stop casting). Our
    // airPlayActive then stays stuck true: the AirPlay button shows
    // green, the scrubber freeze can linger, and the user can't get
    // out of "AirPlay mode" without picking a different target.
    // Poll the property every 1.5s and reconcile.
    const pollId = window.setInterval(onTargetChange, 1500);
    return () => {
      window.clearInterval(pollId);
      a.removeEventListener(
        'webkitplaybacktargetavailabilitychanged' as keyof HTMLMediaElementEventMap,
        onAvailability as EventListener,
      );
      a.removeEventListener(
        'webkitcurrentplaybacktargetiswirelesschanged' as keyof HTMLMediaElementEventMap,
        onTargetChange,
      );
    };
  }, [audioSrc]);

  // When AirPlay drops back to local (iPhone Speaker / built-in
  // route), iOS sometimes leaves the <audio> element in a paused
  // state. The user sees "playing" in our UI (isPlaying still true)
  // but hears nothing. Re-issue play() on the transition false to
  // kick it back into actually decoding.
  const prevAirPlayActiveRef = useRef(airPlayActive);
  useEffect(() => {
    const prev = prevAirPlayActiveRef.current;
    prevAirPlayActiveRef.current = airPlayActive;
    if (prev && !airPlayActive) {
      const a = audioRef.current;
      if (a && usePlayerStore.getState().isPlaying) {
        void a.play().catch(() => {
          /* autoplay rejection — leave isPlaying alone, user can tap play */
        });
      }
    }
  }, [airPlayActive]);

  // Tracks the brief window between user tapping the AirPlay button and
  // iOS confirming the route. When set, the scrubber visual freezes at
  // `airPlayPickingFromTime` so it doesn't race ahead — the local
  // <audio> element keeps decoding (which is necessary for AirPlay
  // routing) and its currentTime ticks forward, but the AirPlay
  // receiver has a 1-3s buffer before sound actually plays. Holding the
  // scrubber until airPlayActive flips true keeps the UI honest.
  const [airPlayPickingFromTime, setAirPlayPickingFromTime] = useState<
    number | null
  >(null);

  // Clear the picker freeze once AirPlay actually activates, OR after a
  // generous timeout (user cancelled the picker without picking).
  useEffect(() => {
    if (airPlayPickingFromTime == null) return;
    if (airPlayActive) {
      setAirPlayPickingFromTime(null);
      return;
    }
    const id = window.setTimeout(() => setAirPlayPickingFromTime(null), 15_000);
    return () => window.clearTimeout(id);
  }, [airPlayPickingFromTime, airPlayActive]);

  // Same problem as the AirPlay picker, but for track changes. When the
  // user skips while AirPlay is active, the <audio> src swaps, the
  // local element re-loads + starts decoding immediately, and its
  // currentTime begins ticking forward — but the AirPlay receiver
  // takes 1-3s to actually start producing sound for the new track.
  // Without intervention the scrubber races ahead of what the listener
  // hears on the speaker.
  //
  // Strategy: when the track id changes, freeze the scrubber at 0
  // until the <audio>'s native `playing` event fires (i.e. it actually
  // started outputting frames, not just trying to). A 5s timeout
  // guards against the case where `playing` never fires (e.g. error
  // on load).
  const [audioWarmingUp, setAudioWarmingUp] = useState(false);
  // True between "user wants to play" (isPlaying=true) and "audio is
  // actually producing frames" (onPlaying fires). Drives the play
  // button's spinner so the UI feels responsive on cellular even
  // while the audio bytes are still being fetched. Cleared on
  // onPlaying / onPause / castActive (cast has its own status).
  const [audioBuffering, setAudioBuffering] = useState(false);
  // Earliest wall-clock time at which the spinner is allowed to clear.
  // Set to now+350ms whenever we raise the buffering flag; any
  // `onPlaying` that arrives sooner queues a deferred clear instead of
  // an immediate one. Guarantees the spinner is visible long enough to
  // perceive (one or two animation frames isn't), even when the audio
  // is already buffered and play() resolves instantly on Wi-Fi.
  const bufferingMinClearAtRef = useRef(0);
  // Pending setTimeout id for the deferred clear, so a fresh
  // raiseBuffering() (e.g. user mashes play/pause) cancels any
  // stale clear queued by a previous tap.
  const bufferingClearTimerRef = useRef<number | null>(null);
  const raiseBuffering = useCallback(() => {
    setAudioBuffering(true);
    bufferingMinClearAtRef.current = Date.now() + 350;
    if (bufferingClearTimerRef.current != null) {
      window.clearTimeout(bufferingClearTimerRef.current);
      bufferingClearTimerRef.current = null;
    }
  }, []);
  const lowerBuffering = useCallback(() => {
    const wait = bufferingMinClearAtRef.current - Date.now();
    if (wait <= 0) {
      setAudioBuffering(false);
      return;
    }
    if (bufferingClearTimerRef.current != null) {
      window.clearTimeout(bufferingClearTimerRef.current);
    }
    bufferingClearTimerRef.current = window.setTimeout(() => {
      bufferingClearTimerRef.current = null;
      setAudioBuffering(false);
    }, wait);
  }, []);
  useEffect(() => {
    if (!track) return;
    setAudioWarmingUp(true);
    const id = window.setTimeout(() => setAudioWarmingUp(false), 5_000);
    return () => window.clearTimeout(id);
  }, [track?.id]);

  const openAirPlayPicker = () => {
    const a = audioRef.current as
      | (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void })
      | null;
    if (!a?.webkitShowPlaybackTargetPicker) return;
    // Snapshot the current position so the scrubber visual stays put
    // while iOS shows the picker / negotiates the AirPlay route.
    setAirPlayPickingFromTime(currentTime);
    a.webkitShowPlaybackTargetPicker();
  };

  // ---- Chromecast (server-side) ---------------------------------------
  //
  // When `castActive` is true, the Beetbot Rust backend is driving a
  // Chromecast directly: our <audio> element is paused (otherwise we'd
  // have two sources of the same track playing in parallel), and
  // transport controls (play/pause/seek) route to /api/cast/control
  // instead of the local element.
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  // Unified "Connect" output sheet (AirPlay + Cast + hand-off), opened from the
  // Now Playing device chip — mirrors Spotify's single Connect entry point.
  const [connectOpen, setConnectOpen] = useState(false);
  // Collapsing Now Playing always dismisses the Connect sheet so it can never
  // be left floating over the mini-player.
  useEffect(() => {
    if (!expanded) setConnectOpen(false);
  }, [expanded]);
  const [castActive, setCastActive] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [castError, setCastError] = useState<string | null>(null);

  // Optimistically raise the buffering flag the instant `isPlaying`
  // becomes true — that way the spinner appears on the play button
  // immediately when the user taps, even while audio.play() is still
  // resolving its initial buffer. onPlaying / onPause / onWaiting
  // handlers below keep the flag in sync with the audio element's
  // actual state going forward. Skipped when casting (the cast
  // status poller drives that mode).
  useEffect(() => {
    if (castActive) {
      setAudioBuffering(false);
      return;
    }
    if (isPlaying) raiseBuffering();
    else setAudioBuffering(false);
  }, [isPlaying, track?.id, castActive, raiseBuffering]);

  // Poll the device list while the picker is open so we pick up
  // Chromecasts that come online mid-search. 2s is friendly to the
  // network and snappy enough for the UI.
  useEffect(() => {
    if (!connectOpen) return;
    let cancelled = false;
    const refresh = () => {
      listCastDevices(token)
        .then((d) => {
          if (!cancelled) setCastDevices(d);
        })
        .catch(() => {
          if (!cancelled) {
            setCastError("Couldn't find speakers on your network.");
          }
        });
    };
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connectOpen, token]);

  // While casting, force the local element to stay paused. The user
  // might briefly hear it if the audio buffer was already filled
  // before we caught it; this useEffect plus the explicit pause on
  // castStart success should cover all transitions.
  useEffect(() => {
    if (castActive) {
      audioRef.current?.pause();
    }
  }, [castActive]);

  // The track id currently loaded on the receiver — used as a guard so
  // we don't fire a duplicate LOAD for the same track when polling
  // status returns the same value. Separate from store.currentTrack
  // because it's set when LOAD is acked, not when the user clicks.
  const castedTrackIdRef = useRef<number | null>(null);

  // Poll /api/cast/status every 1s while casting. Three jobs:
  //   1. mirror the receiver's currentTime into the store so the
  //      scrubber tracks reality (the receiver is the source of truth
  //      while casting; the local <audio> element is paused).
  //   2. detect IDLE+FINISHED — a track ended naturally — and advance
  //      the queue locally; the track-change effect below then LOADs
  //      the next track onto the receiver.
  //   3. detect that the session went away server-side (e.g. user hit
  //      stop from a different client) and drop out of cast mode.
  useEffect(() => {
    if (!castActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const out = await getCastStatus(token);
        if (cancelled) return;
        if (!out.active) {
          // Session dropped on the server — fall back to local mode.
          setCastActive(null);
          usePlayerStore.setState({ isPlaying: false });
          return;
        }
        const s = out.status;
        // Mirror current_time into the store so the scrubber follows
        // the receiver. If the user just dragged the scrubber, the
        // castControl 'seek' fires and the receiver's echoed
        // currentTime catches up within a tick or two.
        if (typeof s.current_time === 'number') {
          usePlayerStore.setState({ currentTime: s.current_time });
        }
        // Mirror play/pause state. The receiver knows whether buffering
        // finished, so PLAYING vs BUFFERING vs PAUSED is authoritative.
        if (s.player_state === 'PLAYING' || s.player_state === 'BUFFERING') {
          usePlayerStore.setState({ isPlaying: true });
        } else if (s.player_state === 'PAUSED') {
          usePlayerStore.setState({ isPlaying: false });
        }
        // Track ended naturally on the receiver — advance the queue.
        // Don't clear castedTrackIdRef here; store.next() about to run
        // will change track.id and the track-change effect below will
        // see the mismatch and fire a fresh castStart.
        if (s.player_state === 'IDLE' && s.idle_reason === 'FINISHED') {
          usePlayerStore.getState().next();
        }
        // NOTE: we intentionally do NOT mirror s.track_id back into
        // castedTrackIdRef. The ref tracks what *we* asked the backend
        // to LOAD; mirroring server state into it creates a feedback
        // loop where a transient stale status during a session swap
        // causes duplicate LOADs.
      } catch (e) {
        if (!cancelled) {
          console.warn('[beetbot] cast status poll failed', e);
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [castActive, token]);

  // When the store's current track changes while casting (because the
  // user hit next/prev, or the auto-advance above ran), LOAD the new
  // track onto the receiver. Guard with castedTrackIdRef so we don't
  // re-LOAD the track that's already playing.
  useEffect(() => {
    if (!castActive || !track || !track.has_audio) return;
    if (castedTrackIdRef.current === track.id) return;
    castedTrackIdRef.current = track.id;
    castStart(castActive.id, track.id, token)
      .then(() => {
        usePlayerStore.setState({ isPlaying: true, currentTime: 0 });
      })
      .catch((e) => {
        console.warn('[beetbot] cast LOAD-next failed', e);
      });
  }, [castActive, track, token]);

  // ---- Playback handoff ("continue on the computer", and take a queue back).
  const [handoffDevices, setHandoffDevices] = useState<RemoteDevice[]>([]);

  // Heartbeat so other devices can see this phone (as a handoff target) and
  // what it's playing (for their "playing on Phone" banner), and keep our own
  // device list fresh. This phone is labelled "Phone".
  useEffect(() => {
    if (!token) return;
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
      // Scope presence to the active profile so accounts stay isolated.
      void sendHeartbeat(token, 'Phone', 'phone', np, profileId);
      listDevices(token, profileId)
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
  }, [token, profileId]);

  // Apply transport commands another device sent to this phone (its "playing
  // on Phone" banner buttons).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const tick = async () => {
      const cmds = await pollRemoteCommands(token);
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
            void postHandoff(token, requesterId, {
              source_label: 'Phone',
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
  }, [token]);

  // Adopt a queue handed to this phone from another device.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const tick = async () => {
      const h = await pollHandoff(token);
      if (cancelled || !h || h.tracks.length === 0) return;
      const tracks = h.tracks.map((t, i) => ({
        id: t.id,
        title: t.title,
        artists: t.artists,
        album: t.album,
        album_art_url: t.album_art_url,
        duration_ms: t.duration_ms,
        position: i,
        has_audio: true,
        status: 'ready',
      }));
      if (castActive) {
        castStop(token).catch(() => {});
        setCastActive(null);
      }
      adoptHandoff(tracks, h.index, h.position, h.playing);
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, castActive, adoptHandoff]);

  // Hand the current queue + playhead to another device, then pause here.
  const handleHandoff = useCallback(
    async (device: RemoteDevice) => {
      const st = usePlayerStore.getState();
      if (st.queue.length === 0) return;
      const payload: HandoffPayload = {
        source_label: 'Phone',
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
        await postHandoff(token, device.device_id, payload);
        usePlayerStore.setState({ isPlaying: false });
      } catch (e) {
        console.warn('[beetbot] handoff failed', e);
      }
    },
    [token],
  );

  const handleStartCast = useCallback(
    async (device: CastDevice) => {
      if (!track || !track.has_audio) {
        setCastError('Track is not downloaded yet — can\'t cast.');
        return;
      }
      setCastError(null);
      try {
        // Carry the local playhead over so the receiver picks up
        // where the listener was — clicking Cast mid-track shouldn't
        // restart the song from 0.
        const localPos =
          audioRef.current?.currentTime ??
          usePlayerStore.getState().currentTime ??
          0;
        const res = await castStart(device.id, track.id, token, localPos);
        // Remember the track we just LOADed so the track-change
        // effect doesn't immediately fire a redundant castStart.
        castedTrackIdRef.current = track.id;
        setCastActive({ id: res.device_id, name: res.device_name });
        // Mark "playing" — the Chromecast starts immediately on LOAD,
        // and we want the transport button to render Pause.
        usePlayerStore.setState({ isPlaying: true });
      } catch {
        setCastError("Couldn't connect to that speaker. Try again.");
      }
    },
    [track, token],
  );

  const handleStopCast = useCallback(async () => {
    try {
      await castStop(token);
    } catch (e) {
      // Best effort — even on error we transition the UI back to
      // local-only mode so the user isn't stuck.
      console.warn('[beetbot] cast stop failed', e);
    }
    setCastActive(null);
    castedTrackIdRef.current = null;
    // Don't auto-play locally — feels jarring when audio jumps
    // back on. User taps play if they want.
    usePlayerStore.setState({ isPlaying: false });
  }, [token]);

  // Routes the in-app transport buttons either to the Chromecast or
  // to the local audio element depending on the active mode.
  const handlePlayPause = useCallback(() => {
    if (castActive) {
      const nextPlaying = !isPlaying;
      usePlayerStore.setState({ isPlaying: nextPlaying });
      castControl(nextPlaying ? 'play' : 'pause', undefined, token).catch(
        (e) => {
          console.warn('[beetbot] cast play/pause failed', e);
          // Revert if the round-trip failed.
          usePlayerStore.setState({ isPlaying: !nextPlaying });
        },
      );
    } else {
      playPause();
    }
  }, [castActive, isPlaying, playPause, token]);

  // Resolve the <audio> src.
  //
  // We use the network stream URL by default. iOS Safari's AirPlay route
  // does NOT work reliably with Blob URLs — the AirPlay device shows a
  // spinner forever because the Blob lives only in this page's JS
  // context. Swapping a Blob URL to a network URL on the fly also
  // disrupts the AirPlay route (clearing src disconnects it). The only
  // reliable approach is to keep the audio src as a stable HTTP URL
  // from the start so AirPlay can attach to it and stay attached.
  //
  // For purely offline playback (airplane mode + cached tracks), we
  // fall back to a Blob URL ONLY when navigator.onLine is false. In
  // that case AirPlay isn't reachable anyway, so the Blob-URL caveat
  // doesn't apply.
  useEffect(() => {
    let cancelled = false;
    const priorBlobUrl = blobUrlRef.current;

    if (!track) {
      setAudioSrc(null);
      setSourceMode('streaming');
      blobUrlRef.current = null;
      if (priorBlobUrl) URL.revokeObjectURL(priorBlobUrl);
      return;
    }
    // Online (the common case): always use the network URL, no
    // intermediate setAudioSrc(null). Direct assignment keeps the
    // audio element's session intact across track changes and lets
    // iOS Safari attach AirPlay to a stable HTTP URL.
    if (navigator.onLine) {
      blobUrlRef.current = null;
      // A track is playable only when it has an imported audio file; the queue
      // filter never enqueues a non-audio track, but guard anyway (null src).
      setAudioSrc(playbackUrl(track, token));
      setSourceMode('streaming');
      if (priorBlobUrl) URL.revokeObjectURL(priorBlobUrl);
      return;
    }
    // Offline path — try the cache; if no hit, fall back to network
    // (will fail to load but the error UI surfaces it).
    setAudioSrc(null);
    (async () => {
      let resolvedSrc: string | null = null;
      let resolvedMode: 'streaming' | 'offline' = 'streaming';
      let newBlobUrl: string | null = null;
      try {
        if ('caches' in self) {
          const cache = await caches.open('beetbot-audio-v1');
          const hit = await cache.match(cacheKeyFor(track.id));
          if (hit) {
            const blob = await hit.blob();
            newBlobUrl = URL.createObjectURL(blob);
            resolvedSrc = newBlobUrl;
            resolvedMode = 'offline';
          }
        }
      } catch (e) {
        console.warn('[beetbot] cache lookup failed', e);
      }
      if (!resolvedSrc) {
        resolvedSrc = playbackUrl(track, token);
        resolvedMode = 'streaming';
      }
      if (cancelled) {
        if (newBlobUrl) URL.revokeObjectURL(newBlobUrl);
        return;
      }
      blobUrlRef.current = newBlobUrl;
      setAudioSrc(resolvedSrc);
      setSourceMode(resolvedMode);
      if (priorBlobUrl) URL.revokeObjectURL(priorBlobUrl);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, token]);

  // NOTE: a track is only playable once an audio file has been imported for it
  // on the desktop; the phone just streams whatever already has a file.

  // Prefetch the next 1-2 tracks in the queue while the current one
  // plays. Fires background fetches so the browser HTTP cache is warm
  // when the user hits next or auto-advance fires. Pre-warming +1 is
  // the big win; +2 makes double-skips and "I want to skim this
  // playlist quickly" feel snappy too. Each prefetch aborts on track
  // change so we never waste bandwidth on tracks we won't reach.
  useEffect(() => {
    if (!track) return;
    const { queue, currentIndex } = usePlayerStore.getState();
    const upcoming = [queue[currentIndex + 1], queue[currentIndex + 2]].filter(
      (t): t is NonNullable<typeof t> => Boolean(t && isPlayable(t)),
    );
    if (upcoming.length === 0) return;
    const ctrl = new AbortController();
    // Stagger by 2s and 6s so neither prefetch competes with the
    // current track's own buffer fill, and the +2 doesn't compete
    // with the +1.
    const timeouts: number[] = [];
    const schedule = (track: typeof upcoming[number], delay: number) => {
      const id = window.setTimeout(() => {
        const url = playbackUrl(track, token);
        if (!url) return;
        if (track.has_audio) {
          // Downloaded file — pull it fully so the browser caches it; the audio
          // element can then load from cache, which survives a locked screen.
          fetch(url, { signal: ctrl.signal })
            .then((r) => r.blob())
            .catch(() => {});
        } else {
          // Streamed (/live) track — a tiny range request makes the desktop
          // de-fragment it to its temp cache NOW, so the real request is ready
          // the instant the queue advances. This is exactly the case that
          // failed before: a non-downloaded next song cold-starting a /live
          // fetch while the phone is locked, in iOS's tiny background window.
          // We don't keep the bytes — only the server-side prep matters.
          fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-1' },
            cache: 'no-store',
            signal: ctrl.signal,
          })
            .then((r) => r.arrayBuffer())
            .catch(() => {});
        }
      }, delay);
      timeouts.push(id);
    };
    schedule(upcoming[0], 2000);
    if (upcoming[1]) schedule(upcoming[1], 6000);
    // Also warm the artwork data-URL cache for the upcoming tracks
    // so MediaSession can hand iOS an inline data URL the moment the
    // queue auto-advances in background. Without this, the next
    // track's metadata briefly carries the network URL — and if the
    // Beetbot host is asleep, iOS may gate the audio session on
    // that doomed artwork fetch. Fire 500ms after the audio
    // prefetch so the artwork doesn't compete for the same TCP
    // pipe during initial buffering of the upcoming audio.
    const artTimeouts: number[] = [];
    upcoming.forEach((t, i) => {
      const id = window.setTimeout(() => {
        void prefetchArtworkDataUrl(t.id);
      }, 2500 + i * 1000);
      artTimeouts.push(id);
    });
    return () => {
      timeouts.forEach((id) => window.clearTimeout(id));
      artTimeouts.forEach((id) => window.clearTimeout(id));
      ctrl.abort();
    };
  }, [track?.id, token, prefetchArtworkDataUrl]);

  // Final blob URL cleanup on unmount so the Player tearing down doesn't
  // leave a dangling allocation.
  useEffect(
    () => () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  // Seek the audio element when the store's currentTime drifts far
  // from the element's currentTime. Triggered when `prev()` (the
  // "restart current song" branch) or any external scrub mutates the
  // store. Without this, store.currentTime = 0 from prev() never makes
  // it to the audio element — the next onTimeUpdate tick overwrites
  // the store back to wherever playback actually is.
  //
  // 1-second threshold avoids the onTimeUpdate echo from re-seeking
  // every tick. Mirrors the desktop PlayerBar's pattern.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (Math.abs(a.currentTime - currentTime) > 1) {
      a.currentTime = currentTime;
    }
  }, [currentTime]);

  // Push play/pause state into the actual element. Gated on `audioSrc`
  // being set so we don't try to .play() the audio element before its src
  // has been resolved (the resolver above is async).
  //
  // Tracks the last `src` we actually issued a load() against. When
  // the page is backgrounded and a track auto-advances, iOS Safari
  // sometimes leaves the <audio> element in a half-armed state: its
  // currentTime ticks forward (and the lock-screen scrubber animates)
  // but no audio actually reaches the speaker. Calling load()
  // explicitly when the src changes — instead of relying on the
  // browser's implicit load after the attribute set — forces iOS to
  // fully prepare the new audio session inside the same call stack
  // as the prior `ended` event, which empirically keeps playback
  // alive across background track changes.
  const loadedSrcRef = useRef<string | null>(null);

  // Live-stream error recovery: the phone streams audio from the desktop, so a
  // dropped stream (the desktop restarting, or a stale URL after the app was
  // backgrounded) makes <audio> error with "format not supported". `reloadNonce`
  // forces a fresh load() of the SAME src to recover; `retryRef` caps the
  // auto-retries with a backoff so a genuinely-bad track still surfaces an error.
  const [reloadNonce, setReloadNonce] = useState(0);
  const retryRef = useRef<{ count: number; timer: number }>({ count: 0, timer: 0 });
  // Consecutive tracks auto-skipped because their source 404'd — a stale queue
  // (e.g. after a library migration/rebrand, or a pruned discovery row) points
  // at ids that no longer exist. Reset on any successful play; capped so an
  // all-dead queue skips through once and stops instead of looping forever.
  const goneRef = useRef(0);

  // While `castActive` is set the receiver is the source of truth — the
  // local element must stay paused or we get two copies of the same
  // track playing in parallel (one in the phone speaker, one on the
  // Chromecast). The status poller continuously mirrors the receiver's
  // playing state into `isPlaying`, so without this gate the very first
  // PLAYING tick would re-fire `a.play()` on the local element.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !audioSrc) return;
    if (castActive) {
      a.pause();
      return;
    }
    // Explicit load() the first time we see a new src this mount.
    // Skipped when the src is unchanged (e.g. effect re-ran because
    // isPlaying flipped) so we don't reset playback to 0 on every
    // pause/resume.
    // A reload nonce (bumped by the stream-error retry) forces a fresh load()
    // of the same src after the desktop restarts; `a.error` covers a manual play
    // tap after a failure. Otherwise the src is unchanged on pause/resume, so we
    // don't reset playback to 0.
    const loadKey = `${audioSrc}#${reloadNonce}`;
    if (loadedSrcRef.current !== loadKey || a.error) {
      loadedSrcRef.current = loadKey;
      try {
        a.load();
      } catch {
        /* load() can throw on some browsers during teardown — harmless */
      }
    }
    if (isPlaying) {
      void a.play().catch((err: unknown) => {
        // AbortError is expected when src swaps mid-play (e.g. user
        // taps the next track before the current one started). Don't
        // surface that as a user-visible error.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        usePlayerStore.setState({ isPlaying: false });
        if (err instanceof Error) {
          // NotAllowedError = autoplay blocked, NotSupportedError = no codec
          setErrorMsg(
            err.name === 'NotAllowedError'
              ? 'Tap play to start.'
              : err.name === 'NotSupportedError'
                ? "This track can't be played here."
                : 'Playback failed. Try again.',
          );
        }
      });
    } else {
      a.pause();
    }
  }, [isPlaying, audioSrc, castActive, reloadNonce]);

  // Background-audio recovery. iOS Safari sometimes leaves the audio
  // element in a stuck state after an in-background track change:
  // store.isPlaying is still true (because we never received an
  // 'ended' or 'pause' that flipped it), but a.paused is true (or
  // worse, a.paused is false but no audio is routed — currentTime
  // advances silently). The fix that works without a refactor is to
  // re-kick play() the moment the user brings the app back to the
  // foreground. The visibilitychange event fires when the tab becomes
  // visible (lock-screen unlock, tab focus, app switcher return).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (castActive) return;
      const a = audioRef.current;
      if (!a) return;
      // Only act when the store says we *should* be playing but the
      // element disagrees. Calling play() unconditionally on every
      // visibility flip would re-start playback even when the user
      // intentionally paused before locking the phone.
      const playing = usePlayerStore.getState().isPlaying;
      if (!playing) return;
      if (a.error) {
        // The stream died while backgrounded (server moved on / URL went stale)
        // — force a fresh load to resume from the saved position.
        retryRef.current.count = 0;
        setReloadNonce((n) => n + 1);
      } else if (a.paused) {
        void a.play().catch(() => {
          /* If iOS still refuses, leave it for the user to tap play. */
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [castActive]);

  // ---- Crossfade engine (experimental, opt-in) -------------------------
  //
  // iOS ignores HTMLMediaElement.volume, so fading requires Web Audio. We
  // build a tiny graph ONLY when crossfade is enabled (default-off playback
  // never touches Web Audio and stays the proven AirPlay-safe path). The
  // primary <audio> stays the permanent AirPlay / MediaSession anchor and
  // fades IN the next track; a throwaway second <audio> plays the OUTGOING
  // tail and fades OUT. The primary never swaps.
  const cfTargetIdRef = useRef<number | null>(null);

  const abortCrossfade = useCallback(() => {
    if (cfCleanupRef.current) {
      window.clearTimeout(cfCleanupRef.current);
      cfCleanupRef.current = null;
    }
    const fade = fadeRef.current;
    if (fade) {
      try {
        fade.pause();
        fade.removeAttribute('src');
        fade.load();
      } catch {
        /* ignore */
      }
    }
    const ctx = audioCtxRef.current;
    if (ctx && primaryGainRef.current) {
      primaryGainRef.current.gain.cancelScheduledValues(ctx.currentTime);
      primaryGainRef.current.gain.value = 1;
    }
    if (ctx && fadeGainRef.current) {
      fadeGainRef.current.gain.cancelScheduledValues(ctx.currentTime);
      fadeGainRef.current.gain.value = 1;
    }
    cfStateRef.current = 'idle';
  }, []);

  // Build the Web Audio graph once: route both <audio> elements through gain
  // nodes. createMediaElementSource permanently routes the primary through Web
  // Audio, so this is only ever called from a user gesture (the unlock effect
  // below), where we can also resume() — routing a suspended context would
  // silence playback.
  const buildGraph = useCallback((): boolean => {
    if (primaryGainRef.current) return true; // already built
    const main = audioRef.current;
    const fade = fadeRef.current;
    if (!main || !fade) return false;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new Ctor();
        audioCtxRef.current = ctx;
      }
      const pg = ctx.createGain();
      const fg = ctx.createGain();
      pg.gain.value = 1;
      fg.gain.value = 1;
      ctx.createMediaElementSource(main).connect(pg).connect(ctx.destination);
      ctx.createMediaElementSource(fade).connect(fg).connect(ctx.destination);
      primaryGainRef.current = pg;
      fadeGainRef.current = fg;
      return true;
    } catch (e) {
      console.warn('[beetbot] crossfade: web audio init failed', e);
      return false;
    }
  }, []);

  // Unlock the context on a real user gesture. Browsers only allow
  // AudioContext.resume() inside a gesture call stack — a React effect can't
  // do it — which is why the earlier version never fired. While crossfade is
  // enabled, the next tap/keypress creates + resumes the context and routes
  // the elements, so the graph is live by the time a fade is due.
  useEffect(() => {
    if (crossfadeSeconds <= 0) return;
    const unlock = () => {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      let ctx = audioCtxRef.current;
      if (!ctx) {
        try {
          ctx = new Ctor();
          audioCtxRef.current = ctx;
        } catch {
          return;
        }
      }
      void ctx.resume().catch(() => {});
      buildGraph();
      // Bless the fade element: play a silent clip during this gesture so its
      // later programmatic play() (mid-crossfade, outside any gesture) is
      // allowed. Without this the fade element silently refuses to start.
      const fade = fadeRef.current;
      if (fade && !fadePrimedRef.current) {
        fadePrimedRef.current = true;
        try {
          fade.src = SILENT_WAV;
          const pr = fade.play();
          if (pr && pr.then) {
            pr
              .then(() => {
                try {
                  fade.pause();
                  fade.currentTime = 0;
                } catch {
                  /* ignore */
                }
              })
              .catch(() => {
                fadePrimedRef.current = false;
              });
          }
        } catch {
          fadePrimedRef.current = false;
        }
      }
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [crossfadeSeconds, buildGraph]);

  // Ready check at fade time: graph built and context running (resume if it
  // briefly suspended, e.g. after backgrounding).
  const ensureAudioGraph = useCallback((): boolean => {
    const ctx = audioCtxRef.current;
    if (!ctx || !primaryGainRef.current) return false;
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      return false;
    }
    return true;
  }, []);

  const startCrossfade = useCallback(
    (remaining: number) => {
      const main = audioRef.current;
      const fade = fadeRef.current;
      const { queue, currentIndex } = usePlayerStore.getState();
      const outgoing = queue[currentIndex];
      const incoming = queue[currentIndex + 1];
      if (!main || !fade || !outgoing || !incoming) return;
      if (!ensureAudioGraph()) return;
      const ctx = audioCtxRef.current;
      const primaryGain = primaryGainRef.current;
      const fadeGain = fadeGainRef.current;
      if (!ctx || !primaryGain || !fadeGain) return;

      cfStateRef.current = 'fading';
      cfTargetIdRef.current = incoming.id;
      const dur = Math.max(0.25, remaining);
      const pos = main.currentTime;

      // Move the outgoing tail to the throwaway element at the same spot.
      fade.src = playbackUrl(outgoing, token) ?? '';
      const seekFade = () => {
        try {
          fade.currentTime = pos;
        } catch {
          /* will catch up once metadata lands */
        }
        fade.removeEventListener('loadedmetadata', seekFade);
      };
      fade.addEventListener('loadedmetadata', seekFade);
      void fade.play().catch(() => {});

      const now = ctx.currentTime;
      fadeGain.gain.cancelScheduledValues(now);
      fadeGain.gain.setValueAtTime(1, now);
      fadeGain.gain.linearRampToValueAtTime(0.0001, now + dur);
      primaryGain.gain.cancelScheduledValues(now);
      primaryGain.gain.setValueAtTime(0.0001, now);
      primaryGain.gain.linearRampToValueAtTime(1, now + dur);

      // Promote the primary to the next track. The existing src/play effects
      // load + start it from 0; it ramps up under primaryGain.
      crossfadeAdvance(0);

      if (cfCleanupRef.current) window.clearTimeout(cfCleanupRef.current);
      cfCleanupRef.current = window.setTimeout(
        () => abortCrossfade(),
        dur * 1000 + 300,
      );
    },
    [ensureAudioGraph, abortCrossfade, token, crossfadeAdvance],
  );

  // Arm the crossfade as the current track nears its end. Gated to: enabled,
  // foreground (iOS freezes timers when backgrounded), online streaming (not
  // offline blob URLs), and not casting.
  useEffect(() => {
    if (crossfadeSeconds <= 0 || castActive || !isPlaying || !track) return;
    if (sourceMode !== 'streaming') return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible')
      return;
    // Warm + route the graph (cheap no-op once routed; resumes the context if
    // a recent gesture lets it). Self-heal the primary gain back to full when
    // idle, in case a prior fade was left interrupted.
    const ready = ensureAudioGraph();
    if (ready && cfStateRef.current === 'idle' && audioCtxRef.current && primaryGainRef.current) {
      const g = primaryGainRef.current.gain;
      if (g.value !== 1) {
        g.cancelScheduledValues(audioCtxRef.current.currentTime);
        g.value = 1;
      }
    }
    if (cfStateRef.current !== 'idle' || !(duration > 0)) return;
    const { queue, currentIndex } = usePlayerStore.getState();
    if (currentIndex + 1 >= queue.length) return; // no next track to fade into
    const remaining = duration - currentTime;
    if (remaining > 0.2 && remaining <= crossfadeSeconds) {
      startCrossfade(remaining);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentTime,
    duration,
    crossfadeSeconds,
    castActive,
    isPlaying,
    track?.id,
    sourceMode,
    startCrossfade,
  ]);

  // Abort a fade if the user pauses or jumps to a track that isn't the one
  // we were fading into (manual skip mid-fade) — otherwise the primary could
  // be left stuck at a low gain.
  useEffect(() => {
    if (cfStateRef.current !== 'fading') return;
    if (!isPlaying) {
      abortCrossfade();
      return;
    }
    if (track && cfTargetIdRef.current != null && track.id !== cfTargetIdRef.current) {
      abortCrossfade();
    }
  }, [isPlaying, track?.id, abortCrossfade]);

  // Tear down the audio context on unmount.
  useEffect(
    () => () => {
      if (cfCleanupRef.current) window.clearTimeout(cfCleanupRef.current);
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    },
    [],
  );

  // Pre-fetch the CURRENT track's artwork into the data-URL cache. On
  // a fresh track open this kicks off the fetch; once it lands we
  // setCurrentArtworkDataUrl which causes the MediaSession effect
  // below to re-run with the inline data URL. If the artwork was
  // already prefetched (next-track effect below warmed it), this
  // resolves synchronously from the cache.
  useEffect(() => {
    if (!track) {
      setCurrentArtworkDataUrl(null);
      return;
    }
    const cached = artworkDataUrlsRef.current.get(track.id);
    if (cached) {
      setCurrentArtworkDataUrl(cached);
      return;
    }
    setCurrentArtworkDataUrl(null);
    let cancelled = false;
    (async () => {
      await prefetchArtworkDataUrl(track.id);
      if (cancelled) return;
      const fresh = artworkDataUrlsRef.current.get(track.id);
      if (fresh) setCurrentArtworkDataUrl(fresh);
    })();
    return () => {
      cancelled = true;
    };
  }, [track?.id, prefetchArtworkDataUrl]);

  // Wire the OS Media Session card. Three concerns are split into three
  // effects with disjoint dependencies so we don't churn metadata (and
  // its artwork URL — the bit AirPlay reads to render album art on the
  // receiver screen) on every onTimeUpdate tick.

  // (1) Metadata — only when the track itself changes. Rebuilding
  // MediaMetadata on every isPlaying / currentTime change made iOS
  // keep re-fetching artwork and never settle on what to send to the
  // AirPlay receiver.
  //
  // Artwork URL: prefer the inline data: URL (currentArtworkDataUrl)
  // when it's ready, falling back to the same-origin proxy URL
  // otherwise. iOS Safari fetches the MediaSession artwork URL via
  // its own URLSession (bypassing this page's service worker), so
  // when the Beetbot host is asleep that fetch hangs and iOS gates
  // the audio session on it — even for offline-cached tracks. A
  // data: URL needs no network and unblocks the audio session.
  // Set MediaMetadata AND register all action handlers in ONE effect
  // on every track change. iOS Safari treats `ms.metadata = new
  // MediaMetadata(...)` as a session reset on some versions and can
  // silently clear previously-registered action handlers. Doing
  // metadata + handlers together — handlers AFTER metadata — gives
  // iOS a complete, fresh action set for the current track every
  // time, which is what the lock-screen Now Playing card reads to
  // decide whether to show prev/next arrows vs the default ±10s
  // skip buttons.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !track) return;
    const ms = navigator.mediaSession;
    const fallbackUrl = new URL(
      trackArtUrl(track.id, token),
      window.location.origin,
    ).toString();
    const art = currentArtworkDataUrl ?? fallbackUrl;
    // When we have the inline data URL we only need ONE size entry —
    // iOS uses whatever's there regardless of `sizes`, and shipping
    // four duplicate copies of a multi-KB base64 blob through
    // MediaMetadata is wasteful.
    const artwork = currentArtworkDataUrl
      ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }]
      : [
          // Multiple size hints so iOS / Android pick the best fit
          // (Apple TV big screen vs Now Playing card vs lock screen).
          { src: art, sizes: '640x640', type: 'image/jpeg' },
          { src: art, sizes: '512x512', type: 'image/jpeg' },
          { src: art, sizes: '256x256', type: 'image/jpeg' },
          { src: art, sizes: '96x96', type: 'image/jpeg' },
        ];
    ms.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists.join(', '),
      album: track.album ?? '',
      artwork,
    });
    ms.setActionHandler('play', () => usePlayerStore.getState().play());
    ms.setActionHandler('pause', () => usePlayerStore.getState().pause());
    ms.setActionHandler('previoustrack', () =>
      usePlayerStore.getState().prev(),
    );
    ms.setActionHandler('nexttrack', () => usePlayerStore.getState().next());
    // Intentionally do NOT register seekto / seekbackward / seekforward.
    // iOS Safari picks the lock-screen UI based on what's registered:
    //   - any seek handler present  → ±10s skip-button variant
    //   - only play/pause/prev/next → prev/next track-arrow variant
    // Empirically, even setActionHandler(seekto, null) is treated by
    // iOS as "this page declared seek capability" and flips to the
    // skip-button UI. Pre-5f65328 (when only the four track handlers
    // existed) the prev/next UI rendered correctly. Match that
    // configuration exactly.
    // Trade-off: lock-screen progress bar is read-only. Open the app
    // to scrub.
  }, [
    track?.id,
    track?.title,
    track?.album,
    track?.album_art_url,
    token,
    currentArtworkDataUrl,
  ]);

  // (3) Playback state — flips when isPlaying changes. Cheap.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // (4) Position state — DELIBERATELY DISABLED.
  //
  // iOS Safari uses setPositionState as a "this content is seekable"
  // signal — even without any seek* action handler, calling
  // setPositionState (with a real duration + position) is enough to
  // make the lock-screen Now Playing card switch from the music-app
  // prev/next layout to the podcast-style ±10s skip layout.
  //
  // Trade-off: we lose the read-only progress bar on the lock
  // screen. Tap the playing track to unlock + open the app for any
  // fine-grained seeking. For 3-4 minute songs that's the right
  // call — prev/next is what the user actually reaches for. Music
  // listeners scrub way less than podcast listeners.
  //
  // (Code is left here as a guarded no-op so the surrounding effect
  // pattern remains visible; flip the early-return off if we ever
  // decide the read-only scrubber is worth the ±10s UI.)
  useEffect(() => {
    // intentionally a no-op
  }, [track, duration, currentTime]);

  // Another device that's actively playing — show its now-playing banner with
  // remote transport controls. The two players stay independent; this is
  // awareness + control. Rendered via a portal so it shows even when this phone
  // has nothing of its own loaded. A short grace window keeps the banner up for
  // ~15s after the remote pauses, so you can resume it from here.
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
    if (remoteActive)
      void postRemoteCommand(token, remoteActive.device_id, action);
  };
  const remoteBanner =
    remoteActive && remoteActive.now_playing
      ? createPortal(
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] w-[min(92vw,26rem)]">
            <RemoteNowPlaying
              label={remoteActive.label}
              nowPlaying={remoteActive.now_playing}
              onPlayPause={() =>
                sendRemote(
                  remoteActive.now_playing!.is_playing ? 'pause' : 'play',
                )
              }
              onPrev={() => sendRemote('prev')}
              onNext={() => sendRemote('next')}
              onSync={() => void requestHandoff(token, remoteActive.device_id)}
            />
          </div>,
          document.body,
        )
      : null;

  if (!track) return remoteBanner;

  // Visual scrubbing state — set while the user is dragging the
  // slider, cleared when they release. The actual audio seek (which
  // is expensive on iOS — every commit triggers a Range request /
  // buffer flush, or a Cast control round-trip) only fires once on
  // release. Without this, dragging fires onChange 30-60 times per
  // second and each commit fights the others, producing very visible
  // lag in iOS Safari.
  const onScrubInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubbingTime(Number(e.target.value));
  };

  const onScrubCommit = () => {
    const t = scrubbingTime;
    if (t == null) return;
    setScrubbingTime(null);
    setCurrentTime(t);
    if (castActive) {
      castControl('seek', t, token).catch((err) => {
        console.warn('[beetbot] cast seek failed', err);
      });
    } else {
      const a = audioRef.current;
      if (a) a.currentTime = t;
    }
  };

  // Jump straight to a timestamp (tapping a synced lyric line).
  const seekTo = (seconds: number) => {
    setCurrentTime(seconds);
    if (castActive) {
      castControl('seek', seconds, token).catch(() => {});
    } else {
      const a = audioRef.current;
      if (a) {
        try {
          a.currentTime = seconds;
        } catch {
          /* ignore */
        }
      }
    }
  };

  // Prefer the remote album art URL when set (Spotify CDN images are big
  // enough for mobile). Fall back to the server's art redirect endpoint.
  // Prefer the same-origin /api/tracks/:id/art over the Spotify CDN
  // URL directly — the SW caches the proxy endpoint, so this works
  // offline too (and the Now Playing view doesn't look ugly with a
  // broken-image icon when the user has no network).
  const art = track.album_art_url
    ? trackArtUrl(track.id, token)
    : null;

  // A muted, desaturated wash of the album accent for the mini bar background —
  // the same recipe as the Now Playing screen's backdrop (desaturate toward
  // gray, then mute toward near-black) so the two share the same tinge, pushed a
  // touch darker so the bar still reads as a distinct surface. Falls back to
  // flat near-black when the art color is unknown.
  const miniBarBg = (() => {
    const m = barVibrant?.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!m) return 'rgb(12 12 14)';
    let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const gray = 0.3 * r + 0.5 * g + 0.2 * b;
    const DESAT = 0.42;
    r = r * (1 - DESAT) + gray * DESAT;
    g = g * (1 - DESAT) + gray * DESAT;
    b = b * (1 - DESAT) + gray * DESAT;
    const mix = (c: number, t: number, w: number) => Math.round(c * (1 - w) + t * w);
    return `rgb(${mix(r, 14, 0.7)}, ${mix(g, 14, 0.7)}, ${mix(b, 16, 0.7)})`;
  })();

  return (
    <div
      className={cn(
        'pointer-events-auto shrink-0 mx-2 mb-1 overflow-hidden backdrop-blur-xl transition-[background-color,box-shadow] duration-500',
        // Square the top when a connection banner is docked flush above, so the
        // banner (rounded top) + bar (rounded bottom) read as one card.
        flushTop ? 'rounded-b-2xl' : 'rounded-2xl',
      )}
      // A rounded, floating mini-bar card (Spotify-style) inset from the edges
      // with a small gap to the transparent nav below. Background = a muted
      // album-accent wash (see miniBarBg) matching the Now Playing screen's tint;
      // cross-fades between tracks. Safe-area inset only when it's the bottom-most
      // element (nav hidden); otherwise the nav below already reserves it.
      style={{
        paddingBottom: bottomInset ? 'env(safe-area-inset-bottom)' : 0,
        backgroundColor: miniBarBg,
        // Faint artwork-accent edge-glow + hairline ring while playing (a glow,
        // not a flood); falls back to the plain drop shadow when paused. When a
        // connection banner is docked flush on top, the crisp 4-side ring +
        // upward glow (box-shadow isn't clipped by overflow-hidden) would paint
        // a notch across the fuse seam — so drop them there and bias the glow
        // downward, letting the banner's own hairline be the only divider.
        boxShadow: !isPlaying
          ? '0 6px 24px rgba(0,0,0,0.45)'
          : flushTop
            ? '0 6px 24px rgba(0,0,0,0.45), 0 10px 22px -10px var(--color-accent)'
            : '0 6px 24px rgba(0,0,0,0.45), 0 0 0 1px color-mix(in srgb, var(--color-accent) 22%, transparent), 0 0 22px -7px var(--color-accent)',
      }}
    >
      {remoteBanner}
      <audio
        ref={audioRef}
        src={audioSrc ?? undefined}
        // `auto` (vs `metadata`) tells the browser to start streaming
        // the whole file as soon as src is set, not only the header.
        // Tapping play after a track loads is then near-instant — the
        // body bytes are already buffered. Costs slightly more upfront
        // network but on LAN that's free, and on cellular the
        // difference is the same bytes paid up-front instead of
        // immediately after the play tap, so net data usage is
        // identical for tracks the user actually listens to.
        preload="auto"
        playsInline
        onTimeUpdate={(e) => {
          // During the warmup window (right after a track loads or
          // we just rehydrated the queue from localStorage), the
          // audio element's currentTime can read 0 before our
          // resume-seek lands. Suppressing onTimeUpdate here keeps
          // the persisted currentTime from being overwritten with
          // 0; onPlaying clears warmup so normal updates resume the
          // instant the audio actually starts producing frames.
          if (audioWarmingUp) return;
          setCurrentTime(e.currentTarget.currentTime);
          if (track) {
            lastTickRef.current = {
              id: track.id,
              ms: e.currentTarget.currentTime * 1000,
              durMs: track.duration_ms,
            };
          }
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          // A live-transcoded (un-downloaded) track streams as length-less ADTS,
          // so the element reports `Infinity` here. Store 0 in that case so the
          // scrubber/length displays fall back to the known catalog duration
          // (track.duration_ms) instead of showing Infinity/0:00.
          setDuration(Number.isFinite(a.duration) ? a.duration : 0);
          // If we rehydrated a non-zero currentTime from
          // localStorage (or returned to the app after closing it
          // mid-song), seek the audio element to that position
          // now that we have its full metadata. Skip when the
          // stored time is near 0 — that means we're starting a
          // fresh track and the default of 0 is right.
          const t = usePlayerStore.getState().currentTime;
          if (t > 1 && Number.isFinite(a.duration) && t < a.duration - 1) {
            try {
              a.currentTime = t;
            } catch {
              /* safari sometimes throws on early seek — onTimeUpdate
                 mirror will catch it the next time the user plays */
            }
          }
        }}
        onEnded={() => {
          // Natural end = completed: snap the tick to full length so the
          // track-change report below records this as a finished play.
          if (track) {
            lastTickRef.current = {
              id: track.id,
              ms: track.duration_ms,
              durMs: track.duration_ms,
            };
          }
          handleTrackEnded();
        }}
        // Treat the element as the source of truth for play/pause state.
        // Without these handlers there's a desync window after a lock-
        // screen pause-then-play sequence: iOS may silently keep the
        // element paused (audio session got reclaimed during the lock)
        // even though MediaSession's 'play' handler ran, store flipped
        // to isPlaying=true, and the lock-screen timer keeps animating.
        // Listening to the native events here means the store always
        // reflects what the audio is *actually* doing.
        onPlay={() => {
          usePlayerStore.setState({ isPlaying: true });
          // Stop any preview clip so the two audio sources don't overlap.
          audioStarted('main');
        }}
        onPause={() => usePlayerStore.setState({ isPlaying: false })}
        // The native `playing` event fires when the audio element has
        // started outputting frames after a buffer / src change. We use
        // it to lift the post-track-change scrubber freeze (see
        // audioWarmingUp). `play` fires earlier (when play() is called)
        // and isn't enough — iOS may still be waiting on AirPlay buffer.
        onPlaying={() => {
          // Audio is flowing again — reset the stream-retry + gone-skip counters
          // so a future hiccup gets a fresh set of retries.
          retryRef.current.count = 0;
          goneRef.current = 0;
          setAudioWarmingUp(false);
          // Use the deferred helper so the spinner stays up for at
          // least the minimum visible window even when buffering is
          // effectively instant (e.g. local Wi-Fi, cached audio).
          lowerBuffering();
        }}
        // `waiting` fires when the audio runs out of buffered data
        // mid-playback (network stall, slow-loading track). Show the
        // play-button spinner so the user sees "loading" instead of
        // wondering why their music just stopped. `playing` clears it
        // again when frames resume.
        onWaiting={() => {
          if (usePlayerStore.getState().isPlaying) {
            raiseBuffering();
          }
        }}
        onError={(e) => {
          const err = e.currentTarget.error;
          // MEDIA_ERR_ABORTED routinely fires when we swap src mid-load
          // (track changes, blob URL revocations); it isn't a user-visible
          // problem -- the next src load will recover.
          if (err && err.code === MediaError.MEDIA_ERR_ABORTED) {
            console.debug('[beetbot] audio aborted (expected during swap)');
            return;
          }
          const failedSrc = e.currentTarget.currentSrc;
          const isStreamError =
            err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
            err?.code === MediaError.MEDIA_ERR_NETWORK;
          // The phone streams audio live from the desktop. A dropped/empty
          // stream — the desktop restarting, or resuming from a stale URL after
          // backgrounding — surfaces as "format not supported". Probe the URL: a
          // 401 means the session died (→ re-pair); anything else is a broken or
          // restarting stream we retry, reusing onLoadedMetadata to resume from
          // the saved position. Capped + backed off so a genuinely-bad track
          // still surfaces an error.
          if (failedSrc && isStreamError) {
            const STREAM_RETRY_MAX = 4;
            const r = retryRef.current;
            const scheduleRetry = () => {
              if (r.count >= STREAM_RETRY_MAX) {
                setErrorMsg('Couldn’t reach the stream — tap play to try again.');
                usePlayerStore.setState({ isPlaying: false });
                return;
              }
              r.count += 1;
              raiseBuffering();
              window.clearTimeout(r.timer);
              r.timer = window.setTimeout(() => {
                setErrorMsg(null);
                setReloadNonce((n) => n + 1);
                usePlayerStore.setState({ isPlaying: true });
              }, Math.min(700 * r.count, 4000));
            };
            void fetch(failedSrc, {
              method: 'GET',
              cache: 'no-store',
              headers: { Range: 'bytes=0-0' },
            })
              .then((res) => {
                if (res.status === 401) {
                  notifyUnauthorized();
                } else if (res.status === 404) {
                  // The track no longer exists (a stale queue after a library
                  // change, or a pruned discovery row). Retrying a ghost is
                  // futile — quietly skip to the next playable track. Capped by
                  // queue length so an entirely-dead queue skips through once
                  // and stops with a message instead of looping forever.
                  const store = usePlayerStore.getState();
                  const cap = Math.max(store.queue.length, 1);
                  goneRef.current += 1;
                  retryRef.current.count = 0;
                  if (goneRef.current > cap) {
                    goneRef.current = 0;
                    setErrorMsg(
                      'These tracks are no longer available — try a fresh playlist or station.',
                    );
                    usePlayerStore.setState({ isPlaying: false });
                    return;
                  }
                  setErrorMsg(null);
                  store.next();
                } else {
                  scheduleRetry();
                }
              })
              .catch(() => scheduleRetry());
            return;
          }
          const msg = describeAudioError(err);
          setErrorMsg(msg);
          console.error('[beetbot] audio error', err, msg);
          usePlayerStore.setState({ isPlaying: false });
        }}
      />
      {/* Throwaway crossfade element: plays only the OUTGOING track's tail
          during a fade (routed through Web Audio gain). No handlers — it
          never drives the store, MediaSession, or AirPlay. */}
      <audio ref={fadeRef} preload="auto" playsInline />
      {errorMsg ? (
        <div className={cn(CALLOUT_ERROR, 'mx-4 mt-3 text-xs break-words')}>
          {errorMsg}
        </div>
      ) : null}

      {/* Single-row mini bar (Spotify-style): art + title/artist + play, with a
          thin progress line at the bottom edge. Tap to open Now Playing (full
          scrubber + shuffle/repeat live there); swipe to skip. */}
      <div className="px-3 py-2.5 flex items-center gap-3">
        <button
          type="button"
          {...miniSwipe.handlers}
          onClick={() => {
            // A horizontal swipe just skipped a track — swallow the tap so it
            // doesn't also expand Now Playing.
            if (miniSwipe.swiped.current) {
              miniSwipe.swiped.current = false;
              return;
            }
            setExpanded(true);
          }}
          aria-label="Open Now Playing"
          className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:opacity-80"
        >
          <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800">
            {art ? (
              <img
                src={art}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : null}
          </div>
          <div className="group flex-1 min-w-0">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <Marquee text={track.title} className="min-w-0 flex-1" />
              {sourceMode === 'offline' && (
                <span
                  className="text-[10px] px-1 py-px rounded bg-white/10 text-neutral-300 font-normal shrink-0"
                  title="Playing from offline cache"
                >
                  offline
                </span>
              )}
            </div>
            <div className="text-xs text-neutral-400 truncate">
              {track.artists.join(', ')}
            </div>
          </div>
        </button>
        <button
          type="button"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          // Gate only "start from paused": a non-downloaded track can't begin
          // its /live stream while the hub is unreachable. Pause stays allowed.
          disabled={!isPlaying && !canPlayCurrent}
          onClick={!isPlaying && !canPlayCurrent ? undefined : handlePlayPause}
          className={cn(
            'h-11 w-11 shrink-0 grid place-items-center text-white active:scale-90 transition',
            !isPlaying && !canPlayCurrent && 'opacity-50 pointer-events-none',
          )}
        >
          {isPlaying && audioBuffering ? (
            <Spinner size={24} />
          ) : isPlaying ? (
            <PauseIcon size={28} />
          ) : (
            <PlayIcon size={28} />
          )}
        </button>
      </div>
      <div className="mx-3 mb-2 h-[3px] rounded-full bg-white/15 overflow-hidden">
        <div
          className="h-full bg-white/85"
          style={{
            // Tint the mini-bar progress while playing (white when paused).
            ...(isPlaying
              ? {
                  backgroundColor:
                    'color-mix(in srgb, var(--color-accent) 80%, white)',
                }
              : {}),
            width: (() => {
              const v =
                scrubbingTime ??
                airPlayPickingFromTime ??
                (airPlayActive && audioWarmingUp ? 0 : currentTime);
              const mx = duration || track.duration_ms / 1000;
              const pct = mx > 0 ? Math.max(0, Math.min(100, (v / mx) * 100)) : 0;
              return `${pct}%`;
            })(),
          }}
        />
      </div>

      {expanded && (
        <NowPlayingOverlay
          art={art}
          title={track.title}
          artists={track.artists}
          album={track.album ?? null}
          sourceMode={sourceMode}
          currentTime={
            scrubbingTime ??
            airPlayPickingFromTime ??
            (airPlayActive && audioWarmingUp ? 0 : currentTime)
          }
          duration={duration || track.duration_ms / 1000}
          isPlaying={isPlaying}
          canPlayCurrent={canPlayCurrent}
          buffering={audioBuffering}
          onScrubInput={onScrubInput}
          onScrubCommit={onScrubCommit}
          onPlayPause={handlePlayPause}
          onPrev={prev}
          onNext={next}
          onClose={() => setExpanded(false)}
          airPlayActive={airPlayActive}
          castActive={castActive}
          onOpenConnect={() => setConnectOpen(true)}
          lyrics={lyrics}
          lyricsLoading={lyricsLoading}
          onSeekTo={seekTo}
          liked={trackLiked}
          onToggleLike={toggleLike}
          onDoubleTapArt={likeFromArt}
          onAddToPlaylist={() => setAddToPlaylistOpen(true)}
          modalAbove={addToPlaylistOpen}
        />
      )}
      {addToPlaylistOpen &&
        track &&
        /* Portal to <body> so the modal (z-50) layers above the Now Playing
           overlay's own body portal (z-40). Rendered inline it would paint
           inside the Player subtree, i.e. *behind* that root-level overlay. */
        createPortal(
          <AddToPlaylistModal
            token={token}
            activeProfileId={profileId}
            track={streamToSearchResult(track)}
            onClose={() => setAddToPlaylistOpen(false)}
          />,
          document.body,
        )}
      {connectOpen && (
        <ConnectSheet
          airPlayAvailable={airPlayAvailable}
          airPlayActive={airPlayActive}
          onOpenAirPlay={() => {
            setConnectOpen(false);
            openAirPlayPicker();
          }}
          castDevices={castDevices}
          castActive={castActive}
          castError={castError}
          onStartCast={handleStartCast}
          onStopCast={handleStopCast}
          handoffDevices={handoffDevices}
          onHandoff={(d) => {
            setConnectOpen(false);
            handleHandoff(d);
          }}
          onClose={() => {
            setConnectOpen(false);
            setCastError(null);
          }}
        />
      )}
    </div>
  );
}

interface NowPlayingOverlayProps {
  art: string | null;
  title: string;
  artists: string[];
  album: string | null;
  sourceMode: 'streaming' | 'offline';
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  /** Whether the current track can START playing right now (downloaded, or a
   *  live-streamable track while the hub is reachable). Gates the play button
   *  from paused so a non-downloaded track can't try to start with the hub down. */
  canPlayCurrent: boolean;
  /** True between "user tapped play" and "audio started outputting frames". */
  buffering: boolean;
  /** Fired continuously while the user is dragging — visual-only updates. */
  onScrubInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Fired once on release (pointer up / touch end / keyboard up). Commits the seek. */
  onScrubCommit: () => void;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  airPlayActive: boolean;
  castActive: { id: string; name: string } | null;
  /** Open the unified "Connect" output sheet (AirPlay + Cast + hand-off),
   *  handled by the parent Player. The bottom device chip shows current output. */
  onOpenConnect: () => void;
  lyrics: Lyrics | null;
  lyricsLoading: boolean;
  onSeekTo: (seconds: number) => void;
  liked: boolean;
  onToggleLike: () => void;
  onDoubleTapArt: () => void;
  /** Open the "Add to playlist" modal for the current track (handled by the
   *  parent Player so the modal layers above this overlay). */
  onAddToPlaylist: () => void;
  /** True when a Player-level modal (Add to playlist) is open above the
   *  overlay — suppresses the overlay's own Escape-to-close so Escape only
   *  dismisses the topmost layer. */
  modalAbove: boolean;
}

/**
 * Full-screen "Now Playing" view in the Spotify mobile style.
 *
 * Rendered as a fixed overlay so it floats above the entire app shell
 * (including the persistent <Player> bar at the root). All transport
 * actions delegate back to the player store via the callbacks passed in,
 * so the audio element and queue state stay live underneath.
 *
 * Safe-area insets are applied here because this overlay sits outside the
 * <main> element where the rest of the app's safe-area handling lives.
 */
function NowPlayingOverlay({
  art,
  title,
  artists,
  album,
  sourceMode,
  currentTime,
  duration,
  isPlaying,
  canPlayCurrent,
  buffering,
  onScrubInput,
  onScrubCommit,
  onPlayPause,
  onPrev,
  onNext,
  onClose,
  airPlayActive,
  castActive,
  onOpenConnect,
  lyrics,
  lyricsLoading,
  onSeekTo,
  liked,
  onToggleLike,
  onDoubleTapArt,
  onAddToPlaylist,
  modalAbove,
}: NowPlayingOverlayProps) {
  // Toggle the album art for a karaoke-style synced lyrics view.
  const [showLyrics, setShowLyrics] = useState(false);
  // B3: swap the art for an editable "Up next" queue. Mutually exclusive with
  // the lyrics view.
  const [showQueue, setShowQueue] = useState(false);
  // Overflow "..." menu: add to playlist / go to artist / go to album / share.
  const [menuOpen, setMenuOpen] = useState(false);
  const openArtistNav = useCatalogNav((s) => s.openArtist);
  const openAlbumNav = useCatalogNav((s) => s.openAlbum);
  const primaryArtist = artists[0] ?? null;
  // Sleep-timer state read straight from the store (this overlay lives in the
  // same module as the player, so no prop threading needed).
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);

  const reduceMotion = usePrefersReducedMotion();
  // A1 slide-up enter + A2 swipe-down-to-dismiss. `entered` drives the mount
  // slide (false→true on the first frame); `dragY` follows a downward drag on
  // the header grabber; `dragging` disables the spring transition so the sheet
  // tracks the finger 1:1.
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragYRef = useRef(0);
  const dismissStart = useRef<{ x: number; y: number } | null>(null);
  const dismissAxis = useRef<'none' | 'v' | 'h'>('none');
  // Per-gesture flag: true when this touch must NOT drive the swipe-to-dismiss
  // — either it began on an interactive control (buttons, scrubber, links) or
  // inside a scroll region that isn't at the top (so a downward drag scrolls
  // that region instead of dismissing, matching Apple Music).
  const dismissDisabled = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  // A3: swipe the album art left/right to skip (taps still double-tap-to-like).
  const artSwipe = useSwipeNav(onNext, onPrev);
  // B1: a subtle color-from-artwork wash behind the top of the sheet.
  const accent = useArtworkColor(art);
  // Apple-Music-style full-bleed gradient sampled from the artwork: a muted,
  // slightly-vignetted wash of the cover's dominant color so white text/controls
  // stay legible over any album. Falls back to the flat dark bg when unknown.
  const bgGradient = (() => {
    const m = accent?.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!m) return null;
    let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Desaturate toward gray for a soft, Apple-like pastel wash rather than a
    // vivid block of the cover color.
    const gray = 0.3 * r + 0.5 * g + 0.2 * b;
    const DESAT = 0.42;
    r = r * (1 - DESAT) + gray * DESAT;
    g = g * (1 - DESAT) + gray * DESAT;
    b = b * (1 - DESAT) + gray * DESAT;
    const mix = (c: number, t: number, w: number) => Math.round(c * (1 - w) + t * w);
    // Muted mid-tone; darker at the very top/bottom (subtle vignette).
    const mid = `rgb(${mix(r, 44, 0.32)}, ${mix(g, 44, 0.32)}, ${mix(b, 48, 0.32)})`;
    const edge = `rgb(${mix(r, 24, 0.58)}, ${mix(g, 24, 0.58)}, ${mix(b, 26, 0.58)})`;
    return `linear-gradient(to bottom, ${edge} 0%, ${mid} 22%, ${mid} 72%, ${edge} 100%)`;
  })();
  // Elapsed fraction for the Apple-style scrubber fill (bright fill left, faint
  // track right).
  const scrubPct =
    duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0;

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Close with a slide-down, then unmount once it finishes. Under Reduce
  // Motion, skip the animation and close immediately.
  const requestClose = useCallback(() => {
    if (reduceMotion) {
      onClose();
      return;
    }
    // Already sliding out — ignore repeat triggers (e.g. swipe-dismiss then
    // Escape) so we don't restart the countdown or queue a second onClose.
    if (closeTimerRef.current != null) return;
    setDragging(false);
    setEntered(false);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 280);
  }, [onClose, reduceMotion]);

  // Cancel a pending slide-out if the overlay unmounts for an external reason
  // (e.g. the track clears mid-dismiss) so onClose never fires post-unmount.
  useEffect(
    () => () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Swipe-down-to-dismiss — wired to the whole sheet so you can pull it down
  // from anywhere that isn't a control (Apple Music-style). It never competes
  // with scrolling because a downward drag only dismisses when the touch began
  // outside any scrolled-down region (see startsInScrolledRegion). Axis-locked:
  // only a downward vertical drag pulls the sheet; release past the threshold
  // dismisses, otherwise it springs back.
  const startsInScrolledRegion = (target: HTMLElement | null): boolean => {
    let el: HTMLElement | null = target;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollTop > 0) return true;
      }
      el = el.parentElement;
    }
    return false;
  };
  const onDismissTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    // Don't hijack drags that begin on a control (play/skip/star/⋯, the
    // scrubber, toolbar toggles, links) or inside a scroll region that's
    // scrolled away from the top — those keep their native behavior.
    dismissDisabled.current =
      !!target?.closest(
        'button, input, a, [role="button"], [role="slider"], [data-no-dismiss]',
      ) || startsInScrolledRegion(target);
    const t = e.touches[0];
    dismissStart.current = { x: t.clientX, y: t.clientY };
    dismissAxis.current = 'none';
  };
  const onDismissTouchMove = (e: React.TouchEvent) => {
    if (dismissDisabled.current) return;
    const s = dismissStart.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (dismissAxis.current === 'none' && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      dismissAxis.current = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    }
    if (dismissAxis.current === 'v' && dy > 0) {
      dragYRef.current = dy;
      if (!dragging) setDragging(true);
      setDragY(dy);
    }
  };
  const onDismissTouchEnd = () => {
    dismissStart.current = null;
    dismissAxis.current = 'none';
    const y = dragYRef.current;
    dragYRef.current = 0;
    setDragging(false);
    if (y > 120) {
      requestClose();
    } else {
      setDragY(0);
    }
  };

  // Lock background scroll while the overlay is up so dragging the
  // scrubber doesn't accidentally scroll the playlist beneath it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Allow Escape to close, in addition to the chevron-down. Useful on
  // desktop browsers where the overlay is otherwise modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost layer handles Escape: when a sub-sheet (overflow
      // menu / handoff picker) or the add-to-playlist modal is open, let it
      // close itself instead of collapsing the whole overlay.
      if (e.key !== 'Escape') return;
      // Sub-sheets (overflow menu, add-to-playlist, the Player-level Connect
      // sheet) handle their own Escape and stop propagation, so the overlay
      // only needs to bail for the ones whose state it can see here.
      if (menuOpen || modalAbove) return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, menuOpen, modalAbove]);

  // Render through a portal so the overlay escapes the Player bar's
  // backdrop-filter ancestor -- elements with backdrop-filter create a
  // containing block for `position: fixed` descendants, which clips this
  // overlay to the bar's height instead of letting it cover the viewport.
  return createPortal(
    <div
      className={`fixed inset-0 z-40 flex flex-col overflow-hidden bg-neutral-950 text-neutral-100 ${
        dragging || reduceMotion
          ? ''
          : 'transition-[transform,border-radius] duration-300'
      }`}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        transform:
          entered || reduceMotion ? `translateY(${dragY}px)` : 'translateY(100%)',
        // Corners round as the sheet is pulled down, revealing the app behind
        // it at the top — the Apple Music drag-to-dismiss feel.
        borderRadius: dragY > 0 ? Math.min(28, dragY * 0.6) : 0,
      }}
      onTouchStart={onDismissTouchStart}
      onTouchMove={onDismissTouchMove}
      onTouchEnd={onDismissTouchEnd}
      onTouchCancel={onDismissTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
    >
      {/* B1: full-bleed artwork-color gradient (Apple Music-style). Fills the
          whole sheet with a muted wash of the cover's dominant color; the flat
          dark bg shows only when the artwork color is unknown. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 -z-10 ${
          reduceMotion ? '' : 'transition-opacity duration-500'
        }`}
        style={{
          background: bgGradient ?? 'none',
          opacity: bgGradient ? 1 : 0,
        }}
      />
      {/* Grab handle — a visual affordance. The whole sheet is draggable
          (handlers live on the root), so no touch wiring is needed here. */}
      <div
        className="shrink-0 pt-2 pb-1 flex justify-center"
        aria-hidden
      >
        <div className="h-1 w-9 rounded-full bg-white/40" />
      </div>
      {/* Header: just the source ("Playing from …"), centered. Swipe anywhere
          on the sheet (below) to dismiss — matching Apple, no redundant close
          chevron. Sleep timer lives in the ⋯ menu now. */}
      <div className="px-4 py-3 shrink-0 text-center">
        <div className={EYEBROW_ON_ART}>
          Playing from
        </div>
        <div className="text-xs font-medium truncate text-white/90">
          {album ?? 'Library'}
        </div>
      </div>

      {/* Album art + metadata + transport */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 flex flex-col">
        <div className="flex-1 min-h-0 flex items-center justify-center py-4">
          {showQueue ? (
            <div className="w-full max-w-md h-full min-h-0">
              <QueueView />
            </div>
          ) : showLyrics ? (
            <div className="w-full max-w-md h-full min-h-0">
              <LyricsView
                lyrics={lyrics}
                currentTime={currentTime}
                loading={lyricsLoading}
                onSeekTo={onSeekTo}
              />
            </div>
          ) : (
            <div
              className="w-[76%] max-w-sm mx-auto aspect-square rounded-2xl overflow-hidden bg-neutral-900 ring-1 ring-white/15 shadow-2xl shadow-black/60 select-none transition-transform duration-500"
              style={{ transform: `scale(${isPlaying ? 1 : 0.94})` }}
              onDoubleClick={onDoubleTapArt}
              {...artSwipe.handlers}
              title="Double-tap to like · swipe to change track"
            >
              {art ? (
                <img
                  src={art}
                  alt=""
                  // transition-transform glides the scale back to rest on
                  // pause (the keyframe animation overrides it while playing,
                  // so it only acts on the playing→paused edge).
                  className={`h-full w-full object-cover transition-transform duration-700 ${
                    isPlaying ? 'animate-[beetbot-breathe_7s_ease-in-out_infinite]' : ''
                  }`}
                  draggable={false}
                />
              ) : (
                <div className="h-full w-full grid place-items-center text-6xl text-neutral-700">
                  ♪
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-2 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-bold tracking-tight leading-tight truncate flex items-center gap-2">
              {album ? (
                // Tap the song title → open the album it came from.
                <button
                  type="button"
                  onClick={() => {
                    openAlbumNav(album, primaryArtist);
                    onClose();
                  }}
                  className="truncate text-left hover:underline active:opacity-80"
                  title={`Go to album · ${album}`}
                >
                  {title}
                </button>
              ) : (
                <span className="truncate">{title}</span>
              )}
              {sourceMode === 'offline' && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-neutral-300 font-normal shrink-0"
                  title="Playing from offline cache"
                >
                  offline
                </span>
              )}
            </h2>
            {primaryArtist ? (
              // Tap the artist name → open the artist's page.
              <button
                type="button"
                onClick={() => {
                  openArtistNav(primaryArtist);
                  onClose();
                }}
                className="block max-w-full truncate text-left text-sm text-white/70 hover:text-white hover:underline active:opacity-80 mt-1"
                title={`Go to artist · ${primaryArtist}`}
              >
                {artists.join(', ')}
              </button>
            ) : (
              <div className="text-sm text-white/70 truncate mt-1">
                {artists.join(', ')}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <LikeButton
              liked={liked}
              onToggle={onToggleLike}
              size={22}
              className="h-10 w-10 rounded-full bg-white/15 hover:bg-white/25 active:scale-95 shrink-0"
            />
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="More options"
              title="More"
              className="h-10 w-10 grid place-items-center rounded-full bg-white/15 text-white hover:bg-white/25 active:scale-95"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.9" />
                <circle cx="12" cy="12" r="1.9" />
                <circle cx="19" cy="12" r="1.9" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrubber */}
        <div className="mt-6">
          <input
            type="range"
            min={0}
            max={Math.max(0, duration)}
            step="0.1"
            value={Math.min(currentTime, duration)}
            onChange={onScrubInput}
            onMouseUp={onScrubCommit}
            onTouchEnd={onScrubCommit}
            onKeyUp={onScrubCommit}
            aria-label="Seek"
            className="w-full h-1.5 appearance-none rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:shadow-black/25 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0"
            style={{
              // Progress fill takes the artwork accent while playing (white
              // remains the paused default) — the tint-through-line swing.
              background: `linear-gradient(to right, ${
                isPlaying
                  ? 'color-mix(in srgb, var(--color-accent) 88%, white)'
                  : 'rgba(255,255,255,0.95)'
              } ${scrubPct}%, rgba(255,255,255,0.26) ${scrubPct}%)`,
            }}
          />
          <div className="flex items-center justify-between text-[11px] text-white/60 tabular-nums mt-1">
            <span>{formatDuration(currentTime * 1000)}</span>
            <span>
              -{formatDuration(Math.max(0, duration - currentTime) * 1000)}
            </span>
          </div>
        </div>

        {/* Main transport (Apple Music-style): prev · play/pause · next.
            Shuffle/Repeat/Autoplay live with the queue; Lyrics/Connect/Queue
            live in the bottom toolbar. */}
        <div className="mt-6 flex items-center justify-center gap-10">
          <button
            type="button"
            onClick={onPrev}
            aria-label="Previous"
            className="h-14 w-14 grid place-items-center text-white hover:text-white active:scale-90 transition"
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M11.5 6 11.5 18 3.5 12z" />
              <path d="M20.5 6 20.5 18 12.5 12z" />
            </svg>
          </button>
          <button
            type="button"
            // Gate only "start from paused": a non-downloaded track can't begin
            // its /live stream while the hub is unreachable. Pause stays allowed.
            disabled={!isPlaying && !canPlayCurrent}
            onClick={!isPlaying && !canPlayCurrent ? undefined : onPlayPause}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className={cn(
              'h-16 w-16 grid place-items-center text-white active:scale-90 transition',
              !isPlaying && !canPlayCurrent && 'opacity-50 pointer-events-none',
            )}
          >
            {isPlaying && buffering ? (
              <Spinner size={34} />
            ) : isPlaying ? (
              <PauseIcon size={48} />
            ) : (
              <PlayIcon size={48} />
            )}
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Next"
            className="h-14 w-14 grid place-items-center text-white hover:text-white active:scale-90 transition"
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M3.5 6 3.5 18 11.5 12z" />
              <path d="M12.5 6 12.5 18 20.5 12z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Bottom toolbar (Apple Music-style): Lyrics · Connect · Queue. Sits
          OUTSIDE the scroll area so it never scrolls away. */}
      <div className="shrink-0 px-6 pb-5 pt-2 flex items-center justify-around gap-2">
        <button
          type="button"
          onClick={() => {
            setShowLyrics((v) => !v);
            setShowQueue(false);
          }}
          aria-label="Lyrics"
          aria-pressed={showLyrics}
          title="Lyrics"
          className={cn(
            'h-11 w-11 grid place-items-center rounded-full active:bg-white/20',
            showLyrics
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z" />
            <path d="M7.066 4.76A1.665 1.665 0 0 0 4 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112zm4 0A1.665 1.665 0 0 0 8 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onOpenConnect}
          aria-label="Connect to a device"
          title={castActive ? castActive.name : airPlayActive ? 'AirPlay' : 'Connect'}
          className={cn(
            'h-11 w-11 grid place-items-center rounded-full active:bg-white/20',
            castActive || airPlayActive
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 18H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
            <path d="M12 15l4.5 5.5h-9z" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            setShowQueue((v) => !v);
            setShowLyrics(false);
          }}
          aria-label="Queue"
          aria-pressed={showQueue}
          title="Queue"
          className={cn(
            'h-11 w-11 grid place-items-center rounded-full active:bg-white/20',
            showQueue
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 6h12M8 12h12M8 18h12" />
            <circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {menuOpen && (
        <TrackActionSheet
          onClose={() => setMenuOpen(false)}
          quick={[
            {
              key: 'favorite',
              label: liked ? 'Favorited' : 'Favorite',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
                </svg>
              ),
              onClick: () => onToggleLike(),
            },
            {
              key: 'add',
              label: 'Add',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 7h10M4 12h6M4 17h6" />
                  <path d="M16 14v7M12.5 17.5h7" />
                </svg>
              ),
              onClick: () => onAddToPlaylist(),
            },
          ]}
          items={[
            ...(primaryArtist
              ? [
                  {
                    key: 'artist',
                    label: 'Go to Artist',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="8" r="4" />
                        <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
                      </svg>
                    ),
                    onClick: () => {
                      if (primaryArtist) openArtistNav(primaryArtist);
                      onClose();
                    },
                  },
                ]
              : []),
            ...(album
              ? [
                  {
                    key: 'album',
                    label: 'Go to Album',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="2.4" />
                      </svg>
                    ),
                    onClick: () => {
                      if (album) openAlbumNav(album, primaryArtist);
                      onClose();
                    },
                  },
                ]
              : []),
          ]}
          sleep={{
            active: sleepTimerEndsAt != null || sleepAtTrackEnd,
            onPick: (opt) => setSleepTimer(opt),
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/** Unified "Connect" output sheet (Spotify-style): one place to pick where
 *  playback goes — this device, AirPlay, a Chromecast, or hand the queue to
 *  another Beetbot device. Opened from the Now Playing device chip. Escape is
 *  registered on the capture phase + stops propagation, so it closes before the
 *  Now Playing overlay underneath sees the key. */
function ConnectSheet({
  airPlayAvailable,
  airPlayActive,
  onOpenAirPlay,
  castDevices,
  castActive,
  castError,
  onStartCast,
  onStopCast,
  handoffDevices,
  onHandoff,
  onClose,
}: {
  airPlayAvailable: boolean;
  airPlayActive: boolean;
  onOpenAirPlay: () => void;
  castDevices: CastDevice[];
  castActive: { id: string; name: string } | null;
  castError: string | null;
  onStartCast: (d: CastDevice) => void;
  onStopCast: () => void;
  handoffDevices: RemoteDevice[];
  onHandoff: (d: RemoteDevice) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const localActive = !castActive && !airPlayActive;
  // Cast wins the "active output" display (mirrors the chip), so AirPlay's
  // highlight is suppressed while casting — they can both be true on iOS.
  const airPlayShownActive = airPlayActive && !castActive;
  const nothingElse =
    !airPlayAvailable && castDevices.length === 0 && handoffDevices.length === 0;
  const rowBase =
    'w-full flex items-center gap-3 py-2.5 px-3 rounded-lg active:bg-white/10 text-left text-[15px]';
  const iconWrap = 'h-9 w-9 shrink-0 grid place-items-center rounded-full bg-white/10 text-white';
  const check = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-white shrink-0">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Connect to a device"
    >
      <button
        type="button"
        aria-label="Close"
        className={SCRIM}
        onClick={onClose}
      />
      <div className="relative mx-3 mb-3 rounded-2xl border border-white/10 bg-neutral-950/90 backdrop-blur-xl shadow-2xl shadow-black/50 px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] max-h-[70vh] overflow-y-auto text-white">
        <div className="mx-auto mb-1.5 h-1 w-9 rounded-full bg-white/40" />
        <h3 className="px-3 mb-1 text-sm font-semibold text-white/90">
          Connect to a device
        </h3>
        <ul className="flex flex-col">
          {/* This device (local playback). While casting, tapping it stops the
              cast and brings playback back here. */}
          <li>
            <button
              type="button"
              disabled={localActive || !castActive}
              onClick={() => {
                if (castActive) onStopCast();
              }}
              className={`${rowBase} ${localActive ? 'bg-white/10' : ''}`}
            >
              <span className={iconWrap}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
                  <rect x="2.5" y="14" width="4.5" height="6.5" rx="1.6" />
                  <rect x="17" y="14" width="4.5" height="6.5" rx="1.6" />
                </svg>
              </span>
              <span className="flex-1 min-w-0 truncate">This device</span>
              {localActive ? (
                check
              ) : castActive ? (
                <span className="text-xs text-white/45 shrink-0">Play here</span>
              ) : null}
            </button>
          </li>
          {/* AirPlay — opens the iOS native route picker */}
          {airPlayAvailable && (
            <li>
              <button type="button" onClick={onOpenAirPlay} className={`${rowBase} ${airPlayShownActive ? 'bg-white/10' : ''}`}>
                <span className={iconWrap}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 17V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11" />
                    <path d="m7 20 5-6 5 6Z" fill="currentColor" />
                  </svg>
                </span>
                <span className="flex-1 min-w-0 truncate">AirPlay</span>
                {airPlayShownActive && check}
              </button>
            </li>
          )}
          {/* Chromecast targets */}
          {castDevices.map((d) => {
            const active = castActive?.id === d.id;
            return (
              <li key={`cast-${d.id}`}>
                <button
                  type="button"
                  onClick={() => (active ? onStopCast() : onStartCast(d))}
                  className={`${rowBase} ${active ? 'bg-white/10' : ''}`}
                >
                  <span className={iconWrap}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.37 7.07 10 1 10zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                    </svg>
                  </span>
                  <span className="flex-1 min-w-0 truncate">{d.friendly_name}</span>
                  {active && check}
                </button>
              </li>
            );
          })}
          {/* Other Beetbot devices — hand the queue over ("Play on Computer") */}
          {handoffDevices.map((d) => (
            <li key={`ho-${d.device_id}`}>
              <button type="button" onClick={() => onHandoff(d)} className={rowBase}>
                <span className={iconWrap}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="4" width="18" height="12" rx="2" />
                    <path d="M8 20h8M12 16v4" />
                  </svg>
                </span>
                <span className="flex-1 min-w-0 truncate">{d.label}</span>
                {d.now_playing?.is_playing && (
                  <span className="text-xs text-white/45 shrink-0">playing</span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {castError && (
          <p className="px-3 mt-2 text-xs text-red-300 break-words">{castError}</p>
        )}
        {nothingElse && (
          <p className="px-3 py-3 text-sm text-white/45">
            No other devices found nearby.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** B3: editable "Up next" — the current track plus the queue tail, with
 *  tap-to-jump, play-next, remove, drag-reorder, and a clear-all. Reads the
 *  player store directly. */
const QUEUE_ROW_H = 56; // px; fixed so the drag math is exact.

function QueueView() {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const removeAt = usePlayerStore((s) => s.removeAt);
  const jumpTo = usePlayerStore((s) => s.jumpTo);
  const moveItem = usePlayerStore((s) => s.moveItem);
  const playNext = usePlayerStore((s) => s.playNext);
  const clearUpcoming = usePlayerStore((s) => s.clearUpcoming);
  // Queue-level playback modes surfaced as pills above the up-next list
  // (Apple Music places these controls with the queue, not the transport).
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  const setAutoplay = usePlayerStore((s) => s.setAutoplay);
  // Active drag: the absolute queue index grabbed + the pointer's start/current
  // Y. Drag is started from the grip handle only, so it never competes with
  // tap-to-jump or list scrolling.
  const [drag, setDrag] = useState<{ from: number; startY: number; y: number } | null>(
    null,
  );
  // Abort an in-progress drag if playback advances under it — `drag.from` is an
  // absolute index captured at drag-start, so a currentIndex change would make
  // it point at a different track and reorder the wrong one.
  useEffect(() => {
    setDrag(null);
  }, [currentIndex]);
  const rows = queue
    .map((t, i) => ({ t, i }))
    .filter(({ i }) => i >= currentIndex);

  // Where the dragged row would drop, clamped to the upcoming range.
  const target =
    drag != null
      ? Math.max(
          currentIndex + 1,
          Math.min(
            queue.length - 1,
            drag.from + Math.round((drag.y - drag.startY) / QUEUE_ROW_H),
          ),
        )
      : -1;

  // Translate a non-dragged upcoming row to open a gap at the drop target.
  const rowShift = (i: number): number => {
    if (drag == null) return 0;
    if (target > drag.from && i > drag.from && i <= target) return -QUEUE_ROW_H;
    if (target < drag.from && i < drag.from && i >= target) return QUEUE_ROW_H;
    return 0;
  };

  const endDrag = (commit: boolean) => {
    if (drag != null && commit && target !== drag.from) {
      moveItem(drag.from, target);
    }
    setDrag(null);
  };

  return (
    <div className="w-full max-w-md h-full min-h-0 overflow-y-auto select-none">
      {/* Playback-mode pills (Apple Music-style): Shuffle · Repeat · Autoplay. */}
      <div className="px-1 mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggleShuffle()}
          aria-pressed={shuffle}
          aria-label="Shuffle"
          title="Shuffle"
          className={cn(
            'flex-1 h-11 grid place-items-center rounded-full active:scale-95',
            shuffle
              ? 'text-accent'
              : 'bg-white/10 text-white/60 active:text-white',
          )}
          style={
            shuffle
              ? {
                  backgroundColor:
                    'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                }
              : undefined
          }
        >
          <ShuffleIcon size={19} />
        </button>
        <button
          type="button"
          onClick={() => toggleRepeat()}
          aria-label={`Repeat: ${repeat}`}
          title={`Repeat: ${repeat}`}
          className={cn(
            'flex-1 h-11 grid place-items-center rounded-full active:scale-95',
            repeat === 'off'
              ? 'bg-white/10 text-white/60 active:text-white'
              : 'text-accent',
          )}
          style={
            repeat !== 'off'
              ? {
                  backgroundColor:
                    'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                }
              : undefined
          }
        >
          {repeat === 'one' ? <RepeatOneIcon size={19} /> : <RepeatIcon size={19} />}
        </button>
        <button
          type="button"
          onClick={() => setAutoplay(!autoplay)}
          aria-pressed={autoplay}
          aria-label="Autoplay"
          title="Autoplay"
          className={cn(
            'flex-1 h-11 grid place-items-center rounded-full active:scale-95',
            autoplay
              ? 'text-accent'
              : 'bg-white/10 text-white/60 active:text-white',
          )}
          style={
            autoplay
              ? {
                  backgroundColor:
                    'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                }
              : undefined
          }
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="2" />
            <path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8" />
          </svg>
        </button>
      </div>
      <ul className="flex flex-col">
        {rows.map(({ t, i }) => {
          const isCurrent = i === currentIndex;
          const isDragging = drag?.from === i;
          const translate = isDragging ? drag.y - drag.startY : rowShift(i);
          return (
            <Fragment key={`${i}:${t.id}`}>
              {isCurrent && (
                <li className={cn(EYEBROW_ON_ART, 'px-1 pt-1 pb-1.5')}>
                  Now playing
                </li>
              )}
              {i === currentIndex + 1 && (
                <li className="px-1 pt-5 pb-1.5 flex items-center justify-between gap-2">
                  <span className={EYEBROW_ON_ART}>
                    Up next
                  </span>
                  <button
                    type="button"
                    onClick={() => clearUpcoming()}
                    className="text-xs font-medium text-white/60 active:text-white"
                  >
                    Clear
                  </button>
                </li>
              )}
              <li
                style={{
                height: QUEUE_ROW_H,
                transform: translate ? `translateY(${translate}px)` : undefined,
                transition: isDragging ? 'none' : 'transform 180ms ease',
                zIndex: isDragging ? 10 : undefined,
                position: 'relative',
                // Now-playing row: faint artwork-accent wash + hairline ring
                // instead of a flat white highlight (dragging still wins below).
                ...(isCurrent && !isDragging
                  ? {
                      backgroundColor:
                        'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                      boxShadow:
                        'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 18%, transparent)',
                    }
                  : {}),
              }}
              className={`flex items-center gap-2 px-1 rounded-lg ${
                isDragging ? 'bg-white/15 shadow-xl shadow-black/50' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => jumpTo(i)}
                className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg active:bg-white/5"
              >
                <div className="h-10 w-10 shrink-0 rounded-lg overflow-hidden bg-neutral-800">
                  {t.album_art_url ? (
                    <img
                      src={t.album_art_url}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm truncate ${
                      isCurrent ? 'text-accent font-medium' : 'text-white/95'
                    }`}
                  >
                    {t.title}
                  </div>
                  <div className="text-xs text-white/55 truncate">
                    {t.artists.join(', ')}
                  </div>
                </div>
              </button>
              {isCurrent ? (
                <span className="text-accent shrink-0 pr-1">
                  <EqualizerBars playing={isPlaying} />
                </span>
              ) : (
                <div className="flex items-center gap-0.5 shrink-0">
                  {/* Play next — jump this track to the top of Up next. Hidden
                      for the row that's already next (would be a no-op). */}
                  {i > currentIndex + 1 && (
                    <button
                      type="button"
                      onClick={() => playNext(i)}
                      aria-label="Play next"
                      title="Play next"
                      className="h-8 w-8 grid place-items-center rounded-full text-white/60 active:bg-white/10"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M5 5h14" />
                        <path d="m8 12 4-4 4 4" />
                        <path d="M12 8v11" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label="Remove from queue"
                    title="Remove"
                    className="h-8 w-8 grid place-items-center rounded-full text-white/60 active:bg-white/10"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                  {/* Drag handle — press and drag to reorder. touch-none so the
                      drag doesn't scroll the list; pointer capture keeps the
                      move/up events here even when the finger leaves it. */}
                  <button
                    type="button"
                    aria-label="Reorder"
                    title="Drag to reorder"
                    className="h-8 w-8 grid place-items-center rounded-full text-white/45 touch-none cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDrag({ from: i, startY: e.clientY, y: e.clientY });
                    }}
                    onPointerMove={(e) => {
                      setDrag((d) => (d ? { ...d, y: e.clientY } : d));
                    }}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <circle cx="9" cy="6" r="1.4" />
                      <circle cx="15" cy="6" r="1.4" />
                      <circle cx="9" cy="12" r="1.4" />
                      <circle cx="15" cy="12" r="1.4" />
                      <circle cx="9" cy="18" r="1.4" />
                      <circle cx="15" cy="18" r="1.4" />
                    </svg>
                  </button>
                </div>
              )}
            </li>
            </Fragment>
          );
        })}
      </ul>
      {rows.length <= 1 && (
        <>
          <div className={cn(EYEBROW_ON_ART, 'px-1 pt-5 pb-1.5')}>
            Up next
          </div>
          <p className="px-1 text-sm text-white/45">Nothing up next.</p>
        </>
      )}
    </div>
  );
}
