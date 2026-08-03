import { useEffect } from 'react';
import { create } from 'zustand';
import { ipc } from './tauri';

/**
 * This build's runtime capabilities, resolved once from `app_capabilities` and
 * cached so on-demand code (a right-click menu builder) can read them
 * synchronously. The open-core build lacks the command, so everything stays
 * `false` and the capability-gated UI (streaming, downloading) never appears.
 */
interface CapabilitiesState {
  streamingPlayback: boolean;
  canDownload: boolean;
  resolved: boolean;
  resolve: () => Promise<void>;
}

export const useCapabilitiesStore = create<CapabilitiesState>((set, get) => ({
  streamingPlayback: false,
  canDownload: false,
  resolved: false,
  resolve: async () => {
    if (get().resolved) return;
    try {
      const caps = await ipc.appCapabilities();
      set({
        streamingPlayback: caps.streamingPlayback,
        canDownload: caps.canDownload,
        resolved: true,
      });
    } catch {
      set({ resolved: true }); // leave the safe `false` defaults
    }
  },
}));

/** Resolve capabilities once. Call from the desktop app root. */
export function useResolveCapabilities(): void {
  const resolve = useCapabilitiesStore((s) => s.resolve);
  useEffect(() => {
    void resolve();
  }, [resolve]);
}

/** True when this build can save catalog tracks as permanent local files. */
export function useCanDownload(): boolean {
  return useCapabilitiesStore((s) => s.canDownload);
}
