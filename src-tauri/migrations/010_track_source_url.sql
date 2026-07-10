-- The original web link a track was imported from (e.g. a SoundCloud track),
-- kept alongside its metadata. NULL for tracks imported without one.
ALTER TABLE tracks ADD COLUMN source_url TEXT;
