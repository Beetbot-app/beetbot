import { useEffect, useRef, useState, type ReactNode } from 'react';

// Sentinel for "no announce pass has run yet" — announceKey itself may
// legitimately be undefined, so absence needs its own value.
const NEVER_ANNOUNCED = Symbol('never-announced');

/**
 * A one-line ticker for text that may not fit, with Spotify's bar behaviour:
 * when the content overflows it glides through ONE full pass when the track
 * (content) first appears, then comes to rest at the start. The pointer
 * always wins: hovering mid-glide PAUSES the pass (readable, clickable,
 * highlighted), and moving off resumes it — or, from rest, fires the single
 * replay pass. It never loops perpetually. Content that fits renders static
 * — no animation, no duplication.
 *
 * This is the sibling of `Marquee` (shared/components), not a replacement:
 * Marquee is hover-to-peek for tiles and takes a plain string; this one takes
 * children (the player bar's title/artist LINKS ride inside) and announces
 * itself. Keep using Marquee for card titles.
 *
 * The pass is driven imperatively with the Web Animations API rather than a
 * CSS class: two earlier CSS attempts each failed invisibly (an inline
 * `animation:` shorthand outranked the :hover rule; a class + key-remount
 * scheme had a restart race), and WAAPI has none of those moving parts — the
 * animation object itself is the "is a pass running" guard and there is
 * nothing for specificity or reconciliation to fight over.
 *
 * The content renders twice and the pass translates by exactly one copy plus
 * the flex gap between them, so it ends pixel-identical to where it began.
 * The space between copies is flex `gap` deliberately, NOT padding: padding
 * would inflate the content's own scrollWidth, double-counting the gap in
 * the glide distance and poisoning every later overflow measurement.
 *
 * The aria-hidden duplicate stays mouse-interactive on purpose: a click that
 * lands on it as the line glides (or just after it settles) must work. Known
 * trade-off: its links are technically tabbable while aria-hidden (a lint
 * smell); keyboard users reach the primary copy first and every link here
 * also exists in menus, so the practical cost is nil.
 * `prefers-reduced-motion` disables the pass entirely.
 */
export function AutoMarquee({
  children,
  className,
  announceKey,
  speed = 30, // px per second — slow enough to read, fast enough to finish
  gap = 48, // px between the two copies
}: {
  children: ReactNode;
  className?: string;
  /** Identity of the content (e.g. the track id). When it changes, the ticker
   *  runs its announce pass again — overflow measurement alone can't tell one
   *  long title from the next (overflow stays truthy across the change), so
   *  without this a long→long track change would never scroll. */
  announceKey?: string | number;
  speed?: number;
  gap?: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const pointerInsideRef = useRef(false);
  const announcedRef = useRef<unknown>(NEVER_ANNOUNCED);
  const [overflowing, setOverflowing] = useState(false);

  // One glide: translate the track by exactly one copy + gap and settle back
  // at 0, which is pixel-identical to where the pass ended. The Animation
  // object doubles as the "pass running" guard; `restart` is for a track
  // change mid-glide, where snapping to the new content's start is correct
  // rather than jarring. Returns whether a pass actually started.
  const play = (restart = false): boolean => {
    const track = trackRef.current;
    const content = contentRef.current;
    const wrap = wrapRef.current;
    if (!track || !content || !wrap) return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (animRef.current) {
      if (!restart) return false;
      animRef.current.cancel();
      animRef.current = null;
    }
    // The duplicate copy must already be committed — gliding without it would
    // drag blank space through the bar.
    if (content.scrollWidth - wrap.clientWidth <= 1 || track.children.length < 2) return false;
    const distance = content.scrollWidth + gap;
    const anim = track.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
      { duration: (distance / speed) * 1000, easing: 'linear' },
    );
    animRef.current = anim;
    anim.finished
      .catch(() => {}) // cancelled — a new pass or unmount took over
      .finally(() => {
        if (animRef.current === anim) animRef.current = null;
      });
    return true;
  };
  const playRef = useRef(play);
  playRef.current = play;

  // Overflow measurement gates the duplicate-copy render.
  useEffect(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content) return;
    const measure = () =>
      setOverflowing(content.scrollWidth - wrap.clientWidth > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(content);
    return () => ro.disconnect();
  }, [gap, children]);
  useEffect(
    () => () => {
      animRef.current?.cancel();
      // A remount is a fresh appearance — it should announce again. (Also
      // keeps StrictMode's dev unmount/remount from eating the first pass.)
      announcedRef.current = NEVER_ANNOUNCED;
    },
    [],
  );

  // The pointer always wins: entering mid-glide PAUSES the pass so the text
  // sits still under the cursor — readable, clickable; leaving resumes it,
  // or fires the single replay pass if the line was at rest. Bound NATIVELY,
  // not via the onMouseEnter/onMouseLeave props: React synthesizes
  // enter/leave from root-delegated events, and (verified in a live harness)
  // it drops them on some pointer paths — the native events fire every time.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onEnter = () => {
      pointerInsideRef.current = true;
      const anim = animRef.current;
      if (anim && anim.playState === 'running') anim.pause();
    };
    const onLeave = () => {
      pointerInsideRef.current = false;
      const anim = animRef.current;
      if (anim) {
        if (anim.playState === 'paused') anim.play();
        return;
      }
      playRef.current(false);
    };
    wrap.addEventListener('mouseenter', onEnter);
    wrap.addEventListener('mouseleave', onLeave);
    return () => {
      wrap.removeEventListener('mouseenter', onEnter);
      wrap.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // The announce pass: once per announceKey, fired only after a commit in
  // which the duplicate copy exists (`overflowing` is state, so this effect
  // runs with the DOM already matching it — no rAF timing games). The key is
  // marked announced only when a pass actually starts, so overflow appearing
  // later (window narrowed) still gets its one pass.
  const prevKeyRef = useRef<unknown>(NEVER_ANNOUNCED);
  useEffect(() => {
    // Any key CHANGE is a fresh appearance, even back to a key seen before
    // (replaying a song must announce again) — the marker only means "this
    // key already announced while continuously current".
    if (prevKeyRef.current !== announceKey) {
      prevKeyRef.current = announceKey;
      announcedRef.current = NEVER_ANNOUNCED;
    }
    if (!overflowing) {
      // Content now fits (track changed to a short title, or the bar grew
      // mid-glide): a leftover pass would drag the short line around.
      animRef.current?.cancel();
      animRef.current = null;
      return;
    }
    if (announcedRef.current === announceKey) return;
    if (playRef.current(true)) {
      announcedRef.current = announceKey;
      // A track change under the pointer starts its announce pass held —
      // the user is reading or about to click; it glides when they move off.
      if (pointerInsideRef.current) animRef.current?.pause();
    }
  }, [announceKey, overflowing]);

  return (
    <div
      ref={wrapRef}
      className={`min-w-0 overflow-hidden whitespace-nowrap ${className ?? ''}`}
    >
      <div ref={trackRef} className="inline-flex" style={{ gap }}>
        <div ref={contentRef} className="inline-flex">
          {children}
        </div>
        {overflowing ? (
          <div aria-hidden className="inline-flex">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
