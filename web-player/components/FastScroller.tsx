import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

interface Props {
  /** The scroll container to drive (the phone's <main>). Nullable because
   *  `useRef<HTMLElement>(null)` yields `RefObject<HTMLElement | null>`; every
   *  read below already guards on it. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Attach + show only while this screen is active (e.g. the Library). */
  active: boolean;
}

// Only offer fast-scroll once the list runs meaningfully past the viewport, so
// short libraries don't get a pointless thumb.
const MIN_OVERFLOW_PX = 800;
const HIDE_DELAY_MS = 1600;
const THUMB_H = 44;

/**
 * A draggable fast-scroll thumb pinned to the right edge (Spotify-style). It
 * mirrors the scroll container's position while scrolling and lets you drag to
 * scrub a long list; it fades out when idle. Phone-only (pointer/touch drag) —
 * desktop has a real scrollbar + wheel.
 */
export function FastScroller({ scrollRef, active }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Mirror the container's scroll position onto the thumb. Written straight to
  // the DOM (not state) so a fast scroll doesn't re-render on every frame.
  const positionThumb = useCallback(() => {
    const sc = scrollRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb) return;
    const max = sc.scrollHeight - sc.clientHeight;
    const usable = Math.max(0, track.clientHeight - THUMB_H);
    const t = max > 0 ? sc.scrollTop / max : 0;
    thumb.style.transform = `translateY(${Math.round(t * usable)}px)`;
  }, [scrollRef]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!draggingRef.current) setVisible(false);
    }, HIDE_DELAY_MS);
  }, []);

  // Attach the scroll listener while active; keep `enabled` in sync as the
  // (async-loaded) library content grows past the viewport.
  useEffect(() => {
    if (!active) {
      setVisible(false);
      setEnabled(false);
      return;
    }
    const sc = scrollRef.current;
    if (!sc) return;
    const recheck = () => {
      setEnabled(sc.scrollHeight - sc.clientHeight > MIN_OVERFLOW_PX);
      positionThumb();
    };
    recheck();
    // Library data lands after mount → the list grows; re-measure a few times.
    const t1 = window.setTimeout(recheck, 300);
    const t2 = window.setTimeout(recheck, 1200);
    const onScroll = () => {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          positionThumb();
        });
      }
      setEnabled(sc.scrollHeight - sc.clientHeight > MIN_OVERFLOW_PX);
      setVisible(true);
      scheduleHide();
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', recheck);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', recheck);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [active, scrollRef, positionThumb, scheduleHide]);

  // Map a pointer Y (viewport coords) to a scroll position — the thumb's center
  // follows the finger.
  const scrubTo = useCallback(
    (clientY: number) => {
      const sc = scrollRef.current;
      const track = trackRef.current;
      if (!sc || !track) return;
      const rect = track.getBoundingClientRect();
      const usable = Math.max(1, track.clientHeight - THUMB_H);
      const max = sc.scrollHeight - sc.clientHeight;
      let top = clientY - rect.top - THUMB_H / 2;
      top = Math.max(0, Math.min(usable, top));
      sc.scrollTop = (top / usable) * max;
    },
    [scrollRef],
  );

  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    scrubTo(e.clientY);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    e.preventDefault();
    scrubTo(e.clientY);
  };
  const onUp = (e: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    scheduleHide();
  };

  if (!active) return null;
  const shown = enabled && (visible || dragging);

  return (
    <div
      ref={trackRef}
      aria-hidden={!shown}
      className="pointer-events-none fixed right-0 z-30 w-10"
      style={{
        top: 'calc(env(safe-area-inset-top) + 60px)',
        bottom: 'calc(var(--overlay-bottom, 96px) + 12px)',
      }}
    >
      {/* The draggable thumb. `top-0` + a translateY transform positions it. */}
      <button
        ref={thumbRef}
        type="button"
        aria-label="Fast scroll"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className={`absolute right-1.5 top-0 grid h-11 w-8 touch-none place-items-center rounded-full bg-neutral-700/95 text-neutral-100 shadow-lg ring-1 ring-white/10 backdrop-blur transition-opacity duration-200 active:bg-neutral-600 ${
          shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
