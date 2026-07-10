import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FirstRunWizard } from '@/components/FirstRunWizard';
import { PlayerBar } from '@/components/PlayerBar';
import { currentTrack, usePlayerStore } from '@/lib/store';
import { ambientGradient, extractDominantColor, type Rgb } from '@shared/albumColor';
import { useAccentColor } from '@shared/useAccent';
import { usePinStore } from '@/lib/pins';
import { useUiStore } from '@/lib/ui';
import { useAppearanceStore, applyZoom, clampZoom, ZOOM_STEP } from '@/lib/appearance';
import { NowPlayingView } from '@/components/NowPlayingView';
import { RightBar } from '@/components/RightBar';
import { useProfileStore } from '@/lib/profile';
import { setActiveProfileId } from '@shared/api';
import { ipc } from '@/lib/tauri';
import { ProfileGate } from '@/components/ProfileGate';
import { Sidebar } from '@/components/Sidebar';
import { BrowsePage } from '@/pages/Browse';
import { HomePage } from '@/pages/Home';
import { LibraryPage } from '@/pages/Library';
import { PlaylistPage } from '@/pages/Playlist';
import { SearchOverlay } from '@/pages/Search';
import { StatsPage } from '@/pages/Stats';
import type { OverlaySnapshot } from '@shared/components/SearchScreen';
import type { BrowseSnapshot } from '@shared/components/BrowseScreen';
import type { HomeDrillSnapshot } from '@shared/components/HomeScreen';
import { useNavStore } from '@/lib/nav';
import { TopBar } from '@/components/TopBar';
import { SettingsPage } from '@/pages/Settings';

type View =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'search' }
  | { name: 'browse' }
  | { name: 'settings' }
  | { name: 'stats' }
  | { name: 'playlist'; id: number };

type MediaControlAction = 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'stop';

const ONBOARDING_KEY = 'beetbot.onboarding_seen';

// Floating-shell layout (identity swing X3): the sidebar, main, right panel, and
// player render as frosted rounded panels separated by ink gaps, floating over
// the artwork wash, instead of flush edge-to-edge bars. A single switch so the
// whole prototype is reversible — flip to false to fall straight back to the
// flush shell (every component keeps its original chrome on the false path).
const FLOATING_SHELL = true;

function App() {
  // Browser-style view history (back/forward in the top bar). The visible view
  // is `stack[index]`; navigating truncates forward entries and pushes. Each
  // entry also carries a snapshot of any page open OVER that view —
  // `overlays[i]` for a search page, `browseDrills[i]` for a Discover drill — so
  // Back/Forward replay them in both directions (they're otherwise ephemeral and
  // vanish the moment you navigate away). At most one of the two is set.
  const [nav, setNav] = useState<{
    stack: View[];
    overlays: (OverlaySnapshot | null)[];
    browseDrills: (BrowseSnapshot | null)[];
    homeDrills: (HomeDrillSnapshot | null)[];
    index: number;
  }>({
    stack: [{ name: 'home' }],
    overlays: [null],
    browseDrills: [null],
    homeDrills: [null],
    index: 0,
  });
  const view = nav.stack[nav.index];
  // Bumped after an in-place playlist edit (e.g. rename) so the persistent
  // sidebar refetches its list even though the top-level view didn't change.
  const [playlistListTick, setPlaylistListTick] = useState(0);
  // Win-back (imp 8): true when Home has a hoisted "Welcome back" shelf; lights a
  // dot on the TopBar Home button while you're on another view.
  const [winBack, setWinBack] = useState(false);
  // `null` while we're still deciding whether to show the wizard; `true`
  // means "show it"; `false` means "don't". Three-state guard so we don't
  // briefly flash the wizard on every reload while we check the DB.
  const [showWizard, setShowWizard] = useState<boolean | null>(null);

  // Search lives in a persistent top bar; its results/detail pages overlay the
  // current view (SearchOverlay), so search is never a sidebar tab. `barSlot` is
  // the search bar's portal target. Each searched page (results / artist / album)
  // is its own history entry: `onOverlayPush` adds one when the user drills in,
  // and `restore` replays an entry's saved page (or clears the overlay) on
  // navigation / Back / Forward. So Back/Forward through searched pages is plain
  // history — they survive and replay in both directions.
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const [restore, setRestore] = useState<{
    signal: number;
    snapshot: OverlaySnapshot | null;
  }>({ signal: 0, snapshot: null });
  const [browseRestore, setBrowseRestore] = useState<{
    signal: number;
    snapshot: BrowseSnapshot | null;
  }>({ signal: 0, snapshot: null });
  const [homeRestore, setHomeRestore] = useState<{
    signal: number;
    snapshot: HomeDrillSnapshot | null;
  }>({ signal: 0, snapshot: null });
  // Replay the page(s) recorded at a history position: the search overlay and
  // the Discover drill at once (at most one is set). Bumped on Back / Forward /
  // navigation-clear; BrowseScreen also re-opens its drill on remount.
  const restoreTo = useCallback(
    (
      searchSnap: OverlaySnapshot | null,
      browseSnap: BrowseSnapshot | null,
      homeSnap: HomeDrillSnapshot | null,
    ) => {
      // Abandon any in-flight "open artist/album" request (from Home / the
      // player bar) when we change history position — otherwise a late resolve
      // would drill into the view we just left and corrupt its saved overlay.
      useNavStore.getState().clear();
      setRestore((r) => ({ signal: r.signal + 1, snapshot: searchSnap }));
      setBrowseRestore((r) => ({ signal: r.signal + 1, snapshot: browseSnap }));
      setHomeRestore((r) => ({ signal: r.signal + 1, snapshot: homeSnap }));
    },
    [],
  );
  // The user drilled to a new page: push a history entry riding on a duplicate
  // of the current view (so clearing reveals that view, never a blank screen).
  // The screen already shows the page, so we record the stop without restoring.
  const pushOverlay = useCallback(
    (
      overlay: OverlaySnapshot | null,
      browse: BrowseSnapshot | null,
      home: HomeDrillSnapshot | null,
    ) => {
      setNav((n) => {
        const stack = n.stack.slice(0, n.index + 1);
        const overlays = n.overlays.slice(0, n.index + 1);
        const browseDrills = n.browseDrills.slice(0, n.index + 1);
        const homeDrills = n.homeDrills.slice(0, n.index + 1);
        stack.push(stack[stack.length - 1]);
        overlays.push(overlay);
        browseDrills.push(browse);
        homeDrills.push(home);
        return { stack, overlays, browseDrills, homeDrills, index: stack.length - 1 };
      });
    },
    [],
  );
  const onOverlayPush = useCallback(
    (snapshot: OverlaySnapshot) => pushOverlay(snapshot, null, null),
    [pushOverlay],
  );
  const onBrowsePush = useCallback(
    (snapshot: BrowseSnapshot) => pushOverlay(null, snapshot, null),
    [pushOverlay],
  );
  const onHomeDrillPush = useCallback(
    (snapshot: HomeDrillSnapshot) => pushOverlay(null, null, snapshot),
    [pushOverlay],
  );
  const navigate = useCallback(
    (v: View) => {
      setNav((n) => {
        const stack = n.stack.slice(0, n.index + 1);
        const overlays = n.overlays.slice(0, n.index + 1);
        const browseDrills = n.browseDrills.slice(0, n.index + 1);
        const homeDrills = n.homeDrills.slice(0, n.index + 1);
        const cur = stack[stack.length - 1];
        // Only dedupe when already on this exact view with NO page open over it.
        // If a search/drill page is open, push a fresh bare entry so that page
        // stays a distinct Back stop behind the new view.
        const same =
          !overlays[overlays.length - 1] &&
          !browseDrills[browseDrills.length - 1] &&
          !homeDrills[homeDrills.length - 1] &&
          cur.name === v.name &&
          (v.name !== 'playlist' ||
            (cur.name === 'playlist' && cur.id === v.id));
        if (same) {
          return { stack, overlays, browseDrills, homeDrills, index: stack.length - 1 };
        }
        stack.push(v);
        overlays.push(null);
        browseDrills.push(null);
        homeDrills.push(null);
        return { stack, overlays, browseDrills, homeDrills, index: stack.length - 1 };
      });
      restoreTo(null, null, null);
    },
    [restoreTo],
  );
  const canBack = nav.index > 0;
  const canForward = nav.index < nav.stack.length - 1;
  // One history step per event tick. Two stacked detail modals (a search drill
  // floating over a Discover drill) each register a window Escape listener, so a
  // single Escape can call goBack twice synchronously — and the functional
  // setNav would decrement the index twice. The lock blocks the second call; the
  // effect clears it after the re-render so the next click works normally.
  const navLock = useRef(false);
  useEffect(() => {
    navLock.current = false;
  });
  // Back/Forward are plain history now: pop/advance one entry and replay the
  // page(s) saved there. Closing a search/Discover detail routes here too.
  const goBack = useCallback(() => {
    if (navLock.current || nav.index <= 0) return;
    navLock.current = true;
    const i = nav.index - 1;
    restoreTo(
      nav.overlays[i] ?? null,
      nav.browseDrills[i] ?? null,
      nav.homeDrills[i] ?? null,
    );
    setNav((n) => ({ ...n, index: n.index - 1 }));
  }, [nav, restoreTo]);
  const goForward = useCallback(() => {
    if (navLock.current || nav.index >= nav.stack.length - 1) return;
    navLock.current = true;
    const i = nav.index + 1;
    restoreTo(
      nav.overlays[i] ?? null,
      nav.browseDrills[i] ?? null,
      nav.homeDrills[i] ?? null,
    );
    setNav((n) => ({ ...n, index: n.index + 1 }));
  }, [nav, restoreTo]);

  // Active user profile (Netflix-style). Null ⇒ show the profile picker.
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  // Tell the shared catalog API which profile is active so search/browse ✓
  // ("in your library") marks scope to THIS profile's playlists. Set during
  // render (App is the root, so it runs before any child screen's fetch effect).
  setActiveProfileId(activeProfileId);

  // Scope sidebar pins to the active profile (pins are per-profile UI state).
  useEffect(() => {
    usePinStore.getState().setProfile(activeProfileId);
  }, [activeProfileId]);

  // The player store is a single global WebView localStorage (not per-profile),
  // so without this the previous user's now-playing song + queue would carry
  // into the next profile on a switch — and replaying it would log the play
  // under the new profile, bleeding into their Home "recently played". Reset
  // playback on a real switch, but NOT on the initial mount, so relaunching
  // still resumes the last queue.
  const prevProfileRef = useRef(activeProfileId);
  useEffect(() => {
    const prev = prevProfileRef.current;
    if (prev != null && activeProfileId !== prev) {
      usePlayerStore.getState().reset();
    }
    prevProfileRef.current = activeProfileId;
  }, [activeProfileId]);

  const nowPlayingFull = useUiStore((s) => s.nowPlayingFull);
  const rightBar = useUiStore((s) => s.rightBar);

  // If the persisted profile was deleted (e.g. on another device), fall back
  // to the picker rather than querying a non-existent profile.
  useEffect(() => {
    if (activeProfileId == null) return;
    let cancelled = false;
    ipc
      .listProfiles()
      .then((ps) => {
        if (!cancelled && !ps.some((p) => p.id === activeProfileId)) {
          setActiveProfile(null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, setActiveProfile]);

  // Decide once on mount whether the user is fresh. They're fresh if:
  //   - localStorage hasn't recorded the wizard as seen, AND
  //   - they have zero playlists.
  // We persist "seen" the first time the wizard closes; otherwise importing
  // a few tracks would still show it next launch.
  useEffect(() => {
    if (activeProfileId == null) return;
    let cancelled = false;
    (async () => {
      try {
        if (localStorage.getItem(ONBOARDING_KEY) === '1') {
          if (!cancelled) setShowWizard(false);
          return;
        }
        const playlists = await ipc.listPlaylists(activeProfileId);
        if (cancelled) return;
        setShowWizard(playlists.length === 0);
      } catch {
        if (!cancelled) setShowWizard(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  // Route OS media-key / Now-Playing events into the player store.
  useEffect(() => {
    const unlisten = listen<MediaControlAction>('media-control', (event) => {
      const store = usePlayerStore.getState();
      switch (event.payload) {
        case 'play':
          store.play();
          break;
        case 'pause':
        case 'stop':
          store.pause();
          break;
        case 'toggle':
          store.playPause();
          break;
        case 'next':
          store.next();
          break;
        case 'prev':
          store.prev();
          break;
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Artwork-derived ambient (Daft-style): sample a tint from the now-playing
  // track's cover and feed it to the window backdrop, so the whole app glows in
  // the color of what's playing. Falls back to a fixed warm wash when nothing is
  // playing or the cover can't be read (CORS).
  const npTrack = usePlayerStore(currentTrack);
  const artUrl = npTrack?.album_art_url ?? null;
  useAccentColor(artUrl);

  // --- Appearance: zoom + "open Now Playing on play" -----------------------
  const zoom = useAppearanceStore((s) => s.zoom);
  // Apply the persisted zoom to the WebView on mount and whenever it changes.
  useEffect(() => {
    void applyZoom(zoom);
  }, [zoom]);
  // ⌘+ / ⌘- / ⌘0 nudge the same zoom the Appearance control drives, so the
  // shortcut and the setting never disagree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const s = useAppearanceStore.getState();
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        s.setZoom(clampZoom(s.zoom + ZOOM_STEP));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        s.setZoom(clampZoom(s.zoom - ZOOM_STEP));
      } else if (e.key === '0') {
        e.preventDefault();
        s.setZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // When a *new* song starts and the preference is on, jump to the full-window
  // Now Playing view. Seeded with the mounted track so relaunching into a
  // persisted queue never auto-opens it.
  const npTrackId = npTrack?.id ?? null;
  const prevNpTrackId = useRef(npTrackId);
  useEffect(() => {
    const prev = prevNpTrackId.current;
    prevNpTrackId.current = npTrackId;
    if (npTrackId == null || npTrackId === prev) return;
    if (useAppearanceStore.getState().openNowPlayingOnPlay) {
      useUiStore.getState().openFullNowPlaying();
    }
  }, [npTrackId]);

  const [tint, setTint] = useState<Rgb | null>(null);
  useEffect(() => {
    if (!artUrl) {
      setTint(null);
      return;
    }
    let cancelled = false;
    void extractDominantColor(artUrl).then((c) => {
      if (!cancelled) setTint(c);
    });
    return () => {
      cancelled = true;
    };
  }, [artUrl]);
  // The whole-app ambient wash, tinted by the now-playing cover. Shares its
  // formula with the detail-page heroes (HeroWash) via ambientGradient.
  const ambientBackground = ambientGradient(tint);

  const handleWizardDone = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, '1');
    } catch {
      // Storage may be blocked; the next launch will just re-show.
    }
    setShowWizard(false);
  };

  // Gate the whole app behind profile selection (Netflix-style).
  if (activeProfileId == null) {
    return <ProfileGate />;
  }

  return (
    <div
      className="relative h-screen flex flex-col overflow-hidden"
      style={{
        // Ambient backdrop (Daft-style): the window's own background is a wash up
        // top (behind the frosted chrome) over a near-black base, fading to a
        // faint glow at the bottom. Painted as the ROOT background — not a
        // separate -z layer — so the translucent top/now-playing/side bars frost
        // straight over it, and a transparent page (Home) reveals it at the top.
        // The tint is derived from the now-playing cover (see ambientBackground).
        background: ambientBackground,
        transition: 'background 700ms ease',
      }}
    >
      <TopBar
        homeActive={view.name === 'home'}
        homeBadge={winBack && view.name !== 'home'}
        onHome={() => navigate({ name: 'home' })}
        onSettings={() => navigate({ name: 'settings' })}
        onOpenStats={() => navigate({ name: 'stats' })}
        onBack={goBack}
        onForward={goForward}
        canBack={canBack}
        canForward={canForward}
        profileId={activeProfileId}
        onSwitchProfile={() => setActiveProfile(null)}
        barSlotRef={setBarSlot}
      />
      <div
        className={`flex-1 min-h-0 flex${
          // pt-14 (56px) drops the cards just below the transparent header so
          // their full rounded tops show (Spotify-style), without wasting room —
          // the cards' own content padding provides the inner inset.
          FLOATING_SHELL ? ' gap-2 px-2 pb-2 pt-14' : ''
        }`}
      >
        <Sidebar
          floating={FLOATING_SHELL}
          active={view.name}
          onOpenPlaylist={(id) => navigate({ name: 'playlist', id })}
          onOpenLibrary={() => navigate({ name: 'library' })}
          currentPlaylistId={view.name === 'playlist' ? view.id : null}
          profileId={activeProfileId}
          // Refetch the playlist list whenever the top-level view changes
          // (e.g. after deleting one and popping back to Library), so the
          // sidebar stays current. The tick suffix also forces a refetch after
          // an in-place rename (no view change).
          refreshSignal={`${view.name}:${playlistListTick}`}
        />
        <main
          className={`relative flex-1 min-h-0 overflow-hidden${
            FLOATING_SHELL ? ' rounded-2xl border border-white/10' : ''
          }`}
        >
          {view.name === 'home' && (
            <HomePage
              onOpenPlaylist={(id) => navigate({ name: 'playlist', id })}
              onOpenBrowse={() => navigate({ name: 'browse' })}
              onWinBack={setWinBack}
              onMixPush={onHomeDrillPush}
              mixRestore={homeRestore}
              onMixBack={goBack}
            />
          )}
          {view.name === 'library' && (
            <LibraryPage
              onOpenPlaylist={(id) => navigate({ name: 'playlist', id })}
              onOpenSettings={() => navigate({ name: 'settings' })}
            />
          )}
          {view.name === 'browse' && (
            <BrowsePage
              restore={browseRestore}
              onBrowsePush={onBrowsePush}
              onBrowseBack={goBack}
            />
          )}
          {view.name === 'settings' && <SettingsPage />}
          {view.name === 'stats' && <StatsPage onBack={goBack} />}
          {view.name === 'playlist' && (
            <PlaylistPage
              // Remount per playlist so scroll position, the virtualized list,
              // and in-flight loads never carry over from a previous (often
              // much longer) playlist.
              key={view.id}
              playlistId={view.id}
              onBack={() => navigate({ name: 'library' })}
              onChanged={() => setPlaylistListTick((t) => t + 1)}
            />
          )}
          {/* Persistent search overlay: the bar portals to the top bar; results
              and artist/album pages float over the current view (nothing when
              idle), so search is never a sidebar tab. */}
          <SearchOverlay
            barSlot={barSlot}
            restore={restore}
            onOverlayPush={onOverlayPush}
            onOverlayBack={goBack}
            // Spotify/Apple-Music-style: tapping into the (idle) search box
            // surfaces Discover as the browse/empty state behind the dropdown.
            onSearchFocus={() => {
              if (view.name !== 'browse') navigate({ name: 'browse' });
            }}
            onOpenBrowse={() => {
              if (view.name !== 'browse') navigate({ name: 'browse' });
            }}
          />
        </main>
        {rightBar !== 'closed' && <RightBar floating={FLOATING_SHELL} />}
      </div>
      <PlayerBar floating={FLOATING_SHELL} />
      {nowPlayingFull && <NowPlayingView />}
      {showWizard && <FirstRunWizard onDone={handleWizardDone} />}
    </div>
  );
}

export default App;
