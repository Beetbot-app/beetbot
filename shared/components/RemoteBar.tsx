import { trackArtUrl, type NowPlayingInfo } from '../api';
import { BEET_LIVE } from '../ui';
import { ConnectIcon } from './ConnectIcon';

interface Props {
  /** The other device's display name, e.g. "Computer". */
  label: string;
  nowPlaying: NowPlayingInfo;
  /** This device's token — the other device's artwork is fetched with OUR
   *  credential, since theirs would be useless to us. */
  token: string;
  /** Match the local bar's home-indicator padding. */
  bottomInset?: boolean;
  /** The other device's album wash + accent, computed by the parent with the
   *  SAME extractor the local bar uses, so both bars look like one control. */
  washBg: string;
  onPlayPause: () => void;
  onNext: () => void;
  /** Toggle the inline device panel. */
  onOpenDevices: () => void;
  /** True while the panel is open — the icon reads as a toggle. */
  devicesOpen?: boolean;
  /** The device panel, rendered INSIDE this card so the bar grows upward
   *  instead of a modal appearing over the page. */
  panel?: React.ReactNode;
}

/**
 * The player bar, pointed at ANOTHER device.
 *
 * Shown only when this device has nothing of its own loaded and something else
 * is playing — so it stands in for the local bar rather than stacking above it
 * (two competing Now Playing surfaces was the thing that made this feel unlike
 * Spotify Connect). The moment you play something here, the local bar takes
 * over again and the other device carries on untouched: on a household server
 * two devices genuinely may play different music, which is the one place we
 * deliberately diverge from Connect's single-stream model.
 *
 * Layout mirrors the local mini bar — artwork, title, transport, progress
 * hairline — so switching between "mine" and "theirs" reads as the same
 * control, not a different widget.
 */
export function RemoteBar({
  label,
  nowPlaying,
  token,
  washBg,
  bottomInset = true,
  onPlayPause,
  onNext,
  onOpenDevices,
  devicesOpen = false,
  panel,
}: Props) {
  // `album_art_url` is null for most library tracks — the cover lives behind
  // a token-signed endpoint, so build it from the id with our own token.
  const art =
    nowPlaying.track_id != null
      ? trackArtUrl(nowPlaying.track_id, token)
      : nowPlaying.album_art_url;
  const pos = nowPlaying.position_ms ?? null;
  const dur = nowPlaying.duration_ms ?? null;
  const pct =
    pos != null && dur != null && dur > 0
      ? Math.max(0, Math.min(100, (pos / dur) * 100))
      : null;

  return (
    // Sits in the SAME layout slot as the local mini bar — normal flow, just
    // above the bottom nav, never `fixed`. Pinning it to the viewport bottom
    // covered the nav and swallowed its taps.
    <div
      className="pointer-events-auto shrink-0 mx-2 mb-1 overflow-hidden rounded-2xl backdrop-blur-xl transition-[background-color,box-shadow] duration-500"
      style={{
        paddingBottom: bottomInset ? 'env(safe-area-inset-bottom)' : 0,
        // Same wash + accent edge-glow the local bar wears while playing.
        backgroundColor: washBg,
        boxShadow: nowPlaying.is_playing
          ? '0 6px 24px rgba(0,0,0,0.45), 0 0 0 1px color-mix(in srgb, var(--color-accent) 22%, transparent), 0 0 22px -7px var(--color-accent)'
          : '0 6px 24px rgba(0,0,0,0.45)',
      }}
    >
      <div>
        {panel}
        <div className="px-3 py-2.5 flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenDevices}
            aria-label="Devices"
            className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg active:opacity-80"
          >
            <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
              {art ? (
                <img
                  src={art}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="text-neutral-500">♪</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {/* The Connect tell: name the device you're steering, above the
                  track — so it's never ambiguous whose music this is. */}
              <div
                className="text-[10px] uppercase tracking-wide leading-tight flex items-center gap-1.5 min-w-0"
                style={{ color: BEET_LIVE }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: BEET_LIVE }}
                />
                <span className="truncate">Playing on {label}</span>
              </div>
              <div className="text-sm font-medium truncate leading-tight">
                {nowPlaying.title}
              </div>
              <div className="text-xs text-neutral-400 truncate leading-tight">
                {nowPlaying.artists.join(', ')}
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenDevices}
            aria-label="Devices"
            aria-expanded={devicesOpen}
            className="h-11 w-9 shrink-0 grid place-items-center text-neutral-300 active:scale-90 transition"
          >
            <ConnectIcon size={20} />
          </button>
          <button
            type="button"
            onClick={onPlayPause}
            aria-label={`${nowPlaying.is_playing ? 'Pause' : 'Play'} on ${label}`}
            className="h-11 w-11 shrink-0 grid place-items-center text-white active:scale-90 transition"
          >
            {nowPlaying.is_playing ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label={`Next on ${label}`}
            className="h-11 w-9 shrink-0 grid place-items-center text-neutral-200 active:scale-90 transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M4 6l11 6L4 18zM16 6h2v12h-2z" />
            </svg>
          </button>
        </div>

        {/* Progress for the OTHER device. Absent on a device running an older
            build (it reports no position) — then we simply draw no line rather
            than a lying zero. */}
        {pct != null && (
          <div className="mx-3 mb-2 h-[3px] rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full"
              style={{
                width: `${pct}%`,
                backgroundColor: nowPlaying.is_playing
                  ? `var(--color-accent, ${BEET_LIVE})`
                  : 'rgba(255,255,255,0.85)',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
