/**
 * The token sheet (design identity §06), encoded once.
 *
 * These are the convergence targets for the whole app's chrome — the "recipes"
 * that were previously find-replaced inline across a dozen files. Both the
 * desktop (`src/`) and phone (`web-player/`) builds import `shared/` directly,
 * so this is the single source of truth: change a recipe here and every surface
 * that routes through it moves together.
 *
 * They are plain Tailwind class strings (not an `@layer components` block)
 * because the two apps have separate Vite roots + entry CSS, so a CSS layer
 * would have to be duplicated and still wouldn't be visible to `shared/`
 * components as one source. Constants compose with the utility classes already
 * in the JSX and stay fully typed.
 *
 * Compose with `cn(...)`: `className={cn(SHEET, 'w-full max-w-lg mx-4')}`.
 */

/** Join class fragments, dropping falsy ones (tiny clsx). */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Surfaces — the Glass pillar
// ---------------------------------------------------------------------------

/** Centered dialog / modal panel (the frosted sheet). */
export const SHEET =
  'rounded-2xl border border-white/10 bg-neutral-950/90 backdrop-blur-xl shadow-2xl shadow-black/50';

/** Phone bottom-sheet shape: flush to the bottom edge on mobile, a floating
 *  dialog from `sm` up. Same frosted surface as SHEET, different silhouette. */
export const BOTTOM_SHEET =
  'border-white/10 bg-neutral-950/90 backdrop-blur-xl rounded-t-2xl border-t sm:rounded-2xl sm:border';

/** Lighter popover tier — menus, dropdowns, timers. */
export const POPOVER =
  'rounded-lg border border-white/10 bg-neutral-900/95 backdrop-blur-xl shadow-xl';

/** Full-viewport dim behind a modal. Callers append z-index + fl/grid
 *  alignment (dialogs center; sheets pin to the bottom edge on phone). */
export const SCRIM = 'fixed inset-0 bg-black/70 backdrop-blur-sm';

/** Persistent chrome bar (top bar / player bar) — the deepest frost. */
export const BAR =
  'bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150 border-white/5';

/** Raised card that groups related content on the neutral-950 page. */
export const CARD = 'rounded-2xl border border-white/10 bg-neutral-900/50';

// ---------------------------------------------------------------------------
// Buttons — one primary (white), one secondary (fill), one destructive
// ---------------------------------------------------------------------------

export const BTN_PRIMARY =
  'rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white active:scale-[0.97] disabled:bg-neutral-700 disabled:text-neutral-400';

export const BTN_SECONDARY =
  'rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 transition hover:bg-neutral-700 active:scale-[0.97] disabled:bg-neutral-900 disabled:text-neutral-500';

export const BTN_DANGER =
  'rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-red-400 active:scale-[0.97]';

/** Low-emphasis utility button — no fill until hover. */
export const BTN_GHOST =
  'rounded-lg px-3 py-2 text-sm text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100';

/** Ghost that warns on hover (Clear / Revoke). */
export const BTN_GHOST_DANGER =
  'rounded-lg px-3 py-2 text-sm text-neutral-400 transition hover:bg-white/5 hover:text-red-400';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** The selected/active half of a pill (nav item, type chip). Identical
 *  everywhere; only the idle half varies, so `navPill()` pairs them. */
export const PILL_SELECTED = 'bg-white/10 text-neutral-100';
export const PILL_IDLE =
  'text-neutral-400 hover:bg-white/5 hover:text-neutral-100';

/** Active/idle classes for a selectable pill or nav item. */
export function navPill(active: boolean): string {
  return active ? PILL_SELECTED : PILL_IDLE;
}

// ---------------------------------------------------------------------------
// Inputs & fields
// ---------------------------------------------------------------------------

/** Text / url / password / email input surface. Width is a layout concern —
 *  the caller sets it (`w-full`, `flex-1`, `w-56`, …). Font size is text-base
 *  (16px) so mobile Safari never focus-zooms; callers that want a bigger size
 *  (a PIN / pairing code) must force it with the `!` suffix, since cn() is a
 *  plain join and can't out-rank a recipe class by source order. */
export const INPUT =
  'rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-base text-neutral-100 placeholder-neutral-600 transition focus:border-neutral-400 focus:outline-none';

// ---------------------------------------------------------------------------
// Callouts — info / warning / error banners
// ---------------------------------------------------------------------------

export const CALLOUT_INFO =
  'rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-300';
export const CALLOUT_WARN =
  'rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200';
export const CALLOUT_ERROR =
  'rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200';

// ---------------------------------------------------------------------------
// Type + misc
// ---------------------------------------------------------------------------

/** Uppercase section kicker. */
export const EYEBROW =
  'text-[11px] font-semibold uppercase tracking-wide text-neutral-500';

/** Eyebrow over artwork / a wash, where neutral-500 would vanish. */
export const EYEBROW_ON_ART =
  'text-[11px] font-semibold uppercase tracking-wide text-white/60';

/** Inline monospace value chip (paths, tokens, codes). */
export const CODE_CHIP =
  'rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-100';

// ---------------------------------------------------------------------------
// Settings controls — toggle · segmented · picker · slider
//
// One colour rule governs this whole family (design identity §06.8): the "on"
// state of every control is WHITE / NEUTRAL — never leaf-green, never beet
// crimson. Crimson stays reserved for the brand mark + the station ignite glow,
// and the red danger tokens above own "destructive". So a lit toggle, a
// selected segment, and a filled slider all read as the same calm white accent,
// and the colour decision lives here, once. The `<Group>/<Row>/<Toggle>/…`
// primitives in `components/SettingsKit.tsx` render both shells through these.
// ---------------------------------------------------------------------------

/** Switch track. Compose with an on/off fill class + the knob below. */
export const TOGGLE_TRACK =
  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40';
export const TOGGLE_TRACK_ON = 'bg-neutral-100';
export const TOGGLE_TRACK_OFF = 'bg-neutral-700';
/** The sliding knob. On a lit (white) track it goes dark; on the dark idle
 *  track it stays light — so it keeps contrast at both ends of the slide. */
export const TOGGLE_KNOB =
  'pointer-events-none inline-block h-5 w-5 transform rounded-full shadow-sm transition-transform';
export const TOGGLE_KNOB_ON = 'translate-x-[22px] bg-neutral-900';
export const TOGGLE_KNOB_OFF = 'translate-x-0.5 bg-neutral-100';

/** Segmented control (e.g. Dense | Default | Spacious) — container + item. */
export const SEGMENTED = 'inline-flex rounded-lg bg-neutral-800/80 p-0.5 text-sm';
export const SEGMENTED_ITEM =
  'rounded-[7px] px-3 py-1 font-medium transition select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60';
export const SEGMENTED_ITEM_ON = 'bg-neutral-100 text-neutral-950 shadow-sm';
export const SEGMENTED_ITEM_OFF = 'text-neutral-400 hover:text-neutral-100';

/** Picker — a value+chevron trigger that opens a POPOVER of choices. */
export const PICKER_TRIGGER =
  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60';
export const PICKER_ITEM =
  'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100';

/** Range slider — white fill + white thumb (the shared neutral accent). */
export const SLIDER = 'w-full cursor-pointer accent-white';
