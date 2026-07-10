import { useCallback, useRef, useState } from 'react';

/** Height of the global desktop top bar (search). Sticky page headers pin just
 *  below it so they're never hidden behind the translucent bar. The phone has
 *  no such bar, but pinning a little below the top reads fine there too. */
export const TOP_BAR_PX = 56;

/**
 * Spotify-style condensed-header trigger. Returns `[condensed, sentinelRef]`:
 * attach the returned ref to a 1px sentinel at the point in the hero where the
 * condensed bar should take over; `condensed` flips true once that sentinel
 * scrolls above the top bar.
 *
 * Uses a callback ref (not a ref object) so the observer is wired up the moment
 * the sentinel mounts — even when it appears after a loading gate — and observes
 * against the viewport, so it works regardless of which element is scrolling.
 */
export function useCondensedHeader(): [
  boolean,
  (node: HTMLElement | null) => void,
] {
  const [condensed, setCondensed] = useState(false);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const setSentinel = useCallback((node: HTMLElement | null) => {
    ioRef.current?.disconnect();
    ioRef.current = null;
    if (!node) return;
    const io = new IntersectionObserver(
      // Condense only when the sentinel has scrolled ABOVE the bar. A sentinel
      // that's merely below the viewport (tall hero on a short viewport, e.g.
      // landscape Safari) is also "not intersecting" — but the hero title is
      // still on screen, so condensing there would double the title.
      ([entry]) =>
        setCondensed(
          !entry.isIntersecting &&
            entry.boundingClientRect.top < TOP_BAR_PX,
        ),
      { threshold: 0, rootMargin: `-${TOP_BAR_PX}px 0px 0px 0px` },
    );
    io.observe(node);
    ioRef.current = io;
  }, []);
  return [condensed, setSentinel];
}

/**
 * Compact sticky header (Spotify-style): a small Play button + the title that
 * fades in once you've scrolled past the hero. Rendered with zero flow height
 * (its visual bar overflows downward) so it overlaps the content rather than
 * pushing it down, and pins just under the global top bar.
 */
export function CondensedHeaderBar({
  condensed,
  title,
  onPlay,
  playing,
}: {
  condensed: boolean;
  title: string;
  onPlay: () => void;
  /** True when this playlist/album is the current playback and it's playing —
   *  the button then shows ⏸ and toggles, mirroring the now-playing bar. */
  playing?: boolean;
}) {
  return (
    // Desktop-only render (Playlist + inline AlbumDetailModal). The content card
    // now sits BELOW the transparent header, so the condensed bar pins to the
    // card's own top (top-0) rather than 56px down.
    <div className="sticky top-0 z-30 h-0">
      <div
        className={`flex h-14 items-center gap-3 px-6 transition-opacity duration-200 ${
          condensed
            ? 'opacity-100 bg-neutral-950/80 backdrop-blur-md border-b border-white/5'
            : 'pointer-events-none opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={onPlay}
          aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-neutral-950 shadow transition hover:scale-105 hover:bg-neutral-200"
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <span className="truncate text-lg font-bold tracking-tight">{title}</span>
      </div>
    </div>
  );
}
