-- Initial schema: playlists, tracks, and the join table. Later features
-- (streaming_sessions, profiles, …) add their own migrations as they land.

-- Single-user Spotify identity. The CHECK clamps it to one row.
CREATE TABLE spotify_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spotify_user_id TEXT NOT NULL,
  display_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spotify_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner TEXT,
  description TEXT,
  cover_url TEXT,
  cover_local_path TEXT,
  snapshot_id TEXT NOT NULL,
  track_count INTEGER NOT NULL,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spotify_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artists TEXT NOT NULL,                       -- JSON array of strings
  album TEXT,
  album_art_url TEXT,
  duration_ms INTEGER NOT NULL,
  isrc TEXT,

  -- How this track got its local audio, e.g. 'manual-file'.
  match_method TEXT,

  -- Local file
  local_path TEXT,
  file_size_bytes INTEGER,
  audio_format TEXT,
  downloaded_at INTEGER,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | downloaded | needs-review | failed | skipped
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_tracks_status ON tracks(status);

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at INTEGER,
  PRIMARY KEY (playlist_id, position)
);

CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
