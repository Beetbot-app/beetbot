import { type ReactNode, useRef, useState } from 'react';
import { getSignInUrl, pingHub } from '@shared/api';
import { cn } from '@shared/ui';
import type { ConnPhase } from '../lib/useConnectivity';

/**
 * The connection banner. It tells the two outage modes apart (this phone is
 * offline vs. the home server is unreachable) and pulses "Back online" once the
 * server returns.
 *
 * Placement: when a track is playing it DOCKS onto the top of the mini-player —
 * a slim, state-tinted status header flush with the bar, so the two read as one
 * card (three floating islands become two) and the alert stands out from the
 * neutral chrome instead of looking like a third nav pill. With nothing playing
 * it's a standalone tinted card above the nav. Persistent while offline;
 * self-dismissing on reconnect.
 */

type Shown = Exclude<ConnPhase, 'online'>;

const COPY: Record<
  Shown,
  { label: string; tint: string; text: string; icon: string; glyph: ReactNode }
> = {
  'device-offline': {
    label: "You're offline",
    tint: 'bg-amber-900/70',
    text: 'text-amber-100',
    icon: 'text-amber-300',
    // Wi-Fi with a slash — no connection on this device.
    glyph: (
      <>
        <path d="M2 8.5a15 15 0 0 1 20 0" />
        <path d="M5 12a10 10 0 0 1 5.5-2.8" />
        <path d="M8.5 15.5a5 5 0 0 1 3-1.4" />
        <path d="M12 19h.01" />
        <path d="m3 3 18 18" />
      </>
    ),
  },
  'hub-offline': {
    label: "Can't reach your library",
    tint: 'bg-orange-900/70',
    text: 'text-orange-100',
    icon: 'text-orange-300',
    // A monitor — the home server (your computer) isn't answering.
    glyph: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
      </>
    ),
  },
  'signed-out': {
    label: 'Sign in again to reach your library',
    tint: 'bg-sky-900/70',
    text: 'text-sky-100',
    icon: 'text-sky-300',
    // A key — this is a permission problem, not a broken machine. Deliberately
    // NOT the monitor glyph: the computer is fine and pointing at it is the
    // mistake this whole state exists to stop making.
    glyph: (
      <>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13 20 3" />
        <path d="m17 6 2 2" />
        <path d="m14 9 2 2" />
      </>
    ),
  },
  reconnected: {
    label: 'Back online',
    tint: 'bg-emerald-900/70',
    text: 'text-emerald-100',
    icon: 'text-emerald-300',
    // Check — the server came back.
    glyph: <path d="m5 13 4 4L19 7" />,
  },
};

export function ConnectionBanner({
  phase,
  token,
  docked,
}: {
  phase: ConnPhase;
  token: string | null;
  /** A track is playing, so fuse onto the mini-player below instead of floating
   *  as a separate card. */
  docked: boolean;
}) {
  const visible = phase !== 'online';
  // Hold the last real phase so the text/colour don't blank mid fade-out, and
  // derive it *during render* so the correct label paints on the first frame.
  const shownRef = useRef<Shown>('device-offline');
  if (phase !== 'online') shownRef.current = phase;
  const shown = shownRef.current;
  // Freeze docked/standalone geometry through the fade too — if the track ends
  // (hasTrack→false) mid fade-out, holding the last value stops the shape from
  // morphing (corners/margin/ring) while the banner is leaving.
  const dockedRef = useRef(docked);
  if (phase !== 'online') dockedRef.current = docked;
  const dockedShown = dockedRef.current;

  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!token || retrying) return;
    setRetrying(true);
    try {
      await pingHub(token);
    } finally {
      setRetrying(false);
    }
  };

  // Read at render: the URL arrives with the 401 that produced this phase.
  const signInHref = shown === 'signed-out' ? getSignInUrl() : null;

  const c = COPY[shown];
  const pulsing = shown !== 'reconnected';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        // Only opacity/transform animate — a mid-fade docked↔standalone class
        // swap must not animate corners/margin/ring into a shape morph.
        'mx-2 flex items-center gap-2.5 px-3.5 backdrop-blur-xl transition-[opacity,transform] duration-300',
        c.tint,
        dockedShown
          ? // Fused header: rounded top only, flush with the bar below (which
            // squares its own top via flushTop), a hairline to divide them.
            'rounded-t-2xl border-b border-black/25 py-1.5'
          : // Standalone floating card above the nav.
            'mb-1 rounded-2xl py-2 ring-1 ring-white/10 shadow-lg shadow-black/40',
        visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-1 opacity-0',
      )}
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
        className={cn('shrink-0', c.icon, pulsing && 'animate-pulse')}
        aria-hidden
      >
        {c.glyph}
      </svg>
      <span className={cn('flex-1 truncate text-[13px] font-medium', c.text)}>
        {c.label}
      </span>
      {shown === 'hub-offline' && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold transition active:scale-95 disabled:opacity-50',
            'bg-white/10 text-white/90 hover:bg-white/15',
          )}
        >
          {retrying ? 'Checking…' : 'Retry'}
        </button>
      )}
      {shown === 'signed-out' && signInHref && (
        // A plain link, not a fetch: signing in is a browser journey (cookies,
        // a redirect back), so it has to happen in a real navigation. Same tab —
        // the gate sends the owner back here when it's done.
        <a
          href={signInHref}
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold transition active:scale-95',
            'bg-white/10 text-white/90 hover:bg-white/15',
          )}
        >
          Sign in
        </a>
      )}
    </div>
  );
}
