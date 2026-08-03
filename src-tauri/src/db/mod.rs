//! SQLite connection management and migration runner.
//!
//! Migrations are embedded at compile time via `include_str!` and applied in
//! ascending version order. Applied versions are tracked in the `_migrations`
//! bookkeeping table; each migration runs inside a transaction so partial
//! application is impossible.
//!
//! A migration whose first line is `-- fk:rebuild` runs with foreign keys OFF
//! (toggled outside its transaction, where the pragma actually works) and is
//! integrity-gated by `PRAGMA foreign_key_check` before commit. Use it for
//! table rebuilds that add or change REFERENCES clauses — see [`is_fk_rebuild`].

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
    (22, include_str!("../../migrations/022_drop_orphaned_schema.sql")),
    (23, include_str!("../../migrations/023_artist_candidate_cache.sql")),
    (24, include_str!("../../migrations/024_profile_foreign_keys.sql")),
    (25, include_str!("../../migrations/025_profile_downloads.sql")),
    (26, include_str!("../../migrations/026_profile_identity.sql")),
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
    apply_migrations_capped(conn, i64::MAX)
}

/// Apply pending migrations up to and including `cap`. `apply_migrations`
/// passes `i64::MAX`; tests pass a real cap to build a database as it existed
/// at an older version, seed period-accurate data, then apply the rest — the
/// only way to exercise a rebuild migration against pre-rebuild rows.
fn apply_migrations_capped(conn: &mut Connection, cap: i64) -> Result<(), DbError> {
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
        if version > cap {
            break; // plan is version-ordered, so nothing later applies either
        }
        // A rebuild migration must run with foreign keys OFF: dropping a table
        // that others reference fires their ON DELETE actions with enforcement
        // on (rebuilding `playlists` empties playlist_tracks), and the pragma
        // is a silent no-op inside a transaction — so it has to happen here,
        // between transactions, not in the migration SQL itself.
        let fk_rebuild = is_fk_rebuild(sql);
        if fk_rebuild {
            conn.pragma_update(None, "foreign_keys", "OFF")?;
        }
        let result = apply_one(conn, version, sql, fk_rebuild);
        if fk_rebuild {
            // Restore on success AND failure — this connection is the app's
            // only one, and it lives on after a failed open attempt is retried.
            conn.pragma_update(None, "foreign_keys", "ON")?;
        }
        result?;
        tracing::info!(version, "applied migration");
    }
    Ok(())
}

/// One migration, one transaction. For an fk-rebuild migration, run
/// `PRAGMA foreign_key_check` before commit and abort on any violation —
/// enforcement is off, so this gate is the only thing standing between a buggy
/// rebuild and a committed database whose references no longer hold.
fn apply_one(
    conn: &mut Connection,
    version: i64,
    sql: &str,
    fk_rebuild: bool,
) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    tx.execute_batch(sql)?;
    if fk_rebuild {
        let violations: Vec<String> = {
            let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        if !violations.is_empty() {
            let mut tables = violations;
            tables.sort();
            tables.dedup();
            return Err(DbError::Migration(format!(
                "migration {version} left foreign-key violations in: {} — rolled back",
                tables.join(", ")
            ))); // tx drops here → rollback
        }
    }
    tx.execute(
        "INSERT INTO _migrations (version) VALUES (?1)",
        params![version],
    )?;
    tx.commit()?;
    Ok(())
}

/// True when a migration's first line is the `-- fk:rebuild` marker. The marker
/// lives in the SQL (not a version list here) so band-100+ migrations passed
/// through [`register_migrations`] can use the same machinery without changing
/// that seam's signature.
fn is_fk_rebuild(sql: &str) -> bool {
    sql.lines()
        .next()
        .map(str::trim)
        .is_some_and(|line| line.eq_ignore_ascii_case("-- fk:rebuild"))
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

    /// A database as it stood at `cap`, with the pragmas `open` would have set.
    /// Lets a test seed rows the way an older build wrote them, then apply the
    /// remaining migrations over that data — the only honest way to exercise a
    /// rebuild against the shape it will actually meet in the wild.
    fn db_at_version(cap: i64) -> Connection {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let mut conn = Connection::open(tmp.path()).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        apply_migrations_capped(&mut conn, cap).unwrap();
        conn
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Foreign keys declared BY `table` (i.e. what it references).
    fn fk_targets(conn: &Connection, table: &str) -> Vec<(String, String)> {
        conn.prepare(&format!("PRAGMA foreign_key_list({table})"))
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(6)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    #[test]
    fn fk_rebuild_marker_must_be_the_first_line() {
        assert!(is_fk_rebuild("-- fk:rebuild\nDROP TABLE x;"));
        assert!(is_fk_rebuild("  -- FK:Rebuild  \nSELECT 1;"));
        assert!(!is_fk_rebuild("-- ordinary migration\nSELECT 1;"));
        // Buried in the body it must NOT count — a stray mention in a comment
        // shouldn't quietly disable foreign keys for someone else's migration.
        assert!(!is_fk_rebuild("SELECT 1;\n-- fk:rebuild"));
        assert!(!is_fk_rebuild(""));
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
    fn foreign_keys_cascade_delete() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO playlists (spotify_id, name, track_count)
             VALUES ('p1', 'Test', 1)",
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

    /// Migration 022 drops the orphaned `spotify_account` table and the four
    /// write-only columns. Proves the migration applies cleanly on a fresh DB
    /// (incl. dropping the indexed `locally_added`) and that the trimmed INSERT
    /// shapes the app now uses still work.
    #[test]
    fn migration_022_drops_orphaned_schema() {
        let conn = fresh_db();
        let has_col = |table: &str, col: &str| -> bool {
            conn.prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(Result::ok)
                .any(|c| c == col)
        };
        let has_table = |name: &str| -> bool {
            conn.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |_| Ok(()),
            )
            .is_ok()
        };

        assert!(!has_table("spotify_account"), "spotify_account dropped");
        assert!(!has_col("playlists", "snapshot_id"), "snapshot_id dropped");
        assert!(!has_col("playlists", "cover_local_path"), "cover_local_path dropped");
        assert!(!has_col("tracks", "retry_count"), "retry_count dropped");
        assert!(!has_col("playlist_tracks", "locally_added"), "locally_added dropped");

        // The trimmed INSERT shapes (no snapshot_id / no locally_added) still work.
        conn.execute(
            "INSERT INTO playlists (spotify_id, name, track_count, profile_id)
             VALUES ('p1', 'Test', 0, 1)",
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
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (1, 1, 0, strftime('%s','now'))",
            [],
        )
        .unwrap();
    }

    /// Seed a v23-shaped database: two profiles with a playlist (and its track
    /// links), plays, a ban, a kv row and a paired session — plus, for each
    /// table, a row belonging to a profile that no longer exists, which is
    /// exactly what a pre-#39 deletion left behind.
    fn seed_v23_fixture(conn: &Connection) {
        const DEAD: i64 = 404; // a profile deleted before the sweep existed
        conn.execute(
            "INSERT INTO profiles (id, name, avatar_color) VALUES (2, 'Two', '#222222')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, spotify_id, title, artists, duration_ms)
             VALUES (1, 't1', 'T', '[\"A\"]', 1000)",
            [],
        )
        .unwrap();
        for (pl, pid) in [(1_i64, 1_i64), (2, 2), (3, DEAD)] {
            conn.execute(
                "INSERT INTO playlists (id, spotify_id, name, track_count, profile_id)
                 VALUES (?1, ?2, 'L', 1, ?3)",
                params![pl, format!("p{pl}"), pid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
                 VALUES (?1, 1, 0, 1)",
                params![pl],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO play_events (track_id, profile_id, played_at, ms_played, completed)
                 VALUES (1, ?1, 1, 1000, 1)",
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
                 VALUES (?1, ?2, 'D', '10.0.0.1', ?3)",
                params![format!("s{pid}"), format!("h{pid}"), pid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO home_impressions
                     (profile_id, item_kind, item_key, first_shown, last_shown, shown_days)
                 VALUES (?1, 'album', 'k', '2026-01-01', '2026-01-01', 1)",
                params![pid],
            )
            .unwrap();
        }
        // The no-profile sentinel: home_impressions writes 0 when there's no
        // active profile. It is NOT an orphan and must survive.
        conn.execute(
            "INSERT INTO home_impressions
                 (profile_id, item_kind, item_key, first_shown, last_shown, shown_days)
             VALUES (0, 'album', 'sentinel', '2026-01-01', '2026-01-01', 1)",
            [],
        )
        .unwrap();
    }

    // The regression test for the wipe this migration was built to avoid.
    // Rebuilding `playlists` with foreign keys ON fires playlist_tracks' cascade
    // when the old table drops — against a copy of a real library that silently
    // deleted every playlist's contents. The runner's fk:rebuild handling is the
    // only reason it doesn't; this test is what keeps it that way.
    #[test]
    fn migration_024_adds_fks_without_eating_playlist_contents() {
        let mut conn = db_at_version(23);
        seed_v23_fixture(&conn);
        let links_before = count(&conn, "SELECT COUNT(*) FROM playlist_tracks");
        assert_eq!(links_before, 3, "fixture seeded 3 playlist_tracks rows");

        apply_migrations(&mut conn).unwrap();

        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM playlist_tracks"),
            2,
            "kept the live profiles' playlist contents; dropped only the orphan playlist's",
        );
        // Orphans (profile 404) are gone from every scoped table.
        for t in ["playlists", "play_events", "artist_bans", "profile_kv"] {
            assert_eq!(
                count(&conn, &format!("SELECT COUNT(*) FROM {t} WHERE profile_id = 404")),
                0,
                "{t}: orphan rows survived the cleanup",
            );
        }
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM home_impressions WHERE profile_id = 404"),
            0,
            "orphan impressions survived",
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM home_impressions WHERE profile_id = 0"),
            1,
            "the no-profile sentinel must NOT be mistaken for an orphan",
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM streaming_sessions WHERE profile_id = 404"),
            0,
            "orphan session still claims a dead profile",
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM streaming_sessions"),
            3,
            "sessions are unbound, never unpaired",
        );
        // Live data intact.
        for (t, n) in [("playlists", 2), ("play_events", 2), ("profile_kv", 2)] {
            assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM {t}")), n, "{t} lost live rows");
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks"), 1, "shared library touched");

        // The point of the exercise: the FKs exist, with the right actions.
        for t in ["playlists", "play_events", "artist_bans", "profile_kv"] {
            assert!(
                fk_targets(&conn, t).contains(&("profiles".into(), "CASCADE".into())),
                "{t} has no CASCADE foreign key to profiles",
            );
        }
        assert!(
            fk_targets(&conn, "streaming_sessions")
                .contains(&("profiles".into(), "SET NULL".into())),
            "streaming_sessions should unbind, not cascade",
        );
        assert!(
            fk_targets(&conn, "play_events").contains(&("tracks".into(), "CASCADE".into())),
            "the pre-existing tracks cascade was dropped in the rebuild",
        );
        // AUTOINCREMENT survived, so ids can't be reissued over live rows.
        assert!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE name IN ('playlists','play_events') AND sql LIKE '%AUTOINCREMENT%'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                == 2,
            "AUTOINCREMENT lost in rebuild",
        );
        assert!(
            count(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check") == 0,
            "migration left dangling references",
        );
    }

    // What the foreign keys actually buy: the guarantee no longer depends on
    // going through profiles::delete(). A raw DELETE — a future code path, a
    // script, anything — now cleans up after itself.
    #[test]
    fn profile_cascade_fires_on_a_raw_delete() {
        let mut conn = db_at_version(23);
        seed_v23_fixture(&conn);
        apply_migrations(&mut conn).unwrap();

        conn.execute("DELETE FROM profiles WHERE id = 2", []).unwrap();

        for t in ["playlists", "play_events", "artist_bans", "profile_kv"] {
            assert_eq!(
                count(&conn, &format!("SELECT COUNT(*) FROM {t} WHERE profile_id = 2")),
                0,
                "{t}: no cascade on a raw profile delete",
            );
            assert_eq!(
                count(&conn, &format!("SELECT COUNT(*) FROM {t} WHERE profile_id = 1")),
                1,
                "{t}: cascade took the bystander's rows too",
            );
        }
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM playlist_tracks"),
            1,
            "the deleted profile's links should go with its playlist, the other's stay",
        );
        let bound: Option<i64> = conn
            .query_row(
                "SELECT profile_id FROM streaming_sessions WHERE id = 's2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bound, None, "session should unbind on cascade");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM streaming_sessions WHERE id = 's2'"),
            1,
            "session was deleted — the device should stay paired",
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks"), 1, "shared library touched");
    }
}
