-- Phase 3: per-track release year + coarse genre bucket, powering Home's
-- Decade Mixes and Genre Mixes. Both are nullable and stay NULL until the
-- auto-enrich pass backfills them from Spotify (album.release_date for the
-- year; the track's artists' Spotify genres, folded to a coarse bucket, for
-- the genre). Indexed because the mix builders GROUP BY them.
ALTER TABLE tracks ADD COLUMN release_year INTEGER;
ALTER TABLE tracks ADD COLUMN genre TEXT;
CREATE INDEX IF NOT EXISTS idx_tracks_release_year ON tracks(release_year);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
