/**
 * When to suggest keeping Beetbot on the home screen.
 *
 * The matrix is the part worth being sure about: three inputs, and only one
 * combination shows anything. Getting it wrong in either direction is bad in a
 * specific way — offering it to somebody who already installed reads as "that
 * didn't work", and offering it on every visit is an advert.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  DISMISSED_KEY,
  isIos,
  isMobile,
  isStandalone,
  rememberDismissed,
  shouldOffer,
  wasDismissed,
} from './install';
import { mockMatchMedia } from '../../test/setup';

describe('shouldOffer', () => {
  test('offers only on a phone, in a tab, to somebody who has not said no', () => {
    expect(shouldOffer({ mobile: true, standalone: false, dismissed: false })).toBe(true);
  });

  test('never on a desktop browser', () => {
    expect(shouldOffer({ mobile: false, standalone: false, dismissed: false })).toBe(false);
  });

  test('never when it is already installed', () => {
    expect(shouldOffer({ mobile: true, standalone: true, dismissed: false })).toBe(false);
  });

  test('never twice', () => {
    expect(shouldOffer({ mobile: true, standalone: false, dismissed: true })).toBe(false);
  });
});

describe('isStandalone', () => {
  test('a plain browser tab is not standalone', () => {
    expect(isStandalone()).toBe(false);
  });

  test('an installed PWA is, by display-mode', () => {
    mockMatchMedia((q) => q.includes('display-mode: standalone'));
    expect(isStandalone()).toBe(true);
  });

  test('iOS reports it its own way, and that counts too', () => {
    // Safari never implemented the display-mode media query for home-screen
    // apps; navigator.standalone is the only signal there.
    vi.spyOn(window, 'navigator', 'get').mockReturnValue({
      ...window.navigator,
      standalone: true,
    } as Navigator);
    expect(isStandalone()).toBe(true);
  });
});

describe('isMobile', () => {
  test('a coarse pointer in a narrow window is a phone', () => {
    mockMatchMedia((q) => q.includes('pointer: coarse'));
    window.innerWidth = 390;
    expect(isMobile()).toBe(true);
  });

  test('a mouse is never a phone, however narrow the window', () => {
    mockMatchMedia(() => false);
    window.innerWidth = 390;
    expect(isMobile()).toBe(false);
  });

  test('a touchscreen laptop at full width is not a phone', () => {
    mockMatchMedia((q) => q.includes('pointer: coarse'));
    window.innerWidth = 1600;
    expect(isMobile()).toBe(false);
  });
});

describe('isIos', () => {
  const withUserAgent = (ua: string, maxTouchPoints = 0) => {
    vi.spyOn(window, 'navigator', 'get').mockReturnValue({
      ...window.navigator,
      userAgent: ua,
      maxTouchPoints,
    } as Navigator);
  };

  test('an iPhone', () => {
    withUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(isIos()).toBe(true);
  });

  test('an iPad, which claims to be a Mac and is given away by touch', () => {
    withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5);
    expect(isIos()).toBe(true);
  });

  test('an actual Mac', () => {
    withUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0);
    expect(isIos()).toBe(false);
  });
});

describe('remembering a dismissal', () => {
  test('nothing is remembered until it is', () => {
    expect(wasDismissed()).toBe(false);
    rememberDismissed();
    expect(wasDismissed()).toBe(true);
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  test('storage that refuses to be read counts as dismissed', () => {
    // Private browsing with storage denied. Staying quiet beats asking on every
    // single visit with no way to make it stop.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(wasDismissed()).toBe(true);
  });

  test('storage that refuses to be written does not throw at the caller', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => rememberDismissed()).not.toThrow();
  });
});
