-- Phase 2: per-profile Spotify accounts.
--
-- `spotify_account` was a singleton (id PRIMARY KEY CHECK (id = 1)). Re-key it
-- by profile_id so each user profile can connect its own Spotify account. The
-- existing connected account (if any) moves to the default profile.
--
-- SQLite can't drop a CHECK constraint in place, so we rebuild the table.
CREATE TABLE spotify_account_new (
  profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  spotify_user_id TEXT NOT NULL,
  display_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Carry the existing single account over to the default (oldest) profile.
INSERT INTO spotify_account_new
    (profile_id, spotify_user_id, display_name, access_token, refresh_token,
     token_expires_at, updated_at)
SELECT (SELECT COALESCE(MIN(id), 1) FROM profiles),
       spotify_user_id, display_name, access_token, refresh_token,
       token_expires_at, updated_at
FROM spotify_account;

DROP TABLE spotify_account;
ALTER TABLE spotify_account_new RENAME TO spotify_account;
