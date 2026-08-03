-- 022: drop orphaned / write-only schema.
--
-- `spotify_account` stored plaintext OAuth tokens for a Spotify-account-sync
-- feature that no longer exists (playlists arrive via one-time import); it has
-- zero readers or writers in the app. The four columns below are written but
-- never read anywhere.

DROP TABLE IF EXISTS spotify_account;

-- `locally_added` is indexed (idx_playlist_tracks_local, from migration 005);
-- SQLite refuses DROP COLUMN on an indexed column, so drop the index first.
DROP INDEX IF EXISTS idx_playlist_tracks_local;
ALTER TABLE playlist_tracks DROP COLUMN locally_added;

ALTER TABLE playlists DROP COLUMN cover_local_path;
ALTER TABLE playlists DROP COLUMN snapshot_id;
ALTER TABLE tracks    DROP COLUMN retry_count;
