import { useSyncExternalStore } from 'react';
import {
  getRecentlyPlayedPlaylistsVersion,
  subscribeRecentlyPlayedPlaylists,
} from './api';

/**
 * Re-render when the "recently played playlists" order changes.
 *
 * The map itself lives in localStorage, which isn't reactive, and the hub's
 * shared copy is merged in asynchronously (on profile switch). Anything that
 * sorts by recency must therefore subscribe — otherwise it paints whatever was
 * cached at mount and only picks up the other device's plays if some unrelated
 * state happens to re-run the sort.
 *
 * Returns an opaque version number: feed it into the dependency list of the
 * memo that does the sorting.
 */
export function useRecentlyPlayedVersion(): number {
  return useSyncExternalStore(
    subscribeRecentlyPlayedPlaylists,
    getRecentlyPlayedPlaylistsVersion,
    getRecentlyPlayedPlaylistsVersion,
  );
}
