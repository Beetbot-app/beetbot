//
// Beetbot web-player service worker.
//
// Three cache namespaces (prefix-versioned; bump the suffix to invalidate):
//   beetbot-shell-*  — HTML / JS / CSS / icons. Network-first nav,
//                      stale-while-revalidate for hashed assets.
//   beetbot-audio-*  — Audio responses cached on explicit user opt-in.
//                      Cache key strips the session token so a token
//                      rotation doesn't invalidate offline tracks.
//   beetbot-api-*    — Stale-while-revalidate cache of read-only API GETs
//                      (library, playlist tracks, metadata, art) so the
//                      PWA boots fully offline.
//
// On /stream/<id> requests we look up the stripped URL in the audio cache.
// On hit we serve from cache (and synthesize a Range 206 if the request had
// a Range header so audio elements can seek inside long files). On miss we
// fall through to network -- we NEVER auto-cache, every cached track is
// the result of an explicit user "Available offline" action.

// v320: home-screen / PWA icons regenerated full-bleed and opaque. The old
// apple-touch-icon.png / icon-192 / icon-512 rasterized the crimson beet to
// black (the gradient was lost) and kept transparent, pre-rounded corners, so
// iOS drew a tiny dark beet inside a white frame. Bumping the shell cache
// forces phones to re-fetch the corrected icons.
// v321: Mix/catalog-playlist rows — now-playing cover overlay is phone-only
// (sm:hidden); desktop keeps the indicator in the number gutter alone.
// v322: real shuffle — one-pass permutation plan (no early repeats, honors
// repeat all/off at pass end), history-aware prev, shuffle-aware crossfade
// + prefetch via peekNextIndex.
// v323: consistency fixes — search Songs tab now-playing indicator, library
// search rows gate on canPlayNow (live-streamable songs no longer dimmed).
// v324: Up next tells the truth under shuffle — queue UIs display the plan
// order and drag-reorder edits the plan.
// v325: hero secondary-button hovers unified to circles; Fisher-Yates for the
// artist-page + taste-picks shuffles.
// v326: cast streamed (non-downloaded) tracks — warm the /live temp file,
// then hand the Chromecast the seekable URL (Preparing… state while cold).
// v327: Connect polish — device-agnostic icon, sheet reflects remote-playing
// device, remote 'playing on…' banner docked to the bottom (no longer over Home).
// v350: Now Playing rework — Connect + Queue moved to the header corners,
// lyrics became a peeking preview card with its own full-screen reading view.
// Nav is cache-first, so without this bump a phone would render the previous
// HTML (and its old bundle hash) for one more launch before picking any of it
// up. Bumping reaps the stale shell cache and lands the new build on the next
// open. Audio + API caches are untouched — offline tracks survive.
// v351: safe-area fixes for the same sheet (dead strip under the lyrics card,
// peek collapsing on inset screens). Re-bumped rather than riding v350: a
// phone that already installed v350 precached the build before these fixes,
// and would otherwise need a second launch to see them.
// v352: the remote device's Now Playing screen gets the lyrics card too.
// v353: remote device screen gains a Queue button + that device's Up next.
// v354: cover stays square when its box is shorter than it is wide.
// v355: swipe-down-to-dismiss on the remote device Now Playing screen.
// v356: devices sheet locks background scroll while it's up.
// v357: flat 48px lyrics peek; devices screen artwork matches the local sheet.
// v358: TEMPORARY viewport probe for the standalone bottom-bar question.
// v359: drop the deprecated black-translucent status bar. On a home-screen
// app it cost 62pt of dead black space at the bottom of the screen.
// v360: status-bar strip follows the screen's own colour (theme-color).
// v362: wash starts at black so it meets the OS status-bar strip cleanly.
// v363: 100vh root + black-translucent restored — wash behind the status bar
// without the bottom bar. Probe re-added for one verification pass.
// v364: viewport confirmed full-screen on device; diagnostic probe removed.
// v365: phone Queue button draws the desktop's queue mark.
// v366: favourite the track playing on another device from its screen.
// v367: remote device screen gets the ⋯ menu; heartbeat carries the album.
// v368: a library write now evicts the cached playlist reads it invalidates.
// v369: remote clock no longer jumps forward the moment playback starts.
// v370: re-probe the hub on pageshow/focus so a resumed PWA clears a stale
// 'can't reach your library' instead of needing a full relaunch.
// v371: MUST BE BUMPED — a phone that reached Beetbot from outside while the
// host was asleep may have the remote-access service's "computer is asleep"
// placeholder cached as the app shell. It used to arrive as a 200, and this
// worker cached any 200 navigation as the shell (see isRealShell), so
// cache-first navigation then served the placeholder on every launch no matter
// what the computer was doing. Bumping reaps the poisoned entry, which is the
// only way an already-affected phone recovers.
// v373: playback resumes after an interruption. iOS pauses media for a phone
// call and hands a web page no "interruption ended" signal at all, so the music
// simply stayed paused — three times in one afternoon of testing. Resume fires
// when the page becomes visible again, which is the only signal available: the
// page is suspended ~12s into a call, so nothing can run to notice it ending.
// v374: Home labelling — "Top songs" is now "Your top songs" (HOME_FEED_VERSION
// bumped with it), and the cold-start shelf now says why it's generic ("Until
// we know your taste"). Bump so phones pick the new bundle up on next launch.
// v375: tappable credits — every artist on the Now Playing overlay is its own
// tap target, and the track sheet's "Go to Artist" lists each credited artist
// on a collab instead of always the first.
// v376: backgrounded track changes. iOS keeps a backgrounded page alive
// *because* it is playing audio; when the audio stops, script execution ceases
// about twelve seconds later and nothing in-page can recover — measured on a
// locked iPhone 1 Aug. Every recovery mechanism was therefore racing a fuse it
// could not beat, so the fix is to stop the audio ever stopping: the prefetch
// now keeps the next tracks' bytes and the boundary plays them from memory with
// no network request. Bump so a phone picks the new bundle up on the next
// launch rather than the one after (navigation is stale-while-revalidate).
// v377: three polish fixes. The playlist header's "downloaded" count was
// reading a capability flag (true for every track on the full build), so it
// always claimed n of n; it now counts files actually on the hub. Home shelf
// titles carry their own "show all" chevron. And a sheet tapped during its
// own slide-out is caught and brought back instead of the tap being lost.
// v378: that chevron is sized in em, so it scales with the title it follows
// instead of sitting at a fixed 16px beside a 24px shelf heading.
// v379: phone library — the kind-filter chips are a real thumb target
// (~36px, was 28), and the main scroller no longer paints a scrollbar, which
// looked like a desktop artefact beside the native apps it sits next to.
// v380: the page itself no longer rubber-bands. Dragging the library moved
// the whole app — sticky header and bottom bar with it — because the document
// was bouncing, not the list. overscroll-behavior:none at the root refuses it.
// v381: the offline set is browsable. "N songs cached offline" was a fact you
// could not act on, sitting above the library as a banner; the songs are now
// an Offline chip in the library and the storage math + Clear all moved to
// Settings, which is how the desktop has always split it.
// v382: "Saved on this device" is a screen you can open — the songs listed
// like a playlist, with Clear all beside the tracks it would delete instead
// of on a settings row.
// v383: the offline collection looks like a collection — cover, title,
// shuffle/play — and a row swiped left asks before it removes that one song.
// v384: the stats range control rides in the pinned header — it decides what
// every number means, and it used to scroll away with them.
// v385: phone settings stops over-explaining. Footers became short row
// subtitles or went away, sharing moved behind a People row, and the delete
// warning now appears only once a tap has armed it.
// v386: you can edit your own profile from the phone — name and photo. The
// card was display-only because the hub had no endpoint for either.
// v387: Done on the profile editor is always live — the photo saves on pick,
// so gating it on a pending rename left it dim right after a visible change.
// v388: deleting a profile moved onto the profile's own screen, and Switch
// profile joined the card it switches away from.
// v389: the profile card uses the shared chevron (a text glyph sat on the
// baseline, reading smaller and out of line with the row below) and drops
// "Listening on this device", which was stating the obvious.
// v390: a profile deleted on the phone disappears from "Who's listening?"
// straight away — /api/profiles is cached stale-while-revalidate, so the gate
// was re-reading the list from before the delete.
// v391: the settings/editor avatar shares the preloaded URL again — the
// cache-busting nonce is appended only after a photo actually changes.
// v392: four phone writes that never evicted their cached read — creating,
// renaming and deleting a playlist, and favouriting a catalog track. Found by
// auditing every write against the cacheable set rather than waiting for the
// next report.
// v393: the artist About card stops being four things at once — the bio's
// "more" is the Wikipedia link, the listener count is gone, and the related
// row is "Fans also like" without a repeated kind label under every face.
// v394: the artist About card is About again — one caption line instead of a
// column grid, no repeated artist name in the heading, and Fans also like is
// its own shelf rather than a footnote to a biography.
// v395: the artist page's closing stretch is a change of shade, not a card,
// and the artist row stopped slicing the hover highlight off its first tile.
// v396: the artist page's closing shade reaches the bottom edge — it was
// stopping short of ModalShell's own pb-6, leaving a dark strip beneath it.
// v397: the drill-in overlay stops padding the bottom of a full-bleed page —
// three ancestors were each adding space under the artist page's closing band.
// v398: Essential Albums no longer repeats the Latest Release — a new record
// usually dominates its artist's top songs, so both were showing one cover.
// v419: MUST BE BUMPED — a signed-out visitor used to get "Couldn't connect" and
// a Retry button, because ensureSession() flattened the hub's 401 (which carries
// the sign-in URL) into a generic failure. The fix gives that state its own
// screen and a real link. But the phones that need it are precisely the ones
// stuck on it, and navigation here is cache-first: without this bump they would
// keep rendering the old bundle from the shell cache and keep seeing the dead
// end. Same reasoning as v371 — reaping the stale shell is the only way an
// already-affected phone recovers.
const SHELL_CACHE = 'beetbot-shell-v419';
// Bump the cache name to invalidate everything ever cached at v1. The
// v1 cache held m4a files downloaded before we started embedding album
// art via ffmpeg post-process — those old bytes have no `covr` atom,
// so AirPlay receivers like Sony TVs render no artwork on their Now
// Playing screen. Forcing a re-fetch from the server gets the freshly-
// embedded files. Users who had tracks marked "Available offline"
// will need to re-toggle offline for those playlists, but going
// forward they get art on AirPlay.
const AUDIO_CACHE = 'beetbot-audio-v2';
// Stale-while-revalidate cache for read-only API responses. Lets the
// PWA boot fully offline: library list + playlist tracks + per-track
// metadata + album art are all served from this cache when there's
// no network. Token is stripped from the cache key (same trick as
// AUDIO_CACHE) so token rotation doesn't invalidate the offline view.
const API_CACHE = 'beetbot-api-v1';
// Regex of API paths whose GET responses we cache. POSTs (or paths
// outside this list — /api/search, /api/cast/*, /api/session,
// /api/pair, /api/streaming/*) always pass through to network so we
// never serve stale results for things that change with every call.
// Note: `profiles` (the "Who's listening?" list) and `profiles/{id}/avatar`
// are cached so the profile picker — the very first screen — renders offline.
// Without it, an offline launch on a device with no profile selected (fresh
// install, or after "switch profile") shows a blank picker and you can't reach
// your offline library.
const CACHEABLE_API =
  /^\/api\/(playlists(\/\d+(\/art)?)?|tracks\/\d+(\/art)?|profiles(\/\d+\/avatar)?)$/;
const SHELL_PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

/**
 * Inline minimal HTML returned by the navigation handler when both
 * cache AND network have failed. Without this, an offline user whose
 * SHELL_CACHE was reaped (cache version bump, iOS storage eviction,
 * etc.) before they re-visited online would see a blank white
 * browser-default error page. This at least tells them what's wrong
 * and gives a reload button.
 *
 * Styled inline — no external CSS — because the whole reason we're
 * here is that no other assets are reachable.
 */
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black" />
  <meta name="theme-color" content="#0a0a0a" />
  <title>Beetbot — offline</title>
  <style>
    html, body { margin: 0; min-height: 100dvh; background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif; }
    body { display: flex; align-items: center; justify-content: center; padding: 2rem env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .card { max-width: 24rem; text-align: center; }
    h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.75rem; }
    p { color: #a3a3a3; font-size: 0.875rem; line-height: 1.5; margin: 0.5rem 0; }
    button { margin-top: 1.25rem; padding: 0.625rem 1.25rem; background: #10b981; color: #0a0a0a; border: 0; border-radius: 0.5rem; font-weight: 500; font-size: 0.875rem; cursor: pointer; }
    button:active { background: #059669; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Beetbot is offline</h1>
    <p>The app hasn't been fully cached on this device yet, or the cache was cleared.</p>
    <p>Connect to your network — or wake your Beetbot host — and reload to finish setup.</p>
    <button onclick="window.location.reload()">Reload</button>
  </div>
</body>
</html>`;

/**
 * Parse the asset URLs (hashed JS bundle, CSS bundle) out of the
 * served `index.html` so the install hook can precache them along
 * with the navigation shell. Without this, a cold offline boot
 * after a SHELL_CACHE bump would have HTML in cache but no
 * JS/CSS, and the page would render white.
 */
/**
 * Is this response actually Beetbot, or something standing in for it?
 *
 * THE BUG THIS FIXES. When Beetbot is reached from outside over a remote-access
 * service and the host computer is asleep, it is not Beetbot that answers — the
 * service in front returns its own "this computer is asleep" placeholder. Those
 * used to arrive as a 200, and this worker cached any 200 navigation as the app
 * shell, so the placeholder was stored AS Beetbot. Navigation is cache-first
 * (deliberately, for the reason given at that handler), so every later launch
 * rendered the placeholder instantly from cache regardless of what the computer
 * was doing. On an iPhone home-screen app that meant reloading and reopening
 * several times before the real app came back.
 *
 * `res.ok` is the whole rule: a placeholder for an unreachable origin is a
 * non-2xx (503), and so is any other sensible error page. Nothing about which
 * service is in front is assumed, because Beetbot does not know or care — it
 * only knows what Beetbot itself sounds like.
 *
 * `type === 'basic'` stays: an opaque cross-origin response has no readable body
 * or status, so caching one as the shell would store a black box.
 */
function isRealShell(res) {
  return Boolean(res && res.ok && res.type === 'basic');
}

function extractAssetUrls(html) {
  const urls = [];
  // <script src="..."> — including type="module" Vite emits.
  const scriptRe = /<script[^>]*\bsrc=["']([^"']+)["']/gi;
  // <link rel="stylesheet" href="..."> and rel="modulepreload" href="...".
  const linkRe = /<link[^>]*\bhref=["']([^"']+\.(?:css|js)[^"']*)["']/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    if (!m[1].startsWith('http')) urls.push(m[1]);
  }
  while ((m = linkRe.exec(html)) !== null) {
    if (!m[1].startsWith('http')) urls.push(m[1]);
  }
  return urls;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        await cache.addAll(SHELL_PRECACHE);
      } catch (e) {
        // Don't block install if one entry fails (e.g. icon.svg 404 in dev).
        console.warn('[beetbot-sw] precache partial:', e);
      }
      // Also precache the hashed JS/CSS bundles referenced by /. We
      // can't list them statically because Vite hashes the filenames
      // per build, so we discover them by parsing the served HTML.
      // Best-effort: any fetch that fails is silently skipped — the
      // navigation handler's network revalidate will pick them up
      // on the next online visit.
      try {
        const indexRes = await fetch('/', { cache: 'no-store' });
        if (indexRes && indexRes.ok) {
          const html = await indexRes.text();
          const assetUrls = extractAssetUrls(html);
          await Promise.all(
            assetUrls.map(async (url) => {
              try {
                const res = await fetch(url);
                if (res && res.ok) await cache.put(url, res.clone());
              } catch {
                /* one asset failing shouldn't block install */
              }
            }),
          );
        }
      } catch (e) {
        console.warn('[beetbot-sw] asset precache failed:', e);
      }
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Reap older shell caches if we bump SHELL_CACHE on a release.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) =>
              (k.startsWith('beetbot-shell-') && k !== SHELL_CACHE) ||
              (k.startsWith('beetbot-audio-') && k !== AUDIO_CACHE) ||
              (k.startsWith('beetbot-api-') && k !== API_CACHE),
          )
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Audio streams: cache-first against the stripped URL. If cached, serve
  // the cached body (Range-respecting). If not cached, pass through to
  // network -- no auto-caching.
  if (url.pathname.startsWith('/stream/')) {
    event.respondWith(handleStreamFetch(req, url));
    return;
  }

  // API calls. Mutations (POST/PUT/PATCH/DELETE) pass through —
  // we never cache those (the GET-only check above already filtered
  // method, but stating the intent here). For GETs, we have a small
  // allowlist of read-only endpoints (CACHEABLE_API): playlists,
  // playlist detail, track meta, track art. Those get stale-while-
  // revalidate so the library + a playlist's track list + art load
  // instantly offline (provided the user has visited them online at
  // least once). Everything else — /api/search, /api/cast/*,
  // /api/session, /api/pair, /api/streaming/* — passes through.
  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API.test(url.pathname)) {
      event.respondWith(handleApiFetch(req, url));
    }
    return;
  }

  // Navigation requests: cache-first with background revalidate.
  //
  // Why not network-first: when the Beetbot host (the user's desktop)
  // is off, the navigation fetch can take 30-60 seconds to time out on
  // iOS Safari — during which the PWA shows a black screen because
  // nothing has rendered yet. Cache-first means we serve the
  // last-known-good HTML instantly on every open, and revalidate in
  // the background so the next launch picks up new JS/CSS hashes.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('/');
        const revalidate = fetch(req)
          .then((fresh) => {
            if (isRealShell(fresh)) {
              cache.put('/', fresh.clone()).catch(() => {});
            }
            return fresh;
          })
          .catch(() => null);
        if (cached) {
          // Don't await — revalidate runs in the background so the
          // page renders instantly. The new hashed JS/CSS get
          // fetched on the next opens.
          event.waitUntil(revalidate);
          return cached;
        }
        // Cold start with empty cache. Try network once; if that
        // also fails (offline, host asleep), return the inline
        // offline-fallback page so the user sees something useful
        // instead of a blank browser error. Once they reconnect and
        // reload, the install hook + cache-first nav will populate.
        const fresh = await revalidate;
        if (fresh) return fresh;
        return new Response(OFFLINE_FALLBACK_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      })(),
    );
    return;
  }

  // Static assets (JS/CSS/SVG bundles emitted by Vite under /assets/...):
  // stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const fetched = fetch(req)
        .then((res) => {
          if (isRealShell(res)) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);
      return cached ?? (await fetched) ?? Response.error();
    })(),
  );
});

async function handleApiFetch(req, url) {
  // Stale-while-revalidate. Cache key strips the rotating session token
  // (a token swap must not invalidate every cached response) but KEEPS
  // `profile_id`: the playlist LIST varies per profile, so dropping it
  // collapsed every account onto one entry and a profile switch briefly
  // served the previous profile's playlists before revalidating. Keep
  // profile_id so each profile has its own cached list.
  const keyUrl = new URL(url.origin + url.pathname);
  const pid = url.searchParams.get('profile_id');
  if (pid !== null) keyUrl.searchParams.set('profile_id', pid);
  const strippedUrl = keyUrl.toString();
  const apiCache = await caches.open(API_CACHE);
  const cached = await apiCache.match(strippedUrl);
  // Fast path when the browser is offline: don't waste 30-60s on a
  // doomed fetch. Return cached if we have it, else surface an
  // immediate error response so the UI can show its offline state.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return cached ?? Response.error();
  }
  // Kick off a network revalidate in the background regardless of
  // whether we have a cached response — that way the cache stays
  // fresh on every successful online visit.
  const networkPromise = fetch(req)
    .then((res) => {
      if (isRealShell(res)) {
        apiCache.put(strippedUrl, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await networkPromise;
  // Best to return Response.error() — the page-side jsonGet() throws
  // on non-ok, and the UI can render a "you appear to be offline"
  // state without crashing.
  return fresh ?? Response.error();
}

async function handleStreamFetch(req, url) {
  // Canonical cache key strips the session token query param. The Cache
  // API matches on URL exactly, so we have to look up the stripped URL
  // directly via cache.match(strippedUrl) rather than relying on
  // ignoreSearch (which would also ignore other future query params).
  const strippedUrl = url.origin + url.pathname;
  const audioCache = await caches.open(AUDIO_CACHE);
  const cached = await audioCache.match(strippedUrl);
  if (cached) {
    // If the audio element asked for a byte range, serve a synthesized 206
    // sliced from the cached body. Without this, iOS Safari may not seek
    // correctly when the response was originally 200 OK.
    const range = req.headers.get('range');
    if (range) {
      try {
        return await sliceRangeResponse(cached, range);
      } catch (e) {
        console.warn('[beetbot-sw] range slice failed, returning full body', e);
        // Fall through to returning the full cached response.
      }
    }
    return cached;
  }
  // Cache miss: pass through to network. Don't write the response back --
  // explicit opt-in via "Available offline" is the only path to caching.
  return fetch(req);
}

/**
 * Parse a Range header like `bytes=N-M` (or `bytes=N-`) and return a 206
 * Partial Content response carved out of `cachedResponse.body`. The cached
 * response must be a 200 OK with a complete body.
 */
async function sliceRangeResponse(cachedResponse, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) throw new Error(`unparseable range: ${rangeHeader}`);
  const fullBuffer = await cachedResponse.clone().arrayBuffer();
  const totalLen = fullBuffer.byteLength;
  let start = match[1] === '' ? 0 : parseInt(match[1], 10);
  let end = match[2] === '' ? totalLen - 1 : parseInt(match[2], 10);
  if (isNaN(start) || isNaN(end) || start > end || end >= totalLen) {
    // Malformed or out-of-range: defer to the full body.
    return cachedResponse;
  }
  const slice = fullBuffer.slice(start, end + 1);
  const headers = new Headers(cachedResponse.headers);
  headers.set('content-range', `bytes ${start}-${end}/${totalLen}`);
  headers.set('content-length', String(slice.byteLength));
  headers.set('accept-ranges', 'bytes');
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}
