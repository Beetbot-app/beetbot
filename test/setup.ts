import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Shared test setup.
 *
 * Two things every test in this suite needs, and neither belongs in an
 * individual file:
 *
 * 1. **A DOM that is empty at the start of each test.** Testing Library mounts
 *    into a shared document; without cleanup, a component from the previous test
 *    is still there and a `getByText` finds the wrong one.
 *
 * 2. **`matchMedia`, which jsdom does not implement.** The install sheet asks it
 *    whether this is a touch device and whether the page is already installed —
 *    so without a stand-in, every test touching it throws before it can assert
 *    anything. Defaults to "no match", i.e. a plain desktop browser; tests that
 *    care set it themselves.
 */

/** Point `matchMedia` at a predicate over the query string. */
export function mockMatchMedia(matches: (query: string) => boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  mockMatchMedia(() => false);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
