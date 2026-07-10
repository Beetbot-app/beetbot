-- Phase 1 (discovery / Signal 3): rich per-artist Last.fm tags for "more like
-- this vibe" similarity. Kept SEPARATE from the coarse `tracks.genre` bucket so
-- the existing (Deezer-filled) genre mixes are untouched.

-- Top weighted tags per (normalized) primary artist name.
CREATE TABLE IF NOT EXISTS artist_tags (
    artist_key TEXT NOT NULL,    -- normalized primary artist (lowercase, ws-collapsed)
    tag        TEXT NOT NULL,    -- lowercased Last.fm tag, e.g. "shoegaze"
    weight     INTEGER NOT NULL, -- Last.fm tag count 0-100 (higher = stronger)
    PRIMARY KEY (artist_key, tag)
);
CREATE INDEX IF NOT EXISTS idx_artist_tags_tag ON artist_tags(tag);

-- One row per artist we've looked up (INCLUDING artists Last.fm had no tags
-- for), so the enrich sweep is incremental and never re-queries an artist.
CREATE TABLE IF NOT EXISTS artist_tags_fetched (
    artist_key  TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,   -- display name as first seen (for radio lookups)
    fetched_at  INTEGER NOT NULL
);
