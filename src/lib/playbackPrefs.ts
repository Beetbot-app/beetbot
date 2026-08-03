import { usePlayerStore } from '@/lib/store';

/**
 * Per-profile playback preferences — crossfade length + autoplay-radio. These
 * are personal taste, but they live inside the (deliberately global, reset-on-
 * switch) player store next to the queue/now-playing state, which must NOT be
 * per-profile. So rather than re-split that shared store, this thin desktop
 * layer keeps a { [profileId]: prefs } map and drives the two fields through the
 * store's existing setters: it LOADS a profile's prefs on switch and PERSISTS
 * any later change (from Settings or Now Playing) back to that profile's slot.
 *
 * Wired from App.tsx via `setPlaybackProfile`, alongside the pins/saved/
 * appearance/audiofx stores. Desktop-only (localStorage); the phone keeps its
 * own player persistence untouched.
 */

type Prefs = { crossfadeSeconds: number; autoplay: boolean };
// Match the player-store factory defaults (crossfade off; autoplay-radio on).
const DEFAULTS: Prefs = { crossfadeSeconds: 0, autoplay: true };

const KEY = 'beetbot.desktop.playback.byProfile';
// The global player blob we seed the owner's slot from, once.
const LEGACY_PLAYER_KEY = 'beetbot.desktop.player-v1';

type ByProfile = Record<string, Prefs>;

function loadMap(): ByProfile {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as ByProfile;
  } catch {
    return {};
  }
}
function saveMap(m: ByProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage blocked → prefs just won't survive a relaunch */
  }
}

/** One-time upgrade: seed the owner (profile 1) from the existing global player
 *  blob so their current crossfade/autoplay survive the move to per-profile. */
function migrate(m: ByProfile): ByProfile {
  if (localStorage.getItem(KEY) != null) return m;
  try {
    const raw = localStorage.getItem(LEGACY_PLAYER_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as { state?: Partial<Prefs> };
      const st = (blob?.state ?? {}) as Partial<Prefs>;
      m = {
        ...m,
        '1': {
          crossfadeSeconds:
            typeof st.crossfadeSeconds === 'number'
              ? st.crossfadeSeconds
              : DEFAULTS.crossfadeSeconds,
          autoplay: typeof st.autoplay === 'boolean' ? st.autoplay : DEFAULTS.autoplay,
        },
      };
    }
  } catch {
    /* unreadable → start clean */
  }
  saveMap(m);
  return m;
}

let map = migrate(loadMap());
let activeId: number | null = null;
// True only while we're loading a profile's prefs INTO the store, so the
// subscription below doesn't echo that write straight back.
let applying = false;

/** Load a profile's crossfade/autoplay into the global player store. Called on
 *  every profile switch (and initial mount). */
export function setPlaybackProfile(id: number | null): void {
  activeId = id;
  const p = id == null ? DEFAULTS : (map[String(id)] ?? DEFAULTS);
  const st = usePlayerStore.getState();
  applying = true;
  st.setCrossfadeSeconds(p.crossfadeSeconds);
  st.setAutoplay(p.autoplay);
  applying = false;
}

// Persist any later change to the active profile's slot. reset() (fired on a
// profile switch) touches only the queue/playhead, never these two, so it never
// races this. Registered once at module load.
usePlayerStore.subscribe((s, prev) => {
  if (applying || activeId == null) return;
  if (s.crossfadeSeconds === prev.crossfadeSeconds && s.autoplay === prev.autoplay) return;
  map = {
    ...map,
    [String(activeId)]: { crossfadeSeconds: s.crossfadeSeconds, autoplay: s.autoplay },
  };
  saveMap(map);
});
