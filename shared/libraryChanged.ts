/**
 * Announce that the library changed — after evicting the reads that change
 * invalidates.
 *
 * The phone is a PWA whose service worker serves `/api/playlists…` from
 * `beetbot-api-v1` stale-while-revalidate: on a hit it returns the cached body
 * immediately and refreshes in the background. That is right for opening the
 * app offline and wrong immediately after a write — every screen listening for
 * `beetbot:library-changed` refetches, hits the cache, and redraws the state
 * from *before* the write. Favouriting a track and then not finding it in
 * Favorites is exactly that: the write landed, the read was stale, and the
 * track appeared only on a later visit once the revalidate had run.
 *
 * `cache: 'reload'` does not help — that bypasses the HTTP cache, not the
 * service worker, which intercepts regardless. The only lever from the page is
 * to delete the entries first.
 *
 * Art is deliberately left cached: covers are big, and a like changing a
 * playlist's cover mosaic is not worth re-downloading every thumbnail for.
 */
const API_CACHE = 'beetbot-api-v1';

/** Matches the playlist list and a playlist's tracks, but not `/art`. */
const INVALIDATED_BY_A_WRITE = /\/api\/playlists(\/\d+)?(\?|$)/;

async function purgeStalePlaylistReads(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(API_CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => INVALIDATED_BY_A_WRITE.test(req.url))
        .map((req) => cache.delete(req)),
    );
  } catch {
    // No Cache API (desktop webview, private browsing) — nothing was cached,
    // so there is nothing stale to evict and the event below still fires.
  }
}

/**
 * Call INSTEAD of dispatching `beetbot:library-changed` by hand: it clears the
 * stale reads first, so the listeners that refetch see the write.
 */
export function notifyLibraryChanged(): void {
  void purgeStalePlaylistReads().finally(() => {
    window.dispatchEvent(new Event('beetbot:library-changed'));
  });
}
