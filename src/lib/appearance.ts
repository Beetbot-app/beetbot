import { create } from 'zustand';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Desktop appearance preferences — how the app *looks*. Zoom and "open Now
 * Playing on play" are personal taste, so they're persisted PER PROFILE (the
 * library is shared, but one person bumping the zoom shouldn't rescale everyone
 * else). Desktop-local only — the phone has no zoom, so there's no server sync.
 *
 * The native-audio-engine beta is different: it's a device-level playback
 * backend choice, not a per-person look, so it stays GLOBAL (one setting for the
 * whole Mac). Kept in this store for convenience but under its own storage key.
 *
 * Kept separate from the player store so a taste change never touches playback
 * state. `setProfile(id)` swaps in a profile's look and is wired from App.tsx
 * alongside the pins/saved stores.
 */

/** Zoom factor bounds. 1 = 100%. ⌘+/⌘- step by ZOOM_STEP; ⌘0 resets to 1. */
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.3;
export const ZOOM_STEP = 0.1;

/** The three named presets the Appearance segmented control offers. */
export const ZOOM_CHOICES = {
  dense: 0.9,
  default: 1.0,
  spacious: 1.1,
} as const;
export type ZoomChoice = keyof typeof ZOOM_CHOICES;

/** Snap an arbitrary zoom to two decimals inside the allowed range. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/** Which named preset a raw zoom reads as (⌘± can land between them). */
export function zoomChoiceOf(zoom: number): ZoomChoice {
  if (zoom <= 0.95) return 'dense';
  if (zoom >= 1.05) return 'spacious';
  return 'default';
}

/** The per-profile slice: the "look" preferences that follow each profile. */
type LookPrefs = { zoom: number; openNowPlayingOnPlay: boolean };
const LOOK_DEFAULTS: LookPrefs = { zoom: 1, openNowPlayingOnPlay: false };

// One localStorage key holds a { [profileId]: LookPrefs } map; the native-engine
// beta is a single global flag under its own key. LEGACY_KEY is the old global
// zustand-persist blob we migrate away from once.
const LOOK_KEY = 'beetbot.desktop.appearance.byProfile';
const ENGINE_KEY = 'beetbot.desktop.nativeEngine';
const LEGACY_KEY = 'beetbot.desktop.appearance';

type ByProfile = Record<string, LookPrefs>;

function loadMap(): ByProfile {
  try {
    return JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') as ByProfile;
  } catch {
    return {};
  }
}
function saveMap(map: ByProfile): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(map));
  } catch {
    /* storage may be blocked; the look just won't survive a relaunch */
  }
}
function loadEngine(): boolean {
  try {
    return localStorage.getItem(ENGINE_KEY) === '1';
  } catch {
    return false;
  }
}
function saveEngine(v: boolean): void {
  try {
    localStorage.setItem(ENGINE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** One-time upgrade: fold the old single global appearance blob into the owner's
 *  slot (profile 1) and lift its nativeEngine into the new global key, so an
 *  update keeps the existing look instead of snapping back to defaults. Runs
 *  only until LOOK_KEY exists. */
function migrateLegacy(map: ByProfile): ByProfile {
  if (localStorage.getItem(LOOK_KEY) != null) return map;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as { state?: Record<string, unknown> };
      const st = (blob?.state ?? blob) as Record<string, unknown>;
      map = {
        ...map,
        '1': {
          zoom: typeof st.zoom === 'number' ? clampZoom(st.zoom) : 1,
          openNowPlayingOnPlay: st.openNowPlayingOnPlay === true,
        },
      };
      if (typeof st.nativeEngine === 'boolean' && localStorage.getItem(ENGINE_KEY) == null) {
        saveEngine(st.nativeEngine);
      }
    }
  } catch {
    /* unreadable legacy blob → start clean */
  }
  saveMap(map); // stamp LOOK_KEY so the migration never runs again
  return map;
}

// The full map lives module-scoped; the store mirrors the active profile's slice
// as reactive fields so components re-render on change (the pins-store pattern).
let map = migrateLegacy(loadMap());

function slice(id: number | null): LookPrefs {
  return id == null ? LOOK_DEFAULTS : (map[String(id)] ?? LOOK_DEFAULTS);
}
function writeLook(id: number, next: LookPrefs): void {
  map = { ...map, [String(id)]: next };
  saveMap(map);
}

interface AppearanceState {
  /** Active profile whose look is mirrored below (null before sign-in). */
  profileId: number | null;
  /** Load a profile's look into the store. Called on every profile switch. */
  setProfile: (id: number | null) => void;
  /** Webview zoom factor (1 = 100%). Per profile. */
  zoom: number;
  setZoom: (z: number) => void;
  /** Open the full Now Playing view automatically when a new song starts. Per profile. */
  openNowPlayingOnPlay: boolean;
  setOpenNowPlayingOnPlay: (v: boolean) => void;
  /** Native audio engine (beta): drive downloaded tracks through the Rust
   *  engine instead of the WebKit <audio> element. Off = the proven webview
   *  player. GLOBAL (device-level). See src/lib/nativeEngine.ts + src-tauri/src/engine. */
  nativeEngine: boolean;
  setNativeEngine: (v: boolean) => void;
  /** Restore the ACTIVE profile's appearance defaults (zoom 100%, no auto-open). */
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  profileId: null,
  zoom: LOOK_DEFAULTS.zoom,
  openNowPlayingOnPlay: LOOK_DEFAULTS.openNowPlayingOnPlay,
  nativeEngine: loadEngine(),
  setProfile: (id) => {
    const s = slice(id);
    set({ profileId: id, zoom: s.zoom, openNowPlayingOnPlay: s.openNowPlayingOnPlay });
  },
  setZoom: (z) => {
    const zoom = clampZoom(z);
    const { profileId } = get();
    if (profileId != null) writeLook(profileId, { ...slice(profileId), zoom });
    set({ zoom });
  },
  setOpenNowPlayingOnPlay: (v) => {
    const { profileId } = get();
    if (profileId != null)
      writeLook(profileId, { ...slice(profileId), openNowPlayingOnPlay: v });
    set({ openNowPlayingOnPlay: v });
  },
  setNativeEngine: (v) => {
    saveEngine(v);
    set({ nativeEngine: v });
  },
  reset: () => {
    const { profileId } = get();
    if (profileId != null) writeLook(profileId, { ...LOOK_DEFAULTS });
    set({ zoom: LOOK_DEFAULTS.zoom, openNowPlayingOnPlay: LOOK_DEFAULTS.openNowPlayingOnPlay });
  },
}));

/**
 * Push the zoom factor to the WebView. Needs the `webview:allow-set-webview-zoom`
 * capability (granted in the app shell) — until the app is rebuilt with it, or
 * when running outside Tauri, this is a harmless no-op, so the Appearance
 * setting still persists and simply takes effect on the next build.
 */
export async function applyZoom(zoom: number): Promise<void> {
  try {
    await getCurrentWebviewWindow().setZoom(clampZoom(zoom));
  } catch {
    /* capability not granted yet, or not running in Tauri — no-op */
  }
}
