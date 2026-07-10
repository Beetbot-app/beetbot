-- Per-play log that powers the listening-stats / "Wrapped" screen.
-- One row each time a track is listened to past a small threshold. Kept
-- entirely local (no cloud), scoped by profile so each user sees their own.
CREATE TABLE play_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  profile_id INTEGER,
  played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_play_events_profile_time ON play_events(profile_id, played_at);
CREATE INDEX idx_play_events_track ON play_events(track_id);
