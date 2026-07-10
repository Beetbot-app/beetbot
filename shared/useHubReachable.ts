import { useSyncExternalStore } from 'react';
import { isHubReachable, onHubReachability } from './api';

/**
 * Re-render on hub-reachability changes and return the current value.
 *
 * Gate hub-dependent controls on this so they disable / show a "needs your
 * computer" hint the moment the desktop becomes unreachable — instead of
 * staying tappable and failing after (a reactive dead-end). Pairs with
 * {@link canPlayNow} for Play controls, and with a plain `!hubUp` check for
 * write actions (rename / delete / like / import / new playlist).
 *
 * Backed by the shared reachability flag (already hysteresis-debounced at the
 * source, so a single slow beat won't flap the gate). useSyncExternalStore
 * keeps the subscription tear-free; the server snapshot is `true` (assume
 * reachable) so SSR/first paint never flashes a disabled state.
 */
export function useHubReachable(): boolean {
  return useSyncExternalStore(
    onHubReachability,
    isHubReachable,
    () => true,
  );
}
