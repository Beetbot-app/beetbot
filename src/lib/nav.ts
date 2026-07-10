import { create } from 'zustand';
import type { CatalogOpenRequest } from '@shared/api';

/**
 * Tiny cross-component navigation bus for "open this artist/album page".
 *
 * The now-playing PlayerBar lives at the App root, while the artist/album
 * pages are rendered deep inside the Search view (the shared SearchScreen
 * in `pageMode`). Rather than thread callbacks through several layers,
 * the bar drops a request here; App reacts by switching to the Search
 * view, and SearchPage hands the request to SearchScreen, which resolves
 * the name to a Deezer hit and drills in. SearchScreen clears it when done.
 */
interface NavState {
  request: CatalogOpenRequest | null;
  /** Open the artist page for the given artist name. */
  openArtist: (name: string) => void;
  /** Open the album page for the given album name (artist disambiguates). */
  openAlbum: (name: string, artist?: string | null) => void;
  /** Consumed-handler: clears the pending request. */
  clear: () => void;
}

export const useNavStore = create<NavState>((set) => ({
  request: null,
  openArtist: (name) => set({ request: { kind: 'artist', name } }),
  openAlbum: (name, artist) =>
    set({ request: { kind: 'album', name, artist: artist ?? null } }),
  clear: () => set({ request: null }),
}));
