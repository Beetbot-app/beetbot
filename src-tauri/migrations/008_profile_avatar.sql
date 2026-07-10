-- Optional custom profile photo. NULL = use the colour + initial tile.
-- Stores an absolute path to an image copied into
-- <app_data>/library/avatars/ (kept inside the asset-protocol scope so the
-- desktop can render it via convertFileSrc, and the phone via
-- GET /api/profiles/{id}/avatar).
ALTER TABLE profiles ADD COLUMN avatar_path TEXT;
