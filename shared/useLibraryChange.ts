import { useEffect, useState } from 'react';

/**
 * A counter that bumps every time the library changes anywhere — a track added
 * to or removed from a playlist, a like/unlike, an album/artist saved. Add it to
 * a fetch effect's dependency array so a page showing membership / saved / "in a
 * playlist" indicators RE-FETCHES on a change instead of going stale until the
 * user navigates away and back.
 *
 * Pairs with the app-wide `beetbot:library-changed` window event that every
 * playlist-mutating surface dispatches (AddToPlaylistModal, the star in likes.ts,
 * AlbumDetailModal's save, …). Reactive stores (`useLikesStore`, `useSavedStore`,
 * `usePinStore`) already cover the controls bound to them; this hook is for the
 * surfaces that render indicators straight from a one-shot fetch.
 *
 * Harmless where the event never fires (e.g. the phone build): the tick simply
 * never advances.
 */
export function useLibraryChangeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChanged = () => setTick((n) => n + 1);
    window.addEventListener('beetbot:library-changed', onChanged);
    return () => window.removeEventListener('beetbot:library-changed', onChanged);
  }, []);
  return tick;
}
