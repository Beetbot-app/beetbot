import { useMemo } from 'react';
import { isPinned, usePinStore } from '@/lib/pins';
import { isArtistSaved, useSavedStore } from '@/lib/saved';
import type {
  SidebarPinController,
  SavedArtistController,
} from '@shared/components/SearchScreen';

// Desktop-only controllers that light up the Pin + Save buttons on the shared
// artist / album / playlist / mix detail pages. Extracted so every host (Search,
// Home, Browse, Playlist) wires them identically — the buttons then appear on a
// detail page no matter where it was opened from. The phone omits these (no
// pinned sidebar), so those buttons simply don't render there.

/** Sidebar "Pin to sidebar" controls for artist + album headers. */
export function useSidebarPinController(): SidebarPinController {
  const pins = usePinStore((s) => s.pins);
  const togglePin = usePinStore((s) => s.toggle);
  return useMemo(
    () => ({
      isArtistPinned: (name) =>
        isPinned(pins, { kind: 'artist', key: name, name, art: null }),
      toggleArtist: (a) => togglePin({ kind: 'artist', ...a }),
      isAlbumPinned: (album, artist) =>
        isPinned(pins, { kind: 'album', album, artist, art: null }),
      toggleAlbum: (a) => togglePin({ kind: 'album', ...a }),
    }),
    [pins, togglePin],
  );
}

/** "Save artist to library" control for the artist header (Library › Artists). */
export function useSavedArtistController(): SavedArtistController {
  const savedArtists = useSavedStore((s) => s.artists);
  const toggleSaved = useSavedStore((s) => s.toggleArtist);
  return useMemo(
    () => ({
      isSaved: (name) => isArtistSaved(savedArtists, name),
      toggle: (a) => toggleSaved(a),
    }),
    [savedArtists, toggleSaved],
  );
}
