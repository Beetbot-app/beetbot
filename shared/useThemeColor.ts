import { useEffect } from 'react';

/**
 * The app's own base background (Tailwind neutral-950). This is what the Home
 * screen actually paints, so it's what the status-bar strip should be when no
 * sheet is up — the manifest's brand ink (#141013) is a warmer near-black and
 * reads as a seam against it.
 */
const DEFAULT_THEME_COLOR = '#0a0a0a';

/** Whatever index.html shipped — captured once, so cleanup has a fixed target. */
const ORIGINAL_THEME_COLOR =
  (typeof document !== 'undefined' &&
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content) ||
  DEFAULT_THEME_COLOR;

function themeColorMeta(): HTMLMetaElement {
  let m = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!m) {
    m = document.createElement('meta');
    m.name = 'theme-color';
    document.head.appendChild(m);
  }
  return m;
}

/** The colour a CSS gradient paints at its start — i.e. at the top edge. */
export function gradientTopColor(gradient: string | null | undefined): string | null {
  if (!gradient) return null;
  const m = gradient.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/);
  return m ? m[0] : null;
}

/**
 * Point the status-bar strip at whatever the screen is painting underneath it.
 *
 * On a home-screen app the strip is drawn by the OS, not by us, so it can't
 * inherit the artwork wash the way the rest of the sheet does — it shows as a
 * black band above the content. Feeding the current top colour to `theme-color`
 * is the only lever the platform gives us. Restores the previous value on
 * unmount so closing a sheet returns the strip to the app background.
 */
export function useThemeColor(color: string | null | undefined) {
  useEffect(() => {
    const m = themeColorMeta();
    m.content = color || DEFAULT_THEME_COLOR;
    // Restore the page's ORIGINAL value, not whatever was set when this effect
    // last ran. The colour arrives asynchronously (the accent is extracted from
    // the cover), so the effect re-runs mid-sheet; saving "previous" then meant
    // the second run captured the first run's tint and closing the sheet left
    // the status bar stuck on the album colour. Verified: it was still
    // rgb(94,64,41) after the devices sheet closed.
    return () => {
      m.content = ORIGINAL_THEME_COLOR;
    };
  }, [color]);
}
