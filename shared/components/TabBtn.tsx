import type { ReactNode } from 'react';
import { cn, navPill } from '../ui';

/** A small selectable pill-tab (e.g. the Queue/Lyrics/Up-next switch). Shared by
 *  the desktop RightBar and Now-Playing view. State classes come from the
 *  navPill recipe so the tab styling stays in one place. */
export function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('px-3 py-1.5 rounded-full text-sm transition', navPill(active))}
    >
      {children}
    </button>
  );
}
