import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { type CastDevice } from '../api';
import { cn, SCRIM, BOTTOM_SHEET } from '../ui';

/**
 * Bottom-sheet picker for Chromecasts the host discovered. Used by
 * both bundles — phone Now Playing overlay and desktop PlayerBar.
 *
 * Tapping a device fires `onPick(device)`; the caller is responsible
 * for the actual `castStart` API call (so each bundle can wire it
 * into its own state machine). When `activeId` is non-null, that row
 * shows "Playing" and the sheet exposes a Stop button.
 *
 * Rendered through a portal so it floats above the player bar's
 * backdrop-filter (which would otherwise contain `position: fixed`
 * descendants — same gotcha we hit with the Now Playing overlay).
 */
export function CastPicker({
  devices,
  activeId,
  error,
  onPick,
  onStop,
  onClose,
}: {
  devices: CastDevice[];
  activeId: string | null;
  error: string | null;
  onPick: (d: CastDevice) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Lock background scroll while the sheet is up so a finger-drag on
  // the device list doesn't accidentally scroll the page beneath.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      className={cn(SCRIM, 'z-50 flex items-end sm:items-center justify-center')}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={cn(BOTTOM_SHEET, 'w-full sm:max-w-md')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Cast to device"
      >
        <div className="px-5 pt-5 pb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Cast to device</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              {devices.length === 0
                ? 'Searching for Chromecasts on your network…'
                : `${devices.length} device${devices.length === 1 ? '' : 's'} on your network`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 -mr-1 shrink-0"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mx-5 mb-2 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200 break-words">
            {error}
          </div>
        )}

        <ul className="px-2 pb-3 divide-y divide-neutral-900 max-h-[55vh] overflow-y-auto">
          {devices.map((d) => {
            const isActive = d.id === activeId;
            return (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onPick(d)}
                  className="w-full py-3 px-3 flex items-center gap-3 text-left rounded-md hover:bg-neutral-900 active:bg-neutral-900 transition"
                >
                  <div
                    className={`h-10 w-10 shrink-0 rounded-md grid place-items-center ${
                      isActive
                        ? 'bg-white/10 text-neutral-200'
                        : 'bg-neutral-900 text-neutral-400'
                    }`}
                  >
                    {/* Material Design "cast" icon — filled. */}
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.37 7.07 10 1 10zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {d.friendly_name}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {d.model ?? 'Chromecast'}
                      {d.ip ? ` · ${d.ip}` : ''}
                    </div>
                  </div>
                  {isActive && (
                    <span className="text-xs text-neutral-200">Playing</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {activeId && (
          <div className="px-5 pb-5">
            <button
              type="button"
              onClick={onStop}
              className="w-full rounded-md bg-neutral-900 hover:bg-neutral-800 text-red-300 font-medium py-2.5"
            >
              Stop casting
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
