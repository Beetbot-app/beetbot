import { useCallback, useEffect, useRef, useState } from 'react';

/** Track the OS "Reduce Motion" setting so we can swap slide/scale transitions
 *  for instant cross-fades (Apple replaces zoom transitions with a fade under
 *  Reduce Motion; the web equivalent is this media query). */
export function usePrefersReducedMotion(): boolean {
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

/** True when the touch began inside a scroll region that is scrolled away from
 *  the top — there, a downward drag must scroll that region rather than pull
 *  the sheet, which is what Apple Music does. */
function startsInScrolledRegion(target: HTMLElement | null): boolean {
  let el: HTMLElement | null = target;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollTop > 0) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Slide-up-on-open and swipe-down-to-dismiss for a full-screen sheet.
 *
 * Shared because two sheets need identical behaviour: this device's Now Playing
 * and the one for a device playing elsewhere. They had drifted — the remote one
 * could only be closed by tapping its grab handle, so the gesture you learn on
 * one screen silently failed on the other.
 *
 * Wire `handlers` to the sheet root, spread `sheetStyle` into its style, and add
 * `transitionClass` to its className. Call `requestClose` from anything that
 * dismisses (handle tap, Escape) so it slides out rather than vanishing.
 */
export function useSheetDismiss({
  onClose,
  /** Drag distance, in px, past which release dismisses instead of springing back. */
  threshold = 120,
}: {
  onClose: () => void;
  threshold?: number;
}) {
  const reduceMotion = usePrefersReducedMotion();
  // `entered` drives the mount slide (false→true on the first frame); `dragY`
  // follows a downward drag; `dragging` disables the spring transition so the
  // sheet tracks the finger 1:1.
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragYRef = useRef(0);
  const dismissStart = useRef<{ x: number; y: number } | null>(null);
  const dismissAxis = useRef<'none' | 'v' | 'h'>('none');
  // Per-gesture flag: true when this touch must NOT drive the swipe — it began
  // on an interactive control, or inside a scrolled-down region.
  const dismissDisabled = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Lock background scroll for as long as the sheet is up. Without it a
  // downward drag pulls the sheet AND scrolls the page behind it, so closing
  // the sheet drops you somewhere you never navigated to. Saving the previous
  // value rather than assuming '' keeps nesting honest: a sheet opened over
  // another restores 'hidden', not scrollable.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
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

  // Cancel a pending slide-out if the sheet unmounts for an external reason
  // (the track clears, the device drops off) so onClose never fires post-unmount.
  useEffect(
    () => () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    dismissDisabled.current =
      !!target?.closest(
        'button, input, a, [role="button"], [role="slider"], [data-no-dismiss]',
      ) || startsInScrolledRegion(target);
    const t = e.touches[0];
    dismissStart.current = { x: t.clientX, y: t.clientY };
    dismissAxis.current = 'none';
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (dismissDisabled.current) return;
    const s = dismissStart.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // Axis-lock once the finger has committed, so a horizontal swipe never
    // drags the sheet a few pixels on its way.
    if (dismissAxis.current === 'none' && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      dismissAxis.current = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    }
    if (dismissAxis.current === 'v' && dy > 0) {
      dragYRef.current = dy;
      if (!dragging) setDragging(true);
      setDragY(dy);
    }
  };
  const onTouchEnd = () => {
    dismissStart.current = null;
    dismissAxis.current = 'none';
    const y = dragYRef.current;
    dragYRef.current = 0;
    setDragging(false);
    if (y > threshold) {
      requestClose();
    } else {
      setDragY(0);
    }
  };

  return {
    reduceMotion,
    entered,
    dragY,
    dragging,
    requestClose,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
    },
    /** Transform + the corner rounding that reveals the app behind as you pull. */
    sheetStyle: {
      transform:
        entered || reduceMotion ? `translateY(${dragY}px)` : 'translateY(100%)',
      borderRadius: dragY > 0 ? Math.min(28, dragY * 0.6) : 0,
    } as React.CSSProperties,
    transitionClass:
      dragging || reduceMotion ? '' : 'transition-[transform,border-radius] duration-300',
  };
}
