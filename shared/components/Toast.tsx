import { createPortal } from 'react-dom';

/**
 * The transient status pill. Placement:
 *  - 'nav' (default): anchored above the mini-player + bottom nav on the phone,
 *    via the --overlay-bottom CSS var.
 *  - 'floating': portal-mounted and safe-area-anchored with a backdrop (Home).
 *
 * Pair with the shared `useToast` hook, which owns the show/dismiss timing.
 */
export function Toast({
  message,
  placement = 'nav',
}: {
  message: string;
  placement?: 'nav' | 'floating';
}) {
  if (placement === 'floating') {
    return createPortal(
      <div
        className="fixed left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 6rem)' }}
      >
        <div className="bg-neutral-800/95 backdrop-blur text-neutral-100 text-sm px-4 py-2 rounded-full shadow-lg ring-1 ring-white/10">
          {message}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-neutral-800 text-sm text-neutral-100 shadow-lg pointer-events-none"
      style={{ bottom: 'calc(var(--overlay-bottom, 146px) + 0.5rem)' }}
    >
      {message}
    </div>
  );
}
