/**
 * The Lyrics + Up-next glyphs.
 *
 * ONE definition each, shared by the player bar's buttons and the fullscreen
 * Now Playing corner toggles. The two surfaces had drawn *different* icons for
 * the same two actions — a quoted speech bubble vs three text lines for Lyrics,
 * a bulleted list vs a note-list for the queue — so the same control looked
 * like two different things depending on where you found it. These are the
 * fullscreen's glyphs, which the bar now adopts. Import them instead of
 * hand-rolling a third variant.
 *
 * `size` is the only knob, and the crisp values are 16 and 24: the lyrics
 * glyph lives on a 16-unit grid, so those map one unit to exactly 2 and 3
 * device pixels at 2x, and the queue glyph's 24-grid hits 1:1 at 24. Other
 * sizes are legal but render the bubble's 1-unit walls slightly soft.
 *
 * When these icons look ASYMMETRIC (one wall thick, one thin), suspect the
 * WEBVIEW ZOOM before the artwork. On 24 Aug 2026 the bar's bubble measured a
 * 2.46px left wall against 1.05px right — reproduced in neither Chrome nor
 * QuickLook's WebKit at any size or offset — and the cause was the app
 * running at ~110% page zoom from a stray Cmd+plus, which multiplies every
 * layout position into fractional device pixels. Cmd+0 fixed what two icon
 * resizes could not. Measure button-centre spacing against its CSS value to
 * detect this: 40px apart should be exactly 80 device px at 2x.
 */

/** Speech bubble with quote marks. A filled glyph on a 16-unit grid (not the
 *  24-unit stroked grid the rest of the chrome uses) — deliberately kept:
 *  an outlined 24-grid version was tried in the icon-harmony pass and the
 *  user preferred this one. Keep the viewBox. */
export function LyricsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z" />
      <path d="M7.066 4.76A1.665 1.665 0 0 0 4 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112zm4 0A1.665 1.665 0 0 0 8 5.668a1.667 1.667 0 0 0 2.561 1.406c-.131.389-.375.804-.777 1.22a.417.417 0 1 0 .6.58c1.486-1.54 1.293-3.214.682-4.112z" />
    </svg>
  );
}

// Connect / Devices and Queue live in shared so the phone draws the same marks.
export { ConnectIcon } from '@shared/components/ConnectIcon';
export { QueueIcon } from '@shared/components/QueueIcon';
