import { EqualizerBars } from './EqualizerBars';

/**
 * The canonical now-playing marker drawn over a track's cover art, shared by
 * every phone music list (playlist, album, mix, genre, artist) so the current
 * song reads the SAME everywhere: an animated equalizer while playing, a static
 * ♪ when paused. Render it inside a `relative` cover box; it returns null when
 * the row isn't the current track.
 *
 * Keeping this in one place is the row-level half of the "one rulebook"
 * streamline — every surface imports this instead of hand-rolling its own
 * overlay (which is how Mix/Playlist ended up showing nothing at all).
 */
export function NowPlayingCover({
  current,
  playing,
  className = '',
}: {
  /** This row is the currently-selected track. */
  current: boolean;
  /** Audio is actually playing (vs current-but-paused). */
  playing: boolean;
  /** Extra classes on the overlay — e.g. `sm:hidden` when a desktop row
   *  already carries the indicator in its number gutter (never show both). */
  className?: string;
}) {
  if (!current) return null;
  return (
    <div
      className={`absolute inset-0 grid place-items-center bg-black/55 ${className}`}
      aria-hidden
    >
      {playing ? (
        <EqualizerBars className="text-white" />
      ) : (
        <span className="text-sm text-white">♪</span>
      )}
    </div>
  );
}
