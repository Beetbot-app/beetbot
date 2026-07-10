-- Netflix-style user profiles.
--
-- The music library stays SHARED: tracks and the downloaded files on disk are
-- never per-profile. Profiles only own *playlists* (via playlists.profile_id),
-- so if two profiles both have a song it's still one row and one download.
--
-- PIN is optional (NULL pin_hash = no lock). When set it's a salted SHA-256
-- hash; the plaintext PIN is never stored. This is casual privacy on a shared
-- device, not high-security auth (a 4-digit PIN is brute-forceable regardless).
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- Hex colour for the Netflix-style avatar tile (UI picks an initial/emoji).
  avatar_color TEXT NOT NULL DEFAULT '#1db954',
  pin_hash TEXT,
  pin_salt TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Ownership link. Plain column (no FK) so we control deletion explicitly in
-- code (reassign / cascade) rather than relying on ON DELETE behaviour.
-- NULL only transiently during this migration before the backfill below.
ALTER TABLE playlists ADD COLUMN profile_id INTEGER;

-- Seed a default profile and assign the entire existing library to it, so the
-- current user's playlists are intact under the first profile. The UI lets
-- this profile be renamed.
INSERT INTO profiles (id, name, avatar_color) VALUES (1, 'Me', '#1db954');
UPDATE playlists SET profile_id = 1 WHERE profile_id IS NULL;

CREATE INDEX idx_playlists_profile ON playlists(profile_id);
