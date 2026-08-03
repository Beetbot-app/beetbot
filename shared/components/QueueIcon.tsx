/**
 * Queue — Spotify-style: a now-playing ▶ leading the top row, two full ruled
 * lines below ("the current song, then the list").
 *
 * Lives in shared so the desktop player, the phone's Now Playing and the remote
 * device screen draw the SAME mark. The phone had drifted to a plain
 * lines-and-dots list glyph, which made one feature look like two — the same
 * drift ConnectIcon was moved here to fix.
 */
export function QueueIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 4.2v4.6l4-2.3z" fill="currentColor" stroke="none" />
      <path d="M11 6.5h9.5" />
      <path d="M3.5 12.5h17" />
      <path d="M3.5 18.5h17" />
    </svg>
  );
}
