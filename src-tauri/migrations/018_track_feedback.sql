-- P15: explicit negative feedback — permanently stop recommending an artist for
-- a profile. Keyed by the normalized artist key (accent-folded + lowercased,
-- matching `norm_artist`), so a ban matches across name variants. profile_id
-- NULL is the no-profile default. Bans are additive (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS artist_bans (
    profile_id  INTEGER,
    artist_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (profile_id, artist_key)
);
