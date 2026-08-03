-- Bind a profile to a signed-in person, so somebody the owner shared this
-- server with gets their own account rather than landing in whichever profile
-- happened to be selected.
--
-- Deliberately provider-agnostic: `identity_provider` is a string the host build
-- supplies, so nothing in the open core names a service. NULL in all three
-- columns is the ordinary local profile — the family-on-one-Mac case — and it
-- stays exactly as it was.
--
-- The unique index is the important part: it is what makes "get or create the
-- profile for this person" idempotent, so a visitor's second request reuses the
-- account their first request created instead of minting a new one per page load.
ALTER TABLE profiles ADD COLUMN identity_provider TEXT;
ALTER TABLE profiles ADD COLUMN identity_sub TEXT;
ALTER TABLE profiles ADD COLUMN identity_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_identity
  ON profiles (identity_provider, identity_sub)
  WHERE identity_sub IS NOT NULL;
