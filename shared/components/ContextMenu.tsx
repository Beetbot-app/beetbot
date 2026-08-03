import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn, POPOVER } from '../ui';
import { SLEEP_OPTIONS, type SleepOption } from '../sleep';

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Trailing glyph, Apple-Music-style (label left, icon right). Use the
   *  shared `MenuGlyphs` set so menus stay visually consistent. */
  icon?: ReactNode;
  /** Draw a hairline group divider ABOVE this item. */
  separator?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

const glyphProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Shared trailing icons for menu items (Apple Music convention). */
export const MenuGlyphs = {
  addToPlaylist: (
    <svg {...glyphProps}>
      <path d="M4 7h10M4 12h6M4 17h6" />
      <path d="M16 14v7M12.5 17.5h7" />
    </svg>
  ),
  download: (
    <svg {...glyphProps}>
      <path d="M12 4v10M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  ),
  folder: (
    <svg {...glyphProps}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  ),
  artist: (
    <svg {...glyphProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
    </svg>
  ),
  album: (
    <svg {...glyphProps}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  ),
  share: (
    <svg {...glyphProps}>
      <path d="M12 3v12" />
      <path d="m8 7 4-4 4 4" />
      <path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </svg>
  ),
  queue: (
    <svg {...glyphProps}>
      <path d="M3 6h11M3 12h11M3 18h7" />
      <circle cx="18" cy="16" r="3" />
      <path d="M21 16V7l-3 1" />
    </svg>
  ),
  star: (
    <svg {...glyphProps}>
      <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
    </svg>
  ),
  pin: (
    <svg {...glyphProps}>
      <path d="M12 17v5" />
      <path d="M8 3h8l-1 7 3 3H6l3-3z" />
    </svg>
  ),
  plus: (
    <svg {...glyphProps}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  check: (
    <svg {...glyphProps}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  edit: (
    <svg {...glyphProps}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  ),
  sleep: (
    <svg {...glyphProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  trash: (
    <svg {...glyphProps}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  play: (
    <svg {...glyphProps} fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  ),
  finder: (
    <svg {...glyphProps}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  ),
};

/**
 * The per-track file actions — "Save offline" / "Remove download" / "Add audio
 * file" — assembled identically for EVERY ⋯ menu so they never drift. The caller
 * computes the track's state and binds the callbacks; omitting a callback drops
 * that action.
 *
 * - Save offline / Remove download only appear when `canDownload`, so a build
 *   with no acquiring provider shows neither and they vanish from every menu at
 *   once.
 * - Add audio file is a plain local-file import (available on every build), so
 *   it's gated only on an `onAddAudio` being supplied, not on `canDownload`.
 *
 * Returns a possibly-empty list; spread it into a menu's `items` where the file
 * actions belong (typically just above "Go to artist/album").
 */
export function fileMenuItems(opts: {
  /** Whether the track currently has a local file (downloaded). */
  hasFile: boolean;
  /** A save is in flight → show a disabled "Downloading…". */
  downloading?: boolean;
  /** Whether this build can acquire — gates the offline save/remove pair. */
  canDownload: boolean;
  onDownload?: () => void;
  onRemove?: () => void;
  onAddAudio?: () => void;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (opts.canDownload) {
    if (opts.hasFile) {
      if (opts.onRemove)
        items.push({
          label: 'Remove download',
          icon: MenuGlyphs.trash,
          onClick: opts.onRemove,
        });
    } else if (opts.downloading) {
      items.push({
        label: 'Downloading…',
        icon: MenuGlyphs.download,
        disabled: true,
        onClick: () => {},
      });
    } else if (opts.onDownload) {
      items.push({
        label: 'Save offline',
        icon: MenuGlyphs.download,
        onClick: opts.onDownload,
      });
    }
  }
  if (!opts.hasFile && opts.onAddAudio)
    items.push({
      label: 'Add audio file',
      icon: MenuGlyphs.plus,
      onClick: opts.onAddAudio,
    });
  return items;
}

/**
 * Desktop right-click / ⋯ context menu — a small frosted panel positioned at
 * the cursor, Apple-Music-style: labels left, trailing glyphs right, hairline
 * dividers between groups. Closes on any outside mousedown, Escape, scroll, or
 * resize. Used by the library/queue/album surfaces; actions reuse existing
 * handlers (play, add to playlist, go to artist/album, queue, like), so it
 * adds nothing to the data layer. Lives in shared/ so both the desktop pages
 * and the shared SearchScreen (browse albums) can render it.
 */
export function ContextMenu({
  state,
  onClose,
}: {
  state: MenuState;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // mousedown (any button) so a fresh right-click elsewhere dismisses this one
    // before the next menu opens. The menu stops propagation on its own mousedown.
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  // Clamp into the viewport so a click near an edge doesn't overflow off-screen.
  const width = 210;
  const separators = state.items.filter((it, i) => it.separator && i > 0).length;
  const height = state.items.length * 36 + separators * 9 + 8;
  const left = Math.min(state.x, window.innerWidth - width - 8);
  const top = Math.min(state.y, window.innerHeight - height - 8);

  // Portal to <body> so the menu escapes any ancestor that clips it — e.g. the
  // sidebar's `overflow-hidden` + `backdrop-filter` aside, which also makes
  // itself the containing block for `position: fixed`, so the menu would render
  // relative to (and be cut off by) the sidebar instead of the viewport.
  return createPortal(
    <div
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cn(POPOVER, 'fixed z-[60] min-w-[200px] py-1')}
      style={{ left, top }}
    >
      {state.items.map((it, i) => (
        <div key={i}>
          {it.separator && i > 0 ? (
            <div className="my-1 border-t border-white/10" aria-hidden />
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
            className={`w-full flex items-center gap-3 text-left px-3 py-2 text-sm transition ${
              it.disabled
                ? 'text-neutral-600 cursor-default'
                : it.danger
                  ? 'text-red-300 hover:bg-white/5'
                  : 'text-neutral-200 hover:bg-white/5'
            }`}
          >
            <span className="flex-1 truncate">{it.label}</span>
            {it.icon ? (
              <span
                className={`shrink-0 ${
                  it.disabled
                    ? 'text-neutral-700'
                    : it.danger
                      ? 'text-red-300/80'
                      : 'text-neutral-400'
                }`}
                aria-hidden
              >
                {it.icon}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Parent-row label for a "Sleep timer" menu item: appends the live state
 *  ("· 12m left", "· end of track") so the menu shows it at a glance. */
export function sleepTimerMenuLabel(
  sleepTimerEndsAt: number | null,
  sleepAtTrackEnd: boolean,
): string {
  if (sleepAtTrackEnd) return 'Sleep timer · end of track';
  if (sleepTimerEndsAt != null) {
    const min = Math.max(1, Math.ceil((sleepTimerEndsAt - Date.now()) / 60_000));
    return `Sleep timer · ${min}m left`;
  }
  return 'Sleep timer';
}

/** The duration picker the "Sleep timer" row opens — a SECOND ContextMenu,
 *  since the menu has no nesting. Same option list as the moon button and the
 *  phone sheet (shared/sleep.ts) so the choices can't drift; ✓ marks the
 *  current pick (Off / End of track — a running countdown can't be mapped
 *  back to the duration that started it, matching SleepTimerButton). */
export function sleepTimerMenuItems(
  sleepTimerEndsAt: number | null,
  sleepAtTrackEnd: boolean,
  onPick: (opt: SleepOption) => void,
): MenuItem[] {
  const active = sleepTimerEndsAt != null || sleepAtTrackEnd;
  return SLEEP_OPTIONS.map((o) => {
    const selected =
      (o.value === 'track' && sleepAtTrackEnd) ||
      (o.value === 'off' && !active);
    return {
      label: o.label,
      onClick: () => onPick(o.value),
      icon: selected ? MenuGlyphs.check : undefined,
    };
  });
}
