//! Portable full-server backup: move a whole Beetbot — every profile, playlist,
//! track, setting, and listening history, optionally the audio files — to a new
//! server as one zip.
//!
//! Export writes a `VACUUM INTO` snapshot of the live database (atomic and
//! consistent without closing the app's connection), scrubs everything bound to
//! THIS machine or its paired devices (provider device tokens, ddns/ngrok
//! tokens, phone pairing sessions), and zips it beside the audio.
//!
//! Import never touches the live database: the incoming snapshot is validated
//! and staged beside it, audio lands in the library folder, absolute paths from
//! the old machine are rewritten, and the actual swap happens on the NEXT boot
//! (`finish_staged_import`) — before any connection is open, with the previous
//! database kept beside it as a rescue copy. A crash anywhere before the swap
//! leaves the running install untouched.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::Manager;
use zip::write::SimpleFileOptions;

use crate::DbState;

/// The staged database the next boot swaps in.
const STAGED_NAME: &str = "library.db.import-staged";
/// Manifest filename inside the zip.
const MANIFEST_NAME: &str = "beetbot-portable.json";
/// Manifest format version this build writes and accepts.
const FORMAT_VERSION: u32 = 1;

/// Settings keys that must never travel: they are secrets or identify THIS
/// machine to an external service. A restored server links itself fresh.
/// Host-shell keys ride the generic `shell_` prefix; anything else a host
/// stores stays host-side by that convention too.
const SCRUB_SETTINGS_WHERE: &str = "key LIKE 'shell\\_%' ESCAPE '\\' \
     OR key LIKE 'ddns\\_%' ESCAPE '\\' \
     OR key LIKE 'ngrok\\_%' ESCAPE '\\'";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifest {
    format: String,
    version: u32,
    exported_at: i64,
    app_version: String,
    audio_included: bool,
    profiles: i64,
    playlists: i64,
    tracks: i64,
    audio_files: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSummary {
    pub profiles: i64,
    pub playlists: i64,
    pub tracks: i64,
    pub audio_files: i64,
    pub audio_included: bool,
    /// Import only: audio referenced by the snapshot that the zip did not
    /// carry and the target machine does not already have — those tracks were
    /// reset to `matched` for re-download.
    pub audio_missing: i64,
}

fn count(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
}

/// Collect `(id, path)` rows for a two-column SELECT.
fn id_path_rows(conn: &Connection, sql: &str) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|row| row.ok())
        .collect();
    Ok(rows)
}

/// The audio/avatar extension of a path, with the dot ("" when none).
fn dot_ext(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Write the full portable backup to `dest`. Blocking — call from
/// `spawn_blocking`.
fn export_blocking(
    db: Arc<Mutex<Connection>>,
    app_version: String,
    dest: PathBuf,
    include_audio: bool,
) -> Result<PortableSummary, String> {
    // 1) Consistent snapshot without closing the live connection.
    let snap_path = dest.with_extension("snapshot-tmp.db");
    let _ = std::fs::remove_file(&snap_path); // VACUUM INTO refuses to overwrite
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "VACUUM INTO ?1",
            rusqlite::params![snap_path.to_string_lossy()],
        )
        .map_err(|e| format!("snapshot failed: {e}"))?;
    }

    let result = export_from_snapshot(&snap_path, &app_version, &dest, include_audio);
    let _ = std::fs::remove_file(&snap_path);
    if result.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    result
}

fn export_from_snapshot(
    snap_path: &Path,
    app_version: &str,
    dest: &Path,
    include_audio: bool,
) -> Result<PortableSummary, String> {
    // 2) Scrub machine-bound rows from the SNAPSHOT (the live db is untouched).
    let snap = Connection::open(snap_path).map_err(|e| e.to_string())?;
    snap.execute(&format!("DELETE FROM settings WHERE {SCRUB_SETTINGS_WHERE}"), [])
        .map_err(|e| e.to_string())?;
    snap.execute("DELETE FROM streaming_sessions", [])
        .map_err(|e| e.to_string())?;

    // 3) Collect what travels beside the database.
    let audio: Vec<(i64, String)> = if include_audio {
        id_path_rows(
            &snap,
            "SELECT id, local_path FROM tracks WHERE local_path IS NOT NULL",
        )?
        .into_iter()
        .filter(|(_, p)| Path::new(p).is_file())
        .collect()
    } else {
        Vec::new()
    };
    let avatars: Vec<(i64, String)> = id_path_rows(
        &snap,
        "SELECT id, avatar_path FROM profiles WHERE avatar_path IS NOT NULL",
    )?
    .into_iter()
    .filter(|(_, p)| Path::new(p).is_file())
    .collect();

    let manifest = PortableManifest {
        format: "beetbot-portable".into(),
        version: FORMAT_VERSION,
        exported_at: chrono::Utc::now().timestamp(),
        app_version: app_version.to_string(),
        audio_included: include_audio,
        profiles: count(&snap, "SELECT COUNT(*) FROM profiles")?,
        playlists: count(&snap, "SELECT COUNT(*) FROM playlists")?,
        tracks: count(&snap, "SELECT COUNT(*) FROM tracks")?,
        audio_files: audio.len() as i64,
    };
    drop(snap); // flush before the file is zipped

    // 4) Zip. The database and manifest deflate well; audio is already
    // compressed, so store it as-is instead of wasting CPU.
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let deflate =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let store = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);

    zip.start_file(MANIFEST_NAME, deflate).map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("library.db", deflate).map_err(|e| e.to_string())?;
    std::io::copy(
        &mut File::open(snap_path).map_err(|e| e.to_string())?,
        &mut zip,
    )
    .map_err(|e| e.to_string())?;

    // Audio keyed by immutable track id — basenames can collide across
    // download folders; ids cannot. Import restores friendly names from the
    // snapshot's own `local_path` basenames.
    for (id, path) in &audio {
        zip.start_file(format!("audio/{id}{}", dot_ext(path)), store)
            .map_err(|e| e.to_string())?;
        std::io::copy(
            &mut File::open(path).map_err(|e| format!("{path}: {e}"))?,
            &mut zip,
        )
        .map_err(|e| e.to_string())?;
    }
    for (id, path) in &avatars {
        zip.start_file(format!("avatars/{id}{}", dot_ext(path)), store)
            .map_err(|e| e.to_string())?;
        std::io::copy(
            &mut File::open(path).map_err(|e| format!("{path}: {e}"))?,
            &mut zip,
        )
        .map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;

    Ok(PortableSummary {
        profiles: manifest.profiles,
        playlists: manifest.playlists,
        tracks: manifest.tracks,
        audio_files: manifest.audio_files,
        audio_included: include_audio,
        audio_missing: 0,
    })
}

/// Export the whole server (all profiles) as a portable zip at `path`.
#[tauri::command]
pub async fn portable_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    path: String,
    include_audio: bool,
) -> Result<PortableSummary, String> {
    let db = state.0.clone();
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        export_blocking(db, version, PathBuf::from(path), include_audio)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<PortableManifest, String> {
    let mut raw = String::new();
    archive
        .by_name(MANIFEST_NAME)
        .map_err(|_| "not a Beetbot portable backup (missing manifest)".to_string())?
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    let manifest: PortableManifest = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if manifest.format != "beetbot-portable" {
        return Err("not a Beetbot portable backup".into());
    }
    if manifest.version > FORMAT_VERSION {
        return Err(format!(
            "this backup needs a newer Beetbot (format v{} > v{FORMAT_VERSION})",
            manifest.version
        ));
    }
    Ok(manifest)
}

/// Read only the manifest, so the UI can confirm before replacing anything.
#[tauri::command]
pub async fn portable_peek(path: String) -> Result<PortableManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        read_manifest(&mut zip::ZipArchive::new(file).map_err(|e| e.to_string())?)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_to(
    archive: &mut zip::ZipArchive<File>,
    entry: &str,
    dest: &Path,
) -> Result<(), String> {
    let mut src = archive.by_name(entry).map_err(|e| format!("{entry}: {e}"))?;
    let mut out = File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut src, &mut out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Stage a portable backup for the next boot. Blocking — call from
/// `spawn_blocking`. Never touches the live database.
fn import_blocking(app_data: PathBuf, zip_path: PathBuf) -> Result<PortableSummary, String> {
    let file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let manifest = read_manifest(&mut archive)?;
    let entries: std::collections::HashSet<String> =
        (0..archive.len()).filter_map(|i| Some(archive.by_index(i).ok()?.name().to_string())).collect();

    // 1) Extract the snapshot beside the live db and prove it's intact.
    let staged_tmp = app_data.join(format!("{STAGED_NAME}.tmp"));
    let _ = std::fs::remove_file(&staged_tmp);
    extract_to(&mut archive, "library.db", &staged_tmp)?;
    {
        let check = Connection::open(&staged_tmp).map_err(|e| e.to_string())?;
        let verdict: String = check
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if verdict != "ok" {
            let _ = std::fs::remove_file(&staged_tmp);
            return Err(format!("backup database failed its integrity check: {verdict}"));
        }
        count(&check, "SELECT COUNT(*) FROM profiles")
            .map_err(|_| "backup database has no profiles table".to_string())?;
    }

    // 2) Re-home files + rewrite the old machine's absolute paths, ON THE
    //    STAGED COPY. Audio lands in the standard library folder; a file that
    //    already exists there with the same basename is reused (same-machine
    //    restore), otherwise it's extracted from the zip when present.
    let library_dir = app_data.join("library");
    let avatar_dir = library_dir.join("avatars");
    std::fs::create_dir_all(&avatar_dir).map_err(|e| e.to_string())?;

    let staged = Connection::open(&staged_tmp).map_err(|e| e.to_string())?;
    let tracks = id_path_rows(
        &staged,
        "SELECT id, local_path FROM tracks WHERE local_path IS NOT NULL",
    )?;
    let mut audio_missing: i64 = 0;
    for (id, old_path) in tracks {
        let basename = Path::new(&old_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.m4a"));
        let target = library_dir.join(&basename);
        let zip_entry = format!("audio/{id}{}", dot_ext(&old_path));

        let new_path = if target.is_file() {
            Some(target) // already here — same-machine restore
        } else if entries.contains(&zip_entry) {
            extract_to(&mut archive, &zip_entry, &target)?;
            Some(target)
        } else {
            None
        };
        match new_path {
            Some(p) => {
                staged
                    .execute(
                        "UPDATE tracks SET local_path = ?1 WHERE id = ?2",
                        rusqlite::params![p.to_string_lossy(), id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            None => {
                // The audio didn't travel and isn't here: hand the track back
                // to the downloader instead of pointing at a ghost file.
                audio_missing += 1;
                staged
                    .execute(
                        "UPDATE tracks SET local_path = NULL, file_size_bytes = NULL,
                                audio_format = NULL, downloaded_at = NULL,
                                status = CASE WHEN status = 'downloaded' THEN 'matched' ELSE status END
                         WHERE id = ?1",
                        rusqlite::params![id],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    let profiles = id_path_rows(
        &staged,
        "SELECT id, avatar_path FROM profiles WHERE avatar_path IS NOT NULL",
    )?;
    for (id, old_path) in profiles {
        let zip_entry = format!("avatars/{id}{}", dot_ext(&old_path));
        let basename = Path::new(&old_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.png"));
        let target = avatar_dir.join(&basename);
        if target.is_file() || {
            entries.contains(&zip_entry) && extract_to(&mut archive, &zip_entry, &target).is_ok()
        } {
            staged
                .execute(
                    "UPDATE profiles SET avatar_path = ?1 WHERE id = ?2",
                    rusqlite::params![target.to_string_lossy(), id],
                )
                .map_err(|e| e.to_string())?;
        } else {
            staged
                .execute("UPDATE profiles SET avatar_path = NULL WHERE id = ?1", [id])
                .map_err(|e| e.to_string())?;
        }
    }
    let summary = PortableSummary {
        profiles: count(&staged, "SELECT COUNT(*) FROM profiles")?,
        playlists: count(&staged, "SELECT COUNT(*) FROM playlists")?,
        tracks: count(&staged, "SELECT COUNT(*) FROM tracks")?,
        audio_files: manifest.audio_files,
        audio_included: manifest.audio_included,
        audio_missing,
    };
    drop(staged);

    // 3) Arm the swap: the marker file the next boot acts on.
    std::fs::rename(&staged_tmp, app_data.join(STAGED_NAME)).map_err(|e| e.to_string())?;
    Ok(summary)
}

/// Validate a portable backup and stage it; the swap happens on next launch.
#[tauri::command]
pub async fn portable_import(
    app: tauri::AppHandle,
    path: String,
) -> Result<PortableSummary, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || import_blocking(app_data, PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Restart the app so a staged import gets swapped in by the next boot.
#[tauri::command]
pub fn portable_restart(app: tauri::AppHandle) {
    app.restart();
}

// ---------------------------------------------------------------------------
// Boot-time swap
// ---------------------------------------------------------------------------

/// Called on startup BEFORE the database opens. When an import is staged,
/// swap it in and keep the previous database (and its WAL sidecars, which
/// belong to it and must never be replayed into the new file) as a rescue
/// copy beside it.
///
/// Public within the crate for the boot hook AND the round-trip tests below.
pub fn finish_staged_import(db_path: &Path) {
    let Some(dir) = db_path.parent() else { return };
    let staged = dir.join(STAGED_NAME);
    if !staged.is_file() {
        return;
    }
    let stamp = chrono::Utc::now().timestamp();
    let rescue = dir.join(format!("library.db.pre-import-{stamp}"));
    if db_path.is_file() {
        if let Err(e) = std::fs::rename(db_path, &rescue) {
            tracing::error!(?e, "staged import: could not set aside the old database — leaving everything untouched");
            return;
        }
        for ext in ["-wal", "-shm"] {
            let side = dir.join(format!("library.db{ext}"));
            if side.exists() {
                let _ = std::fs::rename(&side, dir.join(format!("library.db.pre-import-{stamp}{ext}")));
            }
        }
    }
    match std::fs::rename(&staged, db_path) {
        Ok(()) => tracing::info!(?rescue, "staged import swapped in; previous database kept beside it"),
        Err(e) => {
            tracing::error!(?e, "staged import: swap failed — restoring the previous database");
            let _ = std::fs::rename(&rescue, db_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir under the system temp root.
    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "beetbot-portable-test-{}-{}-{}",
            std::process::id(),
            label,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build an "old server": migrated db + audio + avatar + machine secrets.
    /// Returns (db handle, dir). Track 1's audio lives in the standard library
    /// folder; track 2's in a custom downloads folder (both must travel).
    fn seed_old_server(dir: &Path) -> Arc<Mutex<Connection>> {
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        let lib = dir.join("library");
        let downloads = dir.join("downloads-elsewhere");
        std::fs::create_dir_all(lib.join("avatars")).unwrap();
        std::fs::create_dir_all(&downloads).unwrap();
        let a1 = lib.join("One - Song.m4a");
        let a2 = downloads.join("Two - Song.m4a");
        let av = lib.join("avatars").join("kam.png");
        std::fs::write(&a1, b"AUDIO-ONE").unwrap();
        std::fs::write(&a2, b"AUDIO-TWO").unwrap();
        std::fs::write(&av, b"PNG-BYTES").unwrap();

        conn.execute_batch(&format!(
            "INSERT INTO profiles (name, avatar_color, avatar_path) VALUES ('Kam', '#1db954', '{av}');
             INSERT INTO profiles (name, avatar_color) VALUES ('Guest', '#333333');
             INSERT INTO playlists (spotify_id, name, track_count, profile_id) VALUES ('pl1', 'Roadtrip', 2, 1);
             INSERT INTO tracks (spotify_id, title, artists, duration_ms, status, local_path, file_size_bytes, audio_format, downloaded_at)
               VALUES ('t1', 'One', '[\"A\"]', 1000, 'downloaded', '{a1}', 9, 'm4a', 1);
             INSERT INTO tracks (spotify_id, title, artists, duration_ms, status, local_path, file_size_bytes, audio_format, downloaded_at)
               VALUES ('t2', 'Two', '[\"B\"]', 1000, 'downloaded', '{a2}', 9, 'm4a', 1);
             INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 1, 0), (1, 2, 1);
             INSERT INTO settings (key, value) VALUES
               ('shell_provider_device_token', 'SECRET-DEVICE'),
               ('ddns_token', 'SECRET-DDNS'),
               ('ngrok_authtoken', 'SECRET-NGROK'),
               ('auto_download', '1');
             INSERT INTO streaming_sessions (id, token_sha256, device_label, ip_address)
               VALUES ('s1', 'deadbeef', 'Kam iPhone', '192.168.1.50');",
            av = av.display(),
            a1 = a1.display(),
            a2 = a2.display(),
        ))
        .unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn setting(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok()
    }

    #[test]
    fn round_trip_moves_a_whole_server() {
        let old = scratch("old");
        let new = scratch("new");
        let db = seed_old_server(&old);
        let zip_path = old.join("portable.zip");

        // Migrations may seed default rows — measure, don't assume.
        let (profiles, kam_id, t1_id, t2_id) = {
            let conn = db.lock().unwrap();
            (
                count(&conn, "SELECT COUNT(*) FROM profiles").unwrap(),
                count(&conn, "SELECT id FROM profiles WHERE name = 'Kam'").unwrap(),
                count(&conn, "SELECT id FROM tracks WHERE spotify_id = 't1'").unwrap(),
                count(&conn, "SELECT id FROM tracks WHERE spotify_id = 't2'").unwrap(),
            )
        };

        // --- Export, audio included -----------------------------------------
        let s = export_blocking(db.clone(), "0.0-test".into(), zip_path.clone(), true).unwrap();
        assert_eq!((s.profiles, s.playlists, s.tracks, s.audio_files), (profiles, 1, 2, 2));

        // The LIVE db keeps its secrets — only the snapshot is scrubbed.
        {
            let live = db.lock().unwrap();
            assert_eq!(setting(&live, "shell_provider_device_token").as_deref(), Some("SECRET-DEVICE"));
        }

        // The zip's snapshot: secrets gone, preferences kept, sessions empty.
        {
            let file = File::open(&zip_path).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            let names: Vec<String> = (0..archive.len())
                .map(|i| archive.by_index(i).unwrap().name().to_string())
                .collect();
            assert!(names.contains(&format!("audio/{t1_id}.m4a")), "library-folder audio travels: {names:?}");
            assert!(names.contains(&format!("audio/{t2_id}.m4a")), "custom-folder audio travels");
            assert!(names.contains(&format!("avatars/{kam_id}.png")), "avatar travels");
            let snap_copy = old.join("snap-check.db");
            extract_to(&mut archive, "library.db", &snap_copy).unwrap();
            let snap = Connection::open(&snap_copy).unwrap();
            assert_eq!(setting(&snap, "shell_provider_device_token"), None, "device token must not travel");
            assert_eq!(setting(&snap, "ddns_token"), None);
            assert_eq!(setting(&snap, "ngrok_authtoken"), None);
            assert_eq!(setting(&snap, "auto_download").as_deref(), Some("1"), "preferences travel");
            assert_eq!(count(&snap, "SELECT COUNT(*) FROM streaming_sessions").unwrap(), 0, "pairings must not travel");
        }

        // --- Import on the "new machine" ------------------------------------
        let s = import_blocking(new.clone(), zip_path.clone()).unwrap();
        assert_eq!((s.profiles, s.playlists, s.tracks, s.audio_missing), (profiles, 1, 2, 0));
        let staged = new.join(STAGED_NAME);
        assert!(staged.is_file(), "import stages, never swaps in-place");
        assert_eq!(std::fs::read(new.join("library").join("One - Song.m4a")).unwrap(), b"AUDIO-ONE");
        assert_eq!(std::fs::read(new.join("library").join("Two - Song.m4a")).unwrap(), b"AUDIO-TWO", "custom-folder audio re-homed into the library");
        {
            let st = Connection::open(&staged).unwrap();
            let p: String = st.query_row("SELECT local_path FROM tracks WHERE spotify_id = 't2'", [], |r| r.get(0)).unwrap();
            assert!(p.starts_with(new.to_str().unwrap()), "old machine's absolute path rewritten: {p}");
            let av: String = st.query_row("SELECT avatar_path FROM profiles WHERE name = 'Kam'", [], |r| r.get(0)).unwrap();
            assert!(av.starts_with(new.to_str().unwrap()), "avatar path rewritten: {av}");
        }

        // --- Boot swap ------------------------------------------------------
        let new_db = new.join("library.db");
        std::fs::write(&new_db, b"the fresh server's empty db").unwrap();
        finish_staged_import(&new_db);
        assert!(!new.join(STAGED_NAME).exists(), "staged file consumed");
        let swapped = crate::db::open(&new_db).unwrap();
        assert_eq!(count(&swapped, "SELECT COUNT(*) FROM profiles").unwrap(), profiles);
        let rescued = std::fs::read_dir(&new)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("library.db.pre-import-"));
        assert!(rescued, "previous database kept as a rescue copy");
    }

    /// Full-size round trip against a real library. Run by hand:
    ///   BEETBOT_PORTABLE_SRC_DB=<path to a library.db> \
    ///   BEETBOT_PORTABLE_WORK=<scratch dir> \
    ///   cargo test real_data_round_trip -- --ignored --nocapture
    #[test]
    #[ignore = "needs BEETBOT_PORTABLE_SRC_DB + BEETBOT_PORTABLE_WORK env"]
    fn real_data_round_trip() {
        let src = std::env::var("BEETBOT_PORTABLE_SRC_DB").expect("BEETBOT_PORTABLE_SRC_DB");
        let work = PathBuf::from(std::env::var("BEETBOT_PORTABLE_WORK").expect("BEETBOT_PORTABLE_WORK"));
        std::fs::create_dir_all(&work).unwrap();

        let conn = Connection::open(&src).unwrap();
        let expected = (
            count(&conn, "SELECT COUNT(*) FROM profiles").unwrap(),
            count(&conn, "SELECT COUNT(*) FROM playlists").unwrap(),
            count(&conn, "SELECT COUNT(*) FROM tracks").unwrap(),
            count(&conn, "SELECT COUNT(*) FROM tracks WHERE local_path IS NOT NULL").unwrap(),
            count(&conn, "SELECT COUNT(*) FROM play_events").unwrap(),
        );
        let db = Arc::new(Mutex::new(conn));

        let zip_path = work.join("real-portable.zip");
        let t0 = std::time::Instant::now();
        let s = export_blocking(db, "real-test".into(), zip_path.clone(), true).unwrap();
        eprintln!(
            "EXPORT: {} profiles · {} playlists · {} tracks · {} audio files in {:.1}s → {} MB",
            s.profiles, s.playlists, s.tracks, s.audio_files,
            t0.elapsed().as_secs_f32(),
            std::fs::metadata(&zip_path).unwrap().len() / 1_048_576
        );

        let new_server = work.join("new-server");
        std::fs::create_dir_all(&new_server).unwrap();
        let t0 = std::time::Instant::now();
        let s = import_blocking(new_server.clone(), zip_path).unwrap();
        eprintln!(
            "IMPORT: staged in {:.1}s (audio_missing={})",
            t0.elapsed().as_secs_f32(),
            s.audio_missing
        );

        finish_staged_import(&new_server.join("library.db"));
        let new_db = crate::db::open(&new_server.join("library.db")).unwrap();
        let got = (
            count(&new_db, "SELECT COUNT(*) FROM profiles").unwrap(),
            count(&new_db, "SELECT COUNT(*) FROM playlists").unwrap(),
            count(&new_db, "SELECT COUNT(*) FROM tracks").unwrap(),
            count(&new_db, "SELECT COUNT(*) FROM tracks WHERE local_path IS NOT NULL").unwrap()
                + s.audio_missing,
            count(&new_db, "SELECT COUNT(*) FROM play_events").unwrap(),
        );
        assert_eq!(got, expected, "everything must survive the move");
        assert_eq!(
            count(&new_db, &format!("SELECT COUNT(*) FROM settings WHERE {SCRUB_SETTINGS_WHERE}")).unwrap(),
            0,
            "machine-bound secrets must not travel"
        );
        assert_eq!(count(&new_db, "SELECT COUNT(*) FROM streaming_sessions").unwrap(), 0);

        let p: String = new_db
            .query_row("SELECT local_path FROM tracks WHERE local_path IS NOT NULL LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(p.starts_with(new_server.to_str().unwrap()), "paths re-homed: {p}");
        assert!(Path::new(&p).is_file(), "audio really on disk: {p}");
        eprintln!("VERIFY: counts {got:?} match source, secrets scrubbed, audio re-homed");
    }

    #[test]
    fn catalog_only_import_hands_audio_back_to_the_downloader() {
        let old = scratch("old-lean");
        let new = scratch("new-lean");
        let db = seed_old_server(&old);
        let zip_path = old.join("portable-lean.zip");

        let s = export_blocking(db, "0.0-test".into(), zip_path.clone(), false).unwrap();
        assert_eq!((s.audio_included, s.audio_files), (false, 0));

        let s = import_blocking(new.clone(), zip_path).unwrap();
        assert_eq!(s.audio_missing, 2, "both files were left behind");
        let st = Connection::open(new.join(STAGED_NAME)).unwrap();
        let (status, path): (String, Option<String>) = st
            .query_row("SELECT status, local_path FROM tracks WHERE spotify_id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(status, "matched", "downloaded → matched so the downloader takes over");
        assert_eq!(path, None, "no ghost file paths");
    }
}
