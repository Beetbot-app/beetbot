// App-wide "now playing" accent: the dominant color of the current track's
// artwork, written to the `--color-accent` token on <html> so Tailwind's
// `text-accent` / `bg-accent` utilities pick it up everywhere. Falls back to
// the stylesheet default (white) when there's no track or extraction fails.

import { useEffect } from 'react';
import { extractDominantColor, type Rgb } from './albumColor';

// Very desaturated covers read as gray — a gray accent looks like disabled UI,
// so use white instead. Dark colors are blended toward white to a lightness
// floor so the accent stays legible on the near-black background.
function legible([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.15) return [255, 255, 255];
  const light = (max + min) / 2 / 255;
  const floor = 0.65;
  if (light >= floor) return [r, g, b];
  const t = (floor - light) / (1 - light);
  return [
    Math.round(r + (255 - r) * t),
    Math.round(g + (255 - g) * t),
    Math.round(b + (255 - b) * t),
  ];
}

export function useAccentColor(artUrl: string | null | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    if (!artUrl) {
      root.style.removeProperty('--color-accent');
      return;
    }
    let cancelled = false;
    void extractDominantColor(artUrl).then((c) => {
      if (cancelled) return;
      if (!c) {
        root.style.removeProperty('--color-accent');
        return;
      }
      const [r, g, b] = legible(c);
      root.style.setProperty('--color-accent', `rgb(${r} ${g} ${b})`);
    });
    return () => {
      cancelled = true;
    };
  }, [artUrl]);
}
