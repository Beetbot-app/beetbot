import type { HomeShelf } from './api';

/**
 * A one-shot hand-off of Home shelves from the onboarding finish to a mounted
 * `HomeScreen`.
 *
 * A brand-new profile has no play history, so the server's discovery build has
 * nothing cached and pays the full cold cost — ~40s on a first-seen set of
 * artists, because every Deezer call it makes is spaced 110ms apart. Until that
 * lands, Home is empty. But onboarding just fetched the picked artists' top
 * tracks (to start playback), so we already hold enough to paint a full,
 * high-signal page immediately: one "Because you like {artist}" row per pick,
 * plus a blended "Your mix". The wizard stashes those here on finish; Home reads
 * them once and prepends them ahead of the still-building server feed.
 *
 * Per profile and consumed on read (`take`), never persisted — so they fill the
 * gap exactly once, right after onboarding, and never resurface on a later visit
 * (the real, cached feed owns Home from then on).
 */
const pending = new Map<number, HomeShelf[]>();

/** Fired after `setInstantHomeShelves`, so a Home that mounted before the picks'
 *  top tracks finished fetching still picks them up. Detail carries the profile
 *  the shelves belong to, so a Home on a different profile ignores it. */
export const HOME_INSTANT_EVENT = 'beetbot:home-instant';

/** Stash a profile's picks-derived shelves and notify any mounted Home. No-op
 *  for an empty set (nothing to paint). */
export function setInstantHomeShelves(profileId: number, shelves: HomeShelf[]): void {
  if (!shelves.length) return;
  pending.set(profileId, shelves);
  try {
    window.dispatchEvent(
      new CustomEvent(HOME_INSTANT_EVENT, { detail: { profileId } }),
    );
  } catch {
    /* non-DOM context — Home reads the map on its next load instead */
  }
}

/** Read and CLEAR a profile's stashed shelves. One-shot: a second reader (the
 *  sync read on Home's load vs. the async event) gets nothing. */
export function takeInstantHomeShelves(profileId: number): HomeShelf[] {
  const shelves = pending.get(profileId) ?? [];
  pending.delete(profileId);
  return shelves;
}
