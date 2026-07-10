//! Generic key-value settings helpers backed by the `settings` table.
//!
//! These were previously hosted in the (now-removed) `spotify` module but are
//! generic and used by non-Spotify code (e.g. the Last.fm API key). Kept as a
//! standalone module so they outlive any individual integration.

/// Read a stored setting by key, returning `None` if missing.
pub fn get_setting(
    conn: &rusqlite::Connection,
    key: &str,
) -> Result<Option<String>, rusqlite::Error> {
    match conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |r| r.get::<_, String>(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_setting(
    conn: &rusqlite::Connection,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}
