/**
 * Expiring a resolved portrait MISS.
 *
 * The backfill stores either a real portrait or null, and null used to be the
 * end of it: `portrait` gets marked, and a null is not a stand-in image, so
 * `isReplaceableArt` says no and nothing ever asked again. That made a
 * one-off failure — a throttled search, an entry with no image that day —
 * permanent. Measured against a real library, Deezer has a portrait for ~97%
 * of artists, so a stored null is far more often a stale answer than a real
 * gap.
 *
 * What has to stay true while fixing that:
 *
 * 1. **A hit is still forever.** Only misses expire; a resolved portrait must
 *    never be re-queried on a timer.
 * 2. **A miss expires, but only after the TTL.** Otherwise the backfill goes
 *    from frozen to re-querying every artist every session.
 * 3. **Records written before `artAt` existed get exactly one re-check** —
 *    they are the ones holding the frozen misses this fixes.
 */
import { describe, expect, test } from 'vitest';

import { PORTRAIT_MISS_TTL_MS, isStalePortraitMiss, type SavedArtist } from './saved';

const NOW = 1_800_000_000_000;

function artist(over: Partial<SavedArtist> = {}): SavedArtist {
  return { key: 'aphex-twin', name: 'Aphex Twin', art: null, savedAt: 0, ...over };
}

describe('isStalePortraitMiss', () => {
  test('a resolved hit never goes stale, however old', () => {
    const hit = artist({ art: 'https://cdn/portrait.jpg', portrait: true, artAt: 0 });
    expect(isStalePortraitMiss(hit, NOW)).toBe(false);
  });

  test('an unresolved record is not a miss — the `!portrait` arm already has it', () => {
    expect(isStalePortraitMiss(artist(), NOW)).toBe(false);
  });

  test('a fresh miss is left alone', () => {
    const miss = artist({ portrait: true, artAt: NOW - 1_000 });
    expect(isStalePortraitMiss(miss, NOW)).toBe(false);
  });

  test('a miss just short of the TTL is still fresh', () => {
    const miss = artist({ portrait: true, artAt: NOW - PORTRAIT_MISS_TTL_MS + 1 });
    expect(isStalePortraitMiss(miss, NOW)).toBe(false);
  });

  test('a miss at exactly the TTL is retried', () => {
    const miss = artist({ portrait: true, artAt: NOW - PORTRAIT_MISS_TTL_MS });
    expect(isStalePortraitMiss(miss, NOW)).toBe(true);
  });

  test('a miss from before `artAt` existed is retried once', () => {
    const legacy = artist({ portrait: true });
    expect(isStalePortraitMiss(legacy, NOW)).toBe(true);
  });

  test('re-stamping a still-missing artist buys another full TTL', () => {
    // The regression this guards: if a repeat miss kept its original date, the
    // record would read as expired on every single session.
    const restamped = artist({ portrait: true, artAt: NOW });
    expect(isStalePortraitMiss(restamped, NOW)).toBe(false);
    expect(isStalePortraitMiss(restamped, NOW + PORTRAIT_MISS_TTL_MS)).toBe(true);
  });
});
