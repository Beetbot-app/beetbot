-- N0: Home impression memory. One row per (profile, discovery item) the Home
-- feed has SERVED, so selection can later fade recommendations the user keeps
-- ignoring (impression discounting) instead of re-showing them forever.
--
-- `shown_days` counts calendar DAYS the item appeared (bumped at most once per
-- day at serve time), not raw requests — refreshes don't inflate fatigue.
-- `item_kind` ∈ 'track' | 'album' | 'artist' | 'playlist'; `item_key` is the
-- kind-scoped stable key ("{source}:{source_id}", artists by normalized name).
-- `profile_id` stores 0 for the no-profile default: the serve-time upsert
-- relies on ON CONFLICT, and SQLite treats NULLs as distinct in unique
-- indexes, so a nullable column would never conflict.
CREATE TABLE IF NOT EXISTS home_impressions (
    profile_id  INTEGER NOT NULL,
    item_kind   TEXT    NOT NULL,
    item_key    TEXT    NOT NULL,
    first_shown TEXT    NOT NULL, -- local date, YYYY-MM-DD
    last_shown  TEXT    NOT NULL, -- local date, YYYY-MM-DD
    shown_days  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (profile_id, item_kind, item_key)
);
