import { create } from 'zustand';
import { isPlayable, type StreamTrack, type CatalogOpenRequest } from '@shared/api';
import {
  createPlayerStore,
  currentTrackOf,
  type PlayerState,
} from '@shared/playerStore';

/** Playable iff the hub has an audio file (`has_audio`) OR, on the full build,
 *  the track is matched to a source the hub can stream on demand via
 *  `/stream/{id}/live`. Unmatched tracks aren't playable from the phone.
 *
 *  A `failed` status is a recorded dead end: a prior match found no source, so
 *  it would only 404-skip. Treat it as unplayable so the library dims it and a
 *  freshly-built queue drops it, instead of queueing a guaranteed skip. */
export function canStream(t: StreamTrack): boolean {
  return t.status !== 'failed' && isPlayable(t);
}

// The phone (PWA) player store. Operates on `StreamTrack` rows from the REST
// API instead of `PlaylistTrack` from Tauri IPC; all behavior lives in the
// shared factory. The persisted key/version are kept stable so an upgrade never
// resets anyone's queue. Volume isn't persisted — the phone uses OS volume.
export const usePlayerStore = createPlayerStore<StreamTrack>({
  canStream,
  persistName: 'beetbot.player-v1',
  persistVersion: 1,
});

export function currentTrack(
  state: PlayerState<StreamTrack>,
): StreamTrack | undefined {
  return currentTrackOf(state);
}

/**
 * Phone-side catalog navigation. Things rendered OUTSIDE a screen (the Now
 * Playing overlay's "Go to artist / album") write an open-request here; App
 * watches it, switches to the Search tab, and hands the request to
 * SearchScreen, which resolves the name to a catalog hit and drills into the
 * artist/album modal. Mirrors the desktop's useNavStore (src/lib/nav.ts).
 */
interface CatalogNavState {
  request: CatalogOpenRequest | null;
  openArtist: (name: string) => void;
  openAlbum: (name: string, artist?: string | null) => void;
  clear: () => void;
}

export const useCatalogNav = create<CatalogNavState>((set) => ({
  request: null,
  openArtist: (name) => set({ request: { kind: 'artist', name } }),
  openAlbum: (name, artist) =>
    set({ request: { kind: 'album', name, artist: artist ?? null } }),
  clear: () => set({ request: null }),
}));
