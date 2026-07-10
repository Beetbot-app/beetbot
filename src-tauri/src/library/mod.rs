//! Local-library utilities shared by the local-file import path: ffmpeg
//! discovery, on-disk filename construction, cover-art embedding, and the
//! download-directory resolver.

pub mod artwork;
pub mod ffmpeg;
pub mod filename;

use std::path::PathBuf;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// Resolve the directory we should write audio files into. Settings table
/// wins if set; otherwise `<app_data_dir>/library/`.
pub fn resolve_download_dir(app: &AppHandle, conn: &Connection) -> Result<PathBuf, String> {
    let setting: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'download_dir'",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(s) = setting {
        if !s.trim().is_empty() {
            return Ok(PathBuf::from(s));
        }
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("library"))
}
