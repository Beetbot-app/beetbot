import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Session-scoped scroll positions, keyed by a stable page identity
 * ("artist:892", "album:123", "search:coldplay", "playlist:5", "home"). Lets
 * Back/Forward — and revisiting a page — land where you left off instead of at
 * the top. Module-level so a position survives the component unmount/remount
 * the desktop does: the search overlay swaps its drill-in pages inside ONE
 * scroll container, and the main views remount per navigation. Capped (MRU
 * eviction) so a long session can't grow it without bound.
 */
const POSITIONS = new Map<string, number>();
const MAX_ENTRIES = 120;

function remember(key: string, top: number): void {
  // Re-insert to mark most-recently-used (Map keeps insertion order, so the
  // first key is the oldest).
  POSITIONS.delete(key);
  POSITIONS.set(key, top);
  if (POSITIONS.size > MAX_ENTRIES) {
    const oldest = POSITIONS.keys().next().value;
    if (oldest !== undefined) POSITIONS.delete(oldest);
  }
}

/** Forget a page's saved scroll (e.g. a profile switch clears everyone's). */
export function forgetScroll(key: string): void {
  POSITIONS.delete(key);
}

/**
 * Remember + restore a scroll container's position per logical page.
 *
 * Attach the returned callback ref to the scrollable element and pass a stable
 * `key` for whatever content is currently inside it. When `key` changes the
 * hook saves the outgoing position and restores the incoming one (0 if unseen),
 * and it keeps the current key's position current as you scroll. A `null` key
 * disables it (nothing tracked/restored).
 *
 * Works whether the element persists across key changes (the desktop search
 * overlay) or remounts with the page (Home / a playlist) — save-on-detach plus
 * save-on-key-change cover both.
 */
export function useScrollMemory(
  key: string | null,
): (node: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);
  const keyRef = useRef<string | null>(null);

  const setNode = useCallback((node: HTMLElement | null) => {
    // Detaching (unmount): capture the final position of what was showing.
    if (!node && nodeRef.current && keyRef.current) {
      remember(keyRef.current, nodeRef.current.scrollTop);
    }
    nodeRef.current = node;
  }, []);

  // Keep the current key's position up to date as the container scrolls
  // (rAF-throttled). Deliberately NOT gated on a user gesture: synthetic and
  // assistive scrolls are real scrolls too, and gating on 'wheel' silently
  // stopped saving for them. Spurious transition scrolls (our own restore
  // write, the reset-to-top, the clamp when a page swaps out) are harmless
  // because the key has already flipped to the incoming page by then — they
  // land on the NEW key, never on the position we're trying to preserve.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (keyRef.current) remember(keyRef.current, node.scrollTop);
      });
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // Re-bind if the element identity changed alongside the key (per-view
    // containers that remount); a persistent container just re-binds harmlessly.
  }, [key]);

  // On key change (and first mount): restore the incoming key's position.
  //
  // We deliberately DON'T save the outgoing key here: by the time this runs the
  // DOM has already swapped in the new (often still-short, async-loading) page,
  // so the shared container's scrollTop has been clamped toward 0 — reading it
  // now would overwrite the outgoing page's real position with that clamped
  // value. The continuous scroll listener above already keeps every key current
  // as you scroll (and detach saves unmounting per-view pages), so the outgoing
  // position is safe without a save here.
  useLayoutEffect(() => {
    const node = nodeRef.current;
    // Flip the key FIRST, before touching scrollTop below — so every scroll
    // event this transition causes is attributed to the incoming page, not the
    // outgoing one whose position we're preserving.
    keyRef.current = key;
    if (!node || !key) return;
    const target = POSITIONS.get(key) ?? 0;
    // Set the position immediately (atomically with the key change). For an
    // unseen page target is 0, so this doubles as the reset-to-top when a page
    // swaps into a shared, already-scrolled container — done here under the NEW
    // key so it can't be mis-saved against the outgoing one.
    node.scrollTop = target;
    if (target <= 0) return; // fresh page — top is the final answer

    // Keep re-applying the target until the page is actually tall enough to
    // hold it — then stop. Two things make a page grow into `target` AFTER this
    // effect runs, and a fixed short poll misses the slow one:
    //   • lazy images / a late async block (fast — a few frames)
    //   • a COLD Home feed painting shelves progressively over several seconds
    // So we drive re-application off a ResizeObserver on the content (fires on
    // every height change, however late) plus a brief rAF settle, bounded by a
    // generous timeout, and cancel the instant the user scrolls so we never
    // fight a deliberate scroll.
    let done = false;
    let raf = 0;
    const apply = () => {
      if (done || nodeRef.current !== node || keyRef.current !== key) return;
      if (node.scrollTop < target - 1) node.scrollTop = target;
      if (node.scrollTop >= target - 1) finish(); // reached it
    };
    const finish = () => {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.clearTimeout(timer);
      node.removeEventListener('wheel', finish);
      node.removeEventListener('touchmove', finish);
      window.removeEventListener('keydown', finish);
    };
    // Re-apply whenever the scrollable content changes size — this is what
    // catches the cold feed's late shelves.
    const ro = new ResizeObserver(apply);
    ro.observe(node.firstElementChild ?? node);
    // A short rAF settle for the common fast case (no wait on the observer).
    let frames = 0;
    const tick = () => {
      if (done) return;
      apply();
      if (!done && frames++ < 20) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Bounded window; a page that legitimately can't reach `target` (fewer
    // items than before) just stops here, wherever it got.
    const timer = window.setTimeout(finish, 8000);
    // Any real user scroll ends the restore immediately.
    node.addEventListener('wheel', finish, { passive: true });
    node.addEventListener('touchmove', finish, { passive: true });
    window.addEventListener('keydown', finish);
    return finish;
  }, [key]);

  return setNode;
}
