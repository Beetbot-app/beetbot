-- Small per-profile key/value store for cross-device UI state. First user:
-- the desktop sidebar pins ("sidebar_pins"), so pins survive reinstalls and
-- sync across a profile's devices. Values are opaque JSON strings owned by
-- the client; the server only stores and returns them verbatim.
CREATE TABLE IF NOT EXISTS profile_kv (
  profile_id INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  PRIMARY KEY (profile_id, key)
);
