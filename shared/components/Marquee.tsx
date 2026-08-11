import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * One-line text that, when its enclosing `.group` (a card/tile) is hovered AND
 * the text is actually too long, slides horizontally to reveal the end, then
 * slides back on leave. Idle overflow gets a soft right-edge fade so a clipped
 * title reads as intentional rather than cut off.
 *
 * Driven purely by Tailwind's `group-hover:` — which is pointer-gated in
 * Tailwind v4 — so it never fires on a touch tap. The scroll distance and speed
 * are measured per-string (≈45px/s), so short titles don't move and long ones
 * take proportionally longer.
 */
export function Marquee({
  text,
  className,
  lines = 1,
  children,
}: {
  text: string;
  className?: string;
  /** Touch-only: how many lines to wrap to before ellipsizing (Spotify mobile
   *  uses 2 for the quick-pick tiles, 1 for card titles). Ignored on desktop,
   *  which scrolls the single line on hover. */
  lines?: number;
  /** Rendered in place of the raw text when given — this is how a card line
   *  carries LINKS (per-artist buttons, an album link) while `text` keeps
   *  doing the measuring and the tooltip. The links stay clickable while the
   *  line slides, since the hover-peek is just a transform. */
  children?: ReactNode;
}) {
  // A touch device can't hover to scroll, so a long title would just sit
  // clipped. Fall back to a clean line-clamped ellipsis there — the Spotify-
  // mobile behaviour — and keep the hover-scroll where there IS a pointer.
  // "No hover" (a real phone) OR a phone-width window — either way there's no
  // pointer to scroll the marquee, so clamp instead. The width clause also lets
  // the desktop browser preview at a phone size show the real mobile treatment;
  // the desktop app runs ≥1024px, so it keeps the hover-scroll.
  const MQ = '(hover: none), (max-width: 767px)';
  const [touch, setTouch] = useState(
    typeof window !== 'undefined' && window.matchMedia(MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MQ);
    const on = () => setTouch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    if (touch) return; // no scroll measuring on touch — we line-clamp instead
    const wrap = wrapRef.current;
    const span = spanRef.current;
    if (!wrap || !span) return;
    const measure = () => {
      const over = span.scrollWidth - wrap.clientWidth;
      setShift(over > 4 ? over : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [text, touch]);

  if (touch) {
    return (
      <div
        title={text}
        className={`overflow-hidden ${className ?? ''}`}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: lines,
          WebkitBoxOrient: 'vertical',
        } as CSSProperties}
      >
        {children ?? text}
      </div>
    );
  }

  const overflowing = shift > 0;
  const dur = Math.max(1.2, shift / 45);

  return (
    <div
      ref={wrapRef}
      className={`overflow-hidden ${className ?? ''}`}
      style={
        overflowing
          ? {
              maskImage: 'linear-gradient(to right, black 88%, transparent)',
              WebkitMaskImage: 'linear-gradient(to right, black 88%, transparent)',
            }
          : undefined
      }
    >
      <span
        ref={spanRef}
        title={text}
        className="inline-block whitespace-nowrap will-change-transform [transform:translateX(0)] transition-transform ease-linear group-hover:[transform:translateX(var(--mq))]"
        style={{ ['--mq' as string]: `-${shift}px`, transitionDuration: `${dur}s` }}
      >
        {children ?? text}
      </span>
    </div>
  );
}

/**
 * White circular Play affordance that lifts into the bottom-right of a card's
 * cover on hover (Spotify's signature move, kept in our white house style
 * instead of green). Hidden + nudged down by default; fades and slides up when
 * the enclosing `.group` is hovered. Renders as a real <button> so it can carry
 * its own click (play) distinct from the card's (open) — the card root must be
 * a div, not a button, for this to be valid.
 */
export function CardPlayButton({
  onPlay,
  label,
  className,
  /** The card is the active playback source → show the button ALWAYS (not just
   *  on hover) and render play/pause per `playing`, Spotify-style. */
  persistent = false,
  /** Active + currently playing → pause glyph; otherwise play glyph. */
  playing = false,
}: {
  onPlay: () => void;
  label: string;
  className?: string;
  persistent?: boolean;
  playing?: boolean;
}) {
  const vis = persistent
    ? 'opacity-100 translate-y-0'
    : 'opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0';
  return (
    <button
      type="button"
      aria-label={persistent ? (playing ? 'Pause' : 'Play') : label}
      onClick={(e) => {
        e.stopPropagation();
        onPlay();
      }}
      className={`absolute bottom-2 right-2 grid h-10 w-10 place-items-center rounded-full bg-white text-neutral-950 shadow-[0_8px_16px_rgba(0,0,0,0.5)] transition duration-200 ease-out hover:scale-105 active:scale-95 ${vis} ${className ?? ''}`}
    >
      {persistent && playing ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
        </svg>
      )}
    </button>
  );
}
