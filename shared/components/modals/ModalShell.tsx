import { useEffect } from 'react';
import { cn, SCRIM, BOTTOM_SHEET } from '../../ui';

/** Bottom-sheet-style modal shell shared by both pickers. */
export function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  hero,
  stickyBar,
  condensed,
  onHeaderPlay,
  headerPlaying,
  headerExtra,
  sheet,
  footer,
  // `wide` is accepted (callers still pass it) but no longer affects layout now
  // that the phone shell is a full-bleed page and the desktop shell is inline.
  inline,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Sheet mode: a pinned footer (e.g. a "Done" action) that stays visible
   *  below the scrolling body instead of scrolling off the bottom. */
  footer?: React.ReactNode;
  /** Optional full-bleed header (e.g. an artist banner). When provided,
   *  the default title bar is replaced; the hero renders at the top of
   *  the scrollable body and a floating close button is drawn over it. */
  hero?: React.ReactNode;
  /** Desktop only: a sticky element rendered BEFORE the hero (so it can pin
   *  to the top of the scroll as the hero scrolls away). */
  stickyBar?: React.ReactNode;
  /** Phone: whether the hero has scrolled past its title. Drives the phone's
   *  own unified top bar (which frosts + fades in the title/play), so the phone
   *  matches the library playlist page rather than the desktop CondensedHeaderBar. */
  condensed?: boolean;
  /** Phone: the header play button's action (fades in when condensed). */
  onHeaderPlay?: () => void;
  /** Phone: an always-visible control slot at the top bar's right edge (e.g.
   *  the artist page's ⋯ menu button), Apple-Music-style. Rendered before the
   *  condensed play button. */
  headerExtra?: React.ReactNode;
  /** Phone: whether this source is the current playback + playing → the header
   *  play button shows ⏸ and toggles, matching the hero + library pages. */
  headerPlaying?: boolean;
  /** Picker mode: render as a scrimmed dialog (centered on desktop, bottom
   *  sheet on phone) rather than a full-bleed detail page. Used by the
   *  add-to-playlist / create-playlist pickers. */
  sheet?: boolean;
  /** Wider panel for page-like modals (the artist page). */
  wide?: boolean;
  /** Desktop: render as an inline full page (no overlay/backdrop) with a
   *  "Back" affordance instead of a floating modal. The parent content
   *  area provides the scroll. `onClose` becomes "go back". */
  inline?: boolean;
}) {
  // Lock body scroll only for the overlay modal — an inline page scrolls
  // with its parent and shouldn't freeze the document.
  useEffect(() => {
    if (inline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inline]);

  if (inline) {
    return (
      <div
        className="pb-6"
        // Gentle fade + rise so the page eases in rather than hard-cutting.
        // Replays whenever the shell remounts (e.g. drilling artist → artist,
        // which is keyed on the artist id).
        style={{ animation: 'beetbot-page-enter 280ms ease-out both' }}
      >
        {/* Condensed sticky bar pins to the top as the hero scrolls away. */}
        {stickyBar}
        {/* No inline Back button on desktop — the persistent top bar's global
            Back arrow unwinds these inline pages (search + Discover drill-ins).
            The phone's modal (non-inline branch below) keeps its own close. */}
        {hero ?? (
          <div className="px-1 mb-4 pt-6">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <div className="text-sm text-neutral-400 mt-0.5">{subtitle}</div>
            ) : null}
          </div>
        )}
        {children}
      </div>
    );
  }

  if (sheet) {
    // Picker mode: a scrimmed dialog — centered card on desktop, bottom sheet on
    // phone. (Detail drill-ins use the full-bleed page below instead.)
    return (
      <div
        className={cn(SCRIM, 'z-50 flex flex-col justify-end sm:justify-center sm:items-center')}
        onClick={onClose}
        role="presentation"
      >
        <div
          className={cn(BOTTOM_SHEET, 'relative w-full flex flex-col overflow-hidden sm:max-w-md')}
          // Cap the height so the picker doesn't stretch to nearly the full
          // window on desktop (it read as oversized); still tall enough for a
          // long playlist list, which scrolls inside the body.
          style={{
            maxHeight:
              'min(calc(100dvh - max(env(safe-area-inset-top, 0px), 3rem)), 40rem)',
          }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          <div className="shrink-0 px-4 pt-4 pb-3 flex items-start justify-between gap-3 border-b border-white/5">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold truncate">{title}</h2>
              {subtitle ? (
                <div className="text-xs text-neutral-500 truncate">{subtitle}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 h-8 w-8 shrink-0 grid place-items-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 active:bg-white/10"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div
            className="overflow-y-auto overscroll-contain flex-1 min-h-0"
            style={footer ? undefined : { paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {hero}
            {children}
          </div>
          {footer ? (
            <div
              className="shrink-0 border-t border-white/5 px-4 pt-3 pb-4"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
            >
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Phone: a full-bleed PAGE (not a cover-everything sheet) at z-10 — it sits
  // UNDER the app's z-20 bar+nav wrapper, so the mini player and bottom nav stay
  // visible and tappable, exactly like an iOS push over the tab bar. The page
  // reserves the chrome's height (--overlay-bottom, published by App) so its
  // last row clears the bar+nav.
  return (
    <div
      className="fixed inset-0 z-10 overflow-y-auto overscroll-contain bg-neutral-950"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'var(--overlay-bottom, 146px)',
        animation: 'beetbot-page-enter 280ms ease-out both',
      }}
      role="region"
      aria-label={title}
    >
      {/* One unified top bar — identical to the library playlist page: a
          legibility gradient over the full-bleed hero at rest (just the back
          chevron), frosting + fading in the title + play once the hero scrolls
          past. Replaces the desktop CondensedHeaderBar (phone only). */}
      <div
        className={`sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-2 transition-colors duration-200 ${
          condensed
            ? 'bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/5'
            : 'bg-gradient-to-b from-black/50 to-transparent'
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-400 active:bg-white/10 active:text-neutral-100"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span
          className={`min-w-0 flex-1 truncate text-sm font-semibold transition-opacity duration-200 ${
            condensed ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {title}
        </span>
        {headerExtra}
        {onHeaderPlay ? (
          <button
            type="button"
            onClick={onHeaderPlay}
            aria-label={headerPlaying ? 'Pause' : `Play ${title}`}
            // Collapses to zero width (and eats the flex gap with -ml-2) while
            // hidden, so it doesn't hold a 40px slot open at the right edge —
            // that pushed headerExtra's ⋯/+ inboard of the back chevron's inset.
            className={`grid h-8 shrink-0 place-items-center overflow-hidden rounded-full bg-white text-neutral-950 transition-all duration-200 active:scale-95 ${
              condensed ? 'w-8 opacity-100' : 'pointer-events-none -ml-2 w-0 opacity-0'
            }`}
          >
            {headerPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        ) : null}
      </div>
      {/* -mt-14 lifts the hero up behind the floating bar so the wash runs
          edge-to-edge to the top (no black band); the hero's own pt clears it. */}
      <div className="-mt-14">
        {hero ?? (
          <div className="px-4 pt-20 pb-4">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <div className="text-sm text-neutral-400 mt-0.5">{subtitle}</div>
            ) : null}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
