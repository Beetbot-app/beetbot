/**
 * Connect / Devices — the "monitor + speaker" glyph (lucide MonitorSpeaker):
 * a screen behind, a small speaker with a woofer dot in front. Reads as "your
 * devices", not any one casting protocol.
 *
 * Lives in shared so the desktop player bar and the phone player bar draw the
 * SAME mark — they had drifted to two different device glyphs, which made the
 * same feature look like two features.
 */
export function ConnectIcon({ size = 18 }: { size?: number }) {
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
      <path d="M5.5 20H8" />
      <path d="M17 9h.01" />
      <rect width="10" height="16" x="12" y="4" rx="2" />
      <path d="M8 6H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4" />
      <circle cx="17" cy="15" r="1" />
    </svg>
  );
}
