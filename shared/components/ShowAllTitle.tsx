import type { ReactNode } from 'react';

/**
 * A section title that doubles as its own "show all" link: the words carry the
 * tap target and a › chevron sits right after them, nudging on hover
 * (Apple-Music-style). This is the house pattern — it replaced a separate
 * right-aligned "Show all" text link on home so shelves and the artist page
 * read the same.
 *
 * Without `onShowAll` it renders the label as plain text, so a caller can pass
 * the handler conditionally without branching at the call site. The label
 * truncates and the chevron never shrinks, which is what keeps a long shelf
 * title from pushing the affordance out of the row.
 *
 * The caller owns the typography (`className`) because the two homes for this
 * differ: home shelves are `text-lg lg:text-2xl`, the artist page is `text-lg`.
 */
export function ShowAllTitle({
  label,
  onShowAll,
  className,
}: {
  label: string;
  /** Present ⇒ the title becomes a button with the chevron. */
  onShowAll?: () => void;
  className?: string;
}): ReactNode {
  if (!onShowAll) {
    return <span className={`block truncate ${className ?? ''}`}>{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={onShowAll}
      aria-label={`Show all ${label}`}
      className={`group/sa flex min-w-0 items-center gap-1 text-left transition hover:text-white ${className ?? ''}`}
    >
      <span className="truncate">{label}</span>
      {/* Sized in em, not a fixed step: home shelves set a 24px title and the
          artist page 18px, and a pinned 16px chevron read as an afterthought
          against the bigger one. 1.3em is measured against the glyph, which
          draws well below its font size — it lands near the title's cap
          height at both sizes. */}
      <span
        aria-hidden="true"
        className="shrink-0 text-[1.3em] leading-none text-neutral-500 transition-transform group-hover/sa:translate-x-0.5 group-hover/sa:text-neutral-200"
      >
        ›
      </span>
    </button>
  );
}
