-- Weekly (ISO-week) cache of the per-artist discovery candidate fan-out.
--
-- gather_candidates() turns ONE seed artist into its candidate tracks by fanning
-- out ~15-20 keyless calls (Last.fm similar artists/tracks, ListenBrainz similar,
-- Deezer top/radio/related + per-neighbour track resolution). That fan-out is the
-- ~14s cold cost behind "My station" and the Home discovery shelves. Since "who
-- sounds like X" barely changes week to week, we memoise the whole 4-list result
-- per (artist, ISO-week): repeat builds within the week skip the fan-out, and the
-- key turns over every Monday (in sync with the app's "New every Monday" cadence).
--
-- Pre-ban / pre-rank: ranking, novelty/MMR and "don't recommend" bans are applied
-- on READ (in fuse_rank), so this only memoises the expensive FETCH — a ban still
-- takes effect immediately without waiting for the week to roll over. Rows for
-- prior weeks are pruned on write, so the table stays bounded to the current week.
CREATE TABLE IF NOT EXISTS artist_candidate_cache (
    artist_norm TEXT    NOT NULL,   -- norm_artist(seed) — case/punct-folded key
    iso_week    TEXT    NOT NULL,   -- e.g. "2026-W28" (local %G-W%V)
    candidates  TEXT    NOT NULL,   -- JSON: [Vec<TrackHit>; 4] (the 4 source lists)
    fetched_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (artist_norm, iso_week)
);
