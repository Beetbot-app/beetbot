import { useEffect, useRef, useState } from 'react';
import { cn, POPOVER } from '../ui';

interface Props {
  /** Epoch-ms the timer fires at, or null. */
  sleepTimerEndsAt: number | null;
  /** Whether the timer is set to "end of current track". */
  sleepAtTrackEnd: boolean;
  /** 'off' clears, 'track' = stop after this song, number = minutes from now. */
  onPick: (opt: 'off' | 'track' | number) => void;
  /** Where the menu opens relative to the button. */
  placement?: 'top' | 'bottom';
  className?: string;
}

const OPTIONS: { label: string; value: 'off' | 'track' | number }[] = [
  { label: 'Off', value: 'off' },
  { label: 'End of track', value: 'track' },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '45 minutes', value: 45 },
  { label: '1 hour', value: 60 },
];

/**
 * Moon-icon button + popover for the sleep timer. Highlights when active and
 * shows the remaining minutes as a live badge for a timed countdown. Purely
 * presentational — the parent owns the timer state and the actual pause.
 */
export function SleepTimerButton({
  sleepTimerEndsAt,
  sleepAtTrackEnd,
  onPick,
  placement = 'top',
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  const tickRef = useRef(force);
  tickRef.current = force;

  const active = sleepTimerEndsAt != null || sleepAtTrackEnd;

  // Live-refresh the remaining-minutes badge while a timed countdown runs.
  useEffect(() => {
    if (sleepTimerEndsAt == null) return;
    const id = setInterval(() => tickRef.current((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [sleepTimerEndsAt]);

  const remainingMin =
    sleepTimerEndsAt != null
      ? Math.max(0, Math.ceil((sleepTimerEndsAt - Date.now()) / 60_000))
      : null;

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Sleep timer"
        title="Sleep timer"
        className={`h-8 min-w-8 px-1 grid place-items-center rounded-md transition ${
          active
            ? 'text-neutral-100 bg-white/10'
            : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900'
        }`}
      >
        {remainingMin != null && remainingMin > 0 ? (
          <span className="text-[11px] font-semibold tabular-nums">
            {remainingMin}m
          </span>
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <div
            className={cn(
              POPOVER,
              'absolute right-0 z-50 w-44 overflow-hidden',
              placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            )}
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
              Sleep timer
            </div>
            {OPTIONS.map((o) => {
              const selected =
                (o.value === 'track' && sleepAtTrackEnd) ||
                (o.value === 'off' && !active);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  onClick={() => {
                    onPick(o.value);
                    setOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-left text-neutral-200 hover:bg-neutral-800"
                >
                  <span>{o.label}</span>
                  {selected ? <span className="text-neutral-100">✓</span> : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
