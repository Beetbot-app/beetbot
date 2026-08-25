import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { heartbeatQueue, upcomingQueueIndices } from '@shared/playerStore';
import { canStream, currentTrack, usePlayerStore, useCatalogNav } from '../store';
import {
  apiUrl,
  getStreamingDegradedSince,
  AUDIO_CACHE_NAME,
  cacheKeyFor,
  castControl,
  castStart,
  castStop,
  getCastStatus,
  getLikedTrackIds,
  getLyrics,
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
  HEARTBEAT_QUEUE_MAX,
  type CastDevice,
  type HandoffPayload,
  type Lyrics,
  type RemoteAction,
  type NowPlayingInfo,
  type RemoteDevice,
  type SearchTrackResult,
} from '@shared/api';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { buildSearchTrackResult, streamToSearchResult } from '@shared/trackAdapter';
import {
  useSleepTimer,
  useAutoplayRadio,
  usePlayLogging,
  useCompletionSignal,
} from '@shared/playerHooks';
import { useHubReachable } from '@shared/useHubReachable';
import { gradientTopColor, useThemeColor } from '@shared/useThemeColor';
import { useSheetDismiss } from '@shared/useSheetDismiss';
import { ART_FIT_WIDTH, cn, SCRIM, CALLOUT_ERROR, EYEBROW_ON_ART } from '@shared/ui';
import { useAccentColor } from '@shared/useAccent';
import { TrackActionSheet } from './TrackActionSheet';
import { Marquee } from '@shared/components/Marquee';
import { LikeButton } from '@shared/components/LikeButton';
import { EqualizerBars } from '@shared/components/EqualizerBars';
import { RemoteBar } from '@shared/components/RemoteBar';
import { DevicesPanel } from '@shared/components/DevicesPanel';
import { ConnectIcon } from '@shared/components/ConnectIcon';
import { QueueIcon } from '@shared/components/QueueIcon';
import { BEET_LIVE } from '@shared/ui';
import { RemoteNowPlayingScreen } from '@shared/components/RemoteNowPlayingScreen';
import {
  FullLyricsScreen,
  LyricsCard,
  hasLyricsToShow,
  lyricsCardBg,
} from '@shared/components/LyricsCard';
import { audioStarted, registerAudioPauser } from '@shared/audioCoordinator';
import { formatDuration } from '@shared/format';
import { notifyLibraryChanged } from '@shared/libraryChanged';
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
  /** A connection banner (you're-offline / can't-reach-your-library) is docked
   *  above the bar right now. A track's 404 while offline is the outage talking,
   *  not a genuinely missing source — so suppress the "source not available"
   *  flash instead of stacking a second, misleading banner on the outage one. */
  connBannerShown?: boolean;
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
// iOS — incl. iPadOS masquerading as macOS — the one platform that
// deactivates a backgrounded page's audio session seconds after the
// <audio> element pauses, taking the lock-screen Now Playing card
// (and any chance of resuming from it) down with it.
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// How long a paused session is held open for lock-screen resume before
// we let iOS reclaim it. Long enough for "paused to take a call /
// stepped away"; bounded so a forgotten pause doesn't hold an audio
// session (and its slice of battery) all night.
const PAUSE_KEEPALIVE_MAX_MS = 15 * 60_000;
/** How long a track change may take before a `pause` from the element stops
 *  counting as incidental. Generous on purpose: a cold cellular fetch can be
 *  slow, and being wrong in this direction only costs the keepalive, whereas
 *  being wrong the other way silences the next track. */
const TRACK_CHANGE_GRACE_MS = 15_000;
/** How long the element may sit without enough data to play, while we believe
 *  playback is running, before we force a fresh load. iOS stalls a media fetch
 *  started while the phone is locked often enough that this is a normal
 *  condition, not an exceptional one — and it arrives with NO `error`, so none
 *  of the error-driven recovery below ever sees it. Long enough not to fight a
 *  slow cellular buffer; short enough that a stall doesn't cost a whole song. */
const STALL_RECOVER_MS = 8_000;
/** Stall interval for /live sources. The engine's fallback legitimately needs
 *  up to ~90s for one attempt; the old 8s x4 ladder (~40s) aborted the request
 *  before it could succeed — and each abort orphaned the server-side work, so
 *  the retry raced its own predecessor (audit, 25 Aug). 25s x4 outlasts one
 *  full attempt while still bounding the wait. */
const STALL_RECOVER_LIVE_MS = 25_000;
/** How many times a stalled stream may be reloaded before we stop and hand it
 *  back to the user. Matches the error path's cap: past this, retrying is not
 *  the problem. */
const STALL_RETRY_MAX = 4;

/** How long after an interruption we'll still resume playback when the user
 *  comes back to their phone. Long enough to cover a real phone call, short
 *  enough that music doesn't start up out of a pocket hours later — by then it
 *  reads as the app deciding to play rather than finishing what it was doing. */
const INTERRUPTION_RESUME_WINDOW_MS = 30 * 60_000;
/** How long a starved element gets before we stop waiting for its own loader
 *  and hand it the bytes directly. Measured on a locked iPhone 31 Jul: healthy
 *  track changes reach a full buffer in 0.1-0.8s, so 1.5s only ever catches a
 *  genuine stall. The reload watchdog above stays as the later fallback. */
const BLOB_RESCUE_AFTER_MS = 1_500;
/** Rescue attempts per track before we let the reload watchdog take over. Two
 *  is enough for a transient miss; more would just be the same failure again. */
const BLOB_RESCUE_MAX = 2;

/** How many upcoming tracks we hold decoded audio for. The current track plus
 *  the next two, at roughly 2-3MB each. */
const PREFETCH_HOLD_MAX = 3;

/**
 * A few seconds of genuine silence as an inline WAV. The pause
 * keepalive loops this through a second <audio> element: WebKit keeps
 * the page's audio session active only while something is actually
 * playing — `mediaSession.playbackState = 'paused'` alone does not
 * hold it, and `volume` is read-only on iOS so a muted copy of the
 * real track is not an option (muted playback is ignored for session
 * purposes anyway). A data: URL needs no network, no service worker,
 * and works offline.
 */
function silentWavDataUrl(seconds: number): string {
  const rate = 8000; // 8-bit mono PCM — smallest thing iOS will play
  const samples = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate (8-bit mono = sample rate)
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(0x80); // 8-bit PCM silence is the midpoint
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

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
/**
 * The muted album wash both player bars wear — a desaturated, ink-mixed version
 * of the artwork's vibrant colour. Shared so the remote bar is tinted by the
 * OTHER device's cover exactly the way the local bar is tinted by yours;
 * anything else made the two read as different widgets.
 */
/**
 * The full-bleed artwork gradient the Now Playing sheet wears — desaturated
 * toward grey for a soft pastel wash, darker at the very top and bottom.
 * Shared so the REMOTE sheet is washed by the other device's cover exactly the
 * way the local one is washed by yours. Null when the colour is unknown, which
 * both screens render as flat dark.
 */
export function artworkGradient(vibrant: string | null): string | null {
  const m = vibrant?.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return null;
  let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const gray = 0.3 * r + 0.5 * g + 0.2 * b;
  const DESAT = 0.42;
  r = r * (1 - DESAT) + gray * DESAT;
  g = g * (1 - DESAT) + gray * DESAT;
  b = b * (1 - DESAT) + gray * DESAT;
  const mix = (c: number, t: number, w: number) => Math.round(c * (1 - w) + t * w);
  const mid = `rgb(${mix(r, 44, 0.32)}, ${mix(g, 44, 0.32)}, ${mix(b, 48, 0.32)})`;
  const edge = `rgb(${mix(r, 24, 0.58)}, ${mix(g, 24, 0.58)}, ${mix(b, 26, 0.58)})`;
  return `linear-gradient(to bottom, ${edge} 0%, ${mid} 22%, ${mid} 72%, ${edge} 100%)`;
}

function albumWash(vibrant: string | null): string {
  const m = vibrant?.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return 'rgb(12 12 14)';
  let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const gray = 0.3 * r + 0.5 * g + 0.2 * b;
  const DESAT = 0.42;
  r = r * (1 - DESAT) + gray * DESAT;
  g = g * (1 - DESAT) + gray * DESAT;
  b = b * (1 - DESAT) + gray * DESAT;
  const mix = (c: number, t: number, w: number) => Math.round(c * (1 - w) + t * w);
  return `rgb(${mix(r, 14, 0.7)}, ${mix(g, 14, 0.7)}, ${mix(b, 16, 0.7)})`;
}

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


export function Player({
  token,
  profileId,
  bottomInset = true,
  flushTop = false,
  connBannerShown = false,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // The pause keepalive: a silent loop that holds the iOS audio session
  // open while the user is logically paused, so the lock-screen card
  // survives (verified on-device: without it, iOS reclaims the session
  // ~10 s after a lock-screen pause and the controls vanish). Created
  // lazily on first pause; capped by PAUSE_KEEPALIVE_MAX_MS.
  const keepaliveRef = useRef<HTMLAudioElement | null>(null);
  // True while a track change is in flight. Swapping `src` makes the element
  // fire `pause`, which is indistinguishable from a user pause at the store
  // level — and starting the keepalive there is actively harmful: the silent
  // loop takes the audio session at the exact moment the next track needs it.
  // Backgrounded, the real element's play() then fails, `isPlaying` never
  // returns true, and the loop holds the session until its 15-minute cap while
  // MediaSession shows the new artwork and the clock keeps running. That is the
  // "new song on the lock screen, no sound until you open the app" report.
  const trackChangingRef = useRef(false);
  const trackChangeSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepaliveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepaliveAssertRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when playback was stopped by something other than the user — a phone
  // call, or another app taking the audio session. iOS hands a native app an
  // "interruption ended" notification; a web page gets nothing at all, so this
  // is the only record that we owe the user a resume.
  //
  // Telling the two apart needs no extra flag, because they arrive in opposite
  // orders. A deliberate pause starts in the store — the button, the
  // MediaSession handler — which sets `isPlaying` false and only then does the
  // load effect call `a.pause()`, so the store is already false when the
  // `pause` event lands. An interruption pauses the element directly and finds
  // the store still true.
  //
  // Resuming happens ONLY when the page becomes visible again. A first attempt
  // retried on a timer, on the assumption that `play()` would fail while a call
  // held the audio session. **It doesn't** — tested on-device 1 Aug: the retry
  // succeeded and the music played underneath the call, audible to both
  // parties. `play()` succeeding is not evidence an interruption ended.
  //
  // Nothing can resume without the user coming back to the app, either. The
  // page is suspended about twelve seconds after the audio stops — measured
  // during a real call, heartbeats ceased 8.6s in and never returned — so no
  // timer, listener or AudioContext state change can run to notice the call
  // ending. That ceiling belongs to web pages, not to this code.
  const interruptedRef = useRef(false);
  const interruptedAtRef = useRef(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Ephemeral "source not available" flash shown when an unavailable track is
  // auto-skipped. Kept separate from `errorMsg` (which is wiped on every track
  // change) so advancing to the next track doesn't clear it before it's seen.
  const [flashMsg, setFlashMsg] = useState<string | null>(null);
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
  const adoptHandoff = usePlayerStore((s) => s.adoptHandoff);
  // Crossfade is desktop-only: it needs Web Audio (iOS makes element.volume
  // read-only) but iOS suspends the AudioContext when backgrounded, which stops
  // playback — background playback matters more. The phone never crossfades; the
  // persisted crossfadeSeconds setting is ignored here.

  // Sleep timer: pause when the scheduled time arrives. (The "end of track"
  // variant is handled in the store's handleTrackEnded.)
  useSleepTimer(usePlayerStore);

  // ---- Liked Songs (heart) ----
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const reload = () => {
      void getLikedTrackIds(token, profileId).then((s) => {
        if (!cancelled) setLikedIds(s);
      });
    };
    reload();
    // Keep the star honest when the like changes from another surface — e.g.
    // un-ticking Favorites in the Add-to-playlist sheet un-likes the current
    // track. Without this the mini + Now Playing star stay filled until the
    // next mount. (Mirrors the desktop PlayerBar listener.)
    window.addEventListener('beetbot:library-changed', reload);
    return () => {
      cancelled = true;
      window.removeEventListener('beetbot:library-changed', reload);
    };
  }, [token, profileId]);

  // Play-logging, completion signal, and autoplay-radio are shared with the
  // desktop player via hooks (see shared/playerHooks.ts).
  usePlayLogging({ store: usePlayerStore, token, profileId });

  // Latest playback position of the CURRENT track, refreshed on each timeupdate
  // (and snapped to full length on natural end); reported for the OUTGOING track
  // when the track changes. Feeds completion-weighted recommendations later.
  const lastTickRef = useRef<{ id: number; ms: number; durMs: number } | null>(
    null,
  );
  useCompletionSignal({ store: usePlayerStore, token, profileId, lastTickRef });

  const trackLiked = track ? likedIds.has(track.id) : false;
  const applyLike = useCallback(
    (id: number, next: boolean) => {
      setLikedIds((prev) => {
        const s = new Set(prev);
        if (next) s.add(id);
        else s.delete(id);
        return s;
      });
      void setTrackLiked(token, id, next, profileId)
        .then(() => {
          // Tell the rest of the app (Home Favorites shelf, Library counts, the
          // Favorites playlist) so they refresh live — the star already updated
          // itself optimistically above.
          notifyLibraryChanged();
        })
        .catch(() => {
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
  // peekNextIndex = the store's true next pick (shuffle-plan aware).
  const nextLyricsTrack = usePlayerStore((s) => {
    const i = s.peekNextIndex();
    return i >= 0 ? s.queue[i] : null;
  });
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

  // Autoplay-radio: phone appends the radio StreamTracks directly (its queue row
  // type IS StreamTrack); the token comes straight from the prop.
  useAutoplayRadio({
    store: usePlayerStore,
    getToken: () => token,
    profileId,
    buildRadioTracks: (more) => more,
  });

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
  // True while warming a streamed track's /live temp file before hand-off.
  const [castPreparing, setCastPreparing] = useState(false);

  // -- iOS pause keepalive ------------------------------------------------
  // Hold the audio session open across a pause so the lock-screen card
  // survives. Start is called from TWO places: synchronously inside the
  // media-session 'pause' handler (still within the user-gesture window
  // iOS grants those callbacks — a backgrounded page can't start
  // playback outside one) and from the isPlaying effect (covers in-app
  // pauses, which happen foregrounded where no gesture is needed).
  // Raise the track-change flag, with a safety release: if the new track never
  // reaches `playing` (a dead source, a failed fetch), the flag must not disable
  // the keepalive forever. Releasing early only costs us the pre-#64 behaviour.
  const markTrackChanging = useCallback(() => {
    trackChangingRef.current = true;
    if (trackChangeSafetyRef.current) clearTimeout(trackChangeSafetyRef.current);
    trackChangeSafetyRef.current = setTimeout(() => {
      trackChangingRef.current = false;
    }, TRACK_CHANGE_GRACE_MS);
  }, []);
  const clearTrackChanging = useCallback(() => {
    trackChangingRef.current = false;
    if (trackChangeSafetyRef.current) {
      clearTimeout(trackChangeSafetyRef.current);
      trackChangeSafetyRef.current = null;
    }
  }, []);

  const stopSessionKeepalive = useCallback(() => {
    if (keepaliveTimerRef.current) {
      clearTimeout(keepaliveTimerRef.current);
      keepaliveTimerRef.current = null;
    }
    if (keepaliveAssertRef.current) {
      clearInterval(keepaliveAssertRef.current);
      keepaliveAssertRef.current = null;
    }
    keepaliveRef.current?.pause();
  }, []);
  const startSessionKeepalive = useCallback(() => {
    if (!IS_IOS || castActive) return;
    if (!keepaliveRef.current) {
      const a = new Audio(silentWavDataUrl(3));
      a.loop = true;
      a.preload = 'auto';
      a.setAttribute('playsinline', '');
      keepaliveRef.current = a;
    }
    // The moment the silent loop starts, iOS re-infers "this page is
    // playing" from it — flipping the lock-screen button to pause bars
    // and showing the loop's own 3-second duration (observed on-device
    // 27 Jul). The explicit playbackState only wins if it's re-asserted
    // AFTER the element starts, and iOS re-infers at its own leisure,
    // so keep re-asserting on a slow tick while the keepalive runs.
    const assertPaused = () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    };
    void keepaliveRef.current.play().then(assertPaused).catch(() => {
      /* No gesture credit left — the card will drop as before. */
    });
    if (keepaliveAssertRef.current) clearInterval(keepaliveAssertRef.current);
    keepaliveAssertRef.current = setInterval(assertPaused, 5_000);
    if (keepaliveTimerRef.current) clearTimeout(keepaliveTimerRef.current);
    keepaliveTimerRef.current = setTimeout(
      stopSessionKeepalive,
      PAUSE_KEEPALIVE_MAX_MS,
    );
  }, [castActive, stopSessionKeepalive]);
  // Keep the keepalive in lockstep with the logical state: paused with a
  // track → hold the session; casting / nothing loaded → off. On resume,
  // stop the silent loop on a DELAY: the real element spins up first and
  // the session is never empty mid-handoff (a gap there is how iOS ends
  // up advancing the clock with no audio routed). Also the unmount
  // teardown.
  useEffect(() => {
    if (isPlaying) {
      const t = setTimeout(stopSessionKeepalive, 1_000);
      return () => clearTimeout(t);
    }
    if (!track || castActive) stopSessionKeepalive();
    // A pause raised by swapping `src` is not the user pausing. Starting the
    // silent loop here steals the audio session from the track that is loading.
    else if (!trackChangingRef.current) startSessionKeepalive();
  }, [isPlaying, track?.id, castActive, startSessionKeepalive, stopSessionKeepalive]);
  useEffect(
    () => () => {
      stopSessionKeepalive();
      clearTrackChanging();
    },
    [stopSessionKeepalive, clearTrackChanging],
  );

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
    // Castable = downloaded OR live-streamable; cast_start warms a streamed
    // next-track server-side before the receiver LOADs it (a cold one adds a
    // short gap, an already-warm one is instant).
    if (!castActive || !track || !canStream(track)) return;
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
  // The Devices panel, opened from the player bar in either mode.
  const [devicesOpen, setDevicesOpen] = useState(false);

  // What we've asked another device to do and haven't seen confirmed yet.
  // Without this the flow was: tap → we flip instantly → the very next poll
  // (2s) still carries the OLD state, because the target only picks commands
  // up every 1s and then heartbeats every 2s → we flip back → the truth
  // finally lands and we flip again. Three transitions for one tap.
  const pendingRef = useRef<Map<string, { playing: boolean; until: number }>>(
    new Map(),
  );
  /** Overlay unconfirmed intent on a fresh device list, and retire each entry
   *  the moment the hub agrees (or the window lapses, so a device that never
   *  obeys can't pin the UI to a lie). */
  const applyPending = useCallback((list: RemoteDevice[]): RemoteDevice[] => {
    const pending = pendingRef.current;
    if (pending.size === 0) return list;
    const now = Date.now();
    return list.map((d) => {
      const want = pending.get(d.device_id);
      if (!want || !d.now_playing) return d;
      if (now > want.until || d.now_playing.is_playing === want.playing) {
        pending.delete(d.device_id);
        return d;
      }
      return { ...d, now_playing: { ...d.now_playing, is_playing: want.playing } };
    });
  }, []);
  // The device whose full now-playing screen is open — held by id, not by
  // object, so the screen keeps updating as presence polls come in.
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
  // ⋯ menu for the track playing on ANOTHER device. Owned here rather than in
  // the shared screen because every item acts on this device: our library, our
  // navigation, our modal stack.
  const [remoteMenuOpen, setRemoteMenuOpen] = useState(false);
  // Same catalog navigation the Now Playing overlay uses — selected here too,
  // because the remote ⋯ menu lives at this level.
  const openArtistNav = useCatalogNav((s) => s.openArtist);
  const openAlbumNav = useCatalogNav((s) => s.openAlbum);
  const [remoteAddTrack, setRemoteAddTrack] = useState<SearchTrackResult | null>(null);

  // The remote bar wears the OTHER device's album wash, extracted exactly the
  // same way — so "theirs" and "mine" look like one control, not two widgets.
  // Read straight off the device list — it must come AFTER that state is
  // declared (reading it earlier is a temporal-dead-zone crash tsc won't flag).
  // Prefer the device whose full screen is open — including when it's PAUSED.
  // Keying this on "whichever device is playing" meant a paused device had no
  // artwork to extract from, so its screen lost the wash exactly when the
  // local sheet would still have one.
  const openDeviceForArt =
    handoffDevices.find((d) => d.device_id === openDeviceId) ?? null;
  const remoteNowPlaying =
    openDeviceForArt?.now_playing ??
    handoffDevices.find((d) => d.now_playing?.is_playing)?.now_playing ??
    null;
  const remoteArtUrl =
    remoteNowPlaying?.track_id != null
      ? trackArtUrl(remoteNowPlaying.track_id, token)
      : (remoteNowPlaying?.album_art_url ?? null);
  const remoteVibrant = useArtworkColor(remoteArtUrl);
  // Accent follows whichever cover the bar is actually showing: ours normally,
  // the other device's when we're idle and standing in for it. (Declared here,
  // after remoteArtUrl — the hook order stays stable either way.)
  useAccentColor(
    track?.album_art_url ? trackArtUrl(track.id, token) : remoteArtUrl,
  );

  // Heartbeat so other devices can see this phone (as a handoff target) and
  // what it's playing (for their "playing on Phone" banner), and keep our own
  // device list fresh. This phone is labelled "Phone".
  useEffect(() => {
    if (!token) return;
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
            // Playhead + length so the other device can draw a live progress
            // bar for us. Read off the element rather than store state so it
            // stays honest mid-scrub.
            position_ms: Math.round(
              (audioRef.current?.currentTime ?? st.currentTime ?? 0) * 1000,
            ),
            duration_ms: cur.duration_ms,
            // The id, not a URL: the reader signs its own art request.
            track_id: cur.id,
            queue: up.items,
            queue_len: up.total,
          }
        : null;
      // Scope presence to the active profile so accounts stay isolated.
      void sendHeartbeat(token, null, 'phone', np, profileId);
      listDevices(token, profileId)
        .then((d) => {
          if (!cancelled) setHandoffDevices(applyPending(d));
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
                has_audio: t.has_audio,
                status: t.status ?? null,
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
        // Default FALSE when the sender predates the field: /live serves a
        // downloaded track's file instantly, whereas assuming `true` sent
        // streamed tracks to /stream — a full synchronous download per play.
        has_audio: t.has_audio ?? false,
        status: t.status ?? 'matched',
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
  // Returns what was sent (or null if nothing was), so the caller can show the
  // receiving device's screen straight away instead of leaving you looking at
  // a player that just went silent.
  const handleHandoff = useCallback(
    async (device: RemoteDevice): Promise<NowPlayingInfo | null> => {
      const st = usePlayerStore.getState();
      if (st.queue.length === 0) return null;
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
        const cur = st.queue[st.currentIndex];
        return cur
          ? {
              title: cur.title,
              artists: cur.artists,
              album_art_url: cur.album_art_url,
              album: cur.album ?? null,
              is_playing: true,
              position_ms: Math.round(payload.position * 1000),
              duration_ms: cur.duration_ms,
              track_id: cur.id,
            }
          : null;
      } catch (e) {
        console.warn('[beetbot] handoff failed', e);
        return null;
      }
    },
    [token],
  );

  const handleStartCast = useCallback(
    async (device: CastDevice) => {
      if (!track) return;
      if (!canStream(track)) {
        setCastError("This track can't be cast yet.");
        return;
      }
      setCastError(null);
      // Streamed (not-downloaded) track → warm its /live temp file BEFORE
      // hand-off so the receiver gets a ready, seekable stream and never times
      // out cold. Usually instant (we're likely already playing it); a cold
      // track blocks a few seconds here, shown as "Preparing…".
      const isLive = !track.has_audio;
      try {
        // Carry the local playhead over so the receiver picks up
        // where the listener was — clicking Cast mid-track shouldn't
        // restart the song from 0.
        const localPos =
          audioRef.current?.currentTime ??
          usePlayerStore.getState().currentTime ??
          0;
        if (isLive) {
          setCastPreparing(true);
          try {
            const warm = playbackUrl(track, token);
            if (warm) {
              await fetch(warm, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
            }
          } catch {
            /* cast_start also warms server-side; a failed pre-warm isn't fatal */
          } finally {
            setCastPreparing(false);
          }
        }
        const res = await castStart(device.id, track.id, token, localPos);
        // Remember the track we just LOADed so the track-change
        // effect doesn't immediately fire a redundant castStart.
        castedTrackIdRef.current = track.id;
        setCastActive({ id: res.device_id, name: res.device_name });
        // Mark "playing" — the Chromecast starts immediately on LOAD,
        // and we want the transport button to render Pause.
        usePlayerStore.setState({ isPlaying: true });
      } catch {
        setCastPreparing(false);
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
      // Held bytes win while hidden — see `resolvePlaybackSrc`.
      setAudioSrc(resolvePlaybackSrc(track));
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
          const cache = await caches.open(AUDIO_CACHE_NAME);
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
    const st = usePlayerStore.getState();
    const { queue, currentIndex } = st;
    // +1 = the store's true next pick (shuffle-plan aware). +2 is only
    // knowable in sequential mode; under shuffle we warm just the +1.
    const ni = st.peekNextIndex();
    const upcoming = (
      st.shuffle
        ? [ni >= 0 ? queue[ni] : undefined]
        : [queue[currentIndex + 1], queue[currentIndex + 2]]
    ).filter((t): t is NonNullable<typeof t> => Boolean(t && isPlayable(t)));
    // Evict anything we're no longer about to need. The map is the sole owner
    // of these object URLs, so this is the only place they're revoked — and the
    // current track is always kept, since the element may be playing it.
    const keep = new Set<number>([track.id, ...upcoming.map((t) => t.id)]);
    for (const [id, objectUrl] of prefetchedRef.current) {
      if (keep.has(id)) continue;
      URL.revokeObjectURL(objectUrl);
      prefetchedRef.current.delete(id);
    }
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
        if (prefetchedRef.current.has(track.id)) return;
        // Mark the request as a warm-up: nobody is listening for THIS response,
        // so the hub lets a real tap's resolve overtake it instead of queueing
        // the tap behind us. Only here — the element's own fallback load (when
        // no prefetched copy exists) is a person waiting, and stays unmarked.
        const warmUrl = `${url}${url.includes('?') ? '&' : '?'}warm=1`;
        // Pull the whole track and KEEP it. Warming the HTTP cache is not
        // enough: a media element's own loader is suspended while the page is
        // backgrounded and its range requests miss the cache `fetch()` filled,
        // so the element would still go to the network and still be slow. Bytes
        // we already hold can be handed over as an object URL with no request
        // at all, which is the only way a backgrounded boundary reliably beats
        // iOS's suspension fuse.
        //
        // /live tracks get the same treatment now. They used to receive a
        // 2-byte range request purely to make the desktop de-fragment them, but
        // they are the slowest to start (2-4s observed) and so the likeliest to
        // run the fuse down.
        fetch(warmUrl, { signal: ctrl.signal })
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (!blob || ctrl.signal.aborted) return;
            if (prefetchedRef.current.has(track.id)) return;
            if (prefetchedRef.current.size >= PREFETCH_HOLD_MAX) return;
            prefetchedRef.current.set(track.id, URL.createObjectURL(blob));
          })
          .catch(() => {
            /* the boundary falls back to the network URL, as it always did */
          });
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
      for (const objectUrl of prefetchedRef.current.values()) {
        URL.revokeObjectURL(objectUrl);
      }
      prefetchedRef.current.clear();
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
  // What we last assigned to `audio.src`. Needed because the element's `src`
  // getter returns an absolutised URL, so it can never be compared against the
  // relative paths `audioSrc` holds. The element's source is driven
  // imperatively — see the load effect and `startNextTrackNow` below — rather
  // than through a React `src` prop, because the prop's write lands in a later
  // commit and that delay is what loses the audio session on a locked phone.
  const currentSrcKeyRef = useRef<string | null>(null);

  // Live-stream error recovery: the phone streams audio from the desktop, so a
  // dropped stream (the desktop restarting, or a stale URL after the app was
  // backgrounded) makes <audio> error with "format not supported". `reloadNonce`
  // forces a fresh load() of the SAME src to recover; `retryRef` caps the
  // auto-retries with a backoff so a genuinely-bad track still surfaces an error.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Decoded audio for the tracks we expect to play next, keyed by track id.
  // Holding the bytes is what makes a backgrounded track change instant — see
  // `resolvePlaybackSrc`. This map owns its object URLs and revokes them on
  // eviction; nothing else may revoke them.
  const prefetchedRef = useRef<Map<number, string>>(new Map());
  /** The source to hand the element for `t`.
   *
   *  Normally the network URL. When the page is hidden and we already hold the
   *  track's bytes, the object URL instead — because a backgrounded track change
   *  has to produce audio almost immediately, and a network round trip is too
   *  slow to guarantee that.
   *
   *  The deadline is hard and it is not ours. iOS keeps a backgrounded page
   *  running *because* it is playing audio; once audio actually stops, that
   *  justification lapses and the whole page is suspended — timers, callbacks,
   *  even Web Inspector evaluation. Measured on a locked iPhone 1 Aug: audio
   *  stopped at 22:55:39 and all script execution ceased at 22:55:51. So every
   *  recovery mechanism is racing a ~12s fuse, and the only reliable answer is
   *  not to let the audio stop in the first place.
   *
   *  Foreground stays on the network URL, and so does AirPlay: a Blob lives in
   *  this page's JS context, so an AirPlay receiver handed one spins forever
   *  (see the note on the src effect). Neither is the case that fails. */
  const resolvePlaybackSrc = useCallback(
    (t: { id: number; has_audio: boolean }): string | null => {
      const net = playbackUrl(t, token);
      if (!net || !document.hidden) return net;
      const el = audioRef.current as
        | (HTMLAudioElement & { webkitCurrentPlaybackTargetIsWireless?: boolean })
        | null;
      if (el?.webkitCurrentPlaybackTargetIsWireless) return net;
      return prefetchedRef.current.get(t.id) ?? net;
    },
    [token],
  );
  // Stall watchdog. `stalled`/`waiting` say the fetch produced no data; neither
  // sets `a.error`, so the error paths below never fire and the element sits at
  // readyState 1 (metadata only) indefinitely. Observed on a locked phone
  // 30 Jul: the next track loaded its header, stalled, and never played — the
  // lock screen showed the right duration over silence until the app was
  // foregrounded, which un-stalled the network on its own.
  const stallTimerRef = useRef<number>(0);
  /** Cancel a pending stall recovery — the stream started moving again. */
  const clearStallWatchdog = useCallback(() => {
    if (stallTimerRef.current) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = 0;
    }
  }, []);
  /** Arm the stall watchdog. Re-arming is harmless: the newest timer wins.
   *  Recovery is a fresh load of the same src — the identical move the error
   *  path makes — because a stalled fetch will not resume on its own while the
   *  phone stays locked, and the request that replaces it usually does. */
  const armStallWatchdog = useCallback(() => {
    clearStallWatchdog();
    const isLive = audioRef.current?.currentSrc?.includes('/live') ?? false;
    stallTimerRef.current = window.setTimeout(() => {
      stallTimerRef.current = 0;
      const a = audioRef.current;
      if (!a || !usePlayerStore.getState().isPlaying) return;
      // HAVE_FUTURE_DATA (3) is the bar for "can actually keep playing".
      // Anything less, this long after a stall, is stuck rather than slow.
      if (a.readyState >= 3) return;
      const r = retryRef.current;
      if (r.count >= STALL_RETRY_MAX) {
        setErrorMsg('Couldn’t reach the stream — tap play to try again.');
        usePlayerStore.setState({ isPlaying: false });
        return;
      }
      r.count += 1;
      raiseBuffering();
      setReloadNonce((n) => n + 1);
    }, isLive ? STALL_RECOVER_LIVE_MS : STALL_RECOVER_MS);
  }, [clearStallWatchdog]);
  useEffect(() => clearStallWatchdog, [clearStallWatchdog]);

  // ---- Blob rescue -------------------------------------------------------
  //
  // Reloading a stalled src (the watchdog above) assumes the element's loader
  // can still reach the network. Backgrounded on iOS it cannot, and no amount
  // of reloading changes that. Instrumented on a locked iPhone 31 Jul:
  //
  //   EVT stalled  ready=1 buf=0        <- element has nothing
  //   fetch(sameUrl) -> 2863KB in 5ms   <- page networking is untouched
  //
  // Five milliseconds, because the prefetch had already put those bytes in the
  // HTTP cache. The audio was sitting on the phone and the element still could
  // not reach it: a media element's resource loading is suspended while
  // backgrounded, and its Range requests miss the cache `fetch()` populated.
  // Handing the same bytes over as an in-memory Blob took readyState 0 -> 4 in
  // ~50ms with the screen still locked, twice, in the same run in which the
  // one boundary we deliberately left unrescued stalled as it always had.
  //
  // So this is deliberately NOT the normal source path. `audioSrc` stays a
  // stable HTTP URL (see the AirPlay note on the src effect above) and we only
  // swap in a Blob once the element has demonstrably failed to load on its own.
  // The assignment is made straight to the DOM node rather than through state:
  // React's `src` prop is unchanged, so no reconciliation undoes it and the
  // load effect's `loadKey` stays put.
  const blobRescueTimerRef = useRef<number>(0);
  const blobRescueCountRef = useRef(0);
  /** Cancel a pending rescue — the element started loading after all. */
  const clearBlobRescue = useCallback(() => {
    if (blobRescueTimerRef.current) {
      window.clearTimeout(blobRescueTimerRef.current);
      blobRescueTimerRef.current = 0;
    }
  }, []);
  /** Arm the rescue. Unlike the reload watchdog this does NOT re-arm: `waiting`
   *  and `stalled` often arrive together, and pushing the deadline out on each
   *  one would let a wedged element keep deferring its own rescue. */
  const armBlobRescue = useCallback(() => {
    if (blobRescueTimerRef.current) return;
    blobRescueTimerRef.current = window.setTimeout(() => {
      blobRescueTimerRef.current = 0;
      const a = audioRef.current;
      if (!a || !usePlayerStore.getState().isPlaying) return;
      // Backgrounded only. The defect is that a media element's own loader is
      // suspended while the page is hidden. In the foreground `waiting` means
      // an ordinarily slow network, and swapping to a Blob there would be a
      // regression: playback would wait for the whole file instead of resuming
      // progressively after a few hundred KB.
      if (!document.hidden) return;
      // HAVE_FUTURE_DATA — it recovered on its own while we waited.
      if (a.readyState >= 3) return;
      if (a.src.startsWith('blob:')) return;
      if (blobRescueCountRef.current >= BLOB_RESCUE_MAX) return;
      // AirPlay can't play a Blob: the bytes live in this page's JS context and
      // the receiver spins forever. Read the live element property rather than
      // the React mirror so a route that changed mid-stall is still respected.
      const wireless = (
        a as HTMLAudioElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }
      ).webkitCurrentPlaybackTargetIsWireless;
      if (wireless) return;
      const url = a.currentSrc;
      if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
      blobRescueCountRef.current += 1;
      void (async () => {
        let objectUrl: string | null = null;
        try {
          const resp = await fetch(url);
          if (!resp.ok) return;
          const blob = await resp.blob();
          const el = audioRef.current;
          // Re-check everything: the fetch is async and the track may have
          // changed, recovered, or been paused while it was in flight.
          if (!el || el !== a) return;
          if (el.readyState >= 3 || el.src.startsWith('blob:')) return;
          if (el.currentSrc !== url) return;
          if (!usePlayerStore.getState().isPlaying) return;
          const resumeAt = el.currentTime;
          objectUrl = URL.createObjectURL(blob);
          // Mid-track stalls have a position worth keeping; track boundaries
          // sit at ~0. Restore only once the new source knows its duration.
          if (resumeAt > 0.5) {
            el.addEventListener(
              'loadedmetadata',
              () => {
                try {
                  el.currentTime = resumeAt;
                } catch {
                  /* seek refused — better to restart the track than stay silent */
                }
              },
              { once: true },
            );
          }
          const prior = blobUrlRef.current;
          blobUrlRef.current = objectUrl;
          // Assigning src runs the load algorithm; the bytes are already local
          // so this resolves without touching the network.
          el.src = objectUrl;
          objectUrl = null; // handed over — the track-change effect revokes it
          await el.play();
          if (prior) URL.revokeObjectURL(prior);
        } catch {
          // Leave it to the reload watchdog, then the error path.
        } finally {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
      })();
    }, BLOB_RESCUE_AFTER_MS);
  }, []);
  useEffect(() => clearBlobRescue, [clearBlobRescue]);
  // A new track gets a clean slate: cancel any rescue still armed for the one
  // before it, and hand back the full allowance. Kept out of the src effect
  // above so nothing in the AirPlay-sensitive path has to move.
  useEffect(() => {
    clearBlobRescue();
    blobRescueCountRef.current = 0;
  }, [track?.id, clearBlobRescue]);

  const retryRef = useRef<{ count: number; timer: number }>({ count: 0, timer: 0 });
  // Consecutive tracks auto-skipped because their source 404'd — a stale queue
  // (e.g. after a library migration/rebrand, or a pruned discovery row) points
  // at ids that no longer exist. Reset on any successful play; capped so an
  // all-dead queue skips through once and stops instead of looping forever.
  const goneRef = useRef(0);
  // Timer that clears the brief "source not available" banner after a skip so
  // it reads as a flash, not a persistent error.
  const flashRef = useRef(0);

  // While `castActive` is set the receiver is the source of truth — the
  // local element must stay paused or we get two copies of the same
  // track playing in parallel (one in the phone speaker, one on the
  // Chromecast). The status poller continuously mirrors the receiver's
  // playing state into `isPlaying`, so without this gate the very first
  // PLAYING tick would re-fire `a.play()` on the local element.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!audioSrc) {
      // No track: tear the element down. This used to happen for free when
      // React rendered `src={undefined}`; now that the source is imperative
      // it has to be done here.
      if (currentSrcKeyRef.current !== null) {
        currentSrcKeyRef.current = null;
        loadedSrcRef.current = null;
        a.removeAttribute('src');
        try {
          a.load();
        } catch {
          /* teardown races are harmless */
        }
      }
      return;
    }
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
      const srcChanged = currentSrcKeyRef.current !== audioSrc;
      loadedSrcRef.current = loadKey;
      try {
        if (srcChanged) {
          // Assigning src *is* the load algorithm; calling load() as well
          // would run it twice, and the second run can interrupt the play()
          // the first one just enabled.
          currentSrcKeyRef.current = audioSrc;
          a.src = audioSrc;
        } else {
          // Same source, forced reload: the stream-error retry bumping
          // `reloadNonce`, or a play tap after `a.error`.
          a.load();
        }
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
        // NotSupportedError means the media element couldn't load the source —
        // the same failure the <audio> 'error' handler below probes and resolves
        // (skip / retry / "Song source not available"). Let that handler be the
        // single source of truth instead of racing it with a premature banner.
        if (err instanceof Error && err.name !== 'NotSupportedError') {
          setErrorMsg(
            err.name === 'NotAllowedError'
              ? 'Tap play to start.' // autoplay blocked by the browser
              : 'Playback failed. Try again.',
          );
        }
      });
    } else {
      a.pause();
    }
  }, [isPlaying, audioSrc, castActive, reloadNonce]);

  /** Point the element at the freshly-advanced track *inside the `ended`
   *  event's call stack*, rather than waiting for `audioSrc` to travel through
   *  two React renders.
   *
   *  That wait is the lock-screen bug. `onEnded` only mutates the store; the
   *  source change then needs one render for `isPlaying` and another for
   *  `setAudioSrc` before the effect above touches the element. Backgrounded,
   *  iOS drops the page's audio session across that gap, and the new track then
   *  sits at readyState 1 with an empty buffer indefinitely — from any source,
   *  network URL or fully in-memory Blob alike.
   *
   *  What hid this for so long is an accident. When React renders the
   *  `isPlaying` flip on its own, the effect fires once while `audioSrc` still
   *  names the *old* track, re-playing the just-ended one for ~100ms, and that
   *  incidental playback holds the session until the real source lands. When
   *  React batches the `pause` and `ended` updates into a single render,
   *  `isPlaying` nets to no change, the effect never runs, the replay never
   *  happens, and playback dies. Instrumented on a locked iPhone 1 Aug: 20 of
   *  20 surviving boundaries showed that replay; both failures showed none.
   *
   *  Online path only — the offline branch resolves a Blob from the cache
   *  asynchronously and so cannot run here, and a phone with no network is not
   *  the case this protects. */
  const startNextTrackNow = useCallback(
    (endedTrackId: number | undefined) => {
      const a = audioRef.current;
      if (!a || castActive || !navigator.onLine) return;
      const st = usePlayerStore.getState();
      // Not advancing: end of the queue, or the sleep timer stopping here.
      if (!st.isPlaying) return;
      const next = currentTrack(st);
      if (!next) return;
      // repeat-'one' stays on the same track — the element already holds it,
      // and reloading would re-download it to play the same thing.
      if (endedTrackId !== undefined && next.id === endedTrackId) return;
      // Held bytes win while hidden. This is the whole point of the prefetch
      // cache: at a backgrounded boundary the element must start producing
      // audio before iOS's suspension fuse burns down, and a network round trip
      // is not reliably fast enough.
      const url = resolvePlaybackSrc(next);
      if (!url) return;
      currentSrcKeyRef.current = url;
      // Claim the load so the effect above treats this source as handled and
      // doesn't run the load algorithm a second time on the next render.
      loadedSrcRef.current = `${url}#${reloadNonce}`;
      try {
        a.src = url;
        void a.play().catch(() => {
          /* the effect and the error path each still get their turn */
        });
      } catch {
        /* fall back to the effect-driven path */
      }
    },
    // `token` isn't listed: the source now comes from `resolvePlaybackSrc`,
    // which carries that dependency itself.
    [castActive, reloadNonce, resolvePlaybackSrc],
  );


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
      // …or when an interruption stopped us. `isPlaying` is false there too —
      // the music really did stop, and the UI should say so — but we still owe
      // the user a resume, which is what `interruptedRef` remembers.
      let interrupted = interruptedRef.current;
      if (
        interrupted &&
        Date.now() - interruptedAtRef.current > INTERRUPTION_RESUME_WINDOW_MS
      ) {
        // Long enough ago that picking the music back up would surprise rather
        // than help — a call an hour ago is not a request to start playing.
        interruptedRef.current = false;
        interrupted = false;
      }
      if (!playing && !interrupted) return;
      if (a.error) {
        // The stream died while backgrounded (server moved on / URL went stale)
        // — force a fresh load to resume from the saved position.
        retryRef.current.count = 0;
        setReloadNonce((n) => n + 1);
      } else if (a.paused) {
        if (interrupted) {
          // Put the store back first and let the play/pause effect issue the
          // actual play(), so there is still exactly one caller driving the
          // element rather than two racing.
          interruptedRef.current = false;
          usePlayerStore.setState({ isPlaying: true });
        } else {
          void a.play().catch(() => {
            /* If iOS still refuses, leave it for the user to tap play. */
          });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [castActive]);


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
    ms.setActionHandler('play', () => {
      usePlayerStore.getState().play();
      // Kick the element NOW, inside the action callback's user-gesture
      // window. The store→effect path lands a tick later, outside it,
      // and a backgrounded page's play() from there makes iOS advance
      // the clock without routing any audio (observed on-device 27 Jul:
      // ticker moves, silence). The keepalive loop is left running for
      // the handoff — the isPlaying effect drops it a second later, so
      // the audio session is never empty mid-swap.
      const a = audioRef.current;
      if (a && a.paused) {
        void a.play().catch(() => {
          /* The effect's retry path takes it from here. */
        });
      }
    });
    ms.setActionHandler('pause', () => {
      usePlayerStore.getState().pause();
      // Synchronously, while still inside the action callback's
      // user-gesture window: hold the audio session open, or iOS
      // reclaims it (and the lock-screen card) ~10 s from now.
      startSessionKeepalive();
    });
    // Same incidental-pause problem as a natural track end: skipping swaps
    // `src`, the element fires `pause`, and without the flag the keepalive
    // would grab the session the new track is about to need.
    ms.setActionHandler('previoustrack', () => {
      markTrackChanging();
      usePlayerStore.getState().prev();
    });
    ms.setActionHandler('nexttrack', () => {
      markTrackChanging();
      usePlayerStore.getState().next();
    });
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
    startSessionKeepalive,
    stopSessionKeepalive,
    markTrackChanging,
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
  // Reflect a transport command on the other device IMMEDIATELY, then let the
  // 2-second presence poll confirm it. Without this, tapping pause on a remote
  // device sat visibly dead for up to two seconds — the lag that made this feel
  // unlike Connect. If the device never obeys, the next poll simply puts the
  // real state back, so an optimistic guess is self-healing.
  const echoRemoteState = useCallback((deviceId: string, playing: boolean) => {
    setHandoffDevices((ds) =>
      ds.map((d) =>
        d.device_id === deviceId && d.now_playing
          ? { ...d, now_playing: { ...d.now_playing, is_playing: playing } }
          : d,
      ),
    );
  }, []);
  const commandDevice = useCallback(
    (deviceId: string, action: RemoteAction) => {
      if (action === 'play' || action === 'pause') {
        const playing = action === 'play';
        // Target polls commands every 1s then heartbeats every 2s, and we poll
        // every 2s — so ~5s covers the worst honest round trip.
        pendingRef.current.set(deviceId, { playing, until: Date.now() + 5000 });
        echoRemoteState(deviceId, playing);
      }
      void postRemoteCommand(token, deviceId, action);
    },
    [token, echoRemoteState],
  );
  const sendRemote = (action: RemoteAction) => {
    if (remoteActive) commandDevice(remoteActive.device_id, action);
  };
  // Another device actually playing right now — dots the Devices button while
  // this phone has its own music going, so "something else is on" is visible
  // without a second bar shouting it.
  const otherPlaying =
    handoffDevices.find((d) => d.now_playing?.is_playing) ?? null;
  // The device picker, reachable from the bar in BOTH modes (local and
  // remote) — previously it hid inside the expanded Now Playing, which meant
  // that when this phone had nothing loaded there was no way to reach your
  // devices at all: exactly the moment you need them.
  // The open device's live row (re-read each poll) and its full screen.
  const openDevice =
    handoffDevices.find((d) => d.device_id === openDeviceId) ?? null;
  const remoteScreen =
    openDevice?.now_playing != null ? (
      <RemoteNowPlayingScreen
        label={openDevice.label}
        nowPlaying={openDevice.now_playing}
        token={token}
        bgGradient={artworkGradient(remoteVibrant)}
        accent={remoteVibrant}
        liked={
          openDevice.now_playing.track_id != null &&
          likedIds.has(openDevice.now_playing.track_id)
        }
        onToggleLike={
          openDevice.now_playing.track_id != null
            ? () => {
                const id = openDevice.now_playing!.track_id!;
                applyLike(id, !likedIds.has(id));
              }
            : undefined
        }
        onOpenMenu={() => setRemoteMenuOpen(true)}
        onCommand={(action) => commandDevice(openDevice.device_id, action)}
        onPlayHere={() => {
          void requestHandoff(token, openDevice.device_id);
          setOpenDeviceId(null);
          setDevicesOpen(false);
        }}
        onClose={() => setOpenDeviceId(null)}
      />
    ) : null;

  // The ⋯ menu for a remote track. Four items, all of which act HERE: favourite
  // and add-to-playlist are library writes keyed by track id, and the two
  // navigations move this phone. Deliberately no sleep timer — that one really
  // does belong to the device doing the playing.
  const remoteNp = openDevice?.now_playing ?? null;
  const remoteTrackId = remoteNp?.track_id ?? null;
  const remoteArtist = remoteNp?.artists?.[0] ?? null;
  const remoteMenu =
    remoteMenuOpen && remoteNp ? (
      <TrackActionSheet
        onClose={() => setRemoteMenuOpen(false)}
        quick={[
          {
            key: 'favorite',
            label:
              remoteTrackId != null && likedIds.has(remoteTrackId)
                ? 'Favorited'
                : 'Favorite',
            icon: (
              <svg width="22" height="22" viewBox="0 0 24 24" fill={remoteTrackId != null && likedIds.has(remoteTrackId) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m12 17.3-5.2 3 1-5.9-4.3-4.2 5.9-.9L12 4l2.6 5.3 5.9.9-4.3 4.2 1 5.9z" />
              </svg>
            ),
            onClick: () => {
              if (remoteTrackId != null) applyLike(remoteTrackId, !likedIds.has(remoteTrackId));
            },
          },
          {
            key: 'add',
            label: 'Add',
            icon: (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            ),
            onClick: () => {
              if (remoteTrackId == null) return;
              setRemoteAddTrack(
                buildSearchTrackResult({
                  source: 'local',
                  id: remoteTrackId,
                  title: remoteNp.title,
                  artists: remoteNp.artists,
                  album: remoteNp.album ?? null,
                  album_art_url: remoteNp.album_art_url ?? null,
                  duration_ms: remoteNp.duration_ms ?? 0,
                  isrc: null,
                  has_audio: true,
                  in_playlist_ids: [],
                }),
              );
            },
          },
        ]}
        items={[
          ...(remoteArtist
            ? [
                {
                  key: 'artist',
                  label: 'Go to Artist',
                  icon: (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
                    </svg>
                  ),
                  onClick: () => {
                    openArtistNav(remoteArtist);
                    setOpenDeviceId(null);
                    setDevicesOpen(false);
                  },
                },
              ]
            : []),
          ...(remoteNp.album
            ? [
                {
                  key: 'album',
                  label: 'Go to Album',
                  icon: (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                  ),
                  onClick: () => {
                    openAlbumNav(remoteNp.album!, remoteArtist);
                    setOpenDeviceId(null);
                    setDevicesOpen(false);
                  },
                },
              ]
            : []),
        ]}
      />
    ) : null;

  // Screen + its ⋯ menu + the add-to-playlist modal travel together, so the two
  // render sites below stay a single slot.
  const remoteLayer = (
    <>
      {remoteScreen}
      {remoteMenu}
      {remoteAddTrack &&
        createPortal(
          <AddToPlaylistModal
            token={token}
            activeProfileId={profileId}
            track={remoteAddTrack}
            onClose={() => setRemoteAddTrack(null)}
          />,
          document.body,
        )}
    </>
  );

  // Always mounted so it can ANIMATE both ways: a 0fr→1fr grid row slides it
  // open to its natural height (no magic max-height to guess, no jump when the
  // device list changes length). Collapsed it's zero-height, inert and hidden
  // from assistive tech rather than merely invisible.
  const devicesPanel = (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none',
        devicesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      aria-hidden={!devicesOpen}
    >
      <div className={cn('overflow-hidden', !devicesOpen && 'pointer-events-none')}>
        <DevicesPanel
          devices={handoffDevices}
          token={token}
          onCommand={commandDevice}
          onPlayHere={(deviceId) => {
            void requestHandoff(token, deviceId);
            setDevicesOpen(false);
          }}
          onOpenDevice={(d) => setOpenDeviceId(d.device_id)}
        />
      </div>
    </div>
  );

  // Nothing loaded here, but another device is playing → THIS bar becomes that
  // device's bar (Spotify-Connect-style), instead of the old floating strip
  // stacked on top of the local one. Two bars at once was the thing that made
  // the feature feel unlike Connect.
  if (!track) {
    return remoteActive && remoteActive.now_playing ? (
      <>
        <RemoteBar
          label={remoteActive.label}
          nowPlaying={remoteActive.now_playing}
          token={token}
          washBg={albumWash(remoteVibrant)}
          bottomInset={bottomInset}
          onPlayPause={() =>
            sendRemote(remoteActive.now_playing!.is_playing ? 'pause' : 'play')
          }
          onNext={() => sendRemote('next')}
          onOpenDevices={() => setDevicesOpen((v) => !v)}
          devicesOpen={devicesOpen}
          panel={devicesPanel}
        />
        {remoteLayer}
      </>
    ) : null;
  }

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
  const miniBarBg = albumWash(barVibrant);

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
      <audio
        ref={audioRef}
        // No `src` prop: the source is assigned imperatively (see the load
        // effect and `startNextTrackNow`). A React-rendered `src` lands in a
        // later commit, and on a locked phone that delay costs the audio
        // session — see the comment on `startNextTrackNow`.
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
          markTrackChanging();
          const endedId = track?.id;
          handleTrackEnded();
          // The store is already advanced, so the next source is knowable
          // right here. Handing it to the element now — rather than two
          // renders later — is what keeps the audio session across a
          // backgrounded track change.
          startNextTrackNow(endedId);
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
          // Playing again, however that came about — nothing is owed.
          interruptedRef.current = false;
          // And whatever swap was in flight has landed.
          clearTrackChanging();
          // Stop any preview clip so the two audio sources don't overlap.
          audioStarted('main');
        }}
        onPause={() => {
          const a = audioRef.current;
          const wasPlaying = usePlayerStore.getState().isPlaying;
          usePlayerStore.setState({ isPlaying: false });
          // The store being true here means nothing in the app asked for this
          // pause — an interruption stopped us. See `interruptedRef`.
          // `ended` pauses the element too, but that's a track change with the
          // next song already on its way, not something to resume.
          if (wasPlaying && a && !a.ended) {
            interruptedRef.current = true;
            interruptedAtRef.current = Date.now();
          }
        }}
        // The native `playing` event fires when the audio element has
        // started outputting frames after a buffer / src change. We use
        // it to lift the post-track-change scrubber freeze (see
        // audioWarmingUp). `play` fires earlier (when play() is called)
        // and isn't enough — iOS may still be waiting on AirPlay buffer.
        onPlaying={() => {
          // Audio is flowing again — reset the stream-retry + gone-skip counters
          // so a future hiccup gets a fresh set of retries.
          clearStallWatchdog();
          clearBlobRescue();
          retryRef.current.count = 0;
          // Frames are flowing, so this track earned a fresh set of rescues if
          // it stalls again later. Each one still costs a real stall first.
          blobRescueCountRef.current = 0;
          goneRef.current = 0;
          // Audio is flowing — clear any lingering error/flash banner.
          setErrorMsg(null);
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
            armBlobRescue();
            armStallWatchdog();
          }
        }}
        // `stalled` is the one that mattered on a locked phone: the fetch for the
        // next track delivered its header and then nothing, with no `error` to
        // trigger any of the recovery below. Without a watchdog the element sits
        // at readyState 1 until the app is foregrounded.
        onStalled={() => {
          if (usePlayerStore.getState().isPlaying) {
            armBlobRescue();
            armStallWatchdog();
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
            // Probe /api/tracks/{id} — a DB read — NOT the failed /live URL:
            // re-fetching that URL re-ran the ENTIRE dead resolve (matcher,
            // fallback, up to ~90s) at interactive priority, doubling the
            // wait the listener had already paid (audit, 25 Aug). A 200 here
            // means the track exists and its SOURCE failed; 404 means a ghost
            // row; only a network error means connectivity.
            const probeId = usePlayerStore.getState().queue[
              usePlayerStore.getState().currentIndex
            ]?.id;
            const probeCtl = new AbortController();
            const probeTimer = window.setTimeout(() => probeCtl.abort(), 5000);
            void fetch(apiUrl(`/api/tracks/${probeId}?t=${encodeURIComponent(token ?? '')}`), {
              method: 'GET',
              cache: 'no-store',
              signal: probeCtl.signal,
            })
              .then(async (res) => {
                window.clearTimeout(probeTimer);
                // A fresh live denial rides the track row for ~60s. The one
                // that changes behavior is upstream-unreachable: the SONG is
                // fine, the Mac's network isn't — skip-flashing through the
                // queue blaming each track would be a lie, so stop and say
                // the true thing once.
                const denial =
                  res.ok
                    ? ((await res.json().catch(() => null))?.live_denial ?? null)
                    : null;
                if (res.status === 401) {
                  notifyUnauthorized();
                } else if (denial === 'upstream-unreachable') {
                  retryRef.current.count = 0;
                  setErrorMsg(
                    'Your Mac can\u2019t reach the internet right now. Downloaded songs still play.',
                  );
                  usePlayerStore.setState({ isPlaying: false });
                } else if (res.ok || res.status === 404) {
                  // The track no longer exists (a stale queue after a library
                  // change, or a pruned discovery row). Retrying a ghost is
                  // futile — quietly skip to the next playable track. Capped by
                  // queue length so an entirely-dead queue skips through once
                  // and stops with a message instead of looping forever.
                  const store = usePlayerStore.getState();
                  const cap = Math.max(store.queue.length, 1);
                  goneRef.current += 1;
                  retryRef.current.count = 0;
                  // A 404 means the hub answered, so the source really is gone —
                  // UNLESS a connection banner is already up, in which case the
                  // outage is the real story and a "source not available" banner
                  // would just stack a second, misleading message on it.
                  const showSourceBanner = !connBannerShown;
                  if (goneRef.current > cap) {
                    // Skipped through the whole queue and nothing played — stop
                    // and leave a persistent banner so the silence is explained.
                    goneRef.current = 0;
                    if (showSourceBanner) setErrorMsg('Song source not available');
                    usePlayerStore.setState({ isPlaying: false });
                    return;
                  }
                  // No source for this row — flash a brief banner and skip on.
                  // `flashMsg` is its own state (not the track-change-cleared
                  // `errorMsg`), so advancing to the next track doesn't wipe it
                  // before it's seen; the timer owns how long the flash lasts.
                  if (showSourceBanner) {
                    setFlashMsg('Song source not available');
                    window.clearTimeout(flashRef.current);
                    flashRef.current = window.setTimeout(
                      () => setFlashMsg(null),
                      1500,
                    );
                  }
                  store.next();
                } else {
                  scheduleRetry();
                }
              })
              .catch(() => {
                window.clearTimeout(probeTimer);
                scheduleRetry();
              });
            return;
          }
          const msg = describeAudioError(err);
          setErrorMsg(msg);
          console.error('[beetbot] audio error', err, msg);
          usePlayerStore.setState({ isPlaying: false });
        }}
      />
      {(errorMsg ?? flashMsg) ? (
        <div className={cn(CALLOUT_ERROR, 'mx-4 mt-3 text-xs break-words')}>
          {errorMsg ?? flashMsg}
        </div>
      ) : isPlaying &&
        getStreamingDegradedSince() != null &&
        (audioRef.current?.currentSrc.includes('/live') ?? false) ? (
        // The fast-path alarm, finally on the surface that feels it: streamed
        // starts run ~10s instead of ~1s while degraded. Passive and quiet —
        // it explains the slowness, it doesn't interrupt anything, and
        // downloaded tracks (which are unaffected) never show it.
        <div className="mx-4 mt-3 text-xs text-neutral-500">
          Streaming is running slower than usual right now. Downloaded songs
          aren&rsquo;t affected.
        </div>
      ) : null}

      {remoteLayer}
      {/* Devices, inline: the bar grows upward to show your other devices
          instead of a modal covering the page. */}
      {devicesPanel}
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
        {/* Devices — always reachable from the bar, and dotted while another
            device is playing. Opening it never disturbs playback here: on a
            household server both devices may legitimately play at once, so
            this bar stays YOURS and the sheet is where you steer theirs. */}
        <button
          type="button"
          aria-label={
            otherPlaying ? `Devices — also playing on ${otherPlaying.label}` : 'Devices'
          }
          aria-expanded={devicesOpen}
          onClick={() => setDevicesOpen((v) => !v)}
          className="relative h-11 w-9 shrink-0 grid place-items-center text-neutral-300 active:scale-90 transition"
        >
          <ConnectIcon size={20} />
          {otherPlaying && (
            <span
              className="absolute top-1.5 right-1 h-2 w-2 rounded-full ring-2 ring-neutral-900"
              style={{ backgroundColor: BEET_LIVE }}
            />
          )}
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
          castPreparing={castPreparing}
          onStartCast={handleStartCast}
          onStopCast={handleStopCast}
          handoffDevices={handoffDevices}
          onHandoff={(d) => {
            setConnectOpen(false);
            void handleHandoff(d).then((sent) => {
              if (!sent) return;
              // Seed the row optimistically: the receiver takes a couple of
              // seconds to adopt and heartbeat, and staring at a dead screen
              // in the meantime is precisely the clunky part. The next poll
              // replaces this with the device's own truth.
              setHandoffDevices((ds) =>
                ds.map((x) =>
                  x.device_id === d.device_id ? { ...x, now_playing: sent } : x,
                ),
              );
              setExpanded(false);
              setOpenDeviceId(d.device_id);
            });
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
  // Lyrics live in a card BELOW the player, not in place of the artwork — so
  // the state to track is "has the sheet been scrolled down to it", which
  // drives the Lyrics button's pressed look and makes the button a toggle
  // between the two ends of the scroll.
  const sheetScrollRef = useRef<HTMLDivElement | null>(null);
  const lyricsCardRef = useRef<HTMLElement | null>(null);
  const [atLyrics, setAtLyrics] = useState(false);
  const [lyricsFull, setLyricsFull] = useState(false);
  // B3: swap the art for an editable "Up next" queue.
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

  // A1 slide-up enter + A2 swipe-down-to-dismiss, shared with the remote
  // device sheet so the same gesture works on both.
  const {
    reduceMotion,
    requestClose,
    handlers: dismissHandlers,
    sheetStyle,
    transitionClass,
  } = useSheetDismiss({ onClose });
  // A3: swipe the album art left/right to skip (taps still double-tap-to-like).
  const artSwipe = useSwipeNav(onNext, onPrev);
  // B1: a subtle color-from-artwork wash behind the top of the sheet.
  const accent = useArtworkColor(art);
  // Apple-Music-style full-bleed gradient sampled from the artwork: a muted,
  // slightly-vignetted wash of the cover's dominant color so white text/controls
  // stay legible over any album. Falls back to the flat dark bg when unknown.
  const bgGradient = artworkGradient(accent);
  // The OS paints the status-bar strip; theme-color is the only way to stop it
  // reading as a black seam above the wash.
  useThemeColor(gradientTopColor(bgGradient));
  // Only offer the card when there's something to put in it — a permanent
  // empty panel peeking under every song is noise, and it would leave the
  // Lyrics button scrolling you to "Lyrics not available".
  const hasLyricsCard = hasLyricsToShow(lyrics, lyricsLoading);
  // The Lyrics button is a shortcut for the scroll, not a second way to see
  // them: down to the card, and back up if you're already there.
  const toggleLyrics = () => {
    const sc = sheetScrollRef.current;
    if (!sc) return;
    // scrollHeight rather than the card's offset: the card is shorter than a
    // screen now, so its top can't reach the fold — the browser would clamp
    // and land somewhere arbitrary. Going to the end puts the whole card in
    // view, which is the actual intent.
    sc.scrollTo({
      top: atLyrics ? 0 : sc.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  };
  // Elapsed fraction for the Apple-style scrubber fill (bright fill left, faint
  // track right).
  const scrubPct =
    duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0;

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
      className={`fixed inset-0 z-40 flex flex-col overflow-hidden bg-neutral-950 text-neutral-100 ${transitionClass}`}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        // No bottom inset here on purpose: padding the ROOT stops the sheet —
        // and the lyrics card with it — a home-indicator's height above the
        // physical bottom, leaving a dead strip of wash under the card. The
        // inset moves to the scroller's padding instead, so backgrounds bleed
        // to the screen edge while content still clears the indicator.
        ...sheetStyle,
      }}
      {...dismissHandlers}
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
      <div className="shrink-0 pt-2 pb-1 flex justify-center">
        {/* Tappable as well as draggable: the swipe still works, but a tap on
            the handle is the quickest way back and costs nothing to offer.
            Goes through requestClose so it slides out like every other dismiss
            — calling onClose directly made this one path vanish instantly. */}
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close Now Playing"
          className="p-2 -m-1 active:opacity-70"
        >
          <span className="block h-1 w-9 rounded-full bg-white/40" />
        </button>
      </div>
      {/* Header: the source ("Playing from …") centered, with Connect and Queue
          pinned to the corners. px-6 is not a coincidence — it's the same inset
          the content column below uses, so Connect's box lines up with the
          song title's left edge and Queue's with the ⋯ button's right edge.
          Swipe anywhere on the sheet (below) to dismiss — matching Apple, no
          redundant close chevron. Sleep timer lives in the ⋯ menu now. */}
      <div className="px-6 py-3 shrink-0 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenConnect}
          aria-label="Connect to a device"
          title={castActive ? castActive.name : airPlayActive ? 'AirPlay' : 'Connect'}
          className={cn(
            // -ml-3 pulls the 44px tap target out by exactly the glyph's inset,
            // so the ICON's left edge — not the button box's — lands on the
            // 24px content margin the title, artwork and scrubber all share.
            'h-11 w-11 -ml-3 shrink-0 grid place-items-center rounded-full active:bg-white/20',
            castActive || airPlayActive
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          {/* The same mark the phone bar and the desktop player draw — one
              feature should not wear two different glyphs. */}
          <ConnectIcon size={20} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className={EYEBROW_ON_ART}>
            Playing from
          </div>
          <div className="text-xs font-medium truncate text-white/90">
            {album ?? 'Library'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowQueue((v) => !v);
            // Opening the queue from the lyrics card would leave you staring at
            // lyrics with a queue you can't see — go back up to the player.
            sheetScrollRef.current?.scrollTo({ top: 0 });
          }}
          aria-label="Queue"
          aria-pressed={showQueue}
          title="Queue"
          className={cn(
            // Mirror of the Connect button: -mr-3 puts the glyph's right edge
            // on 24px-from-the-right, level with the ⋯ button's circle below.
            'h-11 w-11 -mr-3 shrink-0 grid place-items-center rounded-full active:bg-white/20',
            showQueue
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          {/* 20px, not 19 — matches ConnectIcon opposite it, and makes the
              inset exactly 12px so the margins land on 24 / 351. */}
          {/* Same mark the desktop player draws. */}
          <QueueIcon size={20} />
        </button>
      </div>

      {/* The sheet body scrolls: one screenful of player, then the lyrics card
          below it. */}
      <div
        ref={sheetScrollRef}
        onScroll={(e) => setAtLyrics(e.currentTarget.scrollTop > 24)}
        className="flex-1 min-h-0 overflow-y-auto px-6 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        {/* Player pane — art, metadata, transport. A fixed one screenful,
            less the 48px that leaves the lyrics card's header row peeking.

            The `+ env(safe-area-inset-bottom)` cancels the inset that the
            scroller's own padding-bottom adds back in, so the peek is 48px on
            every device rather than 48 + the home indicator. Measured off an
            installed PWA it was 82pt — the card read as a big empty slab
            instead of a header you scroll past. */}
        <div
          className={cn(
            'flex flex-col',
            hasLyricsCard ? 'h-[calc(100%-3.5rem+env(safe-area-inset-bottom))]' : 'min-h-full',
          )}
        >
        <div
          className="flex-1 min-h-0 flex items-center justify-center py-4"
          // A size container so the cover can ask how tall its box is
          // (100cqh) and stay square instead of letterboxing.
          style={{ containerType: 'size' }}
        >
          {showQueue ? (
            <div className="w-full max-w-md h-full min-h-0">
              <QueueView />
            </div>
          ) : (
            <div
              // ART_FIT_WIDTH is the release valve for the pane's fixed
              // height: on a screen too short for a full-width square the
              // cover shrinks proportionally, staying square, instead of
              // pushing the lyrics peek off the bottom. max-h-full stays as
              // the fallback where container-query units are unsupported.
              className="max-w-md max-h-full mx-auto aspect-square rounded-2xl overflow-hidden bg-neutral-900 ring-1 ring-white/15 shadow-2xl shadow-black/60 select-none transition-transform duration-500 ease-[cubic-bezier(0.22,1.2,0.36,1)]"
              // Apple Music's signature: playing fills the content width (~24px
              // margins, like Apple), then the cover shrinks notably inward when
              // paused. 0.76 lands the paused size at roughly what the PLAYING
              // size used to be — so playing now takes up much more of the
              // screen and the shrink-on-pause reads clearly.
              style={{ width: ART_FIT_WIDTH, transform: `scale(${isPlaying ? 1 : 0.76})` }}
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
              // Each credited artist is its own tap target — a collab line like
              // "James Blake, Travis Scott, Ludwig Göransson" navigates to the
              // name that was tapped, not always the first. Same pattern as the
              // desktop NowPlayingView.
              <div className="max-w-full truncate text-sm text-white/70 mt-1">
                {artists.map((a, i) => (
                  <span key={`${a}-${i}`}>
                    {i > 0 ? ', ' : ''}
                    <button
                      type="button"
                      onClick={() => {
                        openArtistNav(a);
                        onClose();
                      }}
                      className="hover:text-white hover:underline active:opacity-80"
                      title={`Go to artist · ${a}`}
                    >
                      {a}
                    </button>
                  </span>
                ))}
              </div>
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

        {/* Lyrics card — a PREVIEW you scroll down to, not the lyrics
            themselves. It used to be a full-screen box with its own scroller
            nested inside the sheet's: scroll a little too far and you were
            deep in a list that swallowed the gesture to get back out. A few
            fixed lines and a "Show lyrics" button means there is nothing here
            to get lost in; the whole reading experience moved to its own
            screen, where it belongs. Shared with the remote device screen. */}
        {hasLyricsCard && (
          <LyricsCard
            cardRef={lyricsCardRef}
            lyrics={lyrics}
            currentTime={currentTime}
            loading={lyricsLoading}
            bg={lyricsCardBg(accent)}
            atLyrics={atLyrics}
            onToggle={toggleLyrics}
            onShowFull={() => setLyricsFull(true)}
          />
        )}
      </div>

      {lyricsFull && hasLyricsCard && (
        <FullLyricsScreen
          title={title}
          artists={artists}
          lyrics={lyrics}
          currentTime={currentTime}
          loading={lyricsLoading}
          onSeekTo={onSeekTo}
          bg={lyricsCardBg(accent)}
          onClose={() => setLyricsFull(false)}
        />
      )}

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
  castPreparing,
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
  castPreparing: boolean;
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
  const sectionHead = `${EYEBROW_ON_ART} px-3 pt-3 pb-1`;
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
        {/* Two different contracts, so two labelled groups. Everything under
            "Sound output" is a speaker this phone borrows — the phone still
            owns the playback. The devices below run Beetbot themselves and
            play on their own, which is why they're separated and spelled out. */}
        <p className={sectionHead}>Sound output</p>
        <ul className="flex flex-col" aria-label="Sound output">
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
                  disabled={castPreparing}
                  className={`${rowBase} ${active ? 'bg-white/10' : ''} disabled:opacity-50`}
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
        </ul>
        {/* Other Beetbot devices — hand the queue over ("Play on Computer").
            The heading and the line under it exist because nothing else in the
            row says what tapping does: a Mac sitting in a list of Chromecasts
            reads like one more speaker. */}
        {handoffDevices.length > 0 && (
          <>
            <p className={sectionHead}>Your Beetbot devices</p>
            {/* The sheet only opens from Now Playing, so there is always
                something to hand over — no empty-queue case to hedge for. */}
            <p className="px-3 pb-1.5 text-xs text-white/45">
              Tap one to move your music over — this phone goes quiet.
            </p>
            <ul className="flex flex-col" aria-label="Your Beetbot devices">
              {handoffDevices.map((d) => {
                const np = d.now_playing;
                const live = !!np?.is_playing;
                return (
                  <li key={`ho-${d.device_id}`}>
                    <button
                      type="button"
                      onClick={() => onHandoff(d)}
                      className={rowBase}
                    >
                      <span className={iconWrap}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <rect x="3" y="4" width="18" height="12" rx="2" />
                          <path d="M8 20h8M12 16v4" />
                        </svg>
                      </span>
                      <span className="block flex-1 min-w-0">
                        <span className="block truncate">{d.label}</span>
                        {/* What that device is doing right now — the green dot
                            is the same live cue the Devices panel uses, and it
                            only burns while the device is actually playing. */}
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-white/45">
                          {live && (
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: BEET_LIVE }}
                            />
                          )}
                          <span className="truncate">
                            {np
                              ? `${live ? '' : 'Paused · '}${np.title}${
                                  np.artists.length ? ` — ${np.artists.join(', ')}` : ''
                                }`
                              : 'Nothing playing'}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {castPreparing && (
          <p className="px-3 mt-2 flex items-center gap-2 text-xs text-white/60">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="animate-spin" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.2-8.6" />
            </svg>
            Preparing to cast…
          </p>
        )}
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
  const movePlanItem = usePlayerStore((s) => s.movePlanItem);
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
  const plan = usePlayerStore((s) => s.shuffleUpcomingIds);
  // Active drag: the grabbed DISPLAY position (within Up next) + the pointer's
  // start/current Y. Display position, not queue index — under shuffle the
  // list shows PLAN order, so the two no longer coincide. Drag is started from
  // the grip handle only, so it never competes with tap-to-jump or scrolling.
  const [drag, setDrag] = useState<{ fromPos: number; startY: number; y: number } | null>(
    null,
  );
  // Abort an in-progress drag if playback advances (or shuffle toggles) under
  // it — the grabbed position would point at a different track.
  useEffect(() => {
    setDrag(null);
  }, [currentIndex, shuffle]);
  // Current row first, then Up next in TRUE play order (sequential tail, or
  // the shuffle plan). `pos` is the display position within Up next; -1 marks
  // the now-playing row.
  const rows = useMemo(() => {
    const cur = queue[currentIndex];
    const upcoming = upcomingQueueIndices(queue, currentIndex, shuffle, plan).map(
      (i, pos) => ({ t: queue[i], i, pos }),
    );
    return cur ? [{ t: cur, i: currentIndex, pos: -1 }, ...upcoming] : upcoming;
  }, [queue, currentIndex, shuffle, plan]);
  const upNextCount = rows.length - (rows[0]?.pos === -1 ? 1 : 0);

  // Where the dragged row would drop, clamped to the Up-next range.
  const target =
    drag != null
      ? Math.max(
          0,
          Math.min(
            upNextCount - 1,
            drag.fromPos + Math.round((drag.y - drag.startY) / QUEUE_ROW_H),
          ),
        )
      : -1;

  // Translate a non-dragged upcoming row to open a gap at the drop position.
  const rowShift = (pos: number): number => {
    if (drag == null || pos < 0) return 0;
    if (target > drag.fromPos && pos > drag.fromPos && pos <= target) return -QUEUE_ROW_H;
    if (target < drag.fromPos && pos < drag.fromPos && pos >= target) return QUEUE_ROW_H;
    return 0;
  };

  const endDrag = (commit: boolean) => {
    if (drag != null && commit && target !== drag.fromPos) {
      if (shuffle) {
        // The plan IS the play order under shuffle — reorder it directly.
        movePlanItem(drag.fromPos, target);
      } else {
        // Sequential display is the contiguous queue tail: position ↔ index.
        moveItem(currentIndex + 1 + drag.fromPos, currentIndex + 1 + target);
      }
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
        {rows.map(({ t, i, pos }) => {
          const isCurrent = pos === -1;
          const isDragging = pos >= 0 && drag?.fromPos === pos;
          const translate =
            isDragging && drag ? drag.y - drag.startY : rowShift(pos);
          return (
            <Fragment key={`${i}:${t.id}`}>
              {isCurrent && (
                <li className={cn(EYEBROW_ON_ART, 'px-1 pt-1 pb-1.5')}>
                  Now playing
                </li>
              )}
              {pos === 0 && (
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
                  {pos > 0 && (
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
                      setDrag({ fromPos: pos, startY: e.clientY, y: e.clientY });
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
