import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getLyrics,
  trackArtUrl,
  type Lyrics,
  type NowPlayingInfo,
  type RemoteAction,
} from '../api';
import { ART_FIT_WIDTH, BEET_LIVE, EYEBROW_ON_ART, cn } from '../ui';
import { useSheetDismiss } from '../useSheetDismiss';
import { QueueIcon } from './QueueIcon';
import { LikeButton } from './LikeButton';
import { gradientTopColor, useThemeColor } from '../useThemeColor';
import {
  FullLyricsScreen,
  LyricsCard,
  hasLyricsToShow,
  lyricsCardBg,
} from './LyricsCard';

/**
 * The full Now Playing screen for ANOTHER device — opened by tapping that
 * device's artwork in the Devices panel.
 *
 * Built to the SAME spec as this device's own Now Playing sheet: full-bleed
 * artwork wash, grab handle, centred eyebrow header, ringed cover that shrinks
 * when paused, elapsed / remaining times, bare (uncircled) transport at the
 * same sizes, and the same lyrics card peeking underneath. Steering the
 * desktop should feel like the player you already know, not a second, plainer
 * app.
 *
 * Two honest differences. Position is shown but not scrubbable — seeking
 * another device is a bigger contract than awareness, and a scrubber that looks
 * draggable but isn't is worse than none, so this draws the fill with no thumb;
 * for the same reason the full lyrics view here doesn't take a tap-to-seek.
 * And the header's live cue is green ONLY while that device is actually
 * playing; a lamp that stays lit through a pause is just telling you something
 * untrue.
 */
export function RemoteNowPlayingScreen({
  label,
  nowPlaying,
  token,
  bgGradient,
  accent,
  onCommand,
  onPlayHere,
  onClose,
  liked,
  onToggleLike,
  onOpenMenu,
}: {
  label: string;
  nowPlaying: NowPlayingInfo;
  token: string;
  /** The artwork wash, built by the parent with the same extractor the local
   *  sheet uses. Null when the cover's colour is unknown — then the flat dark
   *  background shows through, exactly as it does locally. */
  bgGradient: string | null;
  /** Raw extracted cover colour, for the lyrics card's tint. */
  accent: string | null;
  onCommand: (action: RemoteAction) => void;
  onPlayHere: () => void;
  onClose: () => void;
  /** Favouriting is a LIBRARY action against your profile, not a playback one —
   *  the track on that device is a track in this same library, so the star
   *  belongs here exactly as it does on your own Now Playing. Optional only
   *  because a device can report a track this server doesn't know by id. */
  liked?: boolean;
  onToggleLike?: () => void;
  /** Opens the ⋯ menu. The host owns it, because its items (add to playlist,
   *  go to artist/album) act on THIS device's library and navigation, not on
   *  the remote device. */
  onOpenMenu?: () => void;
}) {
  const sheetScrollRef = useRef<HTMLDivElement | null>(null);
  const lyricsCardRef = useRef<HTMLElement | null>(null);
  // Slide-up on open, swipe-down to dismiss — the same hook the local Now
  // Playing sheet uses, so the gesture you learn on one screen works on both.
  const { requestClose, handlers: dismissHandlers, sheetStyle, transitionClass } =
    useSheetDismiss({ onClose });
  const [atLyrics, setAtLyrics] = useState(false);
  const [lyricsFull, setLyricsFull] = useState(false);
  // Swaps the artwork for that device's "Up next", the same way the local
  // sheet's Queue button does.
  const [showQueue, setShowQueue] = useState(false);
  useThemeColor(gradientTopColor(bgGradient));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const art =
    nowPlaying.track_id != null
      ? trackArtUrl(nowPlaying.track_id, token)
      : nowPlaying.album_art_url;
  const playing = nowPlaying.is_playing;
  const pos = nowPlaying.position_ms ?? null;
  const dur = nowPlaying.duration_ms ?? null;
  const queue = nowPlaying.queue ?? [];
  // What the device didn't send: it publishes at most HEARTBEAT_QUEUE_MAX rows
  // but reports the true remaining count, so the list can admit its own limit
  // instead of quietly looking like the whole queue.
  const queueHidden = Math.max(0, (nowPlaying.queue_len ?? queue.length) - queue.length);

  // Lyrics for whatever that device is playing. Same LRCLIB lookup the local
  // player uses — signature-based, so it needs no cooperation from the other
  // device beyond the title/artist its heartbeat already sends.
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const trackKey = `${nowPlaying.track_id ?? ''}|${nowPlaying.title}`;
  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setLyricsLoading(true);
    getLyrics(token, {
      title: nowPlaying.title,
      artist: nowPlaying.artists[0] ?? '',
      durationMs: nowPlaying.duration_ms ?? undefined,
    })
      .then((l) => {
        if (!cancelled) setLyrics(l);
      })
      .catch(() => {
        if (!cancelled) setLyrics(null);
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey, token]);

  // The other device's position arrives on a ~2s heartbeat. Shown raw that's
  // fine for a progress bar and useless for lyrics: a line would land up to
  // two seconds late and then jump. So run a local clock between heartbeats —
  // anchor on each new reading, advance in real time while it's playing, and
  // let the next reading correct any drift.
  // `playing` is part of the anchor, not read live: while paused the anchor's
  // timestamp keeps ageing, so the render that first sees playing = true would
  // otherwise add the whole paused interval before the effect below re-anchors
  // — the clock jumped forward and snapped back the moment you hit play
  // (measured: 0:05 then 0:02).
  const anchor = useRef({ pos: pos ?? 0, at: Date.now(), playing: false });
  const [, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const projected =
      anchor.current.pos + (anchor.current.playing ? now - anchor.current.at : 0);
    const reading = pos ?? 0;
    // Each reading was sampled on the other device a moment before it reached
    // us, so it usually lands slightly BEHIND the clock we've been showing.
    // Snapping to it makes the timer tick backwards and the highlighted lyric
    // flicker to the previous line. Take the reading when it's ahead, or when
    // it's far enough off to be a real seek / track change; otherwise keep our
    // own clock and let the next reading catch up to it.
    const isJump = Math.abs(reading - projected) > 1500;
    anchor.current = {
      pos: !playing || isJump || reading > projected ? reading : projected,
      at: now,
      playing,
    };
    setTick((t) => t + 1);
  }, [pos, playing, trackKey]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [playing]);
  const livePos =
    pos == null
      ? null
      : Math.min(
          anchor.current.pos +
            (playing && anchor.current.playing ? Date.now() - anchor.current.at : 0),
          dur ?? Number.POSITIVE_INFINITY,
        );

  const pct = livePos != null && dur != null && dur > 0 ? (livePos / dur) * 100 : 0;
  const mmss = (ms: number) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  const hasLyricsCard = hasLyricsToShow(lyrics, lyricsLoading);
  const toggleLyrics = () => {
    const sc = sheetScrollRef.current;
    if (!sc) return;
    sc.scrollTo({ top: atLyrics ? 0 : sc.scrollHeight, behavior: 'smooth' });
  };

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex flex-col overflow-hidden bg-neutral-950 text-neutral-100 ${transitionClass}`}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        // The bottom inset lives on the scroller's padding, not here — padding
        // the root would stop the lyrics card a home-indicator's height above
        // the screen and leave a dead strip of wash beneath it.
        ...sheetStyle,
      }}
      {...dismissHandlers}
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing on ${label}`}
    >
      {/* Full-bleed artwork wash, the same one the local sheet wears. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 transition-opacity duration-500"
        style={{ background: bgGradient ?? 'none', opacity: bgGradient ? 1 : 0 }}
      />

      <div className="shrink-0 pt-2 pb-1 flex justify-center">
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close"
          className="p-2 -m-1 active:opacity-70"
        >
          <span className="block h-1 w-9 rounded-full bg-white/40" />
        </button>
      </div>

      {/* Centred header, mirroring the local sheet's "Playing from" — and its
          Queue button in the same right corner, on the same 24px content
          margin (a 44px target centres its 20px glyph 12px in, so -mr-3 puts
          the icon's edge on the line). The left corner holds an equal-width
          spacer instead of Connect: you're already looking at one device, so
          there's nothing for it to do here, but the label must stay centred. */}
      <div className="px-6 py-3 shrink-0 flex items-center gap-2">
        <span className="h-11 w-11 -ml-3 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0 text-center">
          <div className={EYEBROW_ON_ART}>Playing on</div>
          <div
            className="text-xs font-medium truncate flex items-center justify-center gap-1.5"
            style={{ color: playing ? BEET_LIVE : 'rgba(255,255,255,0.9)' }}
          >
            {playing && (
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: BEET_LIVE }}
              />
            )}
            {label}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowQueue((v) => !v)}
          disabled={queue.length === 0}
          aria-label={`Queue on ${label}`}
          aria-pressed={showQueue}
          title="Queue"
          className={cn(
            'h-11 w-11 -mr-3 shrink-0 grid place-items-center rounded-full active:bg-white/20',
            'disabled:opacity-30 disabled:pointer-events-none',
            showQueue
              ? 'text-white bg-white/10'
              : 'text-white/70 hover:bg-white/10 hover:text-white',
          )}
        >
          <QueueIcon size={20} />
        </button>
      </div>

      <div
        ref={sheetScrollRef}
        onScroll={(e) => setAtLyrics(e.currentTarget.scrollTop > 24)}
        className="flex-1 min-h-0 overflow-y-auto px-6 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        {/* Same arithmetic as the local sheet: a fixed one-screenful pane, less
            3.5rem, leaves exactly the lyrics card's header row peeking. */}
        <div
          className={cn(
            'flex flex-col',
            hasLyricsCard ? 'h-[calc(100%-3.5rem+env(safe-area-inset-bottom))]' : 'min-h-full',
          )}
        >
          <div
            className="flex-1 min-h-0 flex items-center justify-center py-2"
            // A size container so the cover can ask how tall its box is
            // (100cqh) and stay square instead of letterboxing.
            style={{ containerType: 'size' }}
          >
            {showQueue ? (
              /* That device's "Up next". Read-only on purpose: reordering or
                 removing would need remote commands that don't exist, and a
                 row that looks draggable but isn't is worse than a plain
                 list — the same call the thumbless scrubber makes. */
              <div className="w-full max-w-md h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className={cn(EYEBROW_ON_ART, 'sticky top-0 pb-2')}>Up next</div>
                <ul className="flex flex-col">
                  {queue.map((t, i) => (
                    <li
                      key={`${t.id}-${i}`}
                      className="flex items-center gap-3 py-2 border-b border-white/5 last:border-b-0"
                    >
                      <span className="h-10 w-10 shrink-0 overflow-hidden rounded bg-neutral-800">
                        <img
                          src={trackArtUrl(t.id, token)}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{t.title}</span>
                        <span className="block truncate text-xs text-white/55">
                          {t.artists.join(', ')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {queueHidden > 0 && (
                  <p className="py-3 text-xs text-white/45">
                    and {queueHidden} more on {label}
                  </p>
                )}
              </div>
            ) : (
            <div
              className="max-w-md max-h-full mx-auto aspect-square rounded-2xl overflow-hidden bg-neutral-900 ring-1 ring-white/15 shadow-2xl shadow-black/60 select-none transition-transform duration-500 ease-[cubic-bezier(0.22,1.2,0.36,1)]"
              // Same shrink-on-pause as the local sheet, so "is it playing?" is
              // readable from across the room on either screen. ART_FIT_WIDTH
              // keeps it square when the box is shorter than it is wide, which
              // this screen hits first — its extra button costs 46px of height.
              style={{ width: ART_FIT_WIDTH, transform: `scale(${playing ? 1 : 0.76})` }}
            >
              {art ? (
                <img
                  src={art}
                  alt=""
                  draggable={false}
                  // Same slow breathe the local sheet uses while playing, so a
                  // remote screen feels alive rather than frozen.
                  className={cn(
                    'h-full w-full object-cover transition-transform duration-700',
                    playing && 'animate-[beetbot-breathe_7s_ease-in-out_infinite]',
                  )}
                />
              ) : (
                <div className="h-full w-full grid place-items-center text-5xl text-neutral-700">
                  ♪
                </div>
              )}
            </div>
            )}
          </div>

          <div className="shrink-0">
            {/* Title block + star, laid out like the local sheet's. */}
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold truncate">{nowPlaying.title}</h1>
                <p className="text-neutral-300 truncate">
                  {nowPlaying.artists.join(', ')}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onToggleLike && (
                  <LikeButton
                    liked={!!liked}
                    onToggle={onToggleLike}
                    size={22}
                    className="h-10 w-10 rounded-full bg-white/15 hover:bg-white/25 active:scale-95 shrink-0"
                  />
                )}
                {onOpenMenu && (
                  <button
                    type="button"
                    onClick={onOpenMenu}
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
                )}
              </div>
            </div>

            {/* Local geometry — bright fill left, faint track right — minus the
                thumb, since this one reports position rather than setting it.
                Driven by the interpolated clock, so it creeps rather than
                stepping once every heartbeat. */}
            <div className="mt-5">
              <div className="h-1 rounded-full bg-white/25 overflow-hidden">
                <div
                  className="h-full rounded-full bg-white/90 transition-[width] duration-300 ease-linear"
                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-white/60">
                <span>{livePos != null ? mmss(livePos) : '--:--'}</span>
                <span>
                  {livePos != null && dur != null
                    ? `-${mmss(Math.max(0, dur - livePos))}`
                    : '--:--'}
                </span>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-center gap-6">
              <button
                type="button"
                onClick={() => onCommand('prev')}
                aria-label={`Previous on ${label}`}
                className="h-14 w-14 grid place-items-center text-white active:scale-90 transition"
              >
                <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M11.5 6 11.5 18 3.5 12z" />
                  <path d="M20.5 6 20.5 18 12.5 12z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => onCommand(playing ? 'pause' : 'play')}
                aria-label={`${playing ? 'Pause' : 'Play'} on ${label}`}
                className="h-16 w-16 grid place-items-center text-white active:scale-90 transition"
              >
                {playing ? (
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                ) : (
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={() => onCommand('next')}
                aria-label={`Next on ${label}`}
                className="h-14 w-14 grid place-items-center text-white active:scale-90 transition"
              >
                <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12.5 6 12.5 18 20.5 12z" />
                  <path d="M3.5 6 3.5 18 11.5 12z" />
                </svg>
              </button>
            </div>

            <button
              type="button"
              onClick={onPlayHere}
              className={cn(
                'mt-4 w-full rounded-full border border-white/20 py-3',
                'text-sm font-medium text-white active:bg-white/10',
              )}
            >
              Play here instead
            </button>
          </div>
        </div>

        {hasLyricsCard && (
          <LyricsCard
            cardRef={lyricsCardRef}
            lyrics={lyrics}
            currentTime={(livePos ?? 0) / 1000}
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
          title={nowPlaying.title}
          artists={nowPlaying.artists}
          lyrics={lyrics}
          currentTime={(livePos ?? 0) / 1000}
          loading={lyricsLoading}
          // No onSeekTo: tapping a line would promise a seek this screen can't
          // deliver on another device.
          bg={lyricsCardBg(accent)}
          onClose={() => setLyricsFull(false)}
        />
      )}
    </div>,
    document.body,
  );
}
