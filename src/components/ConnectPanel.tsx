import { useConnectStore } from '@/lib/connect';

/**
 * The RightBar "Connect" tab — see where playback is and send it elsewhere,
 * in the same docked panel style as Lyrics / Up next (the sheet-modal version
 * strayed from the desktop's chrome language). Reads the snapshot PlayerBar
 * publishes into the connect store; PlayerBar keeps ownership of the actual
 * cast/handoff machinery.
 *
 * Rows: "This computer" (the local output) · Chromecasts on the network ·
 * other Beetbot devices (hand the queue over). A remote device playing its
 * own session shows a "Playing" badge — awareness only; sessions are
 * independent, so it never steals This computer's checkmark.
 */
export function ConnectPanel() {
  const {
    castDevices,
    castActive,
    handoffDevices,
    remotePlayingId,
    error,
    preparing,
    onPickCast,
    onStopCast,
    onPickHandoff,
  } = useConnectStore();

  const localActive = !castActive;
  const nothingElse = castDevices.length === 0 && handoffDevices.length === 0;
  const rowBase =
    'w-full py-2.5 px-2 flex items-center gap-3 text-left rounded-lg hover:bg-white/5 active:bg-white/10 transition disabled:opacity-50 disabled:hover:bg-transparent';
  const check = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <ul>
        <li>
          <button
            type="button"
            onClick={() => {
              if (!localActive) onStopCast?.();
            }}
            className={`${rowBase} ${localActive ? 'text-accent' : ''}`}
          >
            <span
              className={`h-9 w-9 shrink-0 rounded-md grid place-items-center ${
                localActive ? 'bg-white/10 text-accent' : 'bg-neutral-900 text-neutral-400'
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              </svg>
            </span>
            <span className="flex-1 min-w-0 truncate text-sm font-medium">
              This computer
            </span>
            {localActive && check}
          </button>
        </li>
      </ul>

      {error && (
        <p className="px-2 py-1.5 text-xs text-red-300 break-words">{error}</p>
      )}
      {preparing && (
        <p className="px-2 py-1.5 flex items-center gap-2 text-xs text-neutral-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="animate-spin" aria-hidden>
            <path d="M21 12a9 9 0 1 1-6.2-8.6" />
          </svg>
          Preparing to cast…
        </p>
      )}

      <ul className="mt-1 divide-y divide-white/5">
        {nothingElse && (
          <li className="px-2 py-3 text-xs text-neutral-500">
            No devices found on your network.
          </li>
        )}

        {/* Chromecasts */}
        {castDevices.map((d) => {
          const active = d.id === castActive?.id;
          return (
            <li key={`cast-${d.id}`}>
              <button
                type="button"
                disabled={preparing}
                onClick={() => (active ? onStopCast?.() : onPickCast?.(d))}
                className={`${rowBase} ${active ? 'text-accent' : ''}`}
              >
                <span
                  className={`h-9 w-9 shrink-0 rounded-md grid place-items-center ${
                    active ? 'bg-white/10 text-accent' : 'bg-neutral-900 text-neutral-400'
                  }`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.37 7.07 10 1 10zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                  </svg>
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">
                    {d.friendly_name}
                  </span>
                  <span className="block text-xs text-neutral-500 truncate">
                    {d.model ?? 'Chromecast'}
                    {d.ip ? ` · ${d.ip}` : ''}
                  </span>
                </span>
                {active && <span className="text-xs text-accent shrink-0">Playing</span>}
              </button>
            </li>
          );
        })}

        {/* Other Beetbot devices — hand the queue over ("Play on Phone"). */}
        {handoffDevices.map((d) => {
          const playingOwn = d.device_id === remotePlayingId;
          return (
            <li key={`ho-${d.device_id}`}>
              <button
                type="button"
                onClick={() => onPickHandoff?.(d)}
                className={rowBase}
                title={`Hand this queue to ${d.label}`}
              >
                <span className="h-9 w-9 shrink-0 rounded-md grid place-items-center bg-neutral-900 text-neutral-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="7" y="3" width="10" height="18" rx="2" />
                    <path d="M11 18h2" />
                  </svg>
                </span>
                <span className="flex-1 min-w-0 truncate text-sm">{d.label}</span>
                {playingOwn && (
                  <span className="text-xs text-accent shrink-0">Playing</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {castActive && (
        <div className="px-2 pt-3 pb-2">
          <button
            type="button"
            onClick={() => onStopCast?.()}
            className="w-full rounded-md bg-neutral-900 hover:bg-neutral-800 text-red-300 text-sm font-medium py-2.5"
          >
            Stop casting to {castActive.name}
          </button>
        </div>
      )}
    </div>
  );
}
