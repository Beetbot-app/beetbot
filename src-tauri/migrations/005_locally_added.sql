-- Phase 6 (web search → add to playlist).
--
-- The user can search Spotify's catalog from the web player and add tracks
-- to existing playlists. Those tracks are persisted only locally — we don't
-- have playlist-modify-* OAuth scopes, so the change doesn't propagate back
-- to Spotify.
--
-- Without a marker, the next sync would wipe them: sync_one_playlist() does
-- a blanket `DELETE FROM playlist_tracks WHERE playlist_id = ?` before
-- rewriting the tracklist from Spotify's response. Tag locally-added rows
-- so sync can skip them during the delete, then re-position them at the
-- tail of the playlist after the Spotify rows land.

ALTER TABLE playlist_tracks
  ADD COLUMN locally_added INTEGER NOT NULL DEFAULT 0;

-- Optional index for the sync-side query `WHERE playlist_id=? AND locally_added=1`.
-- Tiny table in the common case but cheap insurance for users with big libraries.
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_local
  ON playlist_tracks(playlist_id, locally_added);
