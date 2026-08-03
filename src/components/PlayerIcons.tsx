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
 * `size` is the only knob: the bar runs them at 18px, the corner toggles at 20.
 */

/** Speech bubble with quote marks. A filled glyph on a 16-unit grid (not the
 *  24-unit stroked grid the rest of the chrome uses) — deliberately kept:
 *  an outlined 24-grid version was tried in the icon-harmony pass and the
 *  user preferred this one. Keep the viewBox. */
export function LyricsIcon({ size = 18 }: { size?: number }) {
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
