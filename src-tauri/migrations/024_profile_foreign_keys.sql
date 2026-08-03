-- fk:rebuild
--
-- Foreign keys from every profile-scoped table to profiles(id), so the DELETION
-- GUARANTEE lives in the data layer: any way a profile row dies — today's
-- profiles::delete(), some future code path, a stray tool writing to the file —
-- its playlists, listening history, bans and saved items die with it, and its
-- paired devices forget who they were (but stay paired; the device belongs to
-- the household, not the person).
--
-- The `-- fk:rebuild` marker on line 1 makes the runner execute this file with
-- foreign keys OFF and run PRAGMA foreign_key_check before committing. That is
-- load-bearing, not ceremony: rebuilding `playlists` with enforcement on fires
-- playlist_tracks' existing ON DELETE CASCADE when the old table drops, which
-- (verified against a copy of a real library) silently empties every playlist.
--
-- NOT covered here, on purpose:
--   * home_impressions — it stores profile_id 0 as the "no profile" sentinel,
--     which a foreign key would reject on every write. profiles::delete() sweeps
--     it, and the schema-driven test in profiles/mod.rs holds that sweep to
--     every profile_id table it finds.
--   * future tables — a foreign key only exists if its author writes one. The
--     same schema-driven test is what catches the table whose author forgot.

-- ---------------------------------------------------------------------------
-- 1. Orphan cleanup. Rows pointing at profiles that no longer exist predate the
--    delete() sweep (PR #39); they would fail foreign_key_check below. With
--    foreign keys off nothing cascades, so playlist contents go by hand first.
-- ---------------------------------------------------------------------------

DELETE FROM playlist_tracks WHERE playlist_id IN (
    SELECT id FROM playlists
    WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles)
);
DELETE FROM playlists
WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles);

DELETE FROM play_events
WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles);

DELETE FROM artist_bans
WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles);

DELETE FROM profile_kv
WHERE profile_id NOT IN (SELECT id FROM profiles);

-- No FK is added to home_impressions, but the cleanup is free while we're here.
-- profile_id 0 is the no-profile sentinel, not an orphan.
DELETE FROM home_impressions
WHERE profile_id <> 0 AND profile_id NOT IN (SELECT id FROM profiles);

UPDATE streaming_sessions SET profile_id = NULL
WHERE profile_id IS NOT NULL AND profile_id NOT IN (SELECT id FROM profiles);

-- ---------------------------------------------------------------------------
-- 2. Rebuilds. SQLite can't ALTER a foreign key onto an existing column, so:
--    create the table again with the clause, copy, drop, rename, re-create the
--    named indexes. Explicit column lists everywhere — the live tables carry
--    ALTER-appended columns in a different order than a fresh build would.
-- ---------------------------------------------------------------------------

-- playlists — CASCADE. (playlist_tracks references THIS table; it survives the
-- drop because enforcement is off, and its REFERENCES clause resolves by name
-- to the replacement after the rename.)
CREATE TABLE playlists_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spotify_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner TEXT,
  description TEXT,
  cover_url TEXT,
  track_count INTEGER NOT NULL,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE
);
INSERT INTO playlists_new
    (id, spotify_id, name, owner, description, cover_url, track_count,
     last_synced_at, created_at, profile_id)
SELECT id, spotify_id, name, owner, description, cover_url, track_count,
       last_synced_at, created_at, profile_id
FROM playlists;
DROP TABLE playlists;
ALTER TABLE playlists_new RENAME TO playlists;
CREATE INDEX idx_playlists_profile ON playlists(profile_id);

-- play_events — CASCADE, preserving the existing tracks(id) cascade.
CREATE TABLE play_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  ms_played INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO play_events_new (id, track_id, profile_id, played_at, ms_played, completed)
SELECT id, track_id, profile_id, played_at, ms_played, completed
FROM play_events;
DROP TABLE play_events;
ALTER TABLE play_events_new RENAME TO play_events;
CREATE INDEX idx_play_events_profile_time ON play_events(profile_id, played_at);
CREATE INDEX idx_play_events_track ON play_events(track_id);

-- artist_bans — CASCADE. profile_id stays nullable (NULL = the no-profile mode;
-- foreign keys ignore NULLs, so that path is untouched).
CREATE TABLE artist_bans_new (
    profile_id  INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
    artist_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (profile_id, artist_key)
);
INSERT INTO artist_bans_new (profile_id, artist_key, created_at)
SELECT profile_id, artist_key, created_at
FROM artist_bans;
DROP TABLE artist_bans;
ALTER TABLE artist_bans_new RENAME TO artist_bans;

-- profile_kv — CASCADE.
CREATE TABLE profile_kv_new (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  PRIMARY KEY (profile_id, key)
);
INSERT INTO profile_kv_new (profile_id, key, value)
SELECT profile_id, key, value
FROM profile_kv;
DROP TABLE profile_kv;
ALTER TABLE profile_kv_new RENAME TO profile_kv;

-- streaming_sessions — SET NULL, not CASCADE: the paired device keeps its
-- pairing and drops back to "Who's listening?", instead of a family member
-- being forced to re-pair with a code over someone else's deletion.
CREATE TABLE streaming_sessions_new (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  paired_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  revoked_at INTEGER,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL
);
INSERT INTO streaming_sessions_new
    (id, token_sha256, device_label, ip_address, user_agent, paired_at,
     last_seen_at, revoked_at, profile_id)
SELECT id, token_sha256, device_label, ip_address, user_agent, paired_at,
       last_seen_at, revoked_at, profile_id
FROM streaming_sessions;
DROP TABLE streaming_sessions;
ALTER TABLE streaming_sessions_new RENAME TO streaming_sessions;
CREATE INDEX idx_streaming_sessions_token ON streaming_sessions(token_sha256);
