/**
 * Inline SVG icons for the web-player transport bar.
 *
 * iOS Safari renders Unicode glyphs like ⏮ ⏸ ⏭ as colored emojis, which
 * looks foreign next to the desktop UI's monochrome rendering of the same
 * characters. Drawing them as SVGs makes the visual identical across
 * macOS, iOS, Android, and the desktop Tauri shell.
 *
 * Stroke / fill are kept minimal so a single `text-*` Tailwind class on
 * the parent controls the color (currentColor).
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svg(size: number, children: React.ReactNode, rest: SVGProps<SVGSVGElement>) {
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
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size = 22, ...rest }: IconProps) {
  return svg(
    size,
    <path d="M7 5.5v13a.5.5 0 0 0 .77.42l10-6.5a.5.5 0 0 0 0-.84l-10-6.5A.5.5 0 0 0 7 5.5Z" fill="currentColor" stroke="none" />,
    rest,
  );
}

export function PauseIcon({ size = 22, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <rect x="7" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>,
    rest,
  );
}

export function PrevIcon({ size = 22, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M6 6v12" />
      <path d="M19.4 6.3 9 12l10.4 5.7a.5.5 0 0 0 .75-.43V6.73a.5.5 0 0 0-.75-.43Z" fill="currentColor" />
    </>,
    rest,
  );
}

export function NextIcon({ size = 22, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M18 6v12" />
      <path d="M4.6 6.3 15 12 4.6 17.7a.5.5 0 0 1-.75-.43V6.73a.5.5 0 0 1 .75-.43Z" fill="currentColor" />
    </>,
    rest,
  );
}

export function ShuffleIcon({ size = 20, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M16 4h5v5" />
      <path d="m21 4-7.5 7.5" />
      <path d="M16 20h5v-5" />
      <path d="M21 20 3 4" />
      <path d="m3 20 5-5" />
    </>,
    rest,
  );
}

export function RepeatIcon({ size = 20, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>,
    rest,
  );
}

/** Variant with a "1" badge for repeat=one. */
export function RepeatOneIcon({ size = 20, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      {/* tiny "1" inside the repeat loop */}
      <text
        x="12"
        y="14.5"
        fontSize="7"
        fontFamily="ui-monospace, monospace"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
      >
        1
      </text>
    </>,
    rest,
  );
}

export function ChevronDownIcon({ size = 22, ...rest }: IconProps) {
  return svg(size, <path d="m6 9 6 6 6-6" />, rest);
}

export function VolumeIcon({ size = 18, ...rest }: IconProps) {
  return svg(
    size,
    <>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </>,
    rest,
  );
}
