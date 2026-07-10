//
// Beetbot web-player service worker.
//
// Two cache namespaces:
//   beetbot-shell-v1  — HTML / JS / CSS / icons. Network-first nav,
//                       stale-while-revalidate for hashed assets.
//   beetbot-audio-v1  — Audio responses cached on explicit user opt-in.
//                       Cache key strips the session token so a token
//                       rotation doesn't invalidate offline tracks.
//
// On /stream/<id> requests we look up the stripped URL in the audio cache.
// On hit we serve from cache (and synthesize a Range 206 if the request had
// a Range header so audio elements can seek inside long files). On miss we
// fall through to network -- we NEVER auto-cache, every cached track is
// the result of an explicit user "Available offline" action.

// v28: album view — hide the "Add album to library" button once every
// track is already in the library (show "✓ In your library" instead).
// New JS hash, bump to pull.
//
// v27: album view restyle — Spotify album-header layout (full square
// cover + title + "Artist · Year · N songs · duration"), keeping the
// "Add album to library" button. New JS hash, bump to pull.
//
// v26: artist hero restyle — Spotify playlist-header layout (full square
// photo on the left, name + listener count beside it, blurred colour
// wash behind) instead of the cropped banner. Also folds in the recent
// desktop-only shared changes. New JS hash, bump to pull.
//
// v25: "Fans also like" now shows a preview (8) with a "Show all"
// toggle, matching Discography. New JS hash, bump to pull.
//
// v24: About card — switch the backdrop to a blurred/darkened ambient
// photo so the bio text is the focus (the sharp full portrait duplicated
// the top banner). New JS hash, bump to pull.
//
// v23: About section restyle — Spotify-style image card (artist photo
// backdrop + gradient with the listener count + bio overlaid) instead of
// plain text. New JS hash, bump to pull.
//
// v22: artist "About" section — a Wikipedia bio blurb (free, no key,
// attributed) on the artist page. New JS hash, bump to pull.
//
// v21: artist-page polish — fan count on the hero (Deezer nb_fan) and
// explicit "E" badges on tracks (Deezer explicit_lyrics). New JS hash,
// bump to pull.
//
// v20: "Popular releases" now ranks the discography by the artist's
// top-track albums (real popularity signal) instead of pure newest-
// first, so it stops mirroring the Singles tab. New JS hash, bump.
//
// v19: discography polish — "Popular releases" chip label + a
// collapsed preview with a "Show all" toggle. New JS hash, bump.
//
// v18: artist discography restyle — "Year • Type" album cards +
// All / Albums / Singles & EPs filter chips, newest-first. New JS
// hash, bump to pull.
//
// v17: artist page restyle — full-bleed banner hero with the artist
// name set large (Spotify-style), wider modal. New JS hash, bump to pull.
//
// v16: Browse tab — Deezer charts (top songs/albums/artists) + new
// releases, as a new bottom-nav tab. New JS hash, so bump to pull it.
//
// v15: phone library redesign — list/grid toggle, sortable "Recents"
// header (recently played / A–Z / recently added), and 2×2 mosaic
// cover tiles. New JS hash, so bump the shell cache to pull it.
//
// v14: richer artist page — the artist drill-in now shows "Popular"
// (top tracks, with preview + add) and "Fans also like" (related
// artists) alongside the discography. New JS hash, so bump the shell
// cache to pull the new bundle.
//
// v13: recent-searches polish — drop the ↩ emoji glyph for a
// monochrome clock icon, and collapse search-as-you-type prefix
// fragments ("sw"/"swit"/"switch") down to the final term. New JS
// hash, so bump the shell cache to pull the new bundle.
//
// v12: reworks the search preview into a Shazam-style interaction —
// tap the song row and the album art shows a pause glyph with a
// depleting countdown ring (replacing the standalone ▶ button). New
// JS hash, so bump the shell cache to force phones onto the new bundle.
//
// v11: ships the 30-second Deezer preview (▶) button on search
// results. Bumping the shell cache forces phones still running the
// pre-preview bundle to drop it and pull the new JS — without the
// bump, the cache-first navigation handler would keep serving the
// old HTML/JS and the new control would never appear.
//
// v10: ships inline data: URL artwork in MediaSession metadata so
// iOS doesn't make a network fetch for the lock-screen art on
// track auto-advance. That fetch is the suspected reason audio
// stays silent in background when the Beetbot host (desktop) is
// asleep, even for offline-cached tracks.
// v124: full build plays non-downloaded tracks via on-demand /live (instant
// stream / match-on-play); rows are no longer greyed and the cover plays
// instead of previewing; recent-search artist navigation fix.
// v125: unified album page — browse/library albums share the same layout with
// a Spotify-style +/✓ library toggle (Play · Shuffle · +/✓); downloaded badge
// + discoverable pinning (artist/album/playlist) + album-rename gating.
// v126: tapping a searched song streams in full (not the 30s preview); album
// FILE column merges the +/✓ into one aligned spot. (Sticky headers, per-song
// ⋯ menus, edit-details + play/pause state are desktop-only.)
// v127: Discover/catalog playlists render through the shared album/playlist
// page (read-only "Add all to library") AND are searchable from the search bar
// (Playlists tab + grid); "tracks" → "songs" everywhere.
// v128: clickable artist/album names in track rows (→ their pages); catalog
// playlists show per-track cover + Album column; the Deezer-wordmark cover badge
// is a rounded inset chip (on the hero too, not just cards); search dropdown
// surfaces matching playlists inline.
// v129: album/playlist track rows move the add-to-playlist +/✓ next to the
// title (it no longer covers the FILE download badge on hover).
// v130: the add-to-playlist +/✓ gets its OWN column between File and Time
// (consistent Spotify-style spot); the "downloaded" badge becomes a green
// DOWN-ARROW (not a check) so it reads distinctly from the in-playlist ✓.
// v131: a saved album is no longer treated as a playlist — its tracks show no
// per-song ✓ (the album-level save indicator covers it), and albums are dropped
// from the "add to playlist" picker (you can't add songs to an album). The
// download arrow stays in the File column (consistent with the other pages).
// v132: the album-page hero's artist name is clickable → that artist's page.
// v133: Home shows Spotify-style skeleton placeholders (pulsing gray boxes) on
// cold start while the feed loads, instead of a blank page; a small per-profile
// cache keeps return visits from re-flashing the skeleton.
// v134: skeleton shelf title bar is inset (ml-4) like the real title instead of
// flush to the edge.
// v136: phone Settings gets an Account section — current profile, Switch
// profile, and Disconnect this device (re-pair).
// v137: phone Settings is just Account now — dropped the desktop-only
// Crossfade/Library explainer cards.
// v138: switching profiles resets now-playing so one user's song doesn't carry
// into the next profile (it would otherwise log under the new profile).
// v139: cross-device presence ("playing on phone/computer") is scoped per
// profile — one account no longer sees another account's devices.
// v140: per-profile isolation — search recents / recently-played / offline
// flags / pinned playlists / Discover cache are now keyed by profile, and the
// Library shows each profile's own saved music (downloads stay shared).
// v141: auth hardening — the phone binds its session to a profile (PIN-checked
// server-side) so the server enforces playlist ownership per profile.
// v142: the player auto-recovers from a dropped stream (desktop restart / stale
// URL after backgrounding) — retries with backoff + resumes, instead of the
// "Audio format not supported" banner.
// v143: drop the doubled home-indicator inset — the player bar only reserves it
// when it's bottom-most, killing the black gap above the nav. Plus a sticky,
// frosted Home header + a status-bar scrim so content stops bleeding past the
// clock/battery in the standalone PWA.
// v144: prefetch the next track's /live stream (not just downloaded ones) so a
// non-downloaded next song is de-fragmented on the desktop before the queue
// advances — cuts the "couldn't reach the stream" failures when the phone
// advances a song while the screen is locked.
// v145: lyrics load from a persistent DB cache (survives restarts) and the next
// queued track's lyrics are prefetched, so they appear instantly on song change;
// transient LRCLIB failures now retry instead of sticking as a permanent miss.
// v146: unsynced (plain) lyrics render line-by-line with the same spacing + size
// as the synced/karaoke view, instead of one cramped pre-wrap block.
// v167: Apple-style restyle — SF system font app-wide, emerald retired (white
// controls + artwork-derived --color-accent for now-playing indicators), and a
// per-track "⋯" action sheet on playlist rows (Favorite/Add/Go to Artist/Album).
// v169: style consolidation — rounded-lg/xl radii sweep (playlist hero art),
// one frosted recipe for all popups/sheets, unified sticky frosted headers
// (Library gets one), skeleton loaders replace "Loading…" text, "Browse all"
// page lead + in-search Browse button, "What do you want to play?" placeholder.
// v170: Home shelves get Show all (row ⇄ wrapping grid) + uppercase eyebrow
// kickers; New-playlist creation on the phone (Library "+" → name sheet) and
// desktop sidebar "+"; sidebar library sorts by recently played; sheets frosted.
// v196: design cohesion — Spotify-style hover Play button on every album/artist/
// playlist card (search results, "fans also like", artist/album pages), Library
// cards unified to the borderless halo language; keyboard-safe (the nested play
// button no longer double-fires the card's open action).
// v197: Tier 2 cohesion — shared token sheet (shared/ui.ts) now drives the modal
// sheets, scrims, and popover menus (CastPicker, ContextMenu, sleep-timer, search
// sheets/dropdowns) so they converge on one frosted recipe.
// v198: Tier 3 signature swings — artwork tint on progress fills / active queue
// rows / mini-bar glow while playing; one shared ambient hero wash on every
// detail page; one house easing curve (+ desktop reduce-motion); reserved beet
// ignition pulse on "My station".
// v199: phone cohesion — persistent frosted bottom nav on every screen (search /
// browse drill-ins now render as pages under the chrome, not cover-everything
// sheets); ~50 recipe swaps routing every phone sheet/button/input/callout/eyebrow
// through the token sheet; collage-playlist hero tint; unified genre tiles;
// condensed sticky header on playlist scroll; 16px inputs (no iOS focus-zoom).
// v200: detail-page consistency — catalog album/playlist drill-ins from Home now
// cover the greeting + show the back chevron (z-fix) and the Home tab pops them;
// library + catalog detail pages share ONE treatment: floating back over a
// full-bleed hero that frosts+condenses on scroll, and one white play circle.
// v201: connection banner — a floating frosted pill above the mini-bar tells
// "you're offline" (no internet) apart from "can't reach your library" (home
// server asleep/off) and pulses "back online" once the server returns; the
// Player's 2s heartbeat now doubles as the liveness probe.
// v202: banner docks onto the mini-player as a state-tinted header (fused into
// one card) when a track is playing; standalone tinted card above the nav when
// nothing plays. Fewer floating islands; reads as an alert, not a nav pill.
// v203: friendly errors — every action that used to dump a raw exception string
// ("TypeError: Failed to fetch", "import album failed (500)") now shows a clean
// message; write mutations get an abort timeout so a dead host fails fast.
// v204: play-gating — non-downloaded tracks can't stream without the hub, so
// their Play controls now DIM + go inert while the desktop is unreachable
// (the connection banner explains why) instead of failing on tap. Downloaded
// tracks and the queue are unaffected.
// v205: write-gating — hub-write buttons (rename / delete / make-offline / new
// playlist / add album to library) disable + dim when the desktop is
// unreachable, so they can't be tapped into a failure. Local actions (queue,
// evict, sort/pin) stay enabled offline.
// v206: playlist header — match desktop. Rename moves onto the title tap and
// Delete moves into the action row, so the sticky/condensed bar is just back +
// title + play (no persistent edit/delete icons crowding the top bar).
// v207: playlist hero redesign (Apple-Music/Spotify-inspired) — large centered
// cover floating on the artwork wash, centered title/meta, actions as a
// centered row of frosted circles (shuffle · play · offline · delete); rows
// drop the number gutter + duration column and bold their titles; the offline
// toggle compacts to an icon circle (progress detail stays in the banner).
// v208: same hero on the CATALOG album + playlist drill-in pages (phone only —
// the shared AlbumDetailModal now renders the centered hero when !inline, and
// leaves the desktop side-by-side header byte-identical).
// v209: catalog track rows match the library playlist on phone — flex row (art
// · title · download) with the #/Album/Time columns + column header hidden
// (sm:grid restores the full desktop table). Desktop unchanged.
// v220: profile-switch fix — the API cache key kept only origin+pathname, so
// every profile's /api/playlists collapsed onto one entry and switching users
// flashed the previous profile's playlists before revalidating. The key now
// preserves profile_id (token still stripped), so each profile caches its own.
// v221: catalog album + Deezer playlist track rows get the library page's
// swipe gestures (→ Queue, ← Save) with a confirmation toast, across Search,
// Home, and Browse; the per-song ⋯ sheet now also appears on Home/Browse-opened
// catalog pages (was Search-only). Desktop unchanged.
// v222: "Liked Songs" is now "Favorites" everywhere — the star toggle, the
// playlist name, and all copy (menus / toasts / labels) standardize on the
// Apple-style Favorites metaphor; the ♥ placeholder glyph becomes ★.
// v223: Home freshness N0+N1 — the client mints a per-visit nonce that the
// server folds into its shelf-selection seed, so each visit deals a different
// slice of the day's cached discovery pools; served discovery items are now
// impression-logged server-side.
// v224: N0+N1 review fixes — the visit nonce is now held in sessionStorage
// (stable per session; only pull-to-refresh re-mints) so returning to Home no
// longer reshuffles the feed under the user; server keeps impression last_shown
// monotonic across clock rollbacks.
// v225: Home freshness N6+N7 — honest "Updated …" caption from the real
// discovery-pool age, "New" ribbon tightened to 30 days, and the phone refreshes
// Home on foreground-return / day rollover (30-min staleness guard). (N2-N5 were
// server-only: recency-weighted + widened + rotated seed pools, impression
// discounting, exploration slots, and per-visit shelf-lineup selection.)
// v226: "Made for you" rail (P2) — the Play-My-Beetbot button + Deep/Fresh
// chips are replaced by a portrait tile rail carrying two station tiles
// (My station = for-you, Discovery station = fresh); the beet-ignite glow
// moves onto the My-station tile.
// v227: rail mix tiles + mix page (P3) — the daily mixes (artist / genre /
// decade) now render as collage tiles in the rail (not rows), and tapping one
// opens a mix detail page (Play/Shuffle, tracklist) via the shared album page.
// v228: spotlight band (P4) — the server marks one discovery shelf per visit as
// `display:'spotlight'`; the client renders it mid-feed as a full-width band
// (artwork + title + description + Play) instead of a row.
// v229: desktop mix page (P5) — desktop gains the rail mix tiles + a
// history-compliant inline mix page (Back/Forward replay). Phone behavior is
// unchanged; this bump is only because the shared HomeScreen bundle changed.
// v230: rail polish — drop scroll-snap (it ate the left padding, so tiles sat
// flush to the edge); tile play buttons now match the album-card button (white
// circle, bottom-right, shadow, hover-reveal on desktop); station tiles gain
// collage cover art + a play button under a branded wash.
// v231: album-card plays backfill Now-Playing art; desktop Home drill-ins (mix
// page + catalog playlist) are history-compliant + scroll to top on open.
// v232: desktop shell restyle — transparent header (no hard line), sidebar +
// main as rounded cards below the header. Shared-component changes are all
// desktop-gated (inline/pageMode/overlayMode), so phone behavior is unchanged.
// v233: carry the Home-card batch to the phone — "Favorites" rename (star),
// swipe-to-queue/save on catalog rows, Deezer playlist title/hover parity +
// hover play, and the Spotify-style persistent now-playing play/pause across
// album/playlist/song/artist cards + the hero banners (blurred-bg, no crop).
// v234: Home rows + the "Made for you" rail get the same desktop hover ‹ ›
// scroll arrows as the artist page (shared ShelfRow). Desktop-only (sm:flex) —
// the phone still swipes, so phone behavior is unchanged.
// v235: album page reaches now-playing parity with the playlist page — the
// current track highlights + shows equalizer bars, the hero + sticky Play
// button reflect ⏸/▶ and toggle, rows highlight/reveal ▶ on hover, the
// redundant hover "+" is dropped, and the row metrics match the playlist. The
// now-playing wiring is desktop-gated (pageMode/inline), so phone rows are
// unchanged; the shared roomier metrics only apply on the desktop full page.
// v236: artist page reaches parity with the album/playlist pages — icon-only
// pin (no "Pin" text), a condensed sticky header with a ⏸/▶ play button on
// scroll, dynamic hero/Top-Songs/album-card play buttons (highlight + equalizer
// on the current row, persistent pause on the playing album card), and the
// album-card hover halo now matches the Home shelves. Desktop-gated (pageMode).
// v237: fix the artist-page album carousels clipping that hover halo — the
// scroller now uses py-4 + overflow-y-clip inside a -my-4 wrapper (mirroring the
// Home shelves), so each card's -inset-3 highlight has vertical room instead of
// being cut off top/bottom.
// v238: Discover genre pages reach parity with the album/playlist pages — a
// full-bleed hero with Play/Shuffle + a condensed sticky play bar (dynamic
// ⏸/▶), the Top-songs/All-time track lists get now-playing highlight +
// equalizer + a File badge, and every genre shelf uses the app-wide ShelfRow
// (pill arrows + Home-style hover) instead of the old bespoke carousel.
// v239: the "Add to playlist" picker no longer stretches to nearly the full
// window (height capped) and its "Done" button is pinned as a footer so it
// can't be scrolled off / clipped — the playlist list scrolls inside the body.
// v240: catalog track rows drop the bare hover "+" for a ⋯ overflow menu (genre
// pages) and show a small white ✓ next to Time only for songs already in a
// playlist (album / artist / genre) — click it to manage (opens the add-to-
// playlist picker, pre-checked). Adding now lives in the ⋯ menu.
// v241: genre track lists match the playlist page more closely — the Time
// column header reads "Time" (was a clock icon), and the now-playing / hover
// play indicator lives in the # gutter (equalizer while playing, ▶ on hover)
// instead of over the cover, so the cover stays plain art like the playlist.
// v242: playlist "#" column header is centered to line up with the row numbers;
// genre track rows adopt the playlist's larger type (text-base title, text-sm
// artist/album/time on desktop) so they read the same weight/size.
// v243: Browse declutter — drop the "BEETBOT" wordmark stamped on covers, drop
// "Playlist · N songs" card subtitles (creator-only), drop the genre hero's
// "Top songs, albums & artists" filler, tighten section titles ("Top songs",
// "Popular playlists"), and make the global Browse page tiles-only (charts move
// to Home + genre pages) — Spotify Search-landing style.
// v244: Home loads faster — the feed is persisted per profile (localStorage)
// so an app relaunch paints the last feed instantly (stale-while-revalidate,
// no skeleton), and the server serves Home card art at 500×500 instead of
// 1000×1000 (~4× fewer image bytes per feed; full-res stays everywhere else).
// v245: "Recently played" updates live — as the queue advances, the new track
// is optimistically prepended to that shelf (dedup, cap) instead of re-fetching
// the whole feed (which would reshuffle discovery). Mirrors what the server
// records at play-start, so it reconciles on the next natural refresh.
const SHELL_CACHE = 'beetbot-shell-v245';
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
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
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
            if (fresh && fresh.status === 200 && fresh.type === 'basic') {
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
          if (res && res.status === 200 && res.type === 'basic') {
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
      if (res && res.status === 200 && res.type === 'basic') {
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

// -- message channel -----------------------------------------------------
//
// The page side talks to the SW via postMessage so the SW can manage cache
// entries by canonical (stripped) URL.

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const reply = (data) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(data);
  };
  switch (msg.type) {
    case 'cache-track': {
      // Caller pre-fetched the response and provides token-stripped URL.
      // Most callers should use the page-side helper which does this for
      // them; this message is mostly for symmetry.
      event.waitUntil(
        (async () => {
          try {
            const res = await fetch(msg.tokenedUrl);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            const audioCache = await caches.open(AUDIO_CACHE);
            await audioCache.put(msg.strippedUrl, res);
            reply({ ok: true });
          } catch (e) {
            reply({ ok: false, error: String(e) });
          }
        })(),
      );
      return;
    }
    case 'evict-track': {
      event.waitUntil(
        (async () => {
          const audioCache = await caches.open(AUDIO_CACHE);
          const removed = await audioCache.delete(msg.strippedUrl);
          reply({ ok: true, removed });
        })(),
      );
      return;
    }
    case 'evict-all-audio': {
      event.waitUntil(
        (async () => {
          await caches.delete(AUDIO_CACHE);
          reply({ ok: true });
        })(),
      );
      return;
    }
    case 'list-cached-audio': {
      event.waitUntil(
        (async () => {
          const audioCache = await caches.open(AUDIO_CACHE);
          const keys = await audioCache.keys();
          reply({ ok: true, urls: keys.map((r) => r.url) });
        })(),
      );
      return;
    }
  }
});
