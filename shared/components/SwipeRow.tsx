import { useRef, useState, type ReactNode } from 'react';

interface Action {
  label: string;
  /** Tailwind bg class for the revealed action area. */
  bg: string;
}

interface Props {
  children: ReactNode;
  /** Left-to-right swipe (→). */
  onSwipeRight?: () => void;
  /** Right-to-left swipe (←). */
  onSwipeLeft?: () => void;
  rightAction?: Action;
  leftAction?: Action;
  /** Px of travel needed to trigger. */
  threshold?: number;
}

/**
 * Swipe-to-action row wrapper (phone gestures). Uses Pointer Events so it
 * works for both touch and mouse. `touch-action: pan-y` lets vertical scroll
 * pass through while we own horizontal drags; a click that follows a real
 * swipe is suppressed so the row's tap-to-play doesn't also fire.
 */
export function SwipeRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  rightAction,
  leftAction,
  threshold = 72,
}: Props) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<'?' | 'x' | 'y'>('?');
  const swiped = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY };
    axis.current = '?';
    swiped.current = false;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const mx = e.clientX - start.current.x;
    const my = e.clientY - start.current.y;
    if (axis.current === '?' && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      axis.current = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis.current === 'x') {
        try {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    }
    if (axis.current === 'x') {
      let v = mx;
      if (v > 0 && !onSwipeRight) v = 0;
      if (v < 0 && !onSwipeLeft) v = 0;
      setDx(Math.max(-140, Math.min(140, v)));
    }
  };

  const end = () => {
    if (axis.current === 'x') {
      if (dx >= threshold && onSwipeRight) {
        onSwipeRight();
        swiped.current = true;
      } else if (dx <= -threshold && onSwipeLeft) {
        onSwipeLeft();
        swiped.current = true;
      }
    }
    start.current = null;
    axis.current = '?';
    setDragging(false);
    setDx(0);
  };

  return (
    <div
      className="relative overflow-hidden"
      onClickCapture={(e) => {
        if (swiped.current) {
          e.stopPropagation();
          e.preventDefault();
          swiped.current = false;
        }
      }}
    >
      {rightAction && (
        <div
          className={`absolute inset-y-0 left-0 flex items-center pl-4 text-sm font-medium text-white overflow-hidden ${rightAction.bg}`}
          style={{ width: Math.max(0, dx) }}
        >
          {dx > 28 ? rightAction.label : ''}
        </div>
      )}
      {leftAction && (
        <div
          className={`absolute inset-y-0 right-0 flex items-center justify-end pr-4 text-sm font-medium text-white overflow-hidden ${leftAction.bg}`}
          style={{ width: Math.max(0, -dx) }}
        >
          {dx < -28 ? leftAction.label : ''}
        </div>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.18s ease',
          touchAction: 'pan-y',
        }}
        className="relative bg-neutral-950"
      >
        {children}
      </div>
    </div>
  );
}
