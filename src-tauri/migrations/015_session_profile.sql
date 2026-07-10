-- Auth hardening (#4): bind a paired session to a profile so the SERVER is
-- authoritative about which profile a phone is acting as, instead of trusting a
-- client-supplied `profile_id` on every request. Set by POST /api/session/profile
-- after server-side PIN verification; NULL until a profile is selected. The
-- loopback owner (desktop) does not bind — it stays trusted to act as the active
-- profile via IPC.
ALTER TABLE streaming_sessions ADD COLUMN profile_id INTEGER;
