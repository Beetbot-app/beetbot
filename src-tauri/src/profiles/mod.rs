//! Netflix-style user profiles.
//!
//! Profiles own *playlists* (via `playlists.profile_id`). The music library —
//! the `tracks` table and the downloaded files on disk — is shared across all
//! profiles, so a song two profiles both have is still one row and one file.
//!
//! PIN is optional (NULL = no lock). When set it's a salted SHA-256 hash; the
//! plaintext is never stored. This is casual privacy on a shared device, not
//! cryptographic auth (a 4-digit PIN is brute-forceable regardless of hashing).

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub avatar_color: String,
    /// Absolute path to a custom profile photo, or `None` for the colour +
    /// initial tile. The desktop renders it via `convertFileSrc`; the phone
    /// uses `GET /api/profiles/{id}/avatar` when this is set.
    pub avatar_path: Option<String>,
    /// Whether a PIN is set. We never expose the hash to the frontend.
    pub has_pin: bool,
    pub created_at: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("profile {0} not found")]
    NotFound(i64),
    #[error("cannot delete the last profile")]
    LastProfile,
    #[error("name cannot be empty")]
    EmptyName,
}

fn hash_pin(pin: &str, salt: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(pin.as_bytes());
    URL_SAFE_NO_PAD.encode(h.finalize())
}

/// Build (pin_hash, pin_salt) from an optional plaintext PIN. Empty/whitespace
/// or `None` clears the PIN (both columns NULL).
fn make_pin(pin: Option<&str>) -> (Option<String>, Option<String>) {
    match pin {
        Some(p) if !p.trim().is_empty() => {
            let salt = Uuid::new_v4().to_string();
            (Some(hash_pin(p.trim(), &salt)), Some(salt))
        }
        _ => (None, None),
    }
}

fn row_to_profile(r: &rusqlite::Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        name: r.get(1)?,
        avatar_color: r.get(2)?,
        has_pin: r.get::<_, Option<String>>(3)?.is_some(),
        created_at: r.get(4)?,
        avatar_path: r.get(5)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Profile>, ProfileError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, avatar_color, pin_hash, created_at, avatar_path
         FROM profiles ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], row_to_profile)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Only the profiles that belong to this machine — the family-on-one-Mac ones,
/// with nobody signed in behind them.
///
/// This is what a device paired over the local network is shown. It pairs by
/// typing a six-digit code, which proves somebody is in the house and nothing
/// more, so it must not be handed a picker containing the accounts of people the
/// owner shared with over the internet.
pub fn list_local(conn: &Connection) -> Result<Vec<Profile>, ProfileError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, avatar_color, pin_hash, created_at, avatar_path
         FROM profiles WHERE identity_sub IS NULL ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], row_to_profile)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Whether this profile belongs to somebody signed in through a provider.
/// A local device may not select one: it is another person's account.
pub fn is_identity_bound(conn: &Connection, id: i64) -> Result<bool, ProfileError> {
    let bound: Option<String> = conn.query_row(
        "SELECT identity_sub FROM profiles WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(bound.is_some())
}

/// The default profile id (the oldest / lowest-id profile). Used to assign
/// shared-source playlists (imports) in Phase 1, where imported playlists
/// aren't yet scoped per profile. Robust against the seed profile (id 1)
/// being deleted. There is always at least one profile (delete refuses the
/// last), so this never returns 0 in practice.
pub fn default_id(conn: &Connection) -> Result<i64, ProfileError> {
    let id: i64 = conn.query_row(
        "SELECT COALESCE(MIN(id), 1) FROM profiles",
        [],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn get(conn: &Connection, id: i64) -> Result<Profile, ProfileError> {
    conn.query_row(
        "SELECT id, name, avatar_color, pin_hash, created_at, avatar_path
         FROM profiles WHERE id = ?1",
        params![id],
        row_to_profile,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => ProfileError::NotFound(id),
        other => ProfileError::Sqlite(other),
    })
}

pub fn create(
    conn: &Connection,
    name: &str,
    avatar_color: &str,
    pin: Option<&str>,
) -> Result<Profile, ProfileError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProfileError::EmptyName);
    }
    let (pin_hash, pin_salt) = make_pin(pin);
    conn.execute(
        "INSERT INTO profiles (name, avatar_color, pin_hash, pin_salt) VALUES (?1, ?2, ?3, ?4)",
        params![name, avatar_color, pin_hash, pin_salt],
    )?;
    get(conn, conn.last_insert_rowid())
}

// ---------------------------------------------------------------------------
// Profiles bound to a signed-in person
// ---------------------------------------------------------------------------

/// Palette for an auto-created profile's tile. Picked from the address so the
/// same person keeps the same colour, which is what makes a tile recognisable at
/// a glance.
const IDENTITY_COLORS: [&str; 6] = [
    "#c2410c", "#0f766e", "#7c3aed", "#b91c1c", "#1d4ed8", "#a16207",
];

fn color_for(seed: &str) -> &'static str {
    let n: usize = seed.bytes().map(|b| b as usize).sum();
    IDENTITY_COLORS[n % IDENTITY_COLORS.len()]
}

/// A display name from an email address: the part before the @, tidied up.
/// "sam.taylor@example.com" reads as "Sam Taylor" in a list of profiles, which
/// is what somebody expects to see next to their family's names.
fn name_from_email(email: &str) -> String {
    let local = email.split('@').next().unwrap_or(email).trim();
    let spaced: String = local
        .chars()
        .map(|c| if c == '.' || c == '_' || c == '-' || c == '+' { ' ' } else { c })
        .collect();
    let titled = spaced
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if titled.is_empty() {
        email.to_string()
    } else {
        titled
    }
}

/// The profile bound to this person, if there is one.
pub fn find_by_identity(
    conn: &Connection,
    provider: &str,
    sub: &str,
) -> Result<Option<Profile>, ProfileError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, avatar_color, pin_hash, created_at, avatar_path
         FROM profiles WHERE identity_provider = ?1 AND identity_sub = ?2",
    )?;
    let mut rows = stmt.query_map(params![provider, sub], row_to_profile)?;
    Ok(match rows.next() {
        Some(row) => Some(row?),
        None => None,
    })
}

/// The profile for a person who has signed in — creating it the first time.
///
/// This is what turns "somebody the owner shared with" into an account with its
/// own playlists. It is keyed on the provider's stable `sub`, never on the email:
/// people change addresses, and rebinding a whole library because somebody moved
/// house would be an unpleasant surprise. The address is stored anyway, and kept
/// current, because it is what the owner recognises in a list.
///
/// No PIN. A PIN is casual privacy between people sharing one Mac; this person is
/// somewhere else entirely, and their access is already decided by whether the
/// owner has shared with them.
pub fn ensure_for_identity(
    conn: &Connection,
    provider: &str,
    sub: &str,
    email: &str,
) -> Result<Profile, ProfileError> {
    if let Some(existing) = find_by_identity(conn, provider, sub)? {
        // Keep the address current without touching anything they have named.
        if !email.is_empty() {
            conn.execute(
                "UPDATE profiles SET identity_email = ?1 WHERE id = ?2",
                params![email, existing.id],
            )?;
        }
        return Ok(existing);
    }

    let display = if email.is_empty() {
        "Guest".to_string()
    } else {
        name_from_email(email)
    };
    conn.execute(
        "INSERT INTO profiles (name, avatar_color, identity_provider, identity_sub, identity_email)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![display, color_for(sub), provider, sub, email],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Update name + avatar colour. PIN is managed separately via [`set_pin`].
pub fn update(
    conn: &Connection,
    id: i64,
    name: &str,
    avatar_color: &str,
) -> Result<Profile, ProfileError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProfileError::EmptyName);
    }
    let n = conn.execute(
        "UPDATE profiles SET name = ?1, avatar_color = ?2 WHERE id = ?3",
        params![name, avatar_color, id],
    )?;
    if n == 0 {
        return Err(ProfileError::NotFound(id));
    }
    get(conn, id)
}

/// Set or clear a profile's PIN. `None`/empty clears it.
pub fn set_pin(conn: &Connection, id: i64, pin: Option<&str>) -> Result<(), ProfileError> {
    let (pin_hash, pin_salt) = make_pin(pin);
    let n = conn.execute(
        "UPDATE profiles SET pin_hash = ?1, pin_salt = ?2 WHERE id = ?3",
        params![pin_hash, pin_salt, id],
    )?;
    if n == 0 {
        return Err(ProfileError::NotFound(id));
    }
    Ok(())
}

/// Current custom-avatar path for a profile, if any.
pub fn avatar_path(conn: &Connection, id: i64) -> Result<Option<String>, ProfileError> {
    conn.query_row(
        "SELECT avatar_path FROM profiles WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => ProfileError::NotFound(id),
        other => ProfileError::Sqlite(other),
    })
}

/// Set or clear a profile's custom-avatar path. The caller is responsible for
/// copying / deleting the actual image file.
pub fn set_avatar(conn: &Connection, id: i64, path: Option<&str>) -> Result<(), ProfileError> {
    let n = conn.execute(
        "UPDATE profiles SET avatar_path = ?1 WHERE id = ?2",
        params![path, id],
    )?;
    if n == 0 {
        return Err(ProfileError::NotFound(id));
    }
    Ok(())
}

/// Returns true if the PIN matches (or the profile has no PIN set).
pub fn verify_pin(conn: &Connection, id: i64, pin: &str) -> Result<bool, ProfileError> {
    let (hash, salt): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT pin_hash, pin_salt FROM profiles WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ProfileError::NotFound(id),
            other => ProfileError::Sqlite(other),
        })?;
    match (hash, salt) {
        (Some(h), Some(s)) => Ok(hash_pin(pin.trim(), &s) == h),
        // No PIN configured ⇒ always unlocked.
        _ => Ok(true),
    }
}

/// Delete a profile and everything scoped to it: playlists, listening history,
/// Home impressions, artist bans, saved items, and its claims on downloaded
/// songs. No `tracks` row is ever deleted — the library is shared — and only
/// the `playlist_tracks` links cascade away with the playlists. A track whose
/// last download claim was the departing profile's is edited, not removed: it
/// stops pointing at a copy on disk, because that copy is reclaimed (see the
/// download note inside). Refuses to remove the last remaining profile.
///
/// Since migration 024, the database itself backs this up: playlists,
/// play_events, artist_bans and profile_kv cascade off profiles(id),
/// profile_downloads likewise (migration 025), and
/// streaming_sessions.profile_id is SET NULL — so even a deletion path that
/// bypasses this function can't strand rows. The explicit sweep stays anyway:
/// it is the ONLY cleanup for `home_impressions` (whose profile_id 0 sentinel
/// rules out a foreign key), and belt-and-braces for the rest. The
/// schema-driven test below holds this function to every profile_id table the
/// schema contains, however it's cleaned.
///
/// What a cascade can't do is reach the disk, which is why the download
/// reclaim below lives here and not in the schema.
pub fn delete(conn: &mut Connection, id: i64) -> Result<(), ProfileError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(ProfileError::LastProfile);
    }
    let tx = conn.transaction()?;
    // playlist_tracks.playlist_id is ON DELETE CASCADE, so removing the
    // playlists drops their track links automatically. Shared tracks remain.
    tx.execute("DELETE FROM playlists WHERE profile_id = ?1", params![id])?;
    // A download is ownership of a device-wide file, not a file of its own, so
    // deleting a profile releases its claims exactly as `remove_download` does
    // when someone un-downloads one song: the copy on disk goes only when the
    // LAST owner lets go. Ask BEFORE the sweep, while this profile's rows still
    // exist — afterwards there's nothing left to tell "only they had it" from
    // "nobody ever did". A song a second profile also downloaded isn't listed
    // here and keeps both its row and its file.
    let released: Vec<(i64, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT t.id, t.local_path
               FROM tracks t
               JOIN profile_downloads mine ON mine.track_id = t.id
              WHERE mine.profile_id = ?1
                AND NOT EXISTS (SELECT 1 FROM profile_downloads others
                                 WHERE others.track_id = t.id
                                   AND others.profile_id <> ?1)",
        )?;
        let rows = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for table in [
        "play_events",
        "home_impressions",
        "artist_bans",
        "profile_kv",
        "profile_downloads",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE profile_id = ?1"),
            params![id],
        )?;
    }
    // Un-advertise the copy we're about to delete. Without this the track keeps
    // a `local_path` and a "downloaded" badge for everyone else, pointing at a
    // file that no longer exists.
    for (track_id, _) in &released {
        tx.execute(
            "UPDATE tracks
                SET local_path = NULL,
                    status = CASE WHEN status = 'downloaded' THEN 'matched' ELSE status END,
                    updated_at = strftime('%s','now')
              WHERE id = ?1",
            params![track_id],
        )?;
    }
    // A paired device keeps its pairing — it belongs to the household, not to the
    // person being removed — but it must stop claiming to BE them. Clearing the
    // binding drops it back to "Who's listening?" on its next open; revoking the
    // session instead would make a family member re-pair with a code over someone
    // else's deletion.
    tx.execute(
        "UPDATE streaming_sessions SET profile_id = NULL WHERE profile_id = ?1",
        params![id],
    )?;
    let n = tx.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    tx.commit()?;
    // Only now, and before the NotFound check: audio is the one thing here we
    // can't roll back, so it goes after the commit that made it unreferenced —
    // and never in between, which would leave a file no row points at.
    // Best-effort, like every other reclaim path: a file already gone, or on a
    // volume that isn't mounted, isn't a reason to fail a deletion the database
    // has already accepted.
    for (_, path) in &released {
        if let Some(p) = path.as_deref().filter(|s| !s.is_empty()) {
            let _ = std::fs::remove_file(p);
        }
    }
    if n == 0 {
        return Err(ProfileError::NotFound(id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        crate::db::open(tmp.path()).unwrap()
    }

    /// Seed one row in every profile-scoped table for `pid`.
    fn seed_profile_data(conn: &Connection, pid: i64) {
        conn.execute(
            "INSERT INTO playlists (spotify_id, name, track_count, profile_id)
             VALUES (?1, 'List', 0, ?2)",
            params![format!("pl{pid}"), pid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms)
             VALUES (?1, 'T', '[\"A\"]', 1000)",
            params![format!("t{pid}")],
        )
        .unwrap();
        let tid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO play_events (track_id, profile_id, played_at, ms_played, completed)
             VALUES (?1, ?2, 1, 1000, 1)",
            params![tid, pid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profile_downloads (profile_id, track_id) VALUES (?1, ?2)",
            params![pid, tid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO home_impressions
                 (profile_id, item_kind, item_key, first_shown, last_shown, shown_days)
             VALUES (?1, 'album', 'k', '2026-01-01', '2026-01-01', 1)",
            params![pid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO artist_bans (profile_id, artist_key, created_at) VALUES (?1, 'a', 1)",
            params![pid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profile_kv (profile_id, key, value) VALUES (?1, 'saved', '[]')",
            params![pid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO streaming_sessions
                 (id, token_sha256, device_label, ip_address, profile_id)
             VALUES (?1, ?2, 'Phone', '10.0.0.1', ?3)",
            params![format!("s{pid}"), format!("h{pid}"), pid],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str, pid: i64) -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE profile_id = ?1"),
            params![pid],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Every table the SCHEMA says is profile-scoped — read from the database
    /// rather than listed here on purpose. A hand-written list is the bug this
    /// guards against: `delete` only swept `playlists` for years because the
    /// other tables were simply never added to it, and a test carrying its own
    /// copy of that list would have agreed with it.
    fn profile_scoped_tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
                 WHERE m.type = 'table' AND p.name = 'profile_id'
                 GROUP BY m.name ORDER BY m.name",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    // The invariant, stated once: after deleting a profile, NO row anywhere may
    // still point at it. Both policies satisfy that — swept tables keep no rows,
    // and an unbound session's profile_id is NULL, which matches nothing.
    //
    // Foreign keys can't enforce this here (the migration runner holds a
    // transaction open, so it can't disable them long enough to rebuild a table,
    // and `home_impressions` stores 0 for "no profile", which an FK would
    // reject). More to the point, they wouldn't stop it recurring: a new table
    // whose author forgets the FK is the same bug as one whose author forgets the
    // sweep. This test forgets nothing — it asks the schema.
    #[test]
    fn delete_leaves_no_row_pointing_at_the_profile() {
        let mut conn = fresh_db();
        let doomed = create(&conn, "Doomed", "#111", None).unwrap().id;
        let bystander = create(&conn, "Bystander", "#222", None).unwrap().id;
        seed_profile_data(&conn, doomed);
        seed_profile_data(&conn, bystander);

        let tables = profile_scoped_tables(&conn);
        assert!(!tables.is_empty(), "schema query found nothing — the test is broken, not the code");
        // Fail loudly on an unseeded table rather than quietly vouching for one we
        // never filled: an empty table trivially "passes" the sweep below.
        for t in &tables {
            assert!(
                count(&conn, t, doomed) > 0,
                "`{t}` is profile-scoped but `seed_profile_data` doesn't populate it — \
                 add it there, then make sure `delete` handles it",
            );
        }

        delete(&mut conn, doomed).unwrap();

        for t in &tables {
            assert_eq!(
                count(&conn, t, doomed),
                0,
                "`{t}` still points at the deleted profile — teach `delete` to sweep \
                 or unbind it",
            );
            assert!(
                count(&conn, t, bystander) > 0,
                "`{t}`: deleting one profile took another's rows with it",
            );
        }
    }

    // The device stays paired (it's the household's, not the deleted person's) —
    // but it must stop identifying as them, or it streams as a profile that isn't
    // there. Clearing the binding sends it back to the picker.
    #[test]
    fn delete_unbinds_that_profiles_devices_without_unpairing_them() {
        let mut conn = fresh_db();
        let doomed = create(&conn, "Doomed", "#111", None).unwrap().id;
        let bystander = create(&conn, "Bystander", "#222", None).unwrap().id;
        seed_profile_data(&conn, doomed);
        seed_profile_data(&conn, bystander);

        delete(&mut conn, doomed).unwrap();

        let (bound, revoked): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT profile_id, revoked_at FROM streaming_sessions WHERE id = ?1",
                params![format!("s{doomed}")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(bound, None, "session still claims the deleted profile");
        assert_eq!(revoked, None, "session was revoked — the device shouldn't need re-pairing");
        assert_eq!(count(&conn, "streaming_sessions", bystander), 1);
    }

    // Sweeping must not become a licence to wipe the shared library: tracks (and
    // the files behind them) belong to everyone.
    #[test]
    fn delete_leaves_the_shared_library_alone() {
        let mut conn = fresh_db();
        let doomed = create(&conn, "Doomed", "#111", None).unwrap().id;
        create(&conn, "Bystander", "#222", None).unwrap();
        seed_profile_data(&conn, doomed);
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();

        delete(&mut conn, doomed).unwrap();

        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after, "shared tracks must survive a profile deletion");
    }

    /// A downloaded track sitting at `path`, owned by nobody yet.
    fn downloaded_track(conn: &Connection, key: &str, path: &std::path::Path) -> i64 {
        std::fs::write(path, b"audio").unwrap();
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms, status, local_path)
             VALUES (?1, 'T', '[\"A\"]', 1000, 'downloaded', ?2)",
            params![key, path.to_string_lossy()],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn owns_download(conn: &Connection, pid: i64, tid: i64) {
        conn.execute(
            "INSERT INTO profile_downloads (profile_id, track_id) VALUES (?1, ?2)",
            params![pid, tid],
        )
        .unwrap();
    }

    // The download rows cascade away on their own (migration 025), which is
    // exactly why this needs saying: a cascade can't reach the disk. A song only
    // the departing profile had downloaded is now in nobody's Downloaded tab, so
    // its file is unreachable storage — and `prune_orphan_tracks` won't reclaim
    // it either, since the track is still in a surviving profile's playlist.
    // Deleting a profile releases its downloads the same way `remove_download`
    // does: last owner out, file goes.
    #[test]
    fn delete_reclaims_downloads_nobody_else_was_holding() {
        let dir = tempfile::tempdir().unwrap();
        let solo_path = dir.path().join("solo.mp3");
        let shared_path = dir.path().join("shared.mp3");

        let mut conn = fresh_db();
        let doomed = create(&conn, "Doomed", "#111", None).unwrap().id;
        let bystander = create(&conn, "Bystander", "#222", None).unwrap().id;
        let solo = downloaded_track(&conn, "solo", &solo_path);
        let shared = downloaded_track(&conn, "shared", &shared_path);
        owns_download(&conn, doomed, solo);
        owns_download(&conn, doomed, shared);
        owns_download(&conn, bystander, shared);

        delete(&mut conn, doomed).unwrap();

        assert!(!solo_path.exists(), "nobody holds this download — its file should be gone");
        assert!(
            shared_path.exists(),
            "the bystander still has this downloaded; deleting someone else took their file",
        );

        let state = |tid: i64| -> (Option<String>, String) {
            conn.query_row(
                "SELECT local_path, status FROM tracks WHERE id = ?1",
                params![tid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(
            state(solo),
            (None, "matched".into()),
            "track still advertises a copy on disk that delete just removed",
        );
        assert_eq!(
            state(shared).0,
            Some(shared_path.to_string_lossy().into_owned()),
            "a download someone else still holds must stay playable from disk",
        );
        assert_eq!(state(shared).1, "downloaded");
        assert_eq!(count(&conn, "profile_downloads", bystander), 1);
    }

    // The reclaim is scoped to the profile leaving. A download it never had is
    // not its to release, however few owners the song has.
    #[test]
    fn delete_leaves_downloads_it_never_owned_alone() {
        let dir = tempfile::tempdir().unwrap();
        let theirs_path = dir.path().join("theirs.mp3");

        let mut conn = fresh_db();
        let doomed = create(&conn, "Doomed", "#111", None).unwrap().id;
        let bystander = create(&conn, "Bystander", "#222", None).unwrap().id;
        let theirs = downloaded_track(&conn, "theirs", &theirs_path);
        owns_download(&conn, bystander, theirs);

        delete(&mut conn, doomed).unwrap();

        assert!(theirs_path.exists(), "took a file the deleted profile never downloaded");
        assert_eq!(count(&conn, "profile_downloads", bystander), 1);
    }

    // ------------------------------------------------------------------
    // Profiles bound to a signed-in person
    // ------------------------------------------------------------------

    const P: &str = "test-provider";

    #[test]
    fn a_new_person_gets_a_profile_named_after_their_address() {
        let conn = fresh_db();
        let made = ensure_for_identity(&conn, P, "sub-1", "sam.taylor@example.com").unwrap();
        assert_eq!(made.name, "Sam Taylor");
        assert!(!made.has_pin, "a person somewhere else has no use for a PIN");
    }

    #[test]
    fn the_same_person_comes_back_to_the_same_profile() {
        // Every request from a visitor runs this. Minting a profile per page load
        // would leave somebody with a fresh, empty library on every visit.
        let conn = fresh_db();
        let first = ensure_for_identity(&conn, P, "sub-1", "a@example.com").unwrap();
        let second = ensure_for_identity(&conn, P, "sub-1", "a@example.com").unwrap();
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn changing_address_keeps_the_same_library() {
        // Bound to the provider's stable id, never the address — otherwise moving
        // house would silently hand somebody an empty library.
        let conn = fresh_db();
        let before = ensure_for_identity(&conn, P, "sub-1", "old@example.com").unwrap();
        let after = ensure_for_identity(&conn, P, "sub-1", "new@example.com").unwrap();
        assert_eq!(before.id, after.id);

        let stored: String = conn
            .query_row(
                "SELECT identity_email FROM profiles WHERE id = ?1",
                params![after.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "new@example.com", "the owner sees a stale address in the list");
    }

    #[test]
    fn two_people_get_two_profiles() {
        let conn = fresh_db();
        let a = ensure_for_identity(&conn, P, "sub-a", "a@example.com").unwrap();
        let b = ensure_for_identity(&conn, P, "sub-b", "b@example.com").unwrap();
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn two_people_with_the_same_looking_name_do_not_collide() {
        // Both read as "Sam" in the list, and they must still be two accounts.
        let conn = fresh_db();
        let a = ensure_for_identity(&conn, P, "sub-a", "sam@one.example").unwrap();
        let b = ensure_for_identity(&conn, P, "sub-b", "sam@two.example").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.name, b.name);
    }

    #[test]
    fn local_profiles_are_untouched_by_any_of_this() {
        // The family-on-one-Mac case has no identity, and must not be matched by
        // a lookup for one.
        let conn = fresh_db();
        create(&conn, "Local", "#111", None).unwrap();
        assert!(find_by_identity(&conn, P, "sub-1").unwrap().is_none());
        assert!(find_by_identity(&conn, P, "").unwrap().is_none());
    }

    #[test]
    fn a_profile_is_never_found_across_providers() {
        let conn = fresh_db();
        ensure_for_identity(&conn, P, "sub-1", "a@example.com").unwrap();
        assert!(find_by_identity(&conn, "someone-else", "sub-1").unwrap().is_none());
    }

    #[test]
    fn an_address_we_cannot_make_a_name_from_still_yields_a_profile() {
        let conn = fresh_db();
        assert_eq!(ensure_for_identity(&conn, P, "s1", "").unwrap().name, "Guest");
        assert_eq!(ensure_for_identity(&conn, P, "s2", "@example.com").unwrap().name, "@example.com");
    }

    #[test]
    fn the_same_person_keeps_the_same_tile_colour() {
        let conn = fresh_db();
        let a = ensure_for_identity(&conn, P, "sub-1", "a@example.com").unwrap();
        assert_eq!(a.avatar_color, color_for("sub-1"));
    }

    // ------------------------------------------------------------------
    // What each caller may see, and what stays theirs
    // ------------------------------------------------------------------

    #[test]
    fn the_local_list_leaves_out_people_who_signed_in() {
        // What a device paired over the local network is shown. It must read
        // exactly as it did before any of this existed.
        let conn = fresh_db();
        create(&conn, "Family", "#111", None).unwrap();
        ensure_for_identity(&conn, P, "sub-1", "guest@example.com").unwrap();

        let local = list_local(&conn).unwrap();
        assert!(
            local.iter().all(|p| p.name != "Guest" && p.name != "Guest@example.com"),
            "a remote person's account was offered to a device on the local network",
        );
        assert!(local.iter().any(|p| p.name == "Family"));
        assert!(
            list(&conn).unwrap().len() > local.len(),
            "the full list should still contain everybody, for the owner's own machine",
        );
    }

    #[test]
    fn an_account_that_belongs_to_somebody_is_marked_as_theirs() {
        // The guard that stops a device on the local network binding itself to a
        // remote person's account. These accounts carry no PIN, so without it an
        // empty PIN would be accepted and hand over their library.
        let conn = fresh_db();
        let local = create(&conn, "Family", "#111", None).unwrap();
        let theirs = ensure_for_identity(&conn, P, "sub-1", "guest@example.com").unwrap();

        assert!(!is_identity_bound(&conn, local.id).unwrap());
        assert!(is_identity_bound(&conn, theirs.id).unwrap());
        assert!(!theirs.has_pin, "the case the guard exists for");
    }

    #[test]
    fn two_people_keep_separate_playlists() {
        // The promise made to somebody who accepts an invitation: their music is
        // theirs. Playlists hang off profile_id, and two identities are two
        // profiles, so this is really a check that nothing merged them.
        let conn = fresh_db();
        let a = ensure_for_identity(&conn, P, "sub-a", "a@example.com").unwrap();
        let b = ensure_for_identity(&conn, P, "sub-b", "b@example.com").unwrap();
        seed_profile_data(&conn, a.id);
        seed_profile_data(&conn, b.id);

        for (mine, theirs) in [(a.id, b.id), (b.id, a.id)] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM playlists WHERE profile_id = ?1",
                    params![mine],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "somebody's playlists were not their own");
            let leaked: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM playlists WHERE profile_id = ?1 AND profile_id = ?2",
                    params![mine, theirs],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(leaked, 0);
        }
    }
}
