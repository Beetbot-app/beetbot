import { useEffect, useState } from 'react';

/**
 * Announce that a profile changed — its name, its photo, or the set of them.
 *
 * This exists because a profile can now be edited from a *phone*. Until that
 * landed, every profile write went through the desktop's own Tauri commands,
 * so the desktop always knew: whatever changed it also redrew it. A phone
 * writing over HTTP is invisible to the Mac, which loads profiles once and
 * keeps them — so a name or face edited on the sofa left a stale one in the
 * corner of the window until the app was restarted.
 *
 * Two triggers, because there are two ways to find out:
 *   - the event, for a change made in this window;
 *   - regaining focus, for a change made anywhere else. Polling would be the
 *     alternative, and a profile is not worth a timer: you look at the window
 *     when you come back to it, which is exactly when it should be right.
 *
 * The cached read is evicted first, exactly as `notifyLibraryChanged` does for
 * playlists: `/api/profiles` is in the service worker's cacheable set, so a
 * screen that refetches after a write is served the list from *before* it —
 * a profile deleted on the phone kept appearing on "Who's listening?" until
 * something else happened to refresh the cache. The desktop never needed this
 * (it reads profiles through Tauri, with no service worker in the path), which
 * is exactly why the gap only showed up once the phone could write.
 */
const API_CACHE = 'beetbot-api-v1';

/** The profile list and the avatars hanging off it. */
const INVALIDATED_BY_A_PROFILE_WRITE = /\/api\/profiles(\/\d+\/avatar)?(\?|$)/;

async function purgeStaleProfileReads(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(API_CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => INVALIDATED_BY_A_PROFILE_WRITE.test(req.url))
        .map((req) => cache.delete(req)),
    );
  } catch {
    // No Cache API (desktop webview, private browsing) — nothing cached to
    // evict, and the event below still fires.
  }
}

/**
 * Call INSTEAD of dispatching `beetbot:profiles-changed` by hand: it clears the
 * stale reads first, so listeners that refetch see the write.
 */
export function notifyProfilesChanged(): void {
  void purgeStaleProfileReads().finally(() => {
    window.dispatchEvent(new Event('beetbot:profiles-changed'));
  });
}

/**
 * A counter that bumps whenever profiles may have changed. Put it in a fetch
 * effect's dependencies and that fetch re-runs at the right moments.
 */
export function useProfilesVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const onFocus = () => {
      // `focus` alone misses a window that was never blurred but whose tab
      // came back; visibilitychange covers the phone returning from the
      // background.
      if (document.visibilityState === 'visible') bump();
    };
    window.addEventListener('beetbot:profiles-changed', bump);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('beetbot:profiles-changed', bump);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  return version;
}
