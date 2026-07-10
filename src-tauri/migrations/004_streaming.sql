-- Phase 4, step 14: LAN streaming server bookkeeping.
--
-- streaming_sessions is the per-device token registry. Tokens are random
-- 32-byte base64url strings; we don't store them (the device keeps the
-- only copy) -- only their SHA-256 fingerprint so a token leak in this
-- table is non-recoverable, and only the device that actually holds the
-- raw token can re-present it.
--
-- IP and user_agent are stored verbatim for the Devices page; revoked_at
-- being non-null means the desktop user revoked this session.

CREATE TABLE streaming_sessions (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  paired_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  revoked_at INTEGER
);

CREATE INDEX idx_streaming_sessions_token ON streaming_sessions(token_sha256);

-- Defaults for the streaming server. Per plan §7.2 streaming is OFF by
-- default so the user opts in explicitly.
INSERT INTO settings (key, value) VALUES
  ('streaming_port', '47823'),
  ('streaming_enabled', 'false'),
  ('require_pairing_code', 'false');
