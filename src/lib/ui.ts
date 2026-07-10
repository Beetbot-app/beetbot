import { create } from 'zustand';

// Global UI chrome state for the two now-playing surfaces:
//  - the FULL-window "Now Playing" view (Apple Music-style), opened by clicking
//    the player-bar artwork; it takes over the whole app (no sidebar / top bar /
//    player bar) and carries its own transport.
//  - a docked RIGHT BAR for quick Lyrics / Up-next, opened by the player-bar
//    lyrics / queue buttons; the rest of the app stays visible.
// Neither is persisted — you shouldn't launch into them.

export type NowPlayingTab = 'lyrics' | 'queue';
export type RightBar = 'closed' | 'lyrics' | 'queue';

interface UiState {
  // Full-window now playing.
  nowPlayingFull: boolean;
  nowPlayingTab: NowPlayingTab;
  openFullNowPlaying: (tab?: NowPlayingTab) => void;
  toggleFullNowPlaying: () => void;
  closeFullNowPlaying: () => void;
  setNowPlayingTab: (tab: NowPlayingTab) => void;
  // Docked right bar.
  rightBar: RightBar;
  toggleRightBar: (tab: 'lyrics' | 'queue') => void;
  setRightBar: (tab: RightBar) => void;
  closeRightBar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  nowPlayingFull: false,
  nowPlayingTab: 'lyrics',
  openFullNowPlaying: (tab) =>
    set((s) => ({ nowPlayingFull: true, nowPlayingTab: tab ?? s.nowPlayingTab })),
  toggleFullNowPlaying: () => set((s) => ({ nowPlayingFull: !s.nowPlayingFull })),
  closeFullNowPlaying: () => set({ nowPlayingFull: false }),
  setNowPlayingTab: (tab) => set({ nowPlayingTab: tab }),

  rightBar: 'closed',
  toggleRightBar: (tab) =>
    set((s) => ({ rightBar: s.rightBar === tab ? 'closed' : tab })),
  setRightBar: (tab) => set({ rightBar: tab }),
  closeRightBar: () => set({ rightBar: 'closed' }),
}));
