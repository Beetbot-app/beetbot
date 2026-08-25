/** The "beetbot" wordmark — the brand display serif (Fraunces / Playfair
 *  Display, Georgia fallback), bold italic. Matches logo/beetbot-wordmark.svg,
 *  including its tracking: the brand sets letter-spacing -4 at size 104, i.e.
 *  -0.0385em, and the outlined logo SVGs bake exactly that — a rounder value
 *  here renders the live wordmark ~1px wider than every logo asset.
 *  The one place the beet crimson belongs; decorative, so hidden from
 *  assistive tech (the app is labelled elsewhere).
 *
 *  Lives in its own module so both the sidebar (expanded) and the first-run
 *  wizard can show it without pulling the whole Sidebar in. Size comes from the
 *  caller via `className` (the sidebar's 24px is the default).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`select-none text-[24px] font-extrabold italic leading-none tracking-[-0.0385em] ${className ?? ''}`}
      style={{ fontFamily: '"Fraunces", "Playfair Display", Georgia, serif' }}
    >
      <span style={{ color: '#F7EDF0' }}>beet</span>
      <span style={{ color: '#FF3D7F' }}>bot</span>
    </span>
  );
}
