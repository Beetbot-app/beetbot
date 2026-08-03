-- Per-profile download ownership. The download FILES are shared device-wide
-- (one library/ folder), but WHO saved a track is recorded per-profile so each
-- profile's "Downloaded" view stays isolated -- one profile never sees another's
-- downloads. Kept separate from Favorites so downloads never skew recommendations.
CREATE TABLE IF NOT EXISTS profile_downloads (
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  track_id      INTEGER NOT NULL REFERENCES tracks(id)   ON DELETE CASCADE,
  downloaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (profile_id, track_id)
);

-- Backfill: attribute already-downloaded tracks to the profile(s) whose
-- playlists contain them (matches how the Downloaded tab was scoped before).
-- Tracks in no playlist stay unowned here and are cleaned up on launch.
INSERT OR IGNORE INTO profile_downloads (profile_id, track_id)
SELECT DISTINCT p.profile_id, t.id
FROM tracks t
JOIN playlist_tracks pt ON pt.track_id = t.id
JOIN playlists p ON p.id = pt.playlist_id
WHERE ((t.local_path IS NOT NULL AND t.local_path <> '') OR t.status = 'downloaded')
  AND p.profile_id IS NOT NULL;
