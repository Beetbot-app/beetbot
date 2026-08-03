import { create } from 'zustand';
import {
  ensureSession,
  resolveCatalogTrack,
  type SearchTrackResult,
} from '@shared/api';
import { ipc, type PlaylistTrack } from '@/lib/tauri';

/**
 * The "Add audio file" flow, callable from any desktop surface (the now-playing
 * bar, the full Now Playing view, an album page). Holds the library track whose
 * CandidatesModal is open — the modal itself is rendered ONCE at the App root, so
 * every surface just asks this store to open it instead of each rendering its own.
 *
 * A catalog search result (album row, search hit) has no library row yet, so
 * `openForCatalog` resolves it to one first (the same ISRC-deduped upsert "add to
 * playlist" uses), then loads the real row the modal + import command need. A
 * track already in the library (playing, in a playlist) skips straight through
 * `openForTrack`. Desktop only — the phone can't attach files.
 */
interface AddAudioState {
  /** The library track whose "Add audio file" modal is open; null = closed. */
  track: PlaylistTrack | null;
  /** Open the modal for a library track we already hold in full. */
  openForTrack: (t: PlaylistTrack) => void;
  /** Open the modal for a catalog result — resolve it to a library row first. */
  openForCatalog: (t: SearchTrackResult) => Promise<void>;
  clear: () => void;
}

export const useAddAudio = create<AddAudioState>((set) => ({
  track: null,
  openForTrack: (t) => set({ track: t }),
  openForCatalog: async (t) => {
    try {
      const token = await ensureSession();
      const id =
        t.local_track_id ?? (await resolveCatalogTrack(t, token)).track_id;
      const full = await ipc.getTrack(id);
      if (full) set({ track: full });
    } catch {
      /* a failed resolve just leaves the modal closed — no worse than before */
    }
  },
  clear: () => set({ track: null }),
}));
