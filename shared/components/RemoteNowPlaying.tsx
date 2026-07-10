import type { NowPlayingInfo } from '../api';
import { cn, POPOVER } from '../ui';

interface Props {
  /** The other device's display name, e.g. "Computer" / "Phone". */
  label: string;
  nowPlaying: NowPlayingInfo;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Pull the other device's queue + playhead onto *this* device and continue
   *  here (the other device pauses). */
  onSync: () => void;
}

/**
 * Compact "playing on <device>" banner with remote transport controls. Shown
 * on a device when *another* device is actively playing, so you can see and
 * steer it (play / pause / skip) without leaving what you're doing. The two
 * players stay independent — this is awareness + control, not unified
 * playback. The parent positions it (typically a fixed bar near the top).
 */
export function RemoteNowPlaying({
  label,
  nowPlaying,
  onPlayPause,
  onPrev,
  onNext,
  onSync,
}: Props) {
  return (
    <div className={cn(POPOVER, 'flex items-center gap-3 px-3 py-2')}>
      <div className="h-9 w-9 shrink-0 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
        {nowPlaying.album_art_url ? (
          <img
            src={nowPlaying.album_art_url}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="text-neutral-500">♪</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-neutral-200 flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white" />
          Playing on {label}
        </div>
        <div className="text-sm text-neutral-100 truncate">
          {nowPlaying.title}
          {nowPlaying.artists.length > 0 ? (
            <span className="text-neutral-400">
              {' · '}
              {nowPlaying.artists.join(', ')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 text-neutral-200">
        <button
          type="button"
          onClick={onPrev}
          aria-label={`Previous on ${label}`}
          className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 active:bg-white/10 active:scale-95"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M6 6h2v12H6zM20 6 9 12l11 6z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onPlayPause}
          aria-label={`${nowPlaying.is_playing ? 'Pause' : 'Play'} on ${label}`}
          className="h-9 w-9 grid place-items-center rounded-full bg-white text-neutral-950 hover:bg-neutral-200 active:scale-95"
        >
          {nowPlaying.is_playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label={`Next on ${label}`}
          className="h-8 w-8 grid place-items-center rounded-full hover:bg-white/10 active:bg-white/10 active:scale-95"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M4 6l11 6L4 18zM16 6h2v12h-2z" />
          </svg>
        </button>
        <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden />
        {/* Sync to here: pull the other device's queue + playhead onto this
            device and continue (the other device pauses). */}
        <button
          type="button"
          onClick={onSync}
          aria-label={`Play ${label}'s music here`}
          title={`Play ${label}'s music here`}
          className="h-8 w-8 grid place-items-center rounded-full text-neutral-200 hover:bg-white/10 active:bg-white/10 active:scale-95"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v11" />
            <path d="m8 12 4 4 4-4" />
            <path d="M5 21h14" />
          </svg>
        </button>
      </div>
    </div>
  );
}
