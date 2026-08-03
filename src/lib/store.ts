import { canLiveStream } from '@shared/api';
import {
  createPlayerStore,
  currentTrackOf,
  type PlayerState,
} from '@shared/playerStore';
import type { PlaylistTrack } from '@/lib/tauri';

export type { RepeatMode } from '@shared/playerStore';

/// A track is playable iff it has a local audio file: a `local_path` on this
/// device, OR status 'downloaded' — a catalog/handed-off row built for the
/// queue with no in-memory local_path, whose file the hub still has and
/// streams by id via /stream/{id}. On the full build ANY track is also playable:
/// the engine resolves (matching on the fly if needed) + remuxes its source on
/// demand via /stream/{id}/live. Only the open build (no engine) gates on a file.
export function canStream(t: PlaylistTrack): boolean {
  // `t.id > 0` guards the catalog rows that failed to resolve to a library id
  // (sentinel id 0) — those can't be streamed even on the full build. The
  // title guard drops corrupt metadata-less rows: the engine matches by
  // title+artist, so an empty title can never live-resolve — offering it as
  // playable just produces a silent failed stream.
  return (
    t.local_path != null ||
    t.status === 'downloaded' ||
    (canLiveStream() && t.id > 0 && t.title.trim() !== '')
  );
}

// The desktop (Tauri WebView) player store. The Tauri WebView has its own
// localStorage that persists across app restarts, so this picks up the same
// queue / position on next launch. All behavior lives in the shared factory;
// this build only injects its track type, playability rule, and persist key.
export const usePlayerStore = createPlayerStore<PlaylistTrack>({
  canStream,
  // Bumping the suffix would reset everyone's persisted state.
  persistName: 'beetbot.desktop.player-v1',
  // v1 → v2 flipped a persisted 'all' repeat to 'off' (see shared migrate).
  persistVersion: 2,
  persistVolume: true,
});

export function currentTrack(
  state: PlayerState<PlaylistTrack>,
): PlaylistTrack | undefined {
  return currentTrackOf(state);
}
