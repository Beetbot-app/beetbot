import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn, POPOVER } from '@shared/ui';
import { SLEEP_OPTIONS } from '@shared/sleep';

export interface SheetAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Renders in red, iOS-style. Put destructive actions LAST — the divider
   *  above them is the only thing standing between a tap meant for the row
   *  above and something that can't be undone. */
  destructive?: boolean;
}

/**
 * A track "⋯" menu, styled like an iOS context menu (Apple Music): a rounded,
 * frosted popover with a top row of quick actions (Favorite · Add)
 * over a list (Go to Artist/Album · Sleep Timer). Sleep Timer (optional —
 * only the now-playing overlay passes it) flips the popover to a time-picker
 * sub-view. Used by the Now Playing overlay and playlist track rows.
 */
export function TrackActionSheet({
  quick,
  items,
  sleep,
  anchor,
  onClose,
}: {
  quick: SheetAction[];
  items: SheetAction[];
  sleep?: { active: boolean; onPick: (opt: 'off' | 'track' | number) => void };
  /** Viewport rect of the control that opened this (a "⋯" button's
   *  `getBoundingClientRect()`). When given, the popover opens against that
   *  control instead of the default position — a menu that appears far from
   *  the thing you tapped reads as belonging to something else. Omit for the
   *  track-row callers, whose default placement is tuned for a long list. */
  anchor?: { top: number; bottom: number; left: number; right: number };
  onClose: () => void;
}) {
  const [view, setView] = useState<'main' | 'sleep'>('main');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Placement is MEASURED, not guessed. An earlier version assumed a menu
  // height to decide above-or-below, which is fine for a two-item menu and
  // wrong for a track menu with a dozen rows — it would open downward off the
  // bottom of the screen. Measure the rendered popover, then place it.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    maxHeight?: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const el = popRef.current;
    if (!el) return;
    const GAP = 8; // breathing room between the control and its menu
    const EDGE = 12; // viewport gutter
    const h = el.offsetHeight;
    const right = Math.max(EDGE, window.innerWidth - anchor.right);
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    if (h <= below) {
      setPos({ top: anchor.bottom + GAP, right });
    } else if (h <= above) {
      setPos({ bottom: window.innerHeight - anchor.top + GAP, right });
    } else if (below >= above) {
      // Doesn't fit either way: take the roomier side and scroll inside.
      setPos({ top: anchor.bottom + GAP, right, maxHeight: below });
    } else {
      setPos({ bottom: window.innerHeight - anchor.top + GAP, right, maxHeight: above });
    }
    // `view` is a dependency because the sleep sub-view changes the height.
  }, [anchor, view]);

  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  const rowCls =
    'w-full flex items-center gap-3 px-4 py-3 text-left text-[15px] border-t border-white/10 active:bg-white/10';
  return createPortal(
    <div
      // NOT the shared SCRIM (70% black): that weight is right for a confirm
      // dialog, which wants the page gone, and wrong for a context menu, which
      // is a comment ON the page — Apple keeps the list readable behind it so
      // you can still see the row you tapped. Light dim + a soft blur reads as
      // "this menu is in front", not "the app went away". Still full-bleed:
      // it's the tap-anywhere-to-dismiss target.
      className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Track options"
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div
        ref={popRef}
        className={cn(
          POPOVER,
          'absolute w-64 max-w-[85vw] rounded-2xl! text-white',
          pos?.maxHeight ? 'overflow-y-auto' : 'overflow-hidden',
          // Default placement: tuned for a "⋯" partway down a track list.
          !anchor && 'right-3 bottom-[30%]',
          // Anchored menus stay invisible for the one frame between render and
          // measurement, so they never flash at the wrong spot first.
          anchor && !pos && 'opacity-0',
        )}
        style={pos ?? undefined}
      >
        {view === 'main' ? (
          <>
            <div className="flex divide-x divide-white/10">
              {quick.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => run(q.onClick)}
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 active:bg-white/10"
                >
                  <span aria-hidden>{q.icon}</span>
                  <span className="text-[11px] font-medium">{q.label}</span>
                </button>
              ))}
            </div>
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                onClick={() => run(it.onClick)}
                className={cn(rowCls, it.destructive && 'text-red-400')}
              >
                <span
                  className={cn('shrink-0', it.destructive ? 'text-red-400' : 'text-white/90')}
                  aria-hidden
                >
                  {it.icon}
                </span>
                <span className="flex-1">{it.label}</span>
              </button>
            ))}
            {sleep && (
              <button type="button" onClick={() => setView('sleep')} className={rowCls}>
                <span className="shrink-0 text-white/90" aria-hidden>
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" />
                  </svg>
                </span>
                <span className="flex-1">Sleep Timer</span>
                {sleep.active && <span className="text-xs text-white/45">On</span>}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-white/40 shrink-0">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            )}
          </>
        ) : sleep ? (
          <>
            <button
              type="button"
              onClick={() => setView('main')}
              className="w-full flex items-center gap-1 px-3 py-3 text-left border-b border-white/10 active:bg-white/10"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-white/60">
                <path d="m15 6-6 6 6 6" />
              </svg>
              <span className="text-sm font-semibold">Sleep Timer</span>
            </button>
            {SLEEP_OPTIONS.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => run(() => sleep.onPick(o.value))}
                className="w-full flex items-center px-4 py-3 text-left text-[15px] border-t border-white/10 first:border-t-0 active:bg-white/10"
              >
                <span className="flex-1">{o.label}</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
