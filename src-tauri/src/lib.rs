use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use rusqlite::Connection;
use tauri::Manager;

mod acme;
// `pub` so a separate full-build engine crate can consume the source-agnostic
// acquisition boundary (the trait, register_provider, TrackStatus) by name.
pub mod acquisition;
mod apple;
mod audio;
mod auth;
mod backfill;
mod cast;
mod charts;
mod cooccur;
// `pub` so the engine crate can call `db::register_migrations` (band 100+) and
// reuse `db::open`.
pub mod db;
mod deezer;
mod ddns;
mod import;
// `pub` so the engine reuses the file helpers (download dir, basename, artwork,
// ffmpeg) instead of carrying divergent copies.
pub mod library;
mod mdns;
mod media;
mod network;
mod ngrok;
mod profiles;
mod server;
mod settings;
mod soundcloud;
mod tags;
mod textnorm;
mod tls;

/// Shared SQLite connection. `Arc<Mutex<...>>` so spawned download tasks can
/// take owned clones while the Tauri-managed `State` keeps the same handle.
/// Mutex is required because `rusqlite::Connection` is `Send` but not `Sync`;
/// async Tauri commands must scope locks so the mutex is never held across
/// an `.await`.
pub struct DbState(pub Arc<Mutex<Connection>>);

/// Single-flight guard for the metadata backfill (album art + ISRC). Both the
/// manual Settings command and the automatic post-import sweep funnel through
/// `drive_backfill`, so only one Deezer sweep ever runs at a time. `RERUN` lets
/// a request that arrives mid-sweep trigger one more pass instead of a second
/// concurrent sweep that would double the Deezer load and emit interleaved
/// progress.
static BACKFILL_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static BACKFILL_RERUN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[derive(serde::Serialize)]
struct DbHealth {
    migration_version: i64,
    path: String,
}

#[tauri::command]
fn db_health(state: tauri::State<'_, DbState>, app: tauri::AppHandle) -> Result<DbHealth, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let version = db::current_version(&conn).map_err(|e| e.to_string())?;
    let path = db_path(&app).map_err(|e| e.to_string())?;
    Ok(DbHealth {
        migration_version: version,
        path: path.to_string_lossy().into_owned(),
    })
}

// ---- User profiles (Netflix-style) ----------------------------------
//
// Profiles own playlists; the music library (tracks + files) is shared.

#[tauri::command]
fn list_profiles(state: tauri::State<'_, DbState>) -> Result<Vec<profiles::Profile>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    profiles::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_profile(
    state: tauri::State<'_, DbState>,
    name: String,
    avatar_color: String,
    pin: Option<String>,
) -> Result<profiles::Profile, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    profiles::create(&conn, &name, &avatar_color, pin.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_profile(
    state: tauri::State<'_, DbState>,
    id: i64,
    name: String,
    avatar_color: String,
) -> Result<profiles::Profile, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    profiles::update(&conn, id, &name, &avatar_color).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_profile_pin(
    state: tauri::State<'_, DbState>,
    id: i64,
    pin: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    profiles::set_pin(&conn, id, pin.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn verify_profile_pin(
    state: tauri::State<'_, DbState>,
    id: i64,
    pin: String,
) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    profiles::verify_pin(&conn, id, &pin).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_profile(state: tauri::State<'_, DbState>, id: i64) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    // Grab the avatar file path before deleting so we can clean it up after.
    let avatar = profiles::avatar_path(&conn, id).ok().flatten();
    profiles::delete(&mut conn, id).map_err(|e| e.to_string())?;
    if let Some(p) = avatar {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Copy a chosen image into the app's avatars dir and set it as the profile's
/// photo. Stored under `<app_data>/library/avatars/` so it falls inside the
/// asset-protocol scope (desktop) and can be served to the phone.
#[tauri::command]
fn set_profile_avatar(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    id: i64,
    source_path: String,
) -> Result<profiles::Profile, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err("Selected image could not be found.".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library")
        .join("avatars");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic"))
        .unwrap_or_else(|| "jpg".to_string());
    let dest = dir.join(format!("{id}-{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    let dest_str = dest.to_string_lossy().into_owned();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let old = profiles::avatar_path(&conn, id).map_err(|e| e.to_string())?;
    profiles::set_avatar(&conn, id, Some(&dest_str)).map_err(|e| e.to_string())?;
    if let Some(old) = old {
        let _ = std::fs::remove_file(old);
    }
    profiles::get(&conn, id).map_err(|e| e.to_string())
}

/// Read a user-picked image file and return it as a `data:` URL so the
/// in-app cropper can load it (the source lives outside the asset-protocol
/// scope, so the webview can't fetch it directly). Capped to avoid OOM on a
/// huge file.
#[tauri::command]
fn read_image_data_url(source_path: String) -> Result<String, String> {
    let path = PathBuf::from(&source_path);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("Image is too large (max 40 MB).".into());
    }
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        _ => "image/jpeg",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Save a cropped avatar (base64 JPEG bytes produced by the in-app cropper)
/// as a profile's photo. Same storage + cleanup as `set_profile_avatar`, but
/// the bytes come from a canvas instead of a file path.
#[tauri::command]
fn set_profile_avatar_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    id: i64,
    data_base64: String,
) -> Result<profiles::Profile, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim().as_bytes())
        .map_err(|e| format!("bad image data: {e}"))?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library")
        .join("avatars");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}-{}.jpg", uuid::Uuid::new_v4()));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    let dest_str = dest.to_string_lossy().into_owned();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let old = profiles::avatar_path(&conn, id).map_err(|e| e.to_string())?;
    profiles::set_avatar(&conn, id, Some(&dest_str)).map_err(|e| e.to_string())?;
    if let Some(old) = old {
        let _ = std::fs::remove_file(old);
    }
    profiles::get(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_profile_avatar(
    state: tauri::State<'_, DbState>,
    id: i64,
) -> Result<profiles::Profile, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let old = profiles::avatar_path(&conn, id).map_err(|e| e.to_string())?;
    profiles::set_avatar(&conn, id, None).map_err(|e| e.to_string())?;
    if let Some(old) = old {
        let _ = std::fs::remove_file(old);
    }
    profiles::get(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_csv(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    path: String,
    playlist_name: Option<String>,
) -> Result<import::ImportSummary, String> {
    let summary = {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        import::import_exportify_csv(
            &mut conn,
            std::path::Path::new(&path),
            playlist_name.as_deref(),
        )
        .map_err(|e| e.to_string())?
    };
    // Auto-fill missing artwork + ISRC for the freshly-imported tracks (and any
    // older blanks) from Deezer, in the background.
    if summary.tracks_added > 0 {
        spawn_post_import_backfill(&app, state.0.clone());
    }
    Ok(summary)
}

#[tauri::command]
fn import_exportify_archive(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    path: String,
) -> Result<import::BulkImportSummary, String> {
    let summary = {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        import::import_exportify_archive(&mut conn, std::path::Path::new(&path))
            .map_err(|e| e.to_string())?
    };
    if summary.tracks_added > 0 {
        spawn_post_import_backfill(&app, state.0.clone());
    }
    Ok(summary)
}

/// Import a public Apple Music playlist or album by URL. Scrapes the public web
/// page for its tracklist (title + artist per song), then stores each track
/// metadata-only — the user attaches their own audio file afterwards. Scoped to
/// the profile.
#[tauri::command]
async fn import_apple_music_playlist(
    state: tauri::State<'_, DbState>,
    profile_id: i64,
    url: String,
) -> Result<import::ImportSummary, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Paste an Apple Music playlist or album link first.".into());
    }
    let playlist = apple::fetch_playlist(&url)
        .await
        .map_err(|e| format!("Couldn't read that Apple Music link: {e}"))?;
    if playlist.tracks.is_empty() {
        return Err(
            "No tracks found — make sure it's a link to a public Apple Music playlist or album."
                .into(),
        );
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    import::insert_apple_music_playlist(&mut conn, profile_id, &url, &playlist)
        .map_err(|e| e.to_string())
}

/// Import a public SoundCloud playlist/set by URL. Extracts a public client_id
/// from SoundCloud's own web player (no API key needed), resolves the set, and
/// batch-fetches each track's metadata. Metadata only — Beetbot is local-first,
/// so the user attaches their own audio file to each imported track. Scoped to
/// the profile.
#[tauri::command]
async fn import_soundcloud_playlist(
    state: tauri::State<'_, DbState>,
    profile_id: i64,
    url: String,
) -> Result<import::ImportSummary, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a SoundCloud playlist or set link first.".into());
    }
    let playlist = soundcloud::fetch_playlist(&url)
        .await
        .map_err(|e| format!("Couldn't read that SoundCloud link: {e}"))?;
    if playlist.tracks.is_empty() {
        return Err(
            "No tracks found — make sure it's a link to a public SoundCloud playlist/set."
                .into(),
        );
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    import::insert_soundcloud_playlist(&mut conn, profile_id, &url, &playlist)
        .map_err(|e| e.to_string())
}

/// Open exportify.net so the user can export playlists their own (Dev Mode)
/// Beetbot Spotify app cannot read. Pavel's exportify app lives in Spotify's
/// Extended Quota Mode -- the magic is in his client_id, not in the JS.
///
/// We open in the system browser rather than a Tauri webview because Google's
/// OAuth refuses to authenticate inside embedded WebViews (security policy
/// since 2021), and most Spotify accounts are Google-linked. The system
/// browser also gives us proper download handling, cookie persistence, and
/// password autofill for free.
#[tauri::command]
async fn open_exportify_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://exportify.net/", None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct PlaylistSummary {
    id: i64,
    name: String,
    track_count: i64,
    /// How many of this playlist's tracks have an audio file on disk.
    /// Powers the "X/Y downloaded" readout in the Downloads tab without
    /// the UI having to fetch every track row per playlist.
    downloaded_count: i64,
    /// How many tracks are stuck in 'needs-review' (auto-match found no
    /// confident/downloadable source). Lets the Downloads tab badge the
    /// playlists that have songs to resolve without expanding them.
    needs_review_count: i64,
    last_synced_at: Option<i64>,
    source: &'static str,
    cover_url: Option<String>,
    /// Playlist owner / album artist (for the "Album · Artist" subtitle).
    owner: Option<String>,
}

#[derive(serde::Serialize)]
struct PlaylistDetail {
    id: i64,
    name: String,
    description: Option<String>,
    cover_url: Option<String>,
    owner: Option<String>,
    last_synced_at: Option<i64>,
    source: &'static str,
    track_count: i64,
    total_duration_ms: i64,
}

#[derive(serde::Serialize)]
struct PlaylistTrack {
    id: i64,
    spotify_id: String,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    isrc: Option<String>,
    status: String,
    failure_reason: Option<String>,
    local_path: Option<String>,
    position: i64,
    added_at: Option<i64>,
}

#[tauri::command]
fn list_playlists(
    state: tauri::State<'_, DbState>,
    profile_id: i64,
) -> Result<Vec<PlaylistSummary>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // Only show playlists with at least one local track row. This naturally
    // hides:
    //   - Spotify-owned algorithmic / editorial playlists whose tracks
    //     endpoint 403s for new (Dev Mode) apps,
    //   - Empty user-owned playlists like "My playlist #32",
    //   - Any future sync state where the playlist row exists but tracks
    //     never landed.
    // The displayed count is the actual `playlist_tracks` count rather than
    // the API-reported total so the UI never claims tracks we can't show.
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name,
                    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id)
                        AS local_track_count,
                    p.last_synced_at,
                    p.spotify_id,
                    COALESCE(
                        p.cover_url,
                        (SELECT t.album_art_url
                         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                         WHERE pt.playlist_id = p.id AND t.album_art_url IS NOT NULL
                         ORDER BY pt.position
                         LIMIT 1)
                    ) AS effective_cover,
                    (SELECT COUNT(*)
                     FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.playlist_id = p.id
                       AND t.local_path IS NOT NULL AND t.local_path != '')
                        AS downloaded_count,
                    (SELECT COUNT(*)
                     FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.playlist_id = p.id AND t.status = 'needs-review')
                        AS needs_review_count,
                    p.owner
             FROM playlists p
             WHERE p.profile_id = ?1
               AND EXISTS (
                 SELECT 1 FROM playlist_tracks pt2 WHERE pt2.playlist_id = p.id
             )
             ORDER BY p.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([profile_id], |r| {
            let sid: String = r.get(4)?;
            let source = playlist_source(&sid);
            Ok(PlaylistSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                track_count: r.get(2)?,
                downloaded_count: r.get(6)?,
                needs_review_count: r.get(7)?,
                last_synced_at: r.get(3)?,
                source,
                cover_url: r.get(5)?,
                owner: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn playlist_source(spotify_id: &str) -> &'static str {
    // The imported Spotify "Liked Songs" lands as `csv:liked-songs`; treat it
    // (and any `liked:` playlist) as the dedicated "liked" source so the UI
    // can pin it to the top of the library and badge it with a heart.
    if spotify_id == "csv:liked-songs" || spotify_id.starts_with("liked:") {
        "liked"
    } else if spotify_id.starts_with("csv:") {
        "csv"
    } else if spotify_id.starts_with("album:") {
        // A whole-album import (POST /api/albums/import). Typed
        // distinctly from a hand-built playlist so the library can label
        // and filter it as an album.
        "album"
    } else if spotify_id.starts_with("local:") {
        // Playlists minted via POST /api/playlists. Visible to the user,
        // ignored by sync.
        "local"
    } else if spotify_id.starts_with("soundcloud:") {
        // Imported from a SoundCloud playlist link; metadata only.
        "soundcloud"
    } else if spotify_id.starts_with("apple:") {
        // Imported from a public Apple Music playlist link; metadata only
        // (Apple audio is DRM-locked).
        "apple"
    } else {
        "spotify"
    }
}

/// Delete a playlist row by id. `playlist_tracks` rows for it are
/// removed automatically by the foreign-key ON DELETE CASCADE
/// declared in migration 001. Track rows themselves are NEVER
/// touched — they may exist in other playlists, and even if not,
/// leaving the audio file on disk is the safe default (users can
/// re-link them by importing again).
///
/// Caller's responsibility to warn the user that Spotify-mirrored
/// playlists will be restored on the next sync (we don't enforce
/// that here so the API stays a thin DB wrapper).
pub(crate) fn delete_playlist_row(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<bool> {
    let removed = conn.execute(
        "DELETE FROM playlists WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(removed > 0)
}

#[tauri::command]
fn delete_playlist(
    state: tauri::State<'_, DbState>,
    id: i64,
) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let removed = delete_playlist_row(&conn, id).map_err(|e| e.to_string())?;
    if removed {
        tracing::info!(playlist_id = id, "playlist deleted via IPC");
    }
    Ok(removed)
}

/// Rename a playlist by id (display name only). Returns false if no such row.
/// `name` should already be trimmed/validated by the caller. Shared by the
/// `rename_playlist` IPC command and the PATCH /api/playlists/:id HTTP handler.
pub(crate) fn rename_playlist_row(
    conn: &rusqlite::Connection,
    id: i64,
    name: &str,
    description: Option<&str>,
) -> rusqlite::Result<bool> {
    // `description = None` ⇒ name-only edit (the phone's rename). `Some(..)`
    // also sets the description; an empty/blank description clears it to NULL.
    let changed = match description {
        Some(desc) => {
            let desc = desc.trim();
            let desc: Option<&str> = if desc.is_empty() { None } else { Some(desc) };
            conn.execute(
                "UPDATE playlists SET name = ?1, description = ?2 WHERE id = ?3",
                rusqlite::params![name, desc, id],
            )?
        }
        None => conn.execute(
            "UPDATE playlists SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )?,
    };
    Ok(changed > 0)
}

#[tauri::command]
fn rename_playlist(
    state: tauri::State<'_, DbState>,
    id: i64,
    name: String,
    description: Option<String>,
) -> Result<bool, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name is required".into());
    }
    if name.chars().count() > 200 {
        return Err("name too long".into());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let changed = rename_playlist_row(&conn, id, name, description.as_deref())
        .map_err(|e| e.to_string())?;
    if changed {
        tracing::info!(playlist_id = id, %name, "playlist details edited via IPC");
    }
    Ok(changed)
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BackfillResult {
    /// Tracks missing artwork and/or ISRC (the preview count).
    scanned: usize,
    /// Tracks we successfully wrote new metadata to.
    updated: usize,
    /// How many ISRCs we newly filled in.
    isrc_added: usize,
    /// How many album covers we newly filled in.
    art_added: usize,
    /// Tracks we couldn't confidently match on Deezer (left untouched).
    unmatched: usize,
    /// True when a backfill was already running and this request was folded
    /// into it (the manual button clicked while the auto-sweep is in flight).
    already_running: bool,
}

/// Live progress for the metadata backfill, emitted as `backfill-progress`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackfillProgressEvent {
    /// Tracks processed so far this run.
    count: usize,
    /// Total tracks to process this run.
    total: usize,
    /// Tracks updated so far.
    updated: usize,
    /// Most recently processed track title (for display).
    title: Option<String>,
}

/// Collect tracks missing album art and/or an ISRC. `Some(id)` scopes the scan
/// to that profile's playlists (the manual button); `None` scans the whole
/// library (the automatic post-import pass, which doesn't know which profile
/// owns the freshly-imported playlists).
fn collect_backfill_gaps(
    conn: &Connection,
    profile_filter: Option<i64>,
) -> Result<Vec<backfill::TrackGap>, rusqlite::Error> {
    type GapRow = (
        i64,
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    fn map_row(r: &rusqlite::Row) -> rusqlite::Result<GapRow> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
        ))
    }
    let rows: Vec<GapRow> = match profile_filter {
        Some(profile_id) => {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT t.id, t.title, t.artists, t.duration_ms, t.isrc,
                        t.album_art_url, t.release_year, t.genre
                 FROM tracks t
                 JOIN playlist_tracks pt ON pt.track_id = t.id
                 JOIN playlists p ON p.id = pt.playlist_id
                 WHERE p.profile_id = ?1
                   AND ( t.isrc IS NULL OR t.isrc = ''
                      OR t.album_art_url IS NULL OR t.album_art_url = ''
                      OR t.release_year IS NULL OR t.genre IS NULL )",
            )?;
            let collected: Vec<GapRow> = stmt
                .query_map(rusqlite::params![profile_id], map_row)?
                .filter_map(Result::ok)
                .collect();
            collected
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, title, artists, duration_ms, isrc, album_art_url,
                        release_year, genre
                 FROM tracks
                 WHERE ( isrc IS NULL OR isrc = ''
                      OR album_art_url IS NULL OR album_art_url = ''
                      OR release_year IS NULL OR genre IS NULL )",
            )?;
            let collected: Vec<GapRow> = stmt
                .query_map([], map_row)?
                .filter_map(Result::ok)
                .collect();
            collected
        }
    };
    Ok(rows
        .into_iter()
        .map(|(id, title, artists_json, duration_ms, isrc, art, year, genre)| {
            let raw_primary = serde_json::from_str::<Vec<String>>(&artists_json)
                .ok()
                .and_then(|v| v.into_iter().next())
                .unwrap_or_default();
            // Exportify stores a multi-artist track as one ";"-joined string
            // (e.g. "Drake;Travis Scott"); take just the primary for
            // searching/matching. Split only on ";" — a single artist name can
            // legitimately contain a comma ("Tyler, The Creator").
            let primary_artist = raw_primary
                .split(';')
                .next()
                .unwrap_or(&raw_primary)
                .trim()
                .to_string();
            backfill::TrackGap {
                id,
                title,
                primary_artist,
                duration_ms,
                existing_isrc: isrc.filter(|s| !s.is_empty()),
                missing_art: art.map(|s| s.is_empty()).unwrap_or(true),
                missing_year: year.is_none(),
                missing_genre: genre.map(|s| s.is_empty()).unwrap_or(true),
            }
        })
        .collect())
}

/// Resolve each gap against Deezer (network, outside the DB lock) and
/// COALESCE-write any newly-found art/ISRC, emitting a `backfill-progress`
/// event per track. Sequential keeps us under Deezer's ~50-req/5s cap; the
/// client's own backoff handles spikes. Shared by the manual command and the
/// automatic post-import pass.
async fn backfill_run(
    app: tauri::AppHandle,
    db: Arc<Mutex<Connection>>,
    profile_filter: Option<i64>,
) -> Result<BackfillResult, String> {
    use tauri::Emitter;

    // Collect gaps in a short locked scope — the guard must never cross `.await`.
    let gaps: Vec<backfill::TrackGap> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        collect_backfill_gaps(&conn, profile_filter).map_err(|e| e.to_string())?
    };

    let scanned = gaps.len();
    let total = gaps.len();
    let client = deezer::DeezerClient::new();
    // Plain client for the iTunes art fallback (keyless, no special headers).
    let itunes_http = reqwest::Client::new();
    // Drop LEGACY (v1) iTunes miss markers: the matcher has since gained
    // storefront selection + term stripping, so v1 "definitive" misses may now
    // be matchable. The current code writes v2 keys only; this is a no-op once
    // the old rows are gone.
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM settings WHERE key LIKE 'itunes_art_miss:%'",
            [],
        );
    }
    let mut updated = 0usize;
    let mut isrc_added = 0usize;
    let mut art_added = 0usize;
    let mut year_added = 0usize;
    let mut genre_added = 0usize;
    let mut unmatched = 0usize;
    // Genre lives only on the album object, and many tracks share an album, so
    // resolve each Deezer album (genre bucket + release year) at most once.
    let mut album_cache: std::collections::HashMap<u64, (Option<String>, Option<i64>)> =
        std::collections::HashMap::new();

    for (i, gap) in gaps.iter().enumerate() {
        let resolved = backfill::resolve_gap(&client, gap).await;
        let new_isrc = resolved
            .isrc
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let mut new_art = resolved
            .album_art_url
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        // iTunes fallback: only when the track is missing art AND Deezer's
        // resolve produced none (regional gaps — e.g. CJK OSTs). Verified
        // against the hit's own title/artist and paced inside the helper, so
        // it can't return junk art or burst Apple's keyless API. A DEFINITIVE
        // no-match is recorded per track (7-day TTL) so permanently-
        // unmatchable rows stop paying the paced call on every launch;
        // transient failures are never recorded (next run retries), mirroring
        // the MBID cache's only-cache-definitive-results rule.
        if new_art.is_none() && gap.missing_art {
            const ITUNES_MISS_RETRY_SECS: i64 = 7 * 24 * 3600;
            // v2: bump the prefix whenever the matching/search logic improves,
            // so previously-recorded "definitive" misses get one fresh attempt
            // (backfill_run deletes the prior version's keys).
            let miss_key = format!("itunes_art_miss2:{}", gap.id);
            let now = chrono::Utc::now().timestamp();
            let miss_fresh = {
                let conn = db.lock().map_err(|e| e.to_string())?;
                crate::settings::get_setting(&conn, &miss_key)
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_some_and(|at| now - at < ITUNES_MISS_RETRY_SECS)
            };
            if !miss_fresh {
                match backfill::itunes_art_lookup(
                    &itunes_http,
                    &gap.title,
                    &gap.primary_artist,
                )
                .await
                {
                    backfill::ItunesArt::Found(url) => new_art = Some(url),
                    backfill::ItunesArt::NoMatch => {
                        let conn = db.lock().map_err(|e| e.to_string())?;
                        let _ = crate::settings::set_setting(
                            &conn,
                            &miss_key,
                            &now.to_string(),
                        );
                    }
                    backfill::ItunesArt::Unavailable => {}
                }
            }
        }

        // Year + genre. Year may already be on the resolved track; genre always
        // needs the album. Fetch the album (cached) only when this track still
        // needs the genre, or needs the year and the track didn't carry one.
        let mut new_year = if gap.missing_year { resolved.release_year } else { None };
        let mut new_genre: Option<String> = None;
        let need_album = (gap.missing_genre || (gap.missing_year && new_year.is_none()))
            && resolved.album_id.is_some();
        if need_album {
            let aid = resolved.album_id.unwrap();
            // The cache holds ONLY successful fetches — a transient failure is
            // never cached, so a later track sharing the album retries it.
            let (bucket, album_year, fetched_ok) = match album_cache.get(&aid) {
                Some((b, y)) => (b.clone(), *y, true),
                None => match client.get_album(aid).await {
                    Ok(a) => {
                        let info = (
                            a.primary_genre().and_then(|g| backfill::genre_bucket(g)),
                            a.release_date.as_deref().and_then(|d| backfill::parse_year(d)),
                        );
                        album_cache.insert(aid, info.clone());
                        (info.0, info.1, true)
                    }
                    Err(_) => (None, None, false),
                },
            };
            if gap.missing_year && new_year.is_none() {
                new_year = album_year;
            }
            // Stamp "Unknown" only when the album was actually fetched but its
            // genre doesn't map to a bucket (e.g. "Films/Games") — NEVER on a
            // transient fetch failure, which would permanently suppress retries.
            // The Genre-mix builder excludes "Unknown".
            if gap.missing_genre && fetched_ok {
                new_genre = Some(bucket.unwrap_or_else(|| "Unknown".to_string()));
            }
        }

        // Only treat a field as fillable when Deezer gave us a value AND this
        // track was actually missing it.
        let will_write_isrc = new_isrc.is_some() && gap.existing_isrc.is_none();
        let will_write_art = new_art.is_some() && gap.missing_art;
        let will_write_year = new_year.is_some() && gap.missing_year;
        let will_write_genre = new_genre.is_some() && gap.missing_genre;

        if will_write_isrc || will_write_art || will_write_year || will_write_genre {
            let conn = db.lock().map_err(|e| e.to_string())?;
            // The WHERE mirrors the intent: a column is only touched when we
            // have a value for it AND it's currently blank, so updated_at never
            // bumps unless a real field changes.
            let changed = conn
                .execute(
                    "UPDATE tracks SET
                         isrc          = COALESCE(NULLIF(isrc, ''), ?1),
                         album_art_url = COALESCE(NULLIF(album_art_url, ''), ?2),
                         release_year  = COALESCE(release_year, ?4),
                         genre         = COALESCE(NULLIF(genre, ''), ?5),
                         updated_at    = strftime('%s','now')
                     WHERE id = ?3
                       AND ( (?1 IS NOT NULL AND (isrc IS NULL OR isrc = ''))
                          OR (?2 IS NOT NULL AND (album_art_url IS NULL OR album_art_url = ''))
                          OR (?4 IS NOT NULL AND release_year IS NULL)
                          OR (?5 IS NOT NULL AND (genre IS NULL OR genre = '')) )",
                    rusqlite::params![new_isrc, new_art, gap.id, new_year, new_genre],
                )
                .map_err(|e| e.to_string())?;
            drop(conn);
            if changed > 0 {
                updated += 1;
                if will_write_isrc {
                    isrc_added += 1;
                }
                if will_write_art {
                    art_added += 1;
                }
                if will_write_year {
                    year_added += 1;
                }
                if will_write_genre {
                    genre_added += 1;
                }
            } else {
                unmatched += 1;
            }
        } else {
            unmatched += 1;
        }

        let _ = app.emit(
            "backfill-progress",
            BackfillProgressEvent {
                count: i + 1,
                total,
                updated,
                title: Some(gap.title.clone()),
            },
        );
    }

    tracing::info!(
        ?profile_filter,
        scanned,
        updated,
        isrc_added,
        art_added,
        year_added,
        genre_added,
        unmatched,
        "metadata backfill complete"
    );

    Ok(BackfillResult {
        scanned,
        updated,
        isrc_added,
        art_added,
        unmatched,
        already_running: false,
    })
}

/// Single-flight driver for the metadata backfill. If a sweep is already
/// running, it flags a rerun (so tracks imported or confirmed just now aren't
/// missed) and returns `already_running` instead of launching a second
/// concurrent Deezer sweep. `RUNNING` is released on every exit — including a
/// panic — via the RAII guard, so a one-off failure can never wedge the flag
/// `true` and disable all future backfills.
async fn drive_backfill(app: tauri::AppHandle, db: Arc<Mutex<Connection>>) -> BackfillResult {
    use std::sync::atomic::Ordering;

    if BACKFILL_RUNNING.swap(true, Ordering::SeqCst) {
        BACKFILL_RERUN.store(true, Ordering::SeqCst);
        return BackfillResult {
            already_running: true,
            ..Default::default()
        };
    }

    // Release RUNNING whenever this future exits — normal return OR panic.
    struct ReleaseOnDrop;
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            BACKFILL_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _release = ReleaseOnDrop;

    // Report the first (bulk) pass's counts; any reruns just mop up stragglers
    // imported while the first pass was running.
    let mut first: Option<BackfillResult> = None;
    loop {
        BACKFILL_RERUN.store(false, Ordering::SeqCst);
        match backfill_run(app.clone(), db.clone(), None).await {
            Ok(r) => {
                if first.is_none() {
                    first = Some(r);
                }
            }
            Err(e) => tracing::warn!(error = %e, "metadata backfill failed"),
        }
        if !BACKFILL_RERUN.swap(false, Ordering::SeqCst) {
            break;
        }
    }
    first.unwrap_or_default()
}

/// Fire-and-forget the automatic library-wide metadata backfill after an
/// import. The single-flight guard in [`drive_backfill`] prevents a second
/// concurrent sweep.
fn spawn_post_import_backfill(app: &tauri::AppHandle, db: Arc<Mutex<Connection>>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = drive_backfill(app, db).await;
    });
}


#[tauri::command]
fn get_playlist(
    state: tauri::State<'_, DbState>,
    id: i64,
) -> Result<PlaylistDetail, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT p.id, p.name, p.description, p.owner, p.last_synced_at, p.spotify_id,
                COALESCE(
                    p.cover_url,
                    (SELECT t.album_art_url
                     FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.playlist_id = p.id AND t.album_art_url IS NOT NULL
                     ORDER BY pt.position
                     LIMIT 1)
                ) AS effective_cover,
                (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id)
                    AS local_track_count,
                (SELECT COALESCE(SUM(t.duration_ms), 0)
                 FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = p.id) AS total_duration_ms
         FROM playlists p
         WHERE p.id = ?1",
        rusqlite::params![id],
        |r| {
            let sid: String = r.get(5)?;
            Ok(PlaylistDetail {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                owner: r.get(3)?,
                last_synced_at: r.get(4)?,
                source: playlist_source(&sid),
                cover_url: r.get(6)?,
                track_count: r.get(7)?,
                total_duration_ms: r.get(8)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct TrackSearchResult {
    id: i64,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    local_path: Option<String>,
    status: String,
    playlist_id: Option<i64>,
    playlist_name: Option<String>,
}

/// Normalise a user-typed search string into an FTS5 query: split on
/// whitespace, strip non-alphanumeric chars per token, lowercase, append
/// `*` for prefix matching, join with spaces (implicit AND).
///
/// Examples:
///   "Tame Imp" -> "tame* imp*"
///   "Beyoncé"  -> "beyoncé*"
///   "XO"       -> "xo*"
fn fts_query_from_user_input(input: &str) -> String {
    input
        .split_whitespace()
        .map(|tok| {
            tok.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|t| !t.is_empty())
        .map(|t| format!("{t}*"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
fn search_tracks(
    state: tauri::State<'_, DbState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<TrackSearchResult>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    let fts_query = fts_query_from_user_input(trimmed);
    if fts_query.is_empty() {
        return Ok(vec![]);
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.artists, t.album, t.album_art_url,
                    t.duration_ms, t.local_path, t.status,
                    (SELECT p.id FROM playlist_tracks pt
                       JOIN playlists p ON p.id = pt.playlist_id
                      WHERE pt.track_id = t.id ORDER BY pt.position LIMIT 1) AS playlist_id,
                    (SELECT p.name FROM playlist_tracks pt
                       JOIN playlists p ON p.id = pt.playlist_id
                      WHERE pt.track_id = t.id ORDER BY pt.position LIMIT 1) AS playlist_name
             FROM tracks t
             JOIN tracks_fts ON tracks_fts.rowid = t.id
             WHERE tracks_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![fts_query, limit.unwrap_or(50)],
            |r| {
                let artists_json: String = r.get(2)?;
                let artists: Vec<String> =
                    serde_json::from_str(&artists_json).unwrap_or_default();
                Ok(TrackSearchResult {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artists,
                    album: r.get(3)?,
                    album_art_url: r.get(4)?,
                    duration_ms: r.get(5)?,
                    local_path: r.get(6)?,
                    status: r.get(7)?,
                    playlist_id: r.get(8)?,
                    playlist_name: r.get(9)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tracks(
    state: tauri::State<'_, DbState>,
    playlist_id: i64,
) -> Result<Vec<PlaylistTrack>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.spotify_id, t.title, t.artists, t.album, t.album_art_url,
                    t.duration_ms, t.isrc, t.status, t.failure_reason, t.local_path,
                    pt.position, pt.added_at
             FROM tracks t
             JOIN playlist_tracks pt ON pt.track_id = t.id
             WHERE pt.playlist_id = ?1
             ORDER BY pt.position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![playlist_id], |r| {
            let artists_json: String = r.get(3)?;
            let artists: Vec<String> =
                serde_json::from_str(&artists_json).unwrap_or_default();
            Ok(PlaylistTrack {
                id: r.get(0)?,
                spotify_id: r.get(1)?,
                title: r.get(2)?,
                artists,
                album: r.get(4)?,
                album_art_url: r.get(5)?,
                duration_ms: r.get(6)?,
                isrc: r.get(7)?,
                status: r.get(8)?,
                failure_reason: r.get(9)?,
                local_path: r.get(10)?,
                position: r.get(11)?,
                added_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

// ---- Library views (Daft-style Artists / Albums / Songs) ------------------
// Read-only aggregations over the whole shared `tracks` table (independent of
// playlists). Artists/Albums are derived from the per-track `artists` JSON
// array (first/primary artist) and the `album` text column, normalized with the
// same `artist_key()` used everywhere else so casing/spacing never splits a
// group. Additive: nothing else queries through these.

#[derive(serde::Serialize)]
struct LibraryAlbum {
    album: String,
    artist: Option<String>,
    album_art_url: Option<String>,
    track_count: i64,
}

#[derive(serde::Serialize)]
struct LibraryArtist {
    name: String,
    key: String,
    album_art_url: Option<String>,
    track_count: i64,
}

/// Every track in the library, flat — the "Songs" view. Reuses `PlaylistTrack`
/// (no playlist context, so `position` is 0 and `added_at` carries `created_at`).
#[tauri::command]
fn list_library_songs(
    state: tauri::State<'_, DbState>,
    profile_id: Option<i64>,
) -> Result<Vec<PlaylistTrack>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // Per-profile "saved music": tracks reachable through THIS profile's
    // playlists (regular + Liked + saved albums). The `tracks` table / audio
    // files stay shared device-wide, so playback is still instant for every
    // profile — only what shows up in "Your Library" is scoped.
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.spotify_id, t.title, t.artists, t.album, t.album_art_url,
                    t.duration_ms, t.isrc, t.status, t.failure_reason, t.local_path,
                    t.created_at
             FROM tracks t
             WHERE t.id IN (
                 SELECT pt.track_id FROM playlist_tracks pt
                 JOIN playlists p ON p.id = pt.playlist_id
                 WHERE p.profile_id IS ?1
             )
               AND TRIM(t.title) <> ''
             ORDER BY t.title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![profile_id], |r| {
            let artists_json: String = r.get(3)?;
            let artists: Vec<String> =
                serde_json::from_str(&artists_json).unwrap_or_default();
            Ok(PlaylistTrack {
                id: r.get(0)?,
                spotify_id: r.get(1)?,
                title: r.get(2)?,
                artists,
                album: r.get(4)?,
                album_art_url: r.get(5)?,
                duration_ms: r.get(6)?,
                isrc: r.get(7)?,
                status: r.get(8)?,
                failure_reason: r.get(9)?,
                local_path: r.get(10)?,
                position: 0,
                added_at: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Distinct albums in the library, with a representative cover + primary artist
/// + track count. Grouped by (album, primary-artist-key) so two different
/// albums sharing a title don't merge.
#[tauri::command]
fn list_library_albums(
    state: tauri::State<'_, DbState>,
    profile_id: Option<i64>,
) -> Result<Vec<LibraryAlbum>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.album AS album,
                    json_extract(t.artists, '$[0]') AS artist,
                    MAX(t.album_art_url) AS art,
                    COUNT(*) AS cnt
             FROM tracks t
             WHERE t.album IS NOT NULL AND TRIM(t.album) <> ''
               AND t.id IN (
                 SELECT pt.track_id FROM playlist_tracks pt
                 JOIN playlists p ON p.id = pt.playlist_id
                 WHERE p.profile_id IS ?1
               )
             GROUP BY t.album, artist_key(json_extract(t.artists, '$[0]'))
             ORDER BY album COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![profile_id], |r| {
            Ok(LibraryAlbum {
                album: r.get(0)?,
                artist: r.get(1)?,
                album_art_url: r.get(2)?,
                track_count: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Distinct primary artists in the library, with a representative cover + track
/// count. Grouped by the normalized `artist_key` so "ROSALÍA"/"Rosalía" merge.
#[tauri::command]
fn list_library_artists(
    state: tauri::State<'_, DbState>,
    profile_id: Option<i64>,
) -> Result<Vec<LibraryArtist>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(t.artists, '$[0]') AS name,
                    artist_key(json_extract(t.artists, '$[0]')) AS akey,
                    MAX(t.album_art_url) AS art,
                    COUNT(*) AS cnt
             FROM tracks t
             WHERE json_extract(t.artists, '$[0]') IS NOT NULL
               AND TRIM(json_extract(t.artists, '$[0]')) <> ''
               AND t.id IN (
                 SELECT pt.track_id FROM playlist_tracks pt
                 JOIN playlists p ON p.id = pt.playlist_id
                 WHERE p.profile_id IS ?1
               )
             GROUP BY akey
             ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![profile_id], |r| {
            Ok(LibraryArtist {
                name: r.get(0)?,
                key: r.get(1)?,
                album_art_url: r.get(2)?,
                track_count: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

// ---- Library backup & restore (Daft "backup/restore your library") -------
// Portable JSON snapshot of a profile's playlists + their tracks. Restore is
// non-destructive: playlists upsert by their own spotify_id and tracks dedupe
// by spotify_id (ON CONFLICT DO NOTHING, so existing audio/status is never
// clobbered) — the exact transaction shape the CSV importer uses.

#[derive(serde::Serialize, serde::Deserialize)]
struct BackupTrack {
    spotify_id: String,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    isrc: Option<String>,
    added_at: Option<i64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BackupPlaylist {
    name: String,
    spotify_id: String,
    cover_url: Option<String>,
    owner: Option<String>,
    tracks: Vec<BackupTrack>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LibraryBackup {
    version: u32,
    playlists: Vec<BackupPlaylist>,
}

#[derive(serde::Serialize)]
struct BackupSummary {
    playlists: i64,
    tracks: i64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write a profile's playlists + tracks to `path` as a JSON backup file.
#[tauri::command]
fn export_library(
    state: tauri::State<'_, DbState>,
    profile_id: i64,
    path: String,
) -> Result<BackupSummary, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut pstmt = conn
        .prepare(
            "SELECT id, name, spotify_id, cover_url, owner
             FROM playlists WHERE profile_id = ?1 ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let prows = pstmt
        .query_map(rusqlite::params![profile_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut playlists = Vec::with_capacity(prows.len());
    let mut track_total: i64 = 0;
    for (pid, name, spotify_id, cover_url, owner) in prows {
        let mut tstmt = conn
            .prepare(
                "SELECT t.spotify_id, t.title, t.artists, t.album, t.album_art_url,
                        t.duration_ms, t.isrc, pt.added_at
                 FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
                 WHERE pt.playlist_id = ?1 ORDER BY pt.position",
            )
            .map_err(|e| e.to_string())?;
        let tracks = tstmt
            .query_map(rusqlite::params![pid], |r| {
                let artists_json: String = r.get(2)?;
                let artists: Vec<String> =
                    serde_json::from_str(&artists_json).unwrap_or_default();
                Ok(BackupTrack {
                    spotify_id: r.get(0)?,
                    title: r.get(1)?,
                    artists,
                    album: r.get(3)?,
                    album_art_url: r.get(4)?,
                    duration_ms: r.get(5)?,
                    isrc: r.get(6)?,
                    added_at: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        track_total += tracks.len() as i64;
        playlists.push(BackupPlaylist {
            name,
            spotify_id,
            cover_url,
            owner,
            tracks,
        });
    }

    let playlist_count = playlists.len() as i64;
    let backup = LibraryBackup {
        version: 1,
        playlists,
    };
    let json = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(BackupSummary {
        playlists: playlist_count,
        tracks: track_total,
    })
}

/// Restore (merge) a JSON backup written by `export_library` into this profile.
#[tauri::command]
fn import_library_backup(
    state: tauri::State<'_, DbState>,
    profile_id: i64,
    path: String,
) -> Result<BackupSummary, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let backup: LibraryBackup = serde_json::from_str(&json)
        .map_err(|_| "That file isn't a valid Beetbot backup.".to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let playlist_count = backup.playlists.len() as i64;
    let mut tracks_total: i64 = 0;

    for pl in &backup.playlists {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let snapshot = format!("backup-import:{}", unix_now());
        tx.execute(
            "INSERT INTO playlists
                 (spotify_id, name, snapshot_id, track_count, last_synced_at, profile_id)
             VALUES (?1, ?2, ?3, 0, strftime('%s','now'), ?4)
             ON CONFLICT(spotify_id) DO UPDATE SET
                 name = excluded.name,
                 snapshot_id = excluded.snapshot_id,
                 last_synced_at = excluded.last_synced_at",
            rusqlite::params![pl.spotify_id, pl.name, snapshot, profile_id],
        )
        .map_err(|e| e.to_string())?;
        let playlist_id: i64 = tx
            .query_row(
                "SELECT id FROM playlists WHERE spotify_id = ?1",
                rusqlite::params![pl.spotify_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            rusqlite::params![playlist_id],
        )
        .map_err(|e| e.to_string())?;

        for (position, tr) in pl.tracks.iter().enumerate() {
            let artists_json =
                serde_json::to_string(&tr.artists).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO tracks
                     (spotify_id, title, artists, album, album_art_url, duration_ms, isrc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(spotify_id) DO NOTHING",
                rusqlite::params![
                    tr.spotify_id,
                    tr.title,
                    artists_json,
                    tr.album,
                    tr.album_art_url,
                    tr.duration_ms,
                    tr.isrc,
                ],
            )
            .map_err(|e| e.to_string())?;
            let track_id: i64 = tx
                .query_row(
                    "SELECT id FROM tracks WHERE spotify_id = ?1",
                    rusqlite::params![tr.spotify_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![playlist_id, track_id, position as i64, tr.added_at],
            )
            .map_err(|e| e.to_string())?;
            tracks_total += 1;
        }
        tx.execute(
            "UPDATE playlists SET track_count = ?1 WHERE id = ?2",
            rusqlite::params![pl.tracks.len() as i64, playlist_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(BackupSummary {
        playlists: playlist_count,
        tracks: tracks_total,
    })
}

/// Fetch a single track row by its id, independent of any playlist.
/// Used by the desktop play path: results from Home's "On repeat", Search,
/// and Browse may carry no playlist context, so we resolve `local_path`
/// straight from the track id. `position`/`added_at` aren't meaningful here.
/// Returns `None` when no track matches.
#[tauri::command]
fn get_track(
    state: tauri::State<'_, DbState>,
    track_id: i64,
) -> Result<Option<PlaylistTrack>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT t.id, t.spotify_id, t.title, t.artists, t.album, t.album_art_url,
                    t.duration_ms, t.isrc, t.status, t.failure_reason, t.local_path
             FROM tracks t
             WHERE t.id = ?1",
            rusqlite::params![track_id],
            |r| {
                let artists_json: String = r.get(3)?;
                let artists: Vec<String> =
                    serde_json::from_str(&artists_json).unwrap_or_default();
                Ok(PlaylistTrack {
                    id: r.get(0)?,
                    spotify_id: r.get(1)?,
                    title: r.get(2)?,
                    artists,
                    album: r.get(4)?,
                    album_art_url: r.get(5)?,
                    duration_ms: r.get(6)?,
                    isrc: r.get(7)?,
                    status: r.get(8)?,
                    failure_reason: r.get(9)?,
                    local_path: r.get(10)?,
                    position: 0,
                    added_at: None,
                })
            },
        )
        .ok();
    Ok(row)
}

// ---- Last.fm API key (free; powers genre-accurate Browse charts) ----

#[tauri::command]
fn lastfm_get_key(state: tauri::State<'_, DbState>) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    settings::get_setting(&conn, "lastfm_api_key")
        .map(|v| v.filter(|s| !s.trim().is_empty()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn lastfm_set_key(state: tauri::State<'_, DbState>, key: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    settings::set_setting(&conn, "lastfm_api_key", key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn lastfm_clear_key(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    settings::set_setting(&conn, "lastfm_api_key", "").map_err(|e| e.to_string())
}

/// Adopt a user-supplied audio file as the source for `track_id` — the
/// "I already own this, just use my copy" path for tracks that are DRM-locked
/// on every free source. m4a/aac inputs are copied verbatim (preserves an
/// iTunes/Bandcamp purchase); everything else is transcoded to AAC m4a for
/// universal device playback. Embeds the Spotify cover art and marks the
/// track downloaded.
///
/// The acquisition work runs through [`acquisition::AcquisitionProvider`] (the
/// open/closed boundary; the open build's `LocalFileProvider` does exactly what
/// this command always did). The command keeps ownership of the single
/// `UPDATE tracks SET …` so status-writing stays in one place.
#[tauri::command]
async fn import_local_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    track_id: i64,
    source_path: String,
) -> Result<String, String> {
    let outcome = acquisition::active_provider()
        .acquire(
            &app,
            &state.0,
            track_id,
            acquisition::AcquireSource::UserFile(PathBuf::from(&source_path)),
        )
        .await
        .map_err(|e| e.to_string())?;

    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE tracks SET
                 status          = ?1,
                 local_path      = ?2,
                 file_size_bytes = ?3,
                 failure_reason  = NULL,
                 match_method    = ?4,
                 downloaded_at   = strftime('%s','now'),
                 updated_at      = strftime('%s','now')
             WHERE id = ?5",
            rusqlite::params![
                outcome.status.as_db_str(),
                outcome.local_path,
                outcome.file_size_bytes,
                outcome.match_method,
                track_id
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(outcome.local_path)
}

/// Transcode any audio file to AAC m4a (~256k) with a faststart atom for
/// streaming. Requires ffmpeg on PATH. `pub` so both the built-in
/// `LocalFileProvider` and a separate full-build engine crate reuse it.
pub async fn transcode_to_m4a(
    src: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    // Resolve ffmpeg explicitly — a bare "ffmpeg" isn't found when the app
    // is launched from Finder/Dock (minimal PATH without Homebrew).
    let ffmpeg_bin =
        crate::library::ffmpeg::ffmpeg_path().unwrap_or_else(|| std::path::PathBuf::from("ffmpeg"));
    let status = tokio::process::Command::new(&ffmpeg_bin)
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(src)
        .args([
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
        ])
        .arg(dest)
        .status()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg not found on PATH (install it with: brew install ffmpeg)".to_string()
            } else {
                e.to_string()
            }
        })?;
    if !status.success() {
        return Err(format!(
            "ffmpeg couldn't convert that file (exit {:?}). Is it a valid, non-DRM audio file?",
            status.code()
        ));
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct StreamingStatus {
    enabled: bool,
    port: u16,
    https_port: u16,
    lan_url: Option<String>,
    hostname_url: Option<String>,
    /// `https://<hostname>.local:<https_port>` -- iOS Safari needs this for
    /// secure-context features (Cache API, Service Workers). `None` if the
    /// TLS cert couldn't be generated.
    https_url: Option<String>,
    /// Public URL the user opens on their phone to install the cert profile.
    /// Served from the HTTP listener (phones can't trust HTTPS until they
    /// have the cert -- chicken-and-egg).
    cert_install_url: Option<String>,
    requires_restart: bool,
}

fn read_streaming_settings(conn: &rusqlite::Connection) -> (bool, u16) {
    let enabled = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'streaming_enabled'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|s| matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"))
        .unwrap_or(false);
    let port: u16 = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'streaming_port'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(47823);
    (enabled, port)
}

#[tauri::command]
fn streaming_status(state: tauri::State<'_, DbState>) -> Result<StreamingStatus, String> {
    let (enabled, port) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        read_streaming_settings(&conn)
    };
    let https_port = port.wrapping_add(1);
    let lan_ip = local_ip_address::local_ip().ok();
    let lan_url = lan_ip.map(|ip| format!("http://{ip}:{port}"));
    let hostname_bare = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .map(|h| h.trim_end_matches(".local").to_string());
    let hostname_url = hostname_bare
        .as_ref()
        .map(|h| format!("http://{h}.local:{port}"));
    let https_url = hostname_bare
        .as_ref()
        .map(|h| format!("https://{h}.local:{https_port}"));
    // The cert install page is served by the HTTP listener -- the phone
    // can't trust HTTPS until it has the cert.
    let cert_install_url = lan_ip.map(|ip| format!("http://{ip}:{port}/cert"));
    Ok(StreamingStatus {
        enabled,
        port,
        https_port,
        lan_url,
        hostname_url,
        https_url,
        cert_install_url,
        // Toggling streaming / remote, or issuing a cert, now reconfigures the
        // live HTTP/HTTPS/mDNS server at runtime via `reconfigure_streaming`,
        // so no app restart is needed.
        requires_restart: false,
    })
}

#[tauri::command]
async fn streaming_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    enabled: bool,
) -> Result<(), String> {
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('streaming_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![if enabled { "true" } else { "false" }],
        )
        .map_err(|e| e.to_string())?;
    }
    // Drive the live server to match the new setting -- no restart needed.
    reconfigure_streaming(&app).await
}

#[derive(serde::Serialize)]
struct PairingInfo {
    /// Always present. UI shouldn't render it unless `pairing_required`
    /// is also true.
    code: String,
    seconds_until_rotation: i64,
    pairing_required: bool,
    remote_streaming_enabled: bool,
}

#[tauri::command]
fn pairing_get_info(
    state: tauri::State<'_, DbState>,
    pairing: tauri::State<'_, PairingStateHandle>,
) -> Result<PairingInfo, String> {
    let (pairing_required, remote_streaming_enabled) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let req = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'require_pairing_code'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .map(|s| matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"))
            .unwrap_or(false);
        let remote = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'remote_streaming_enabled'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .map(|s| matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"))
            .unwrap_or(false);
        // Public mode forces pairing.
        (req || remote, remote)
    };
    let (code, secs) = {
        let mut state = pairing.0.lock().map_err(|e| e.to_string())?;
        let secs = state.seconds_until_rotation();
        (state.current().to_string(), secs)
    };
    Ok(PairingInfo {
        code,
        seconds_until_rotation: secs,
        pairing_required,
        remote_streaming_enabled,
    })
}

#[tauri::command]
fn pairing_set_required(
    state: tauri::State<'_, DbState>,
    enabled: bool,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('require_pairing_code', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![if enabled { "true" } else { "false" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn remote_streaming_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    enabled: bool,
) -> Result<(), String> {
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('remote_streaming_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![if enabled { "true" } else { "false" }],
        )
        .map_err(|e| e.to_string())?;
        // Public mode forces the explicit pairing flag on; flipping off
        // remote does not implicitly turn pairing off (the user may want
        // pairing on LAN too).
        if enabled {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('require_pairing_code', 'true')
                 ON CONFLICT(key) DO UPDATE SET value = 'true'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    // Remote-on should ensure HTTPS + mDNS are up; the auth layer already
    // reads `remote_streaming_enabled` live, so this just makes sure the
    // network surface exists. Reconfigure to bring it up (or leave it as-is).
    reconfigure_streaming(&app).await?;

    // Automatic router port forwarding. On enable, open the HTTP+HTTPS
    // ports via UPnP and start the refresher; on disable, close them. The
    // mapping work runs in the background so the toggle returns promptly and
    // a slow/absent router doesn't block the UI. UPnP failures are recorded
    // in UpnpState (read via `upnp_status`) and the manual instructions
    // remain the fallback.
    if let Some(upnp) = app.try_state::<UpnpState>() {
        let upnp = (*upnp).clone();
        let db = state.0.clone();
        let streaming_port = {
            let conn = db.lock().map_err(|e| e.to_string())?;
            let (_enabled, port) = read_streaming_settings(&conn);
            port
        };
        tauri::async_runtime::spawn(async move {
            if enabled {
                upnp_on_enable(upnp, db, streaming_port).await;
            } else {
                upnp_on_disable(upnp, streaming_port).await;
            }
        });
    }

    // Embedded ngrok tunnel — the alternative to DuckDNS/port-forwarding. Only
    // does anything when an authtoken is configured; otherwise it's a no-op (the
    // user is presumably on DuckDNS). On enable, (re)start forwarding to the
    // local streaming port; on disable, tear the tunnel down. Runs in the
    // background so a slow ngrok handshake doesn't block the toggle.
    if let Some(ngrok_state) = app.try_state::<ngrok::NgrokState>() {
        let ngrok_state = (*ngrok_state).clone();
        let db = state.0.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            ngrok::stop(&ngrok_state);
            if enabled {
                let (authtoken, domain, port) = {
                    let conn = db.lock().expect("db mutex poisoned");
                    (
                        ngrok::read_authtoken(&conn),
                        ngrok::read_domain(&conn),
                        read_streaming_settings(&conn).1,
                    )
                };
                if let Some(token) = authtoken {
                    ngrok::start(app, ngrok_state, token, domain, port);
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn get_security_log_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("security.log").to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct StreamingSession {
    id: String,
    device_label: String,
    ip_address: String,
    user_agent: Option<String>,
    paired_at: i64,
    last_seen_at: i64,
}

#[tauri::command]
fn list_streaming_sessions(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<StreamingSession>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, device_label, ip_address, user_agent, paired_at, last_seen_at
             FROM streaming_sessions
             WHERE revoked_at IS NULL
               -- Loopback is this computer (the desktop app talking to its own
               -- server), not a device streaming to you — don't list it.
               AND ip_address NOT LIKE '127.%'
               AND ip_address <> '::1'
               -- Only genuinely-recent devices. One idle past the expiry window
               -- has effectively dropped (its token no longer works either), so
               -- it shouldn't sit in the list looking 'active'.
               AND last_seen_at >= strftime('%s','now') - ?1
             ORDER BY last_seen_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![crate::server::SESSION_IDLE_EXPIRY_SECS], |r| {
            Ok(StreamingSession {
                id: r.get(0)?,
                device_label: r.get(1)?,
                ip_address: r.get(2)?,
                user_agent: r.get(3)?,
                paired_at: r.get(4)?,
                last_seen_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn revoke_streaming_session(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE streaming_sessions SET revoked_at = strftime('%s','now') WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// How long an orphan row is spared after it was last touched — see
/// `prune_orphan_tracks`.
const ORPHAN_KEEP_SECS: i64 = 30 * 24 * 60 * 60; // 30 days

/// Delete "orphan" track rows: rows in NO playlist, created as a by-product of
/// playing/queueing a catalog song (we upsert a `tracks` row just to get an id
/// to stream by). They're invisible in the library but clutter the DB. Liked
/// songs live in the Liked Songs playlist, so they are NOT orphans and are never
/// touched. Deletes the local file too (rare — most orphans are un-downloaded
/// 'pending' rows); the row delete FK-cascades its play_events.
///
/// Recency guard: rows touched (created or played/matched) within the last 30
/// days are SPARED — they back the current / recently-played queue, which the
/// player persists across restarts. Pruning them would leave the restored queue
/// pointing at dangling ids, so a non-downloaded track dead-ends with "no live
/// stream" on cold open. Genuinely-stale clutter (untouched > 30 days) is still
/// reclaimed.
///
/// Runs automatically on launch (a short-delayed spawned task in the setup
/// hook) — there is no longer a manual button for it. Returns the number of
/// orphan rows deleted.
fn prune_orphan_tracks(conn: &rusqlite::Connection) -> usize {
    let rows: Vec<(i64, Option<String>)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, local_path FROM tracks t
             WHERE NOT EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id)
               AND t.updated_at < strftime('%s','now') - ?1",
        ) {
            Ok(stmt) => stmt,
            Err(e) => {
                tracing::warn!(error = %e, "orphan prune: failed to prepare query");
                return 0;
            }
        };
        let it = match stmt.query_map([ORPHAN_KEEP_SECS], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        }) {
            Ok(it) => it,
            Err(e) => {
                tracing::warn!(error = %e, "orphan prune: failed to query rows");
                return 0;
            }
        };
        it.filter_map(Result::ok).collect()
    };
    let count = rows.len();
    let mut files_deleted = 0usize;
    for (id, local_path) in &rows {
        if let Some(p) = local_path {
            if std::fs::remove_file(p).is_ok() {
                files_deleted += 1;
            }
        }
        let _ = conn.execute("DELETE FROM tracks WHERE id = ?1", rusqlite::params![id]);
    }
    if count > 0 {
        tracing::info!(count, files_deleted, "cleaned up orphan track rows");
    }
    count
}

/// One-off-but-idempotent repair for the semicolon-artist rows: Exportify CSVs
/// join multiple artists with ';' in "Artist Name(s)", and `parse_artists`
/// split only on ',' until recently — so ~275 legacy tracks stored ONE element
/// like "Aminé;Leon Thomas". Grouping/bans already truncate at ';' (artist_key
/// / norm_artist), but DISPLAY (row artist lines, search, share) still showed
/// the raw joined string. Rewrite those arrays into properly split lists.
/// Idempotent: once repaired, no row matches the LIKE and this is a no-op.
/// Runs on launch alongside the orphan prune. Returns rows rewritten.
fn split_semicolon_artists(conn: &rusqlite::Connection) -> usize {
    let rows: Vec<(i64, String)> = {
        let mut stmt = match conn
            .prepare("SELECT id, artists FROM tracks WHERE artists LIKE '%;%'")
        {
            Ok(stmt) => stmt,
            Err(e) => {
                tracing::warn!(error = %e, "artist repair: failed to prepare query");
                return 0;
            }
        };
        let it = match stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }) {
            Ok(it) => it,
            Err(e) => {
                tracing::warn!(error = %e, "artist repair: failed to query rows");
                return 0;
            }
        };
        it.filter_map(Result::ok).collect()
    };
    let mut fixed = 0usize;
    for (id, artists_json) in &rows {
        let Ok(list) = serde_json::from_str::<Vec<String>>(artists_json) else {
            continue; // malformed JSON — leave it alone
        };
        let Some(split) = import::split_semicolon_artist_list(&list) else {
            continue; // clean already (e.g. ';' appeared outside the JSON strings)
        };
        let Ok(json) = serde_json::to_string(&split) else { continue };
        if conn
            .execute(
                "UPDATE tracks SET artists = ?1 WHERE id = ?2",
                rusqlite::params![json, id],
            )
            .is_ok()
        {
            fixed += 1;
        }
    }
    if fixed > 0 {
        tracing::info!(fixed, "split legacy semicolon-joined artist rows");
    }
    fixed
}

#[tauri::command]
fn get_download_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let path = library::resolve_download_dir(&app, &conn).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ---- Storage (Settings → Library → Storage) -------------------------------
//
// Two on-disk pools the user might want to see: the temporary streaming cache
// (safe to wipe) and their downloaded audio (never touched here).

/// Best-effort recursive size of a directory tree, in bytes. A missing or
/// unreadable directory counts as 0; individual unreadable entries are skipped
/// rather than failing the whole walk.
fn dir_size_bytes(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size_bytes(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// The temporary remux cache for streamed (non-downloaded) playback. It lives
/// in the OS temp dir, self-prunes to a cap, and is always safe to clear —
/// anything removed is simply re-created on the next stream.
fn live_cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("beetbot-live")
}

#[derive(serde::Serialize)]
struct StorageUsage {
    /// Bytes in the temporary streaming cache (safe to clear).
    cache_bytes: u64,
    /// Bytes of imported / downloaded audio in the library folder.
    downloads_bytes: u64,
}

#[tauri::command]
fn storage_usage(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<StorageUsage, String> {
    let downloads = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        library::resolve_download_dir(&app, &conn).map_err(|e| e.to_string())?
    };
    Ok(StorageUsage {
        cache_bytes: dir_size_bytes(&live_cache_dir()),
        downloads_bytes: dir_size_bytes(&downloads),
    })
}

/// Delete the temporary streaming cache. Returns the number of bytes freed.
/// Never touches the download folder (that's the user's real library).
#[tauri::command]
fn clear_live_cache() -> Result<u64, String> {
    let dir = live_cache_dir();
    let before = dir_size_bytes(&dir);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(before.saturating_sub(dir_size_bytes(&dir)))
}

/// Diagnostic probe of the user's network: public IP, CGNAT, UPnP.
/// Triggered only when the user opens Settings → Remote access and taps
/// the button -- we don't want background probes hitting ipify.
#[tauri::command]
async fn probe_network() -> network::NetworkProbe {
    network::probe().await
}

// ---- UPnP automatic port forwarding ---------------------------------
//
// When REMOTE streaming is on we try to punch the HTTP + HTTPS ports
// through the router automatically via UPnP, so the user doesn't have to
// log into their router and add forwards by hand. When UPnP isn't
// available (no IGD, router has it disabled, CGNAT) we record the error
// and the existing manual-forward instructions stay as the fallback.

/// The two TCP ports we forward: HTTP (`streaming_port`) and HTTPS
/// (`streaming_port + 1`).
fn upnp_ports(streaming_port: u16) -> [u16; 2] {
    [streaming_port, streaming_port.wrapping_add(1)]
}

/// Live status of the automatic port forwarding, readable by the UI so it
/// can show "router configured automatically" vs. fall back to the manual
/// instructions. Guarded by a std `Mutex`; never held across an `.await`.
#[derive(Debug, Default, Clone)]
struct UpnpStatus {
    /// True once the mapping was successfully (re)added on the last attempt.
    mapped: bool,
    /// The router's external (WAN) IP, if discovery returned one.
    external_ip: Option<String>,
    /// The error from the last attempt, if it failed. Drives the manual
    /// fallback hint in the UI.
    error: Option<String>,
    /// Whether a refresher task is currently running, so we never spawn a
    /// second one.
    refresher_running: bool,
}

#[derive(Clone)]
struct UpnpState(Arc<Mutex<UpnpStatus>>);

/// Shape returned to the frontend by the `upnp_status` command.
#[derive(serde::Serialize)]
struct UpnpStatusOut {
    mapped: bool,
    external_ip: Option<String>,
    error: Option<String>,
}

/// One attempt to open the mapping. Records the outcome into `UpnpState`.
/// Best-effort: a failure is recorded (so the UI can fall back to manual
/// instructions) and swallowed -- it never propagates as a hard error.
async fn upnp_open_once(upnp: &UpnpState, streaming_port: u16) {
    let lan_ip = match local_ip_address::local_ip() {
        Ok(std::net::IpAddr::V4(v4)) => v4,
        Ok(std::net::IpAddr::V6(_)) => {
            // UPnP IGD port mapping is IPv4-only; an IPv6-only LAN address
            // can't be forwarded this way.
            let mut s = upnp.0.lock().expect("upnp mutex poisoned");
            s.mapped = false;
            s.error = Some("No IPv4 LAN address to forward".to_string());
            return;
        }
        Err(e) => {
            let mut s = upnp.0.lock().expect("upnp mutex poisoned");
            s.mapped = false;
            s.error = Some(format!("Couldn't determine LAN IP: {e}"));
            return;
        }
    };
    let ports = upnp_ports(streaming_port);
    let result = network::open_port_mapping(lan_ip, &ports).await;
    // Fetch the external IP for display; failure here isn't fatal.
    let external_ip = network::fetch_upnp_external_ip().await;
    let mut s = upnp.0.lock().expect("upnp mutex poisoned");
    match result {
        Ok(()) => {
            s.mapped = true;
            s.error = None;
            s.external_ip = external_ip;
        }
        Err(e) => {
            s.mapped = false;
            s.error = Some(e);
            s.external_ip = external_ip;
        }
    }
}

/// Read `remote_streaming_enabled` straight from the settings table. Takes
/// the DB lock briefly; never held across an `.await`.
fn read_remote_streaming_enabled(db: &Arc<Mutex<Connection>>) -> bool {
    let conn = db.lock().expect("db mutex poisoned");
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'remote_streaming_enabled'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .map(|s| matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"))
    .unwrap_or(false)
}

/// Spawn the background refresher that re-adds the mapping every ~30 min
/// for as long as remote streaming stays enabled. The lease we request is
/// finite (1h) so a crash doesn't leave the port open forever; refreshing
/// well before expiry keeps it alive while the feature is on. Re-reads the
/// setting each tick and exits when it flips off. Idempotent: if a
/// refresher is already running we don't start a second one.
fn spawn_upnp_refresher(
    upnp: UpnpState,
    db: Arc<Mutex<Connection>>,
    streaming_port: u16,
) {
    {
        let mut s = upnp.0.lock().expect("upnp mutex poisoned");
        if s.refresher_running {
            return;
        }
        s.refresher_running = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // First tick fires immediately; the enable path already did one
        // open, so skip the initial tick to avoid an immediate duplicate.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if !read_remote_streaming_enabled(&db) {
                break;
            }
            upnp_open_once(&upnp, streaming_port).await;
        }
        let mut s = upnp.0.lock().expect("upnp mutex poisoned");
        s.refresher_running = false;
    });
}

/// Enable path: open the mapping now and ensure the refresher is running.
async fn upnp_on_enable(
    upnp: UpnpState,
    db: Arc<Mutex<Connection>>,
    streaming_port: u16,
) {
    upnp_open_once(&upnp, streaming_port).await;
    spawn_upnp_refresher(upnp, db, streaming_port);
}

/// Disable path: close the mapping and clear the mapped flag. The running
/// refresher exits on its own next tick once it sees the setting is off.
async fn upnp_on_disable(upnp: UpnpState, streaming_port: u16) {
    let ports = upnp_ports(streaming_port);
    let result = network::close_port_mapping(&ports).await;
    let mut s = upnp.0.lock().expect("upnp mutex poisoned");
    s.mapped = false;
    s.error = result.err();
}

/// Read the current automatic-port-forwarding status for the UI.
#[tauri::command]
fn upnp_status(state: tauri::State<'_, UpnpState>) -> UpnpStatusOut {
    let s = state.0.lock().expect("upnp mutex poisoned");
    UpnpStatusOut {
        mapped: s.mapped,
        external_ip: s.external_ip.clone(),
        error: s.error.clone(),
    }
}

// ---- DDNS commands ---------------------------------------------------

#[tauri::command]
fn ddns_get_status(state: tauri::State<'_, DbState>) -> Result<ddns::DdnsStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    ddns::load_status(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn ddns_set_config(
    state: tauri::State<'_, DbState>,
    subdomain: String,
    token: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    ddns::set_subdomain(&conn, subdomain.trim()).map_err(|e| e.to_string())?;
    drop(conn);
    ddns::set_token(token.trim()).map_err(|e| e.to_string())?;
    if ddns::read_token().is_none() {
        return Err("Saved but couldn't read back. Check the security log.".into());
    }
    Ok(())
}

#[tauri::command]
fn ddns_clear(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    ddns::clear_settings(&conn).map_err(|e| e.to_string())?;
    drop(conn);
    ddns::clear_token().map_err(|e| e.to_string())
}

#[tauri::command]
async fn ddns_update_now(
    state: tauri::State<'_, DbState>,
) -> Result<String, String> {
    let db = state.0.clone();
    let outcome = ddns::run_once(&db).await.map_err(|e| e.to_string())?;
    Ok(format!("{} → {}", outcome.hostname, outcome.ip))
}

// ---- ngrok tunnel commands -------------------------------------------

#[tauri::command]
fn ngrok_get_status(
    state: tauri::State<'_, DbState>,
    ngrok_state: tauri::State<'_, ngrok::NgrokState>,
) -> Result<ngrok::NgrokStatus, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(ngrok::status(&conn, &ngrok_state))
}

#[tauri::command]
async fn ngrok_set_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    ngrok_state: tauri::State<'_, ngrok::NgrokState>,
    authtoken: String,
    domain: String,
) -> Result<(), String> {
    let configured = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        // Only overwrite the token when a fresh one is supplied; an empty field
        // means "keep the saved token" (the UI clears it after saving and the
        // secret can't be re-sent), so a domain-only edit doesn't wipe it.
        if !authtoken.trim().is_empty() {
            ngrok::set_authtoken(&conn, &authtoken).map_err(|e| e.to_string())?;
        }
        ngrok::set_domain(&conn, &domain).map_err(|e| e.to_string())?;
        ngrok::read_authtoken(&conn).is_some()
    };
    if configured {
        // Configuring ngrok IS opting into remote access, so enable it for the
        // user instead of making them flip a second switch. This brings the
        // server up, forces pairing on, and (via its own ngrok hook) starts the
        // tunnel with the freshly-saved config. Idempotent if already enabled.
        remote_streaming_set_enabled(app, state, true).await?;
    } else {
        // Token cleared/blank — just reflect the saved config and stop any
        // tunnel; don't force remote access on (the user may prefer DuckDNS).
        restart_ngrok_from_settings(app, state.0.clone(), (*ngrok_state).clone());
    }
    Ok(())
}

#[tauri::command]
fn ngrok_clear(
    state: tauri::State<'_, DbState>,
    ngrok_state: tauri::State<'_, ngrok::NgrokState>,
) -> Result<(), String> {
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        ngrok::clear_config(&conn).map_err(|e| e.to_string())?;
    }
    ngrok::stop(&ngrok_state);
    Ok(())
}

/// Stop any running tunnel, then start a fresh one iff remote streaming is
/// enabled AND an authtoken is configured. Shared by `ngrok_set_config` and
/// app startup. Non-blocking (the ngrok handshake runs in the background).
fn restart_ngrok_from_settings(
    app: tauri::AppHandle,
    db: Arc<Mutex<Connection>>,
    ngrok_state: ngrok::NgrokState,
) {
    tauri::async_runtime::spawn(async move {
        ngrok::stop(&ngrok_state);
        let (enabled, authtoken, domain, port) = {
            let conn = db.lock().expect("db mutex poisoned");
            let enabled = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'remote_streaming_enabled'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
                .map(|s| matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"))
                .unwrap_or(false);
            (
                enabled,
                ngrok::read_authtoken(&conn),
                ngrok::read_domain(&conn),
                read_streaming_settings(&conn).1,
            )
        };
        if enabled {
            if let Some(token) = authtoken {
                ngrok::start(app, ngrok_state, token, domain, port);
            }
        }
    });
}

// ---- ACME / Let's Encrypt commands -----------------------------------

fn acme_tls_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tls"))
}

#[tauri::command]
fn acme_get_status(app: tauri::AppHandle) -> Result<acme::AcmeStatus, String> {
    let dir = acme_tls_dir(&app)?;
    Ok(acme::read_status(&dir))
}

#[derive(serde::Deserialize)]
struct AcmeIssueArgs {
    contact_email: Option<String>,
    staging: bool,
}

#[tauri::command]
async fn acme_issue(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    args: AcmeIssueArgs,
) -> Result<acme::IssueOutcome, String> {
    // Pull DDNS config under the lock (subdomain) + keychain (token).
    let subdomain = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        ddns::get_subdomain(&conn)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "Configure a DuckDNS subdomain before requesting a certificate."
                    .to_string()
            })?
    };
    let token = ddns::read_token()
        .ok_or_else(|| "Save the DuckDNS token first.".to_string())?;
    let tls_dir = acme_tls_dir(&app)?;
    let req = acme::IssueRequest {
        tls_dir: tls_dir.clone(),
        subdomain,
        duckdns_token: token,
        contact_email: args.contact_email,
        environment: if args.staging {
            acme::Environment::Staging
        } else {
            acme::Environment::Production
        },
    };
    match acme::issue(req).await {
        Ok(outcome) => {
            tracing::info!(host = %outcome.hostname, "Let's Encrypt cert issued");
            // Hot-reload the running HTTPS server so the new cert is in
            // use without an app restart. Production environments only --
            // staging certs are untrusted by design, so swapping them in
            // would just make the LAN URL stop working.
            if !args.staging {
                if let Err(e) = reload_https_cert(&app).await {
                    tracing::warn!(?e, "cert reload failed -- restart needed");
                }
                // If HTTPS wasn't running yet (e.g. streaming was just
                // enabled, or no cert existed at startup), reconfigure starts
                // it now. `reload_https_cert` above handles the already-running
                // case; this handles the not-yet-started case.
                if let Err(e) = reconfigure_streaming(&app).await {
                    tracing::warn!(?e, "reconfigure after cert issue failed");
                }
            }
            Ok(outcome)
        }
        Err(e) => {
            tracing::warn!(?e, "Let's Encrypt issuance failed");
            acme::record_failure(&tls_dir, &e.to_string());
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn acme_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = acme_tls_dir(&app)?;
    acme::clear(&dir).map_err(|e| e.to_string())
}

/// Background-runnable renewal check. Returns `Ok(true)` if it renewed,
/// `Ok(false)` if nothing was due, and `Err` if a needed renewal failed.
/// Considers a cert "due for renewal" when its mtime is older than 60
/// days -- Let's Encrypt certs are valid for 90, so we have 30 days of
/// retry slack if issuance fails.
async fn try_renew_cert(app: &tauri::AppHandle) -> Result<bool, String> {
    use std::time::SystemTime;
    let dir = acme_tls_dir(app)?;
    let cert_file = acme::cert_path(&dir);
    if !cert_file.is_file() {
        return Ok(false);
    }
    let meta = std::fs::metadata(&cert_file).map_err(|e| e.to_string())?;
    let age = meta
        .modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if age < 60 * 24 * 3600 {
        return Ok(false);
    }
    tracing::info!(age_days = age / 86_400, "auto-renewing Let's Encrypt cert");
    // Pull DDNS config; if it isn't set we can't renew. Use the DB
    // managed state -- this code runs on the same Tokio runtime.
    let db_state = app.state::<DbState>();
    let subdomain = {
        let conn = db_state
            .0
            .lock()
            .map_err(|e| format!("db mutex poisoned: {e}"))?;
        ddns::get_subdomain(&conn).map_err(|e| e.to_string())?
    };
    let Some(subdomain) = subdomain else {
        return Err("DDNS not configured -- can't auto-renew".into());
    };
    let token = ddns::read_token()
        .ok_or_else(|| "DDNS token missing -- can't auto-renew".to_string())?;
    let req = acme::IssueRequest {
        tls_dir: dir.clone(),
        subdomain,
        duckdns_token: token,
        contact_email: None,
        environment: acme::Environment::Production,
    };
    match acme::issue(req).await {
        Ok(outcome) => {
            tracing::info!(host = %outcome.hostname, "auto-renew succeeded");
            // Hot-reload the live HTTPS config with the new cert/key.
            let _ = reload_https_cert(app).await;
            Ok(true)
        }
        Err(e) => {
            acme::record_failure(&dir, &format!("auto-renew: {e}"));
            Err(e.to_string())
        }
    }
}

/// Tell the in-flight axum-server to load the new cert + key from disk.
/// No restart, no dropped connections -- new TLS handshakes pick up the
/// new cert immediately and existing connections finish on their old one.
async fn reload_https_cert(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = acme_tls_dir(app)?;
    let cert_path = acme::cert_path(&dir);
    let key_path = acme::key_path(&dir);
    if !(cert_path.is_file() && key_path.is_file()) {
        return Err("Let's Encrypt cert files missing on disk".into());
    }
    let cfg = app
        .try_state::<HttpsConfigState>()
        .ok_or_else(|| "HTTPS server isn't running".to_string())?;
    cfg.0
        .reload_from_pem_file(&cert_path, &key_path)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!("HTTPS cert hot-reloaded");
    Ok(())
}

/// Return the absolute path to the rolling-log directory so the Settings
/// page can render it and open Finder. The dir is created during the
/// setup hook; this command is safe even if log init failed (we just
/// report the canonical path).
#[tauri::command]
fn get_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_download_dir(
    state: tauri::State<'_, DbState>,
    path: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('download_dir', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![path.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    let dir = app.path().app_data_dir()?;
    Ok(dir.join("library.db"))
}

/// Pick the directory containing the built web-player bundle.
///
/// Tries the following in order, returning the first that exists:
///   1. `<resource_dir>/web-player/`              -- installed app bundle
///   2. `<CARGO_MANIFEST_DIR>/../dist/web-player` -- dev (cargo / tauri dev)
///   3. `<cwd>/dist/web-player`                   -- launching from project root
///
/// Returns `None` if none exist; the server will just skip the static
/// fallback and the player won't be reachable until `pnpm build` has run.
fn resolve_web_player_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // CARGO_MANIFEST_DIR points at `src-tauri/` at compile time.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_dist = manifest_dir
        .parent()
        .map(|p| p.join("dist").join("web-player"))
        .unwrap_or_else(|| manifest_dir.join("..").join("dist").join("web-player"));

    // In debug builds (cargo / tauri dev) we prefer the project-relative
    // `dist/web-player` so re-running `pnpm build:web` is enough to
    // refresh the served bundle -- no Rust restart needed. Tauri also
    // copies that dir into target/debug/ on app startup, but that copy is
    // stale by the next rebuild.
    if cfg!(debug_assertions) {
        candidates.push(project_dist.clone());
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("web-player"));
        candidates.push(resource_dir.join("dist").join("web-player"));
    }
    if !cfg!(debug_assertions) {
        candidates.push(project_dist);
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist").join("web-player"));
    }
    for c in candidates {
        if c.is_dir() && c.join("index.html").is_file() {
            return Some(c);
        }
    }
    None
}

/// Wrapper around `tracing_appender::non_blocking::WorkerGuard` so we can
/// stash it in Tauri state. Dropping the guard flushes the background log
/// worker -- if the guard dies before `run()` returns, the last few log
/// lines never hit disk.
struct LogGuard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

/// Handle to the live HTTPS server's rustls config. Stored in Tauri state
/// so the ACME issue path can call `.reload_from_pem_file()` on it after
/// a successful re-issuance -- no app restart needed.
#[derive(Clone)]
struct HttpsConfigState(axum_server::tls_rustls::RustlsConfig);

/// A spawned axum listener we can stop at runtime. Dropping/sending on
/// `shutdown` asks the server to drain; awaiting `task` then blocks until
/// the listener has actually released its bound port so a fresh listener
/// can rebind the same address without hitting "address already in use".
struct RunningListener {
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Only meaningful for the HTTP listener (HTTPS is always 0.0.0.0).
    bind_ip: [u8; 4],
}

/// Live runtime handles + the bits needed to (re)spawn them. Guarded by an
/// async mutex so `reconfigure_streaming` is serialized; the guard is never
/// held across a `.bind()`-then-`.await` of an old task while also holding
/// the DB mutex (we read settings into locals first, then drop those guards).
struct ServerRuntime {
    http: Option<RunningListener>,
    https: Option<RunningListener>,
    mdns: Option<mdns::MdnsHandle>,
    web_dir: Option<PathBuf>,
    /// Cloneable; needed to (re)spawn listeners.
    server_state: server::AppState,
    port: u16,
}

/// Tauri-managed handle to the live server runtime.
struct ServerControl(Arc<tokio::sync::Mutex<ServerRuntime>>);

/// Drive the live HTTP/HTTPS/mDNS server to match the current settings.
///
/// This is the ONE place that (re)spawns listeners. Called once at startup
/// to establish the initial state, then again by `streaming_set_enabled`,
/// `remote_streaming_set_enabled`, and `acme_issue` so toggling a setting or
/// issuing a cert takes effect at runtime -- no app restart.
///
/// Security posture preserved:
///   streaming OFF => HTTP bound to 127.0.0.1 only, no mDNS, no HTTPS.
///   streaming ON  => HTTP on 0.0.0.0 + mDNS + HTTPS (if a cert is available).
///
/// Invariant: never hold the DB `Mutex` (or the `ServerControl` mutex's
/// inner guard) across an `.await` that does network/bind work. We read the
/// settings into locals, drop the DB guard, then do async work.
async fn reconfigure_streaming(app: &tauri::AppHandle) -> Result<(), String> {
    let control = app
        .try_state::<ServerControl>()
        .ok_or_else(|| "ServerControl not initialized".to_string())?;
    let runtime = control.0.clone();
    let mut rt = runtime.lock().await;

    // Read settings into locals, then drop the DB guard before any await.
    let enabled = {
        let db_state = app.state::<DbState>();
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let (enabled, _port) = read_streaming_settings(&conn);
        enabled
    };

    let port = rt.port;
    let https_port = port.wrapping_add(1);
    let web_dir = rt.web_dir.clone();
    let server_state = rt.server_state.clone();

    // ---- HTTP: rebind only if the desired bind differs from the current.
    let desired_bind: [u8; 4] = if enabled { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let current_bind = rt.http.as_ref().map(|l| l.bind_ip);
    if current_bind != Some(desired_bind) {
        // Stop the old listener (if any) and AWAIT its task so the port is
        // released before we rebind the same address.
        if let Some(old) = rt.http.take() {
            let _ = old.shutdown.send(());
            let _ = old.task.await;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let http_state = server_state.clone();
        let http_web_dir = web_dir.clone();
        let task = tauri::async_runtime::spawn(async move {
            if let Err(e) = server::run(http_state, desired_bind, port, http_web_dir, rx).await {
                tracing::error!(?e, "HTTP streaming server crashed");
            }
        });
        rt.http = Some(RunningListener {
            shutdown: tx,
            task,
            bind_ip: desired_bind,
        });
        tracing::info!(?desired_bind, "HTTP listener (re)bound");
    }

    // ---- mDNS: announce when enabled, withdraw when not.
    if enabled && rt.mdns.is_none() {
        match (
            local_ip_address::local_ip(),
            hostname::get().ok().and_then(|h| h.into_string().ok()),
        ) {
            (Ok(ip), Some(host)) => {
                let host = host.trim_end_matches(".local").to_string();
                match mdns::announce(port, ip, &host) {
                    Ok(handle) => rt.mdns = Some(handle),
                    Err(e) => tracing::warn!(?e, "mDNS announce failed"),
                }
            }
            other => {
                tracing::warn!(?other, "could not resolve LAN IP / hostname for mDNS");
            }
        }
    } else if !enabled && rt.mdns.is_some() {
        // Dropping the handle deregisters the service.
        rt.mdns = None;
        tracing::info!("mDNS service withdrawn");
    }

    // ---- HTTPS: start when enabled + a cert is available; stop when off.
    if enabled && rt.https.is_none() {
        if let Some(rustls_config) = materialize_https_config(app) {
            app.manage(HttpsConfigState(rustls_config.clone()));
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let https_state = server_state.clone();
            let https_web_dir = web_dir.clone();
            let task = tauri::async_runtime::spawn(async move {
                if let Err(e) =
                    server::run_https(https_state, https_port, https_web_dir, rustls_config, rx)
                        .await
                {
                    tracing::error!(?e, "HTTPS streaming server crashed");
                }
            });
            rt.https = Some(RunningListener {
                shutdown: tx,
                task,
                bind_ip: [0, 0, 0, 0],
            });
            tracing::info!("HTTPS listener started");
        }
    } else if !enabled && rt.https.is_some() {
        if let Some(old) = rt.https.take() {
            let _ = old.shutdown.send(());
            let _ = old.task.await;
        }
        tracing::info!("HTTPS listener stopped");
    }

    Ok(())
}

/// Build the rustls config for the HTTPS listener, mirroring the cert
/// selection the setup hook used to do inline: prefer the Let's Encrypt cert
/// under app_data/tls when present (browser-trusted), otherwise materialize a
/// self-signed cert via `tls::ensure_cert`. Returns `None` (and logs) if no
/// cert can be produced -- the caller then just doesn't start HTTPS.
fn materialize_https_config(
    app: &tauri::AppHandle,
) -> Option<axum_server::tls_rustls::RustlsConfig> {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(?e, "no app_data_dir for TLS; HTTPS disabled");
            return None;
        }
    };
    let tls_dir = data_dir.join("tls");

    // Prefer the Let's Encrypt cert when present.
    let le_cert = acme::cert_path(&tls_dir);
    let le_key = acme::key_path(&tls_dir);
    let (cert_path, key_path) = if le_cert.is_file() && le_key.is_file() {
        tracing::info!("HTTPS using Let's Encrypt cert");
        (le_cert, le_key)
    } else {
        // Self-signed fallback. Generate (or load) it from the same dir.
        let hostname_bare = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .map(|h| h.trim_end_matches(".local").to_string());
        let Some(host) = hostname_bare else {
            tracing::warn!("no hostname for self-signed cert; HTTPS disabled");
            return None;
        };
        let lan_ip = local_ip_address::local_ip().ok();
        match tls::ensure_cert(&tls_dir, &host, lan_ip) {
            Ok(art) => (art.cert_path, art.key_path),
            Err(e) => {
                tracing::warn!(?e, "TLS cert init failed; HTTPS disabled");
                return None;
            }
        }
    };

    match server::build_rustls_config(&cert_path, &key_path) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::error!(?e, "failed to build rustls config; HTTPS disabled");
            None
        }
    }
}

/// Shared pairing-code state. The desktop Settings UI polls this to
/// render the rotating 6-digit code.
#[derive(Clone)]
struct PairingStateHandle(Arc<Mutex<auth::PairingState>>);

/// Path-bearing handle to the security log so the Settings UI can offer
/// an "Open log" link.
#[derive(Clone)]
struct SecurityLogState(#[allow(dead_code)] Arc<auth::SecurityLog>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(setup_app)
        .invoke_handler(invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Close the ngrok tunnel cleanly on exit (either event may be the one
            // that fires) so its edge releases the reserved domain immediately.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                ngrok_shutdown_blocking(app_handle);
            }
        });
}

/// Gracefully close the ngrok tunnel (if any) before the process exits, so the
/// edge releases the reserved domain immediately instead of leaving a ghost
/// session that blocks the next launch's rebind. No-op when ngrok isn't
/// configured. Exposed so the full-build shell can call it from its run loop.
pub fn ngrok_shutdown_blocking(app: &tauri::AppHandle) {
    use tauri::Manager;
    match app.try_state::<ngrok::NgrokState>() {
        Some(state) => {
            tracing::info!("ngrok: exit handler — closing tunnel gracefully");
            ngrok::shutdown_blocking(&state);
        }
        None => tracing::warn!("ngrok: exit handler — NgrokState not found"),
    }
}

/// Core Tauri app setup (logging, DB open, server, profiles, cast, …). Exposed
/// so the full-build shell reuses it and runs the engine's startup around it.
pub fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
            // Set up tracing once, with both stderr (for `cargo tauri dev`
            // logs) and a rolling daily file under <app_data_dir>/logs/.
            // The non-blocking writer's WorkerGuard must outlive the
            // process; we stash it in Tauri state.
            use tracing_subscriber::layer::SubscriberExt;
            use tracing_subscriber::util::SubscriberInitExt;
            let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
            let stderr_layer = tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true);
            let log_guard: Option<tracing_appender::non_blocking::WorkerGuard> =
                match app.path().app_data_dir() {
                    Ok(data_dir) => {
                        let log_dir = data_dir.join("logs");
                        match std::fs::create_dir_all(&log_dir) {
                            Ok(()) => {
                                let appender = tracing_appender::rolling::daily(
                                    &log_dir,
                                    "beetbot.log",
                                );
                                let (non_blocking, guard) =
                                    tracing_appender::non_blocking(appender);
                                let file_layer = tracing_subscriber::fmt::layer()
                                    .with_writer(non_blocking)
                                    .with_ansi(false);
                                let _ = tracing_subscriber::registry()
                                    .with(env_filter)
                                    .with(stderr_layer)
                                    .with(file_layer)
                                    .try_init();
                                tracing::info!(?log_dir, "rolling log file initialized");
                                Some(guard)
                            }
                            Err(e) => {
                                let _ = tracing_subscriber::registry()
                                    .with(env_filter)
                                    .with(stderr_layer)
                                    .try_init();
                                tracing::warn!(?e, ?log_dir, "log dir create failed");
                                None
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tracing_subscriber::registry()
                            .with(env_filter)
                            .with(stderr_layer)
                            .try_init();
                        tracing::warn!(?e, "could not resolve app_data_dir for logs");
                        None
                    }
                };
            if let Some(guard) = log_guard {
                app.manage(LogGuard(guard));
            }

            let path = db_path(&app.handle())?;
            tracing::info!(?path, "opening library database");
            let conn = db::open(&path)?;

            // Housekeeping: drop paired-device sessions idle past the expiry
            // window so the table doesn't accumulate stale/abandoned rows. They
            // already stopped working + stopped listing (see is_valid_session /
            // list_streaming_sessions); this just deletes them for good.
            if let Ok(n) = conn.execute(
                "DELETE FROM streaming_sessions
                 WHERE last_seen_at < strftime('%s','now') - ?1",
                rusqlite::params![server::SESSION_IDLE_EXPIRY_SECS],
            ) {
                if n > 0 {
                    tracing::info!(pruned = n, "expired idle streaming sessions");
                }
            }

            let db_arc = Arc::new(Mutex::new(conn));
            // Give the ddns module a private handle so its sync
            // read_token / set_token helpers can hit the settings table
            // without us threading a connection through every call site.
            ddns::install_db_handle(db_arc.clone());
            app.manage(DbState(db_arc.clone()));

            // Background backfill: walk every downloaded track and
            // make sure cover art is embedded in the m4a. AirPlay
            // receivers (Apple TV, HomePod with display, Sony TVs)
            // read artwork from the file's `covr` atom, not from the
            // web MediaSession API. Tracks downloaded before this
            // change have no embedded art — this catches them up so
            // the user doesn't have to re-download anything to see
            // art on their TV. Idempotent (skips files that already
            // have a cover stream), no UI noise.
            library::artwork::spawn_backfill_task(db_arc);

            // Push the beet icon to the main window's title bar + macOS
            // Dock at runtime. `tauri.conf.json`'s `bundle.icon` only
            // kicks in when bundling a release `.app`; in `tauri dev`
            // the binary runs bare, so the Dock shows a generic
            // placeholder unless we set the icon programmatically here.
            if let Some(win) = app.get_webview_window("main") {
                // include_image! embeds the PNG at compile time and
                // returns an Image<'static>. set_icon clones the
                // underlying pixels so we don't have to keep the
                // macro's value alive.
                let icon = tauri::include_image!("icons/128x128@2x.png");
                let _ = win.set_icon(icon);
            }

            // Spawn the LAN streaming server if the user has it enabled.
            // Reads streaming_port + streaming_enabled out of the settings
            // table; if disabled (default), we just skip and the user can
            // flip it on later from Devices.
            let db_handle = {
                let state = app.state::<DbState>();
                state.0.clone()
            };
            // Port is fixed at startup; `streaming_enabled` is read live by
            // `reconfigure_streaming` (and re-read on every toggle), so we
            // don't capture it here.
            let port = {
                let conn = db_handle.lock().expect("db mutex poisoned");
                let (_enabled, port) = read_streaming_settings(&conn);
                port
            };
            // The local HTTP server + the background tasks that feed
            // Home/Search/Discover must ALWAYS run so the desktop UI works
            // on a fresh install. When streaming is off we bind loopback
            // only (127.0.0.1) so nothing is exposed on the LAN; when it's
            // on we bind all interfaces (0.0.0.0) and additionally spin up
            // the TLS/HTTPS/mDNS/ACME LAN-exposure extras below.
            {
                // Materialize (load-or-generate) the TLS cert eagerly so
                // AppState.cert_pem / hostname_bare are populated regardless of
                // the streaming toggle. They feed the /cert install endpoint
                // and the .mobileconfig payload, which must work the moment a
                // user enables streaming at runtime -- not only when streaming
                // happened to be on at launch. The cert lives on disk locally;
                // nothing is exposed on the network until reconfigure binds
                // 0.0.0.0 / starts HTTPS.
                let lan_ip_for_cert = local_ip_address::local_ip().ok();
                let hostname_bare = hostname::get()
                    .ok()
                    .and_then(|h| h.into_string().ok())
                    .map(|h| h.trim_end_matches(".local").to_string());
                let tls = if let Some(host) = hostname_bare.as_deref() {
                    match app.path().app_data_dir().ok() {
                        Some(data_dir) => match tls::ensure_cert(
                            &data_dir.join("tls"),
                            host,
                            lan_ip_for_cert,
                        ) {
                            Ok(art) => {
                                tracing::info!(
                                    cert_path = %art.cert_path.display(),
                                    "TLS cert ready"
                                );
                                Some(art)
                            }
                            Err(e) => {
                                tracing::warn!(?e, "TLS cert init failed; HTTPS disabled");
                                None
                            }
                        },
                        None => {
                            tracing::warn!("no app_data_dir for TLS; HTTPS disabled");
                            None
                        }
                    }
                } else {
                    None
                };
                let cert_pem_arc = tls.as_ref().map(|t| Arc::new(t.cert_pem.clone()));
                let host_arc = hostname_bare.as_ref().map(|h| Arc::new(h.clone()));

                // Shared auth surface used by both the HTTP and HTTPS
                // listeners. Pairing state lives in memory only; the rate
                // limiter tracks per-IP attempt windows; security.log
                // path is under app_data_dir so the user can grep it.
                let pairing = Arc::new(std::sync::Mutex::new(
                    auth::PairingState::new(),
                ));
                let rate_limiter = auth::RateLimiter::default();
                let security_log_path = app
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|d| d.join("security.log"))
                    .unwrap_or_else(|| std::path::PathBuf::from("security.log"));
                let security_log = Arc::new(auth::SecurityLog::new(security_log_path.clone()));
                app.manage(PairingStateHandle(pairing.clone()));
                app.manage(SecurityLogState(security_log.clone()));

                // Spin up Chromecast discovery + active-session
                // tracker. Failure here is non-fatal — the device
                // list just stays empty and the Cast UI shows "no
                // devices found."
                let cast_handle = match cast::CastManager::start() {
                    Ok(m) => Some(Arc::new(m)),
                    Err(e) => {
                        tracing::warn!(?e, "cast manager init failed");
                        None
                    }
                };

                let server_state = server::AppState {
                    db: db_handle.clone(),
                    cert_pem: cert_pem_arc.clone(),
                    hostname_bare: host_arc.clone(),
                    pairing: pairing.clone(),
                    rate_limiter: rate_limiter.clone(),
                    security_log: security_log.clone(),
                    cast: cast_handle,
                    streaming_port: port,
                    // Shared outbound HTTP client (MusicBrainz / ListenBrainz
                    // artist-graph lookups). No total timeout; only bound the
                    // connect — per-call timeouts are set at each call site.
                    proxy_http: reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .build()
                        .expect("outbound http client builds"),
                    app: app.handle().clone(),
                };
                let web_dir = resolve_web_player_dir(&app.handle());
                // `tls` was only consumed by the old inline HTTPS spawn;
                // `reconfigure_streaming` now re-derives the cert paths via
                // `materialize_https_config`. Drop the binding explicitly so
                // it isn't flagged unused.
                let _ = tls;

                // Initialize the live server runtime + control handle, then
                // call `reconfigure_streaming` once to establish the initial
                // state (loopback-only HTTP when streaming is off; 0.0.0.0 +
                // mDNS + HTTPS when on). All later toggles go through the same
                // function, so this is the single source of truth for which
                // listeners are up.
                let runtime = ServerRuntime {
                    http: None,
                    https: None,
                    mdns: None,
                    web_dir: web_dir.clone(),
                    server_state: server_state.clone(),
                    port,
                };
                app.manage(ServerControl(Arc::new(tokio::sync::Mutex::new(runtime))));
                {
                    let init_app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = reconfigure_streaming(&init_app).await {
                            tracing::error!(?e, "initial server reconfigure failed");
                        }
                    });
                }

                // Automatic UPnP port forwarding. Managed status the UI can
                // read; if remote streaming is already on at launch, open the
                // mapping + start the 30-min refresher (mirrors the DDNS
                // updater wiring below).
                let upnp = UpnpState(Arc::new(Mutex::new(UpnpStatus::default())));
                app.manage(upnp.clone());
                if read_remote_streaming_enabled(&db_handle) {
                    let upnp_db = db_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        upnp_on_enable(upnp, upnp_db, port).await;
                    });
                }

                // Embedded ngrok tunnel. Managed status the UI can read; the
                // helper brings the tunnel up iff remote streaming is on AND an
                // authtoken is configured, and is a no-op otherwise (e.g. the
                // user is on DuckDNS instead).
                let ngrok_state = ngrok::NgrokState::new();
                app.manage(ngrok_state.clone());
                restart_ngrok_from_settings(app.handle().clone(), db_handle.clone(), ngrok_state);

                // Pre-warm the Browse cache for the popular genres in the
                // background, so the first visit to one is already instant.
                server::spawn_browse_prewarm(db_handle.clone());

                // Cache LRCLIB lyrics for the whole library in the background, so
                // now-playing lyrics are an instant local hit instead of a 6-12s
                // round-trip. Gentle + resumable; the cache is a few KB per track.
                server::spawn_lyrics_prewarm(db_handle.clone());

                // Phase 1 discovery (Signal 3): fetch rich per-artist Last.fm
                // tags in the background so radio can lean on the user's "vibe"
                // graph. Incremental + rate-limited; no-op without a key.
                server::spawn_tag_enrich(&server_state);

                // Phase 4 discovery (Signal 2): extract audio "sounds-like"
                // feature vectors for downloaded files in the background (ffmpeg
                // decode + numpy/scipy). Incremental + CPU-gentle; dormant if no
                // python3-with-numpy is found.
                server::spawn_audio_enrich(&server_state);

                // Pre-warm the per-(profile, day) Home discovery cache in the
                // background (and re-warm just after each local midnight, when
                // the date key rolls over), so the day's first Home load is
                // cache-served instead of paying the ~15-25-call fan-out live.
                server::spawn_home_prewarm(&server_state);

                // Keyless metadata backfill on startup: fills any remaining
                // gaps (artwork/ISRC + release_year/genre for Home's
                // Decade/Genre mixes) from Deezer. Single-flight + COALESCE, so
                // a fully-filled library is a quick no-op; the existing library
                // gets its year/genre on the first launch after this ships.
                {
                    let bf_app = app.handle().clone();
                    let bf_db = db_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                        let _ = drive_backfill(bf_app, bf_db).await;
                    });
                }

                // Prune orphan track rows on launch: rows in no playlist, left
                // behind by playing/queueing catalog songs. Short delay so it
                // doesn't compete with first-paint queries. The DB lock is taken
                // and released inside the closure (never held across an await).
                {
                    let prune_db = db_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        let (pruned, artists_fixed) = {
                            let conn = prune_db.lock().expect("db mutex poisoned");
                            // Same launch pass: repair legacy ';'-joined artist
                            // arrays (Exportify imports predating the split fix).
                            (prune_orphan_tracks(&conn), split_semicolon_artists(&conn))
                        };
                        tracing::info!(
                            pruned,
                            artists_fixed,
                            "launch DB cleanup complete (orphan prune + artist repair)"
                        );
                    });
                }

                // ACME auto-renewal sweeper. Always runs (cheap): wakes every
                // 24 hours; if a Let's Encrypt cert exists and its file mtime
                // is older than 60 days, re-issue (LE certs are valid 90 days).
                // Skips silently when no cert is present yet -- the first
                // issuance is always user-initiated.
                let renew_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut ticker = tokio::time::interval(
                        std::time::Duration::from_secs(24 * 3600),
                    );
                    ticker.set_missed_tick_behavior(
                        tokio::time::MissedTickBehavior::Delay,
                    );
                    loop {
                        ticker.tick().await;
                        if let Err(e) = try_renew_cert(&renew_app).await {
                            tracing::debug!(?e, "auto-renewal: nothing to do");
                        }
                    }
                });
            } // end always-run server block

            // Background DDNS updater. Wakes every 5 minutes; if a
            // subdomain + token are present it pushes the current public
            // IP to the provider. Skips the push silently when no token
            // is configured -- that's the off state. Each iteration is
            // independent: if one fails, the next one tries again.
            let ddns_db = db_handle.clone();
            tauri::async_runtime::spawn(async move {
                // First tick happens immediately so newly-configured DDNS
                // doesn't sit unpublished until the first interval.
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(300));
                ticker.set_missed_tick_behavior(
                    tokio::time::MissedTickBehavior::Delay,
                );
                loop {
                    ticker.tick().await;
                    let configured = {
                        let conn = ddns_db.lock().expect("db mutex poisoned");
                        ddns::get_subdomain(&conn).ok().flatten().is_some()
                    };
                    if !configured {
                        continue;
                    }
                    if ddns::read_token().is_none() {
                        continue;
                    }
                    match ddns::run_once(&ddns_db).await {
                        Ok(o) => {
                            tracing::info!(host = %o.hostname, ip = %o.ip,
                                "DDNS update succeeded");
                        }
                        Err(e) => {
                            tracing::warn!(?e, "DDNS update failed");
                        }
                    }
                }
            });

            // Optional: souvlaki integration. Failure (e.g. system MediaPlayer
            // unavailable) is logged but non-fatal -- audio playback still
            // works without the OS Now Playing card.
            match media::init(&app.handle()) {
                Ok(controls) => {
                    app.manage(media::MediaState(Arc::new(Mutex::new(controls))));
                    tracing::info!("media controls initialized");
                }
                Err(e) => {
                    tracing::warn!(?e, "media controls unavailable; skipping");
                }
            }
            Ok(())
}

/// The core command handler. Exposed so the full-build shell composes it with
/// the engine's handler (the shell routes each invoke by command name).
pub fn invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            ping,
            db_health,
            import_csv,
            import_exportify_archive,
            import_apple_music_playlist,
            import_soundcloud_playlist,
            open_exportify_window,
            list_playlists,
            get_playlist,
            delete_playlist,
            rename_playlist,
            list_tracks,
            get_track,
            search_tracks,
            list_library_songs,
            list_library_albums,
            list_library_artists,
            export_library,
            import_library_backup,
            import_local_file,
            streaming_status,
            streaming_set_enabled,
            list_streaming_sessions,
            revoke_streaming_session,
            get_download_dir,
            set_download_dir,
            storage_usage,
            clear_live_cache,
            get_log_dir,
            probe_network,
            upnp_status,
            ddns_get_status,
            ddns_set_config,
            ddns_clear,
            ddns_update_now,
            ngrok_get_status,
            ngrok_set_config,
            ngrok_clear,
            acme_get_status,
            acme_issue,
            acme_clear,
            pairing_get_info,
            pairing_set_required,
            remote_streaming_set_enabled,
            get_security_log_path,
            list_profiles,
            create_profile,
            update_profile,
            set_profile_pin,
            verify_profile_pin,
            delete_profile,
            set_profile_avatar,
            set_profile_avatar_data,
            read_image_data_url,
            clear_profile_avatar,
            lastfm_get_key,
            lastfm_set_key,
            lastfm_clear_key,
            media::media_set_track,
            media::media_set_playback,
        ]
}
