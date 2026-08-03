import type { SearchTrackResult, StreamTrack, StatTrack } from './api';

/**
 * Assemble the `SearchTrackResult` shape the add-to-playlist picker + resolve
 * flow consume, from a track row. Previously open-coded 6 times across desktop
 * and phone with subtle drift; this is the one place the 14-field shape lives.
 *
 * `source`/`source_id` drive the host's LINK-vs-insert contract (source 'local'
 * links the existing library row by id; other sources upsert), and
 * `in_playlist_ids` seeds the picker's pre-checked rows — both are behavior-
 * bearing, so callers pass them explicitly. `local_track_id` is always the row
 * id; `preview_url`/`explicit` are always null/false for a library row.
 */
export function buildSearchTrackResult(f: {
  source: string;
  id: number;
  title: string;
  artists: string[];
  album: string | null;
  album_art_url: string | null;
  duration_ms: number;
  isrc: string | null;
  has_audio: boolean;
  in_playlist_ids: number[];
}): SearchTrackResult {
  return {
    source: f.source,
    source_id: String(f.id),
    title: f.title,
    artists: f.artists,
    album: f.album,
    album_art_url: f.album_art_url,
    duration_ms: f.duration_ms,
    isrc: f.isrc,
    local_track_id: f.id,
    in_playlist_ids: f.in_playlist_ids,
    has_audio: f.has_audio,
    preview_url: null,
    explicit: false,
  };
}

/** Now-playing `StreamTrack` → `SearchTrackResult` (a local library row:
 *  `source: 'local'` + `source_id` = the id makes the host LINK it rather than
 *  insert a duplicate). Membership is filled in by the picker on open. */
export function streamToSearchResult(t: StreamTrack): SearchTrackResult {
  return buildSearchTrackResult({
    source: 'local',
    id: t.id,
    title: t.title,
    artists: t.artists,
    album: t.album ?? null,
    album_art_url: t.album_art_url ?? null,
    duration_ms: t.duration_ms,
    isrc: null,
    has_audio: t.has_audio,
    in_playlist_ids: [],
  });
}

/** Play-log `StatTrack` → `SearchTrackResult`, flagged local so it plays from
 *  the library. Single-arg by design: it's used as `.map(statToTrack)`. */
export function statToTrack(t: StatTrack): SearchTrackResult {
  return buildSearchTrackResult({
    source: 'local',
    id: t.track_id,
    title: t.title,
    artists: t.artists,
    album: t.album,
    album_art_url: t.album_art_url,
    duration_ms: t.duration_ms,
    isrc: null,
    // Only history tracks with an imported audio file are playable; the player
    // gates play on has_audio.
    has_audio: t.has_audio ?? false,
    in_playlist_ids: [],
  });
}
