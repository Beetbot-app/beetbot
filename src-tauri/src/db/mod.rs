//! SQLite connection management and migration runner.
//!
//! Migrations are embedded at compile time via `include_str!` and applied in
//! ascending version order. Applied versions are tracked in the `_migrations`
//! bookkeeping table; each migration runs inside a transaction so partial
//! application is impossible.

use rusqlite::{Connection, params};
use std::path::Path;

/// Ordered list of (version, sql) pairs. New migrations are appended to the
/// end of this slice — never reorder or rewrite a shipped migration.
///
/// Reserved version bands: **core 1–99**, **engine 100+**. A closed engine crate
/// contributes its additive migrations via [`register_migrations`] (band 100+)
/// rather than editing this const, so the core SQL never names engine tokens.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/001_init.sql")),
    (2, include_str!("../../migrations/002_reserved.sql")),
    (3, include_str!("../../migrations/003_fts.sql")),
    (4, include_str!("../../migrations/004_streaming.sql")),
    (5, include_str!("../../migrations/005_locally_added.sql")),
    (6, include_str!("../../migrations/006_profiles.sql")),
    (7, include_str!("../../migrations/007_spotify_per_profile.sql")),
    (8, include_str!("../../migrations/008_profile_avatar.sql")),
    (9, include_str!("../../migrations/009_play_events.sql")),
    (10, include_str!("../../migrations/010_track_source_url.sql")),
    (11, include_str!("../../migrations/011_track_year_genre.sql")),
    (12, include_str!("../../migrations/012_artist_tags.sql")),
    (13, include_str!("../../migrations/013_play_completion.sql")),
    (14, include_str!("../../migrations/014_track_features.sql")),
    (15, include_str!("../../migrations/015_session_profile.sql")),
    (16, include_str!("../../migrations/016_lyrics_cache.sql")),
    (17, include_str!("../../migrations/017_lyrics_refetch_plain.sql")),
    (18, include_str!("../../migrations/018_track_feedback.sql")),
    (19, include_str!("../../migrations/019_profile_kv.sql")),
    (20, include_str!("../../migrations/020_rename_liked_to_favorites.sql")),
    (21, include_str!("../../migrations/021_home_impressions.sql")),
];

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// A malformed migration sequence (duplicate or non-ascending versions
    /// across the core/engine bands). Surfaced at `open()` rather than a
    /// debug-only panic, so a misconfigured engine fails loudly in release too.
    #[error("migration error: {0}")]
    Migration(String),
}

/// Engine-contributed additive migrations (reserved band 100+). Installed once
/// at startup by a closed engine crate's init, BEFORE [`open`]; the open build
/// never registers any, so this stays empty and migrations run exactly 1..=N.
static ENGINE_MIGRATIONS: std::sync::OnceLock<Vec<(i64, &'static str)>> =
    std::sync::OnceLock::new();

/// Register engine-owned migrations (band 100+) before the database is opened.
/// Set-once (a second call is a silent no-op, like `ddns::install_db_handle`).
// Engine seam: called by the closed engine crate's init; unused in the open build.
#[allow(dead_code)]
pub fn register_migrations(extra: Vec<(i64, &'static str)>) {
    debug_assert!(
        extra.iter().all(|(v, _)| *v >= 100),
        "engine migrations must use the reserved 100+ band"
    );
    let _ = ENGINE_MIGRATIONS.set(extra);
}

/// Open (or create) a SQLite database at `path`, enable WAL + foreign keys,
/// and apply any pending migrations.
pub fn open(path: &Path) -> Result<Connection, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(path)?;
    // WAL = concurrent reads while a writer is active. Required once we have
    // multiple connections (background workers, HTTP server) hitting the DB.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Register `artist_key(name)` as a deterministic SQL scalar function so SQL-side
    // artist-name normalization is BYTE-IDENTICAL to the Rust `crate::tags::artist_key`
    // (Unicode-aware lowercasing + interior-whitespace collapse). SQLite's built-in
    // lower() is ASCII-only and trim() doesn't collapse interior runs, so inline
    // `lower(trim(...))` silently diverged from the Rust key for names like "ROSALÍA"
    // or "RÜFÜS DU SOL". Sharing one function guarantees seed/table sides never drift.
    conn.create_scalar_function(
        "artist_key",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let name: Option<String> = ctx.get(0)?;
            Ok(name.map(|n| crate::tags::artist_key(&n)))
        },
    )?;
    apply_migrations(&mut conn)?;
    Ok(conn)
}

fn apply_migrations(conn: &mut Connection) -> Result<(), DbError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
         );",
    )?;
    // Which migrations remain to apply (per-version, band-validated, ordered).
    let engine = ENGINE_MIGRATIONS
        .get()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let applied: std::collections::HashSet<i64> = {
        let mut stmt = conn.prepare("SELECT version FROM _migrations")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for (version, sql) in plan_migrations(MIGRATIONS, engine, &applied)? {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO _migrations (version) VALUES (?1)",
            params![version],
        )?;
        tx.commit()?;
        tracing::info!(version, "applied migration");
    }
    Ok(())
}

/// The ordered list of migrations still to apply: core (band 1–99) merged with
/// engine band-100+, validated and minus those already recorded. Pure (no DB) so
/// the cross-band gate is unit-testable.
///
/// The `applied` set is checked PER-VERSION — not against `MAX(version)`. A
/// high-water mark would silently skip a later core migration once an engine
/// band-100+ migration is recorded (e.g. `15 <= 100`); membership applies each
/// version exactly once regardless of band interleaving. Also enforces the
/// reserved band and rejects a duplicate / non-ascending version (which would
/// otherwise run two SQL bodies then trip the `_migrations` PRIMARY KEY mid-open)
/// — both in release, unlike `register_migrations`' debug_assert.
fn plan_migrations<'a>(
    core: &[(i64, &'a str)],
    engine: &[(i64, &'a str)],
    applied: &std::collections::HashSet<i64>,
) -> Result<Vec<(i64, &'a str)>, DbError> {
    if let Some((v, _)) = engine.iter().find(|(v, _)| *v < 100) {
        return Err(DbError::Migration(format!(
            "engine migration version {v} is below the reserved 100+ band"
        )));
    }
    let mut all: Vec<(i64, &'a str)> = core.iter().chain(engine.iter()).copied().collect();
    all.sort_by_key(|entry| entry.0);
    if let Some(w) = all.windows(2).find(|w| w[0].0 >= w[1].0) {
        return Err(DbError::Migration(format!(
            "duplicate or non-ascending migration version: {} then {}",
            w[0].0, w[1].0
        )));
    }
    Ok(all.into_iter().filter(|(v, _)| !applied.contains(v)).collect())
}

/// Highest applied migration version, or 0 if the DB is fresh.
pub fn current_version(conn: &Connection) -> Result<i64, DbError> {
    let v: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |r| r.get(0),
    )?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        open(tmp.path()).unwrap()
    }

    // A later core migration must still apply after an engine band-100+ migration
    // has been recorded — the per-version gate, not a MAX(version) high-water mark
    // (which would skip `15 <= 100`). This is the seam the engine plugs into.
    #[test]
    fn plan_skips_applied_per_version_not_by_max() {
        let core = [(14, "core14"), (15, "core15")];
        let engine = [(100, "engine100")];
        let applied: std::collections::HashSet<i64> = [14, 100].into_iter().collect();
        let plan = plan_migrations(&core, &engine, &applied).unwrap();
        assert_eq!(plan, vec![(15, "core15")]);
    }

    #[test]
    fn plan_rejects_engine_below_reserved_band() {
        let applied = std::collections::HashSet::new();
        let r = plan_migrations(&[(1, "a")], &[(50, "bad")], &applied);
        assert!(matches!(r, Err(DbError::Migration(_))));
    }

    #[test]
    fn plan_rejects_duplicate_version() {
        let applied = std::collections::HashSet::new();
        let r = plan_migrations(&[(1, "a")], &[(100, "x"), (100, "y")], &applied);
        assert!(matches!(r, Err(DbError::Migration(_))));
    }

    #[test]
    fn migrations_apply_to_fresh_db() {
        let conn = fresh_db();
        // Derive the expected version from the table so it never goes stale when a
        // migration is appended.
        assert_eq!(
            current_version(&conn).unwrap(),
            MIGRATIONS.last().unwrap().0
        );

        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in [
            "_migrations",
            "playlist_tracks",
            "playlists",
            "profiles",
            "settings",
            "spotify_account",
            "streaming_sessions",
            "track_features",
            "tracks",
            "tracks_fts",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn reopening_db_is_idempotent() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn1 = open(tmp.path()).unwrap();
        drop(conn1);
        let conn2 = open(tmp.path()).unwrap();
        assert_eq!(current_version(&conn2).unwrap(), MIGRATIONS.last().unwrap().0);
    }

    #[test]
    fn spotify_account_is_keyed_by_profile() {
        let conn = fresh_db();
        // Migration 006 seeds profile id=1.
        conn.execute(
            "INSERT INTO spotify_account
                 (profile_id, spotify_user_id, access_token, refresh_token, token_expires_at)
             VALUES (1, 'u1', 'a', 'r', 0)",
            [],
        )
        .unwrap();
        // A second account for the same profile conflicts (profile_id is PK).
        let err = conn.execute(
            "INSERT INTO spotify_account
                 (profile_id, spotify_user_id, access_token, refresh_token, token_expires_at)
             VALUES (1, 'u2', 'a', 'r', 0)",
            [],
        );
        assert!(err.is_err(), "one Spotify account per profile");

        // A different profile can connect its own account.
        conn.execute(
            "INSERT INTO profiles (id, name) VALUES (2, 'Alia')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spotify_account
                 (profile_id, spotify_user_id, access_token, refresh_token, token_expires_at)
             VALUES (2, 'u2', 'a', 'r', 0)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn foreign_keys_cascade_delete() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO playlists (spotify_id, name, snapshot_id, track_count)
             VALUES ('p1', 'Test', 'snap1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms)
             VALUES ('t1', 'Track', '[\"Artist\"]', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position)
             VALUES (1, 1, 0)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM playlists WHERE id = 1", []).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "playlist_tracks should cascade on playlist delete");
    }

    /// Migration 005 added a `locally_added` flag to playlist_tracks so the
    /// Spotify sync can distinguish rows the user added via the web player
    /// from rows that came from a Spotify API response. Without this
    /// column the sync's `DELETE FROM playlist_tracks WHERE playlist_id=?`
    /// would silently wipe web-search additions on every sync.
    #[test]
    fn migration_005_adds_locally_added_column() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO playlists (spotify_id, name, snapshot_id, track_count)
             VALUES ('p1', 'Test', 'snap1', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms)
             VALUES ('t1', 'T', '[\"A\"]', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks
                 (playlist_id, track_id, position, locally_added)
             VALUES (1, 1, 0, 1)",
            [],
        )
        .unwrap();
        let flag: i64 = conn
            .query_row(
                "SELECT locally_added FROM playlist_tracks WHERE playlist_id = 1 AND track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, 1);
        // Default value is 0 for rows inserted without specifying it.
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms)
             VALUES ('t2', 'U', '[\"B\"]', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position)
             VALUES (1, 2, 1)",
            [],
        )
        .unwrap();
        let default_flag: i64 = conn
            .query_row(
                "SELECT locally_added FROM playlist_tracks WHERE playlist_id = 1 AND track_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(default_flag, 0);
    }
}
