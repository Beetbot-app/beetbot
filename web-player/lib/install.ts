/**
 * Whether to suggest keeping Beetbot on the home screen.
 *
 * Split from the sheet itself so the decision is a plain function rather than
 * something buried in a render, and so the sheet file exports only a component.
 *
 * The reason any of this exists: on iOS a page in a Safari tab stops its audio
 * when the screen locks; installed to the home screen it does not. That is the
 * difference between a music player that works in your pocket and one that
 * doesn't, and nobody finds it by themselves — least of all somebody who has
 * just followed an invitation from a friend.
 */

export const DISMISSED_KEY = 'beetbot.install_sheet_dismissed';

/** Already installed? Then there is nothing to suggest. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** A phone or tablet — the only place a home-screen icon is worth suggesting. */
export function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  // Touch plus a narrow viewport. Deliberately not user-agent sniffing: iPadOS
  // reports itself as a Mac, and a desktop browser in a narrow window has no
  // coarse pointer.
  return window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 1024;
}

/** iOS, where there is no install API and instructions are the only option. */
export function isIos(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iPadOS 13+ claims to be a Mac; touch points are what give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Has the person already said no? */
export function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Private browsing with storage denied. Better to stay quiet than to ask on
    // every single visit with no way to make it stop.
    return true;
  }
}

export function rememberDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* nothing to remember it in; the sheet simply reappears next visit */
  }
}

/**
 * The whole rule, in one place: offer only on a phone, only in a browser tab,
 * and only to somebody who has not already dismissed it.
 */
export function shouldOffer(opts: {
  mobile: boolean;
  standalone: boolean;
  dismissed: boolean;
}): boolean {
  return opts.mobile && !opts.standalone && !opts.dismissed;
}
