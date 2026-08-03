import type { PlaylistTrack } from '@/lib/tauri';
import { buildSearchTrackResult } from '@shared/trackAdapter';
import type { SearchTrackResult } from '@shared/api';

/**
 * Desktop `PlaylistTrack` → `SearchTrackResult` for the add-to-playlist picker
 * (and the resolve/patch flow). `source`, `inPlaylistIds`, and `hasAudio` are
 * per-call so each surface keeps its exact contract: the player surfaces
 * (PlayerBar / NowPlaying / Library) use `source: 'local'` + fetched membership;
 * the library playlist page uses `source: 'library'` and counts a downloaded
 * row as playable even without an in-memory local_path.
 */
export function playlistTrackToSearch(
  t: PlaylistTrack,
  opts: {
    source?: string;
    inPlaylistIds?: number[];
    hasAudio?: boolean;
  } = {},
): SearchTrackResult {
  return buildSearchTrackResult({
    source: opts.source ?? 'local',
    id: t.id,
    title: t.title,
    artists: t.artists ?? [],
    album: t.album ?? null,
    album_art_url: t.album_art_url ?? null,
    duration_ms: t.duration_ms ?? 0,
    isrc: t.isrc ?? null,
    has_audio: opts.hasAudio ?? t.local_path != null,
    in_playlist_ids: opts.inPlaylistIds ?? [],
  });
}
