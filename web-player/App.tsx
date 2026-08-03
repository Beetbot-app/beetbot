import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  bindSessionProfile,
  ensureSession,
  friendlyError,
  getProfiles,
  notifyUnauthorized,
  profileAvatarUrl,
  reissuePhoneSession,
  resolveCatalogTrack,
  resolveCatalogTracks,
  setActiveProfileId,
  setSessionExpiredHandler,
  setSessionRefreshedHandler,
  setTokenReissuer,
  setTrackLiked,
  submitPairing,
  type Genre,
  type ResolvedTrack,
  type SearchTrackResult,
  type StreamTrack,
} from '@shared/api';
import {
  SearchScreen,
  type SavedArtistController,
} from '@shared/components/SearchScreen';
import { AddToPlaylistModal } from '@shared/components/modals/AddToPlaylistModal';
import { isArtistSaved, useSavedStore } from '@/lib/saved';
import { TrackActionSheet } from './components/TrackActionSheet';
import { BrowseScreen } from '@shared/components/BrowseScreen';
import { LibraryScreen } from './components/LibraryScreen';
import { FastScroller } from './components/FastScroller';
import { PlaylistScreen } from './components/PlaylistScreen';
import { ProfileGate } from './components/ProfileGate';
import { Player } from './components/Player';
import { ConnectionBanner } from './components/ConnectionBanner';
import { InstallSheet } from './components/InstallSheet';
import { useConnectivity } from './lib/useConnectivity';
import { StatsScreen } from '@shared/components/StatsScreen';
import { HomeScreen } from '@shared/components/HomeScreen';
import { cn, BAR, INPUT, CALLOUT_ERROR, BTN_PRIMARY, BTN_SECONDARY } from '@shared/ui';
import { SettingsScreen } from './components/SettingsScreen';
import { usePlayerStore, useCatalogNav, currentTrack } from './store';

// Active profile is per-device on the phone (localStorage).
const PROFILE_KEY = 'beetbot.phone.active_profile';
function readPhoneProfile(): number | null {
  try {
    const v = localStorage.getItem(PROFILE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}
function writePhoneProfile(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(PROFILE_KEY);
    else localStorage.setItem(PROFILE_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/**
 * Phone-bundle implementation of "play this track" — seeds the
 * web-player's StreamTrack-shaped queue with the freshly-mapped
 * search result. The shared SearchScreen calls this through the
 * `onPlayTrack` prop, which keeps it ignorant of which player store
 * lives in this bundle.
 */
async function playSearchResultPhone(
  t: SearchTrackResult,
  list?: SearchTrackResult[],
  index?: number,
): Promise<void> {
  try {
    const token = await ensureSession();
    // Played from a list (genre "Top songs", an album, an artist's top tracks) →
    // seed the WHOLE list as the queue from the tapped row so playback continues
    // down it. One batch upsert maps every catalog row to a library id.
    if (list && list.length > 1 && index != null) {
      const resolved = await resolveCatalogTracks(list, token);
      const queue = list.map((ct, i) => catalogToStreamTrack(ct, resolved[i], i));
      usePlayerStore.getState().setQueue(queue, index);
      return;
    }
    // Single track. Catalog result → create a library row (ISRC-deduped) for a
    // track id; already-in-library results skip this.
    let trackId = t.local_track_id;
    if (trackId == null) {
      trackId = (await resolveCatalogTrack(t, token)).track_id;
    }
    usePlayerStore
      .getState()
      .setQueue([
        catalogToStreamTrack(
          t,
          { track_id: trackId, status: t.has_audio ? 'downloaded' : '' },
          0,
        ),
      ]);
  } catch (e) {
    console.warn('[beetbot] phone play-from-search failed', e);
  }
}

/**
 * Build a queue-ready `StreamTrack` from a catalog result + its resolved
 * library id. Only `has_audio` rows are playable (the hub streams their file
 * via /stream/{id}); every other row gets a falsy status so the queue's
 * `canStream` filter drops it. Rows that failed to resolve get id 0 too.
 */
function catalogToStreamTrack(
  ct: SearchTrackResult,
  resolved: ResolvedTrack | undefined,
  i: number,
): StreamTrack {
  return {
    id: resolved?.track_id ?? 0,
    title: ct.title,
    artists: ct.artists,
    album: ct.album,
    album_art_url: ct.album_art_url,
    duration_ms: ct.duration_ms,
    position: i,
    has_audio: ct.has_audio,
    status: resolved?.track_id && ct.has_audio ? 'downloaded' : '',
  };
}

type View =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'search' }
  // `from` = the view to return to on Back (there's no history stack), so
  // Settings/Stats go back to wherever they were opened from (Home vs Library).
  | { name: 'stats'; from: View }
  | { name: 'settings'; from: View }
  // A single genre feed opened from the Search "Browse all" grid — its own page
  // (no search bar on top); Back returns to Search.
  | { name: 'browse'; genre: Genre }
  | { name: 'playlist'; id: number };

type SessionState =
  | { kind: 'loading' }
  | { kind: 'ready'; token: string }
  | { kind: 'pairing-required' }
  | { kind: 'error'; message: string };

export default function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [view, setView] = useState<View>({ name: 'home' });
  const [profileId, setProfileId] = useState<number | null>(readPhoneProfile);

  // Catalog navigation requested from the Now Playing overflow menu ("Go to
  // artist" / "Go to album"): switch to the Search tab and let SearchScreen
  // resolve the name to a catalog hit and drill into its modal.
  const catalogRequest = useCatalogNav((s) => s.request);
  const clearCatalogNav = useCatalogNav((s) => s.clear);
  const openArtistNav = useCatalogNav((s) => s.openArtist);
  const openAlbumNav = useCatalogNav((s) => s.openAlbum);
  useEffect(() => {
    if (catalogRequest) setView({ name: 'search' });
  }, [catalogRequest]);

  // Per-song "⋯" bottom sheet for an opened catalog album/playlist row — the
  // same TrackActionSheet the library album/playlist rows use, so a searched
  // album reads and behaves like a saved one. `albumSheetTrack` is a catalog
  // row (may have no library id yet), so Favorite resolves it to a track first.
  const [albumSheetTrack, setAlbumSheetTrack] = useState<SearchTrackResult | null>(
    null,
  );
  const [albumAddTrack, setAlbumAddTrack] = useState<SearchTrackResult | null>(
    null,
  );
  const favoriteCatalogTrack = useCallback(
    async (t: SearchTrackResult) => {
      try {
        const token = await ensureSession();
        const trackId =
          t.local_track_id ?? (await resolveCatalogTrack(t, token)).track_id;
        await setTrackLiked(token, trackId, true, profileId);
      } catch (e) {
        console.warn('[beetbot] favorite-from-album failed', e);
      }
    },
    [profileId],
  );

  // Swipe-right on an opened catalog album/playlist row → append to the queue.
  // Mirrors `favoriteCatalogTrack`: resolve the catalog row to a library id,
  // then build the same queue-ready StreamTrack `playSearchResultPhone` uses
  // and enqueue it (the store drops it if it can't stream, matching the row's
  // "Not available yet" guard).
  const queueCatalogTrack = useCallback(async (t: SearchTrackResult) => {
    try {
      const token = await ensureSession();
      const trackId =
        t.local_track_id ?? (await resolveCatalogTrack(t, token)).track_id;
      usePlayerStore
        .getState()
        .enqueue(
          catalogToStreamTrack(
            t,
            { track_id: trackId, status: t.has_audio ? 'downloaded' : '' },
            0,
          ),
        );
    } catch (e) {
      console.warn('[beetbot] queue-from-album failed', e);
    }
  }, []);

  // B6: pull-to-refresh on Home. Tracks a downward drag from the top of the
  // scroll container; past the threshold it bumps `homeRefreshKey`, which
  // HomeScreen watches to refetch (its history shelves are computed fresh).
  const mainRef = useRef<HTMLElement>(null);
  const pullStartY = useRef<number | null>(null);
  // Mirror the pull distance in a ref: touchmove's setPullDist is batched, so
  // touchend would otherwise read a stale value and never cross the threshold.
  const pullDistRef = useRef(0);
  const [pullDist, setPullDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  // N7: when Home last refreshed (wall time + local day), so a return-to-
  // foreground can decide whether the feed is stale enough to refetch.
  const lastHomeRefreshAt = useRef(Date.now());
  const lastHomeRefreshDay = useRef(new Date().toDateString());
  const PULL_THRESHOLD = 70;
  const onMainTouchStart = (e: React.TouchEvent) => {
    if (view.name !== 'home' || refreshing) {
      pullStartY.current = null;
      return;
    }
    const el = mainRef.current;
    pullStartY.current = el && el.scrollTop <= 0 ? e.touches[0].clientY : null;
  };
  const onMainTouchMove = (e: React.TouchEvent) => {
    if (pullStartY.current == null) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    // Rubber-band resistance + cap. Only engages on a downward pull at the top.
    const clamped = dy > 0 ? Math.min(dy * 0.5, 90) : 0;
    pullDistRef.current = clamped;
    setPullDist(clamped);
  };
  const onMainTouchEnd = () => {
    if (pullStartY.current == null) return;
    pullStartY.current = null;
    const dist = pullDistRef.current;
    pullDistRef.current = 0;
    if (dist >= PULL_THRESHOLD) {
      setRefreshing(true);
      lastHomeRefreshAt.current = Date.now();
      lastHomeRefreshDay.current = new Date().toDateString();
      setHomeRefreshKey((k) => k + 1);
      window.setTimeout(() => {
        setRefreshing(false);
        setPullDist(0);
      }, 900);
    } else {
      setPullDist(0);
    }
  };

  // Shrink the floating nav to icons-only while scrolling down; expand it back
  // on scroll-up or near the top (iOS-26-style minimize-on-scroll).
  const lastScrollTop = useRef(0);
  const [navCompact, setNavCompact] = useState(false);
  // Bumped when the active tab is re-tapped, so Home/Search close any open
  // drill-in overlay (they manage their own detail state internally).
  const [resetNonce, setResetNonce] = useState(0);
  // Win-back (imp 8): true when Home has a hoisted "Welcome back" shelf; lights a
  // dot on the Home tab while you're on another tab.
  const [winBack, setWinBack] = useState(false);
  const onMainScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const last = lastScrollTop.current;
    if (top < 48) setNavCompact(false);
    else if (top - last > 6) setNavCompact(true);
    else if (last - top > 6) setNavCompact(false);
    lastScrollTop.current = top;
  };
  // Scope the shared catalog API's ✓ marks to the active profile's playlists.
  // Set during render so it's current before any screen's fetch effect runs.
  setActiveProfileId(profileId);

  // Saved artists (Library › Artists) — KV-backed, syncs with the desktop.
  useEffect(() => {
    useSavedStore.getState().setProfile(profileId);
  }, [profileId]);
  const savedArtists = useSavedStore((s) => s.artists);
  const toggleSavedArtist = useSavedStore((s) => s.toggleArtist);
  const saveController = useMemo<SavedArtistController>(
    () => ({
      isSaved: (name) => isArtistSaved(savedArtists, name),
      toggle: (a) => toggleSavedArtist(a),
    }),
    [savedArtists, toggleSavedArtist],
  );

  // The bottom nav is PERSISTENT on every screen (iOS tab-bar convention:
  // Spotify/Apple keep it on playlist/album/artist detail and pushed pages;
  // only the full-screen Now Playing covers it). It's the bottom-most element,
  // so it — not the bar — pays the home-indicator inset.
  const showBottomNav = true;
  // The player bar + nav are absolutely overlaid over the scroll area (so
  // content shows through the gaps around them, Spotify-style); `main` reserves
  // their combined height as bottom padding. Whether a track is queued decides
  // if the bar contributes to that height.
  const hasTrack = usePlayerStore((s) => s.queue.length > 0);
  // Now-playing state for the Spotify-style card play/pause on Home.
  const homeIsPlaying = usePlayerStore((s) => s.isPlaying);
  const homeNowPlayingKey = usePlayerStore((s) => s.nowPlayingKey);
  const homeNowPlayingTrackId = usePlayerStore(currentTrack)?.id ?? null;
  // Now-playing awareness for the genre page: a catalog row carries no library
  // id until it's played, so match by id, then title+artist (the phone track
  // has no ISRC). Lets the genre "Top songs" rows show the equalizer marker on
  // the current track's cover, matching the playlist.
  const nowPlayingTrack = usePlayerStore(currentTrack);
  const isBrowseTrackCurrent = useCallback(
    (t: SearchTrackResult) => {
      const np = nowPlayingTrack;
      if (!np) return false;
      if (t.local_track_id != null && t.local_track_id === np.id) return true;
      const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
      return (
        !!np.title &&
        norm(t.title) === norm(np.title) &&
        norm(t.artists?.[0]) === norm(np.artists?.[0])
      );
    },
    [nowPlayingTrack],
  );
  // Minimal shape for the live "Recently played" prepend. Sourced from the LAST
  // LOGGED play (crossed the ~20s "counts as a play" threshold), NOT the
  // currently-playing track — so the optimistic shelf only shows songs the
  // server will actually keep. A sub-20s play prepended at track-start would
  // vanish on the next feed fetch (it was never recorded in play_events).
  const homeLogged = usePlayerStore((s) => s.lastLoggedTrack);
  const homeNowPlayingTrack = homeLogged
    ? {
        id: homeLogged.id,
        title: homeLogged.title,
        artists: homeLogged.artists,
        album: homeLogged.album,
        album_art_url: homeLogged.album_art_url,
        duration_ms: homeLogged.duration_ms,
        has_audio: homeLogged.has_audio,
      }
    : null;
  const homeTogglePlay = usePlayerStore((s) => s.playPause);
  const homeSetNowPlayingKey = usePlayerStore((s) => s.setNowPlayingKey);

  // Connection state (this device's internet + the home server's reachability)
  // drives the banner in the floating stack below. Called unconditionally here,
  // before the early returns, so it obeys the rules of hooks; it only surfaces
  // a banner once a session exists (token non-null).
  const sessionToken = session.kind === 'ready' ? session.token : null;
  const connPhase = useConnectivity(sessionToken);
  const bannerShown = connPhase !== 'online';

  // The banner fades out over 300ms, but `bannerShown` flips the instant the
  // phase goes online. Keep a lagging "present" flag alive through that fade so
  // the docked fuse (squared player top + reserved height) holds until the
  // tinted header has fully left — otherwise the bar pops its corners and the
  // header detaches mid-fade.
  const [bannerPresent, setBannerPresent] = useState(false);
  useEffect(() => {
    if (bannerShown) {
      setBannerPresent(true);
      return;
    }
    const id = window.setTimeout(() => setBannerPresent(false), 320);
    return () => window.clearTimeout(id);
  }, [bannerShown]);
  // iOS freezes timers while backgrounded, so the 320ms lag above could be
  // suspended mid-fade and leave the fuse stuck on (bar squared-top with an
  // empty reserved gap). On return to the foreground, snap it back to truth.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setBannerPresent(bannerShown);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [bannerShown]);

  // N7: refresh Home when the app returns to the foreground after a while, or
  // once the local day has rolled over (the server rebuilds discovery per
  // calendar day, so an overnight background→foreground should pick up the new
  // pool). Bumping homeRefreshKey re-mints the visit nonce, so the refetch is a
  // genuinely fresh per-visit slice. Guarded by a staleness window + day check
  // so a quick app-switch doesn't reshuffle the feed under you or waste a fetch.
  // Silent (no spinner): HomeScreen keeps painting the cached feed until the new
  // one lands. Manual pull-to-refresh resets the same staleness clock above.
  useEffect(() => {
    const HOME_STALE_MS = 30 * 60 * 1000;
    const maybeRefresh = () => {
      if (document.hidden || view.name !== 'home') return;
      const now = Date.now();
      const today = new Date().toDateString();
      const dayRolled = today !== lastHomeRefreshDay.current;
      if (dayRolled || now - lastHomeRefreshAt.current >= HOME_STALE_MS) {
        lastHomeRefreshAt.current = now;
        lastHomeRefreshDay.current = today;
        setHomeRefreshKey((k) => k + 1);
      }
    };
    document.addEventListener('visibilitychange', maybeRefresh);
    return () => document.removeEventListener('visibilitychange', maybeRefresh);
  }, [view.name]);

  // The overlay's reserved height (banner + bar + nav + home-indicator),
  // published as a CSS var so full-bleed drill-in pages and toasts can clear
  // the chrome without knowing the player's internals. The connection banner
  // rides above the bar, so its height joins the reservation whenever it's up
  // (slimmer when docked onto the bar, taller as a standalone card) — otherwise
  // the last content row / a toast would slide under it.
  const overlayBottom = `calc(env(safe-area-inset-bottom) + ${
    (hasTrack ? 76 : 0) + 70 + (bannerPresent ? (hasTrack ? 32 : 46) : 0)
  }px)`;

  const selectProfile = (id: number | null) => {
    writePhoneProfile(id);
    setProfileId(id);
  };

  // The player store is global on this device, so reset now-playing on a real
  // profile switch (not the first pick) — otherwise the previous user's song
  // carries over into the next profile and would log under them. Mirrors desktop.
  const prevProfileRef = useRef(profileId);
  useEffect(() => {
    const prev = prevProfileRef.current;
    if (prev != null && profileId !== prev) {
      usePlayerStore.getState().reset();
    }
    prevProfileRef.current = profileId;
  }, [profileId]);

  // Bind the session to the active profile server-side on launch so the server
  // can enforce per-profile playlist ownership. Best-effort + no PIN here —
  // covers no-PIN profiles and already-selected ones; a PIN profile re-binds
  // when re-selected through the gate.
  useEffect(() => {
    if (session.kind === 'ready' && profileId != null) {
      void bindSessionProfile(session.token, profileId);
    }
  }, [session, profileId]);

  // If an authenticated request 401s AFTER we were established (token
  // revoked/expired server-side), drop back to the pairing screen. Only when
  // already `ready`, though: during the initial load a STALE stored token (e.g.
  // from a prior pairing on this device) makes a concurrent call 401 before
  // ensureSession() swaps in a fresh one — that transient 401 must NOT flash the
  // pairing screen (it self-heals to `ready`, which is why a refresh "fixed" it).
  // ensureSession() owns the first-load decision; a genuine remote pairing
  // requirement still surfaces via its PairingRequiredError.
  useEffect(() => {
    // Silent recovery for a provider-proxied phone: a mid-session 401 re-mints
    // a token from /api/session instead of flashing the pairing code. The code
    // only appears if the server GENUINELY requires pairing (a real remote
    // visitor makes /api/session refuse) -- see reissuePhoneSession.
    setTokenReissuer(reissuePhoneSession);
    // When a re-mint swaps the token in, adopt it so children stop handing the
    // stale one to every request.
    setSessionRefreshedHandler((token) => {
      setSession((s) => (s.kind === 'ready' ? { kind: 'ready', token } : s));
    });
    // A 401 that could NOT be re-minted (pairing genuinely required, or offline)
    // drops an established session back to the pairing screen.
    setSessionExpiredHandler(() => {
      setSession((s) => (s.kind === 'ready' ? { kind: 'pairing-required' } : s));
    });
    return () => {
      setTokenReissuer(null);
      setSessionRefreshedHandler(null);
      setSessionExpiredHandler(null);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await ensureSession();
        if (!cancelled) setSession({ kind: 'ready', token });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.name === 'PairingRequiredError') {
          setSession({ kind: 'pairing-required' });
        } else {
          setSession({ kind: 'error', message: friendlyError(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Warm the profiles cache (the "Who's listening?" list + avatar images) on
  // every online launch, so the picker renders offline — even on a device that
  // already has a profile selected and normally skips the gate (the SW only
  // caches a GET it actually sees). Fire-and-forget; the SW stores the
  // responses for the next offline boot.
  useEffect(() => {
    if (session.kind !== 'ready') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const token = session.token;
    getProfiles(token)
      .then((profiles) => {
        for (const p of profiles) {
          if (p.avatar_path) {
            const img = new Image();
            img.src = profileAvatarUrl(p.id, token);
          }
        }
      })
      .catch(() => {
        /* offline / host asleep — nothing to warm */
      });
  }, [session]);

  if (session.kind === 'loading') {
    return (
      <div className="h-full grid place-items-center text-sm text-neutral-500">
        Connecting to Beetbot…
      </div>
    );
  }
  if (session.kind === 'pairing-required') {
    return (
      <PairingScreen
        onPaired={(token) => setSession({ kind: 'ready', token })}
      />
    );
  }
  if (session.kind === 'error') {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight mb-2">Couldn&apos;t connect</h1>
          <p className="text-sm text-neutral-400 break-words">{session.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={cn(BTN_SECONDARY, 'mt-4')}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Profile gate (Netflix-style) once we have a session but no profile yet.
  if (profileId == null) {
    return <ProfileGate token={session.token} onSelect={selectProfile} />;
  }

  return (
    <div
      className="h-full flex flex-col relative"
      style={{ ['--overlay-bottom' as string]: overlayBottom }}
    >
      {/* First visit on a phone: how to keep this on the home screen. Shown once,
          and never when it is already installed — see InstallSheet. */}
      <InstallSheet />
      {/* B6: pull-to-refresh spinner — rides down with the pull, then spins
          while refreshing. Only shown on Home. */}
      {view.name === 'home' && (pullDist > 0 || refreshing) && (
        <div
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none"
          style={{
            top: `calc(env(safe-area-inset-top) + ${refreshing ? 10 : pullDist - 26}px)`,
            opacity: refreshing ? 1 : Math.min(pullDist / PULL_THRESHOLD, 1),
          }}
        >
          <div className="h-8 w-8 grid place-items-center rounded-full bg-neutral-900/90 backdrop-blur-xl ring-1 ring-white/10 shadow-xl text-neutral-200">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              className={refreshing || pullDist >= PULL_THRESHOLD ? 'animate-spin' : ''}
              style={
                refreshing || pullDist >= PULL_THRESHOLD
                  ? undefined
                  : { transform: `rotate(${pullDist * 3}deg)` }
              }
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-6.2-8.5" />
              <path d="M21 3v6h-6" />
            </svg>
          </div>
        </div>
      )}
      {/* Frosted scrim over the status-bar inset (standalone PWA): scrolled
          content tucks under it cleanly instead of bleeding past the clock /
          battery. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-30 bg-neutral-950/40 backdrop-blur-2xl backdrop-saturate-150"
        style={{ height: 'env(safe-area-inset-top)' }}
      />
      <main
        ref={mainRef}
        onTouchStart={onMainTouchStart}
        onTouchMove={onMainTouchMove}
        onTouchEnd={onMainTouchEnd}
        onScroll={onMainScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain"
        // Apply iOS safe-area insets at the App level so they cover
        // *every* branch a screen might render -- including transient
        // "Loading library…" / "Couldn't load library" placeholders
        // that flash for a frame during view transitions. Otherwise
        // those one-frame states slide under the Dynamic Island.
        //
        // Bottom: keeps the last list row above the home indicator
        // when no Player bar is rendered (no track queued yet).
        // Top:    keeps every screen's header below the status bar.
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          // The player bar + nav are absolutely overlaid (below), so main must
          // reserve their height so its last row doesn't hide behind them.
          paddingBottom: 'var(--overlay-bottom)',
        }}
      >
        {view.name === 'home' && (
          <HomeScreen
            token={session.token}
            activeProfileId={profileId}
            save={saveController}
            refreshKey={homeRefreshKey}
            resetSignal={resetNonce}
            onPlayTrack={playSearchResultPhone}
            nowPlayingKey={homeNowPlayingKey}
            nowPlayingTrackId={homeNowPlayingTrackId}
            nowPlayingTrack={homeNowPlayingTrack}
            isPlaying={homeIsPlaying}
            isTrackCurrent={isBrowseTrackCurrent}
            onTogglePlay={homeTogglePlay}
            onPlayedFrom={homeSetNowPlayingKey}
            onOpenPlaylist={(id) => setView({ name: 'playlist', id })}
            onOpenSearch={() => setView({ name: 'search' })}
            onOpenSettings={() => setView({ name: 'settings', from: { name: 'home' } })}
            onWinBack={setWinBack}
            onShowTrackSheet={setAlbumSheetTrack}
            onAlbumAddToQueue={queueCatalogTrack}
            onAlbumSaveToLiked={favoriteCatalogTrack}
          />
        )}
        {view.name === 'settings' && (
          <SettingsScreen
            token={session.token}
            profileId={profileId}
            onBack={() => setView(view.from)}
            onOpenStats={() => setView({ name: 'stats', from: view })}
            onSwitchProfile={() => {
              // Back to the "Who's listening?" gate; land on Home after picking.
              setView({ name: 'home' });
              selectProfile(null);
            }}
            onDisconnect={() => {
              // Drop the profile AND the session token → the phone asks for a
              // pairing code again (re-pair as a different user / different host).
              setView({ name: 'home' });
              selectProfile(null);
              notifyUnauthorized();
            }}
          />
        )}
        {view.name === 'library' && (
          <LibraryScreen
            token={session.token}
            profileId={profileId}
            onOpen={(id) => setView({ name: 'playlist', id })}
            onOpenSettings={() => setView({ name: 'settings', from: { name: 'library' } })}
          />
        )}
        {view.name === 'stats' && (
          <StatsScreen
            token={session.token}
            profileId={profileId}
            onBack={() => setView(view.from)}
          />
        )}
        {view.name === 'search' && (
          <SearchScreen
            token={session.token}
            onPlayTrack={playSearchResultPhone}
            activeProfileId={profileId}
            onOpenSettings={() => setView({ name: 'settings', from: { name: 'search' } })}
            onOpenLibraryPlaylist={(id) => setView({ name: 'playlist', id })}
            onPlayLibrarySong={(t) => usePlayerStore.getState().setQueue([t], 0)}
            save={saveController}
            openRequest={catalogRequest}
            onRequestHandled={clearCatalogNav}
            resetSignal={resetNonce}
            onShowTrackSheet={setAlbumSheetTrack}
            onAlbumAddToQueue={queueCatalogTrack}
            onAlbumSaveToLiked={favoriteCatalogTrack}
            isTrackCurrent={isBrowseTrackCurrent}
            isNowPlaying={homeIsPlaying}
            onTogglePlay={homeTogglePlay}
            browseSlot={
              <BrowseScreen
                token={session.token}
                onPlayTrack={playSearchResultPhone}
                activeProfileId={profileId}
                save={saveController}
                onShowTrackSheet={setAlbumSheetTrack}
                onAlbumAddToQueue={queueCatalogTrack}
                onAlbumSaveToLiked={favoriteCatalogTrack}
                titleVariant="eyebrow"
                onOpenGenre={(genre) => setView({ name: 'browse', genre })}
                isTrackCurrent={isBrowseTrackCurrent}
                isNowPlaying={homeIsPlaying}
                onTogglePlay={homeTogglePlay}
              />
            }
          />
        )}
        {view.name === 'browse' && (
          <BrowseScreen
            token={session.token}
            onPlayTrack={playSearchResultPhone}
            activeProfileId={profileId}
            save={saveController}
            onShowTrackSheet={setAlbumSheetTrack}
            onAlbumAddToQueue={queueCatalogTrack}
            onAlbumSaveToLiked={favoriteCatalogTrack}
            initialGenre={view.genre}
            onExitGenre={() => setView({ name: 'search' })}
            isTrackCurrent={isBrowseTrackCurrent}
            isNowPlaying={homeIsPlaying}
            onTogglePlay={homeTogglePlay}
          />
        )}
        {view.name === 'playlist' && (
          <PlaylistScreen
            token={session.token}
            playlistId={view.id}
            profileId={profileId}
            onBack={() => setView({ name: 'library' })}
          />
        )}
      </main>
      {/* Fast-scroll thumb for long lists — drag the right-edge grip to scrub.
          Library-only for now (that's where lists run long); reads/drives the
          shared <main> scroll container. */}
      <FastScroller scrollRef={mainRef} active={view.name === 'library'} />
      {/* Floating bar + nav: lifted out of the flex flow and pinned over the
          scroll area, so content shows THROUGH the transparent gaps around them
          (Spotify-style). `main` reserves matching bottom padding so its last
          row still clears them. The wrapper is pointer-events-none so scrolls /
          taps in the transparent margins fall through to the content behind; the
          bar card and nav opt back in. A soft upward gradient keeps the nav
          legible over bright artwork without hiding the content behind it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-neutral-950 via-neutral-950/55 to-transparent" />
        <div className="relative">
          {/* Connection banner rides above the mini-bar: "you're offline" /
              "can't reach your library" / a one-shot "back online" pulse. When a
              track is playing it docks flush onto the bar as a tinted header. */}
          <ConnectionBanner
            phase={connPhase}
            token={sessionToken}
            docked={hasTrack}
          />
          {/* The nav (below) is the bottom-most element and pays the
              home-indicator inset, so the bar never does. Square the bar's top
              when a banner is docked above it so they form one card. */}
          <Player
            token={session.token}
            profileId={profileId}
            bottomInset={false}
            flushTop={bannerPresent && hasTrack}
            connBannerShown={bannerShown}
          />
          {/* Persistent bottom nav — on every screen, iOS-style. */}
          {showBottomNav && (
            <BottomNav
              current={view.name}
              compact={navCompact}
              winBack={winBack}
              onChange={(name) => {
                // Re-tapping the already-active tab pops any open drill-in
                // (album/artist/playlist detail rendered inside the tab) back to
                // the feed, then scrolls to the top — standard iOS tab-bar
                // behavior. The bump signals Home/Search to close their overlays.
                if (name === view.name) {
                  setResetNonce((n) => n + 1);
                  mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                } else {
                  setView({ name } as View);
                }
              }}
            />
          )}
        </div>
      </div>
      {/* Per-song "⋯" sheet for an opened catalog album/playlist row — the same
          component + actions the library album/playlist rows use, so a searched
          album matches a saved one. Favorite resolves the catalog row to a
          library track first; Add opens the playlist picker; Go to Artist/Album
          navigate (Go to Album auto-hides on album rows, which carry no album). */}
      {albumSheetTrack && (
        <TrackActionSheet
          onClose={() => setAlbumSheetTrack(null)}
          quick={[
            {
              key: 'favorite',
              label: 'Favorite',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
                </svg>
              ),
              onClick: () => void favoriteCatalogTrack(albumSheetTrack),
            },
            {
              key: 'add',
              label: 'Add',
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 7h10M4 12h6M4 17h6" />
                  <path d="M16 14v7M12.5 17.5h7" />
                </svg>
              ),
              onClick: () => setAlbumAddTrack(albumSheetTrack),
            },
          ]}
          items={[
            ...(albumSheetTrack.artists[0]
              ? [
                  {
                    key: 'artist',
                    label: 'Go to Artist',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="8" r="4" />
                        <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
                      </svg>
                    ),
                    onClick: () => openArtistNav(albumSheetTrack.artists[0]),
                  },
                ]
              : []),
            ...(albumSheetTrack.album
              ? [
                  {
                    key: 'album',
                    label: 'Go to Album',
                    icon: (
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="2.4" />
                      </svg>
                    ),
                    onClick: () =>
                      openAlbumNav(
                        albumSheetTrack.album!,
                        albumSheetTrack.artists[0] ?? null,
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {albumAddTrack &&
        createPortal(
          <AddToPlaylistModal
            token={session.kind === 'ready' ? session.token : ''}
            activeProfileId={profileId}
            track={albumAddTrack}
            onClose={() => setAlbumAddTrack(null)}
          />,
          document.body,
        )}
    </div>
  );
}

function BottomNav({
  current,
  compact,
  winBack,
  onChange,
}: {
  current: string;
  compact: boolean;
  winBack: boolean;
  onChange: (v: 'home' | 'search' | 'library') => void;
}) {
  return (
    <div
      className="pointer-events-auto shrink-0 px-3"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.125rem)' }}
    >
      {/* Detached floating pill (iOS-26-style): the same frosted glass as the
          mini bar above it, so the two read as one floating system. Shrinks to
          icons-only while scrolling down. */}
      <nav
        className={cn(
          BAR,
          'mx-auto max-w-md rounded-full ring-1 ring-white/10 shadow-lg shadow-black/40 overflow-hidden',
        )}
        aria-label="Primary"
      >
      <div className="flex">
        <NavBtn
          active={current === 'home' || current === 'settings'}
          compact={compact}
          badge={winBack && current !== 'home'}
          label="Home"
          icon={
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
            </svg>
          }
          onClick={() => onChange('home')}
        />
        <NavBtn
          active={current === 'search' || current === 'browse'}
          compact={compact}
          label="Search"
          icon={
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          }
          onClick={() => onChange('search')}
        />
        <NavBtn
          active={current === 'library' || current === 'playlist' || current === 'stats'}
          compact={compact}
          label="Library"
          icon={
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="4" width="4" height="16" rx="1" />
              <rect x="10" y="4" width="4" height="16" rx="1" />
              <path d="m17 4 4 16" />
            </svg>
          }
          onClick={() => onChange('library')}
        />
      </div>
      </nav>
    </div>
  );
}

function NavBtn({
  active,
  compact,
  badge,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  compact: boolean;
  badge?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 grid place-items-center gap-0.5 transition-[padding] duration-200 active:opacity-60 ${
        compact ? 'py-2' : 'py-2.5'
      } ${active ? 'text-white' : 'text-neutral-400'}`}
    >
      <span className="relative grid place-items-center">
        {icon}
        {badge && (
          <span className="absolute -top-0.5 -right-1.5 h-2 w-2 rounded-full bg-white ring-2 ring-neutral-900" />
        )}
      </span>
      {/* Labels collapse away when the pill is shrunk. */}
      <span
        className={`text-[10px] font-medium uppercase tracking-wide overflow-hidden transition-all duration-200 ${
          compact ? 'max-h-0 opacity-0' : 'max-h-4 opacity-100'
        }`}
      >
        {label}
      </span>
    </button>
  );
}

function PairingScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill the label with something useful so the desktop's Devices
  // list shows "iPhone — Alex's iPhone" instead of just the UA blurb.
  useEffect(() => {
    const guess =
      /iPad/.test(navigator.userAgent)
        ? 'iPad'
        : /iPhone/.test(navigator.userAgent)
          ? 'iPhone'
          : /Android/.test(navigator.userAgent)
            ? 'Android'
            : 'Browser';
    setLabel(guess);
  }, []);

  const pair = useCallback(
    async (theCode: string) => {
      if (theCode.trim().length !== 6) {
        setError('Code must be 6 digits.');
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const token = await submitPairing(theCode, label.trim() || null);
        onPaired(token);
      } catch (err) {
        setError(friendlyError(err));
      } finally {
        setBusy(false);
      }
    },
    [label, onPaired],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void pair(code);
    },
    [pair, code],
  );

  // Arrived via a QR that carries the code (?pair=123456)? Auto-pair so the
  // phone connects in one tap — no typing.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    const pre = new URLSearchParams(window.location.search).get('pair');
    if (pre && /^\d{6}$/.test(pre)) {
      autoTried.current = true;
      setCode(pre);
      void pair(pre);
    }
  }, [pair]);

  return (
    <div className="h-full grid place-items-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 text-center"
      >
        <div>
          <h1 className="text-xl font-bold tracking-tight mb-1">Enter pairing code</h1>
          <p className="text-sm text-neutral-400">
            The desktop app shows a 6-digit code in Settings → Devices.
            Codes rotate every 5 minutes.
          </p>
        </div>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          className={cn(INPUT, 'w-full py-3 text-center text-2xl! tracking-[0.4em] font-mono')}
          disabled={busy}
          autoFocus
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="device label (shown to host)"
          className={cn(INPUT, 'w-full')}
          disabled={busy}
        />
        {error && (
          <div className={cn(CALLOUT_ERROR, 'text-xs')}>
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy || code.trim().length !== 6}
          className={cn(BTN_PRIMARY, 'w-full py-3')}
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  );
}
