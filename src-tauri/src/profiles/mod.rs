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

/// The default profile id (the oldest / lowest-id profile). Used to assign
/// shared-source playlists (Spotify sync, CSV import) in Phase 1, where there
/// is still a single Spotify account. Robust against the seed profile (id 1)
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

/// Delete a profile and the playlists it owns. The shared `tracks` rows and
/// downloaded files are untouched (they may belong to other profiles too);
/// only the `playlist_tracks` links cascade away with the playlists. Refuses
/// to remove the last remaining profile.
pub fn delete(conn: &mut Connection, id: i64) -> Result<(), ProfileError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(ProfileError::LastProfile);
    }
    let tx = conn.transaction()?;
    // playlist_tracks.playlist_id is ON DELETE CASCADE, so removing the
    // playlists drops their track links automatically. Shared tracks remain.
    tx.execute("DELETE FROM playlists WHERE profile_id = ?1", params![id])?;
    let n = tx.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    tx.commit()?;
    if n == 0 {
        return Err(ProfileError::NotFound(id));
    }
    Ok(())
}
