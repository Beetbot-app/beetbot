/**
 * Settings kit — the six primitives every settings surface is built from.
 *
 * Desktop (`src/pages/Settings.tsx`) and phone (`web-player/…/SettingsScreen`)
 * both render through these, so a setting is defined once and looks native in
 * either shell. The visual language lives entirely in the token sheet
 * (`../ui`): the on-state of every control is white/neutral (design identity
 * §06.8) — never leaf-green, never beet crimson — so the colour decision is
 * made in one place and inherited here.
 *
 *   <Group>      rounded inset card; optional label/title above + helper footer below
 *   <Row>        label (+ secondary line) left · control slot right · optional chevron
 *   <Toggle>     white/neutral switch
 *   <Slider>     range input with the white fill
 *   <Segmented>  Dense | Default | Spacious style choice
 *   <Picker>     value + chevron → menu of choices
 *
 * Icons follow the app's own idiom (viewBox 0 0 24 24, strokeWidth 1.8, round
 * caps — see `svgProps` in `src/components/Sidebar.tsx`), inlined so the kit is
 * self-contained across both bundles.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  cn,
  CARD,
  EYEBROW,
  POPOVER,
  TOGGLE_TRACK,
  TOGGLE_TRACK_ON,
  TOGGLE_TRACK_OFF,
  TOGGLE_KNOB,
  TOGGLE_KNOB_ON,
  TOGGLE_KNOB_OFF,
  SEGMENTED,
  SEGMENTED_ITEM,
  SEGMENTED_ITEM_ON,
  SEGMENTED_ITEM_OFF,
  PICKER_TRIGGER,
  PICKER_ITEM,
  SLIDER,
} from '../ui';

// ---------------------------------------------------------------------------
// Icons — the app's stroke idiom, inlined
// ---------------------------------------------------------------------------

const strokeProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} {...strokeProps} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} {...strokeProps} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckMark({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} {...strokeProps} className={className}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Group — the rounded inset card
// ---------------------------------------------------------------------------

export function Group({
  title,
  label,
  description,
  footer,
  className,
  children,
}: {
  /** Semibold header above the card. */
  title?: string;
  /** Uppercase eyebrow above the card (Apple/iOS group label). */
  label?: string;
  /** Muted text under the header, above the card. */
  description?: ReactNode;
  /** Muted consequence text below the card ("When off, songs play at…"). */
  footer?: ReactNode;
  /** Extra classes on the card surface. */
  className?: string;
  children: ReactNode;
}) {
  const hasHeader = Boolean(label || title || description);
  return (
    <section className="mb-6">
      {hasHeader && (
        <div className="mb-3">
          {label && <div className={EYEBROW}>{label}</div>}
          {title && (
            <h2 className={cn('text-base font-semibold tracking-tight', label && 'mt-1')}>
              {title}
            </h2>
          )}
          {description && (
            <p className={cn('text-xs text-neutral-500', (label || title) && 'mt-0.5')}>
              {description}
            </p>
          )}
        </div>
      )}
      <div className={cn(CARD, 'p-5', className)}>{children}</div>
      {footer && <p className="mt-2 px-1 text-xs text-neutral-500">{footer}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row — one line inside a Group
// ---------------------------------------------------------------------------

export function Row({
  label,
  secondary,
  control,
  chevron,
  onClick,
  divider,
  title,
  className,
  children,
}: {
  label: ReactNode;
  /** Muted second line under the label. */
  secondary?: ReactNode;
  /** Right-side control (toggle, picker, value, or button). */
  control?: ReactNode;
  /** Show a drill-in chevron on the right. */
  chevron?: boolean;
  /** Make the whole row a button (drill-in). */
  onClick?: () => void;
  /** Hairline divider + top padding — for stacking rows in one card. */
  divider?: boolean;
  /** Tooltip for the (possibly truncated) label. */
  title?: string;
  className?: string;
  /** Progressive-disclosure content revealed below the row. */
  children?: ReactNode;
}) {
  const head = (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={title}>
          {label}
        </div>
        {secondary != null && (
          <div className="mt-0.5 text-xs text-neutral-500">{secondary}</div>
        )}
      </div>
      {(control != null || chevron) && (
        <div className="flex shrink-0 items-center gap-2">
          {control}
          {chevron && <ChevronRight className="text-neutral-500" />}
        </div>
      )}
    </div>
  );

  const body = children ? (
    <div className="space-y-3">
      {head}
      {children}
    </div>
  ) : (
    head
  );

  const inner = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 block w-full rounded-lg px-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      {body}
    </button>
  ) : (
    body
  );

  return divider ? (
    <div className="mt-3 border-t border-white/10 pt-3">{inner}</div>
  ) : (
    inner
  );
}

// ---------------------------------------------------------------------------
// Toggle — the white/neutral switch
// ---------------------------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(TOGGLE_TRACK, checked ? TOGGLE_TRACK_ON : TOGGLE_TRACK_OFF)}
    >
      <span className={cn(TOGGLE_KNOB, checked ? TOGGLE_KNOB_ON : TOGGLE_KNOB_OFF)} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Slider — range input with the white fill
// ---------------------------------------------------------------------------

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  id,
  className,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  id?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(SLIDER, className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Segmented — a small set of mutually-exclusive choices
// ---------------------------------------------------------------------------

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (next: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn(SEGMENTED, className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(SEGMENTED_ITEM, active ? SEGMENTED_ITEM_ON : SEGMENTED_ITEM_OFF)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker — value + chevron opening a small menu
// ---------------------------------------------------------------------------

export function Picker<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={PICKER_TRIGGER}
      >
        {current?.label ?? String(value)}
        <ChevronDown
          className={cn('text-neutral-500 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          className={cn(POPOVER, 'absolute right-0 z-50 mt-1 min-w-[10rem] p-1')}
          role="listbox"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={PICKER_ITEM}
              >
                <span className={active ? 'text-neutral-100' : undefined}>{o.label}</span>
                {active && <CheckMark className="text-neutral-100" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
