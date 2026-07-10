import { useEffect, type ReactNode } from 'react';
import { cn, POPOVER } from '../ui';

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
  edit: (
    <svg {...glyphProps}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
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

  return (
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
    </div>
  );
}
