import { create } from 'zustand';
import { ensureSession, getLikedTrackIds, setTrackLiked } from '@shared/api';
import { notifyLibraryChanged } from '@shared/libraryChanged';

/**
 * Shared "Favorites" (liked) state for the desktop. Both the mini player bar and
 * the full Now Playing view read + toggle the star through this one store, so a
 * like made in either surface is reflected in the other immediately (the full
 * view covers the bar, so they'd otherwise drift out of sync). The store owns
 * the session token (via ensureSession) so callers only pass the profile id.
 */
interface LikesState {
  likedIds: Set<number>;
  /** Reload the liked-track set for the active profile. */
  refresh: (profileId?: number | null) => Promise<void>;
  /** Optimistically flip a track's liked state and persist it (reverts on error). */
  toggle: (trackId: number, profileId?: number | null) => Promise<void>;
}

export const useLikesStore = create<LikesState>((set, get) => ({
  likedIds: new Set(),

  refresh: async (profileId) => {
    try {
      const token = await ensureSession();
      const ids = await getLikedTrackIds(token, profileId);
      set({ likedIds: ids });
    } catch {
      // Keep the prior set on a transient failure.
    }
  },

  toggle: async (trackId, profileId) => {
    const next = !get().likedIds.has(trackId);
    set((s) => {
      const ids = new Set(s.likedIds);
      if (next) ids.add(trackId);
      else ids.delete(trackId);
      return { likedIds: ids };
    });
    try {
      const token = await ensureSession();
      await setTrackLiked(token, trackId, next, profileId);
      // The FIRST like creates the Favorites (Liked Songs) playlist server-side,
      // and later toggles change its track count. The sidebar only refetches its
      // playlist list on this event, so without it a brand-new account's star
      // fills but "Favorites" doesn't appear in the sidebar until a navigation.
      notifyLibraryChanged();
    } catch {
      // Reconcile with the server's truth rather than reverting to the captured
      // `next` — robust against interleaved taps that would leave a stale value.
      await get().refresh(profileId);
    }
  },
}));
