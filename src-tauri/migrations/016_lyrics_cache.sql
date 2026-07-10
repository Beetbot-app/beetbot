-- Persistent LRCLIB lyrics cache. Survives app restarts so a track is fetched
-- from LRCLIB at most once ever. `found` distinguishes a real result (1) from a
-- confirmed "no lyrics" (0); a transient network/timeout failure is NEVER written
-- here, so a blip can't poison the cache as a permanent miss. `fetched_at` lets a
-- confirmed miss go stale (re-checked) so lyrics LRCLIB adds later still surface.
CREATE TABLE IF NOT EXISTS lyrics_cache (
    sig          TEXT PRIMARY KEY,   -- lowercased "title|artist|album|duration"
    plain        TEXT,
    synced       TEXT,
    instrumental INTEGER NOT NULL DEFAULT 0,
    found        INTEGER NOT NULL,   -- 1 = lyrics/instrumental present, 0 = confirmed none
    fetched_at   INTEGER NOT NULL
);
