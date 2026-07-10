import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Desktop appearance preferences — how the app *looks*, persisted per install
 * (not per profile). Kept separate from the player store so a taste change
 * never touches playback state.
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

interface AppearanceState {
  /** Webview zoom factor (1 = 100%). */
  zoom: number;
  setZoom: (z: number) => void;
  /** Open the full Now Playing view automatically when a new song starts. */
  openNowPlayingOnPlay: boolean;
  setOpenNowPlayingOnPlay: (v: boolean) => void;
  /** Restore appearance defaults (zoom 100%, no auto-open). */
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      zoom: 1,
      setZoom: (z) => set({ zoom: clampZoom(z) }),
      openNowPlayingOnPlay: false,
      setOpenNowPlayingOnPlay: (v) => set({ openNowPlayingOnPlay: v }),
      reset: () => set({ zoom: 1, openNowPlayingOnPlay: false }),
    }),
    {
      name: 'beetbot.desktop.appearance',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

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
