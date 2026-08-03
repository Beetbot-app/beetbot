import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn, POPOVER, SCRIM } from '@shared/ui';
import { SLEEP_OPTIONS } from '@shared/sleep';

export interface SheetAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
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
  onClose,
}: {
  quick: SheetAction[];
  items: SheetAction[];
  sleep?: { active: boolean; onPick: (opt: 'off' | 'track' | number) => void };
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
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  const rowCls =
    'w-full flex items-center gap-3 px-4 py-3 text-left text-[15px] border-t border-white/10 active:bg-white/10';
  return createPortal(
    <div
      className={cn(SCRIM, 'z-50')}
      role="dialog"
      aria-modal="true"
      aria-label="Track options"
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div className={cn(POPOVER, 'absolute right-3 bottom-[30%] w-64 max-w-[85vw] overflow-hidden rounded-2xl! text-white')}>
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
              <button key={it.key} type="button" onClick={() => run(it.onClick)} className={rowCls}>
                <span className="shrink-0 text-white/90" aria-hidden>
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
