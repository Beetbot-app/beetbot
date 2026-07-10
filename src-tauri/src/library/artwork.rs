//! Embed cover art into downloaded m4a files via ffmpeg.
//!
//! Why this exists: AirPlay receivers (Apple TV, HomePod with display,
//! Sony TVs, etc.) read album art from the audio file's embedded
//! metadata (the m4a `covr` atom), not from the web MediaSession API.
//! Even though we set MediaSession metadata on the page side, Sony /
//! generic AirPlay receivers don't pick it up. Embedding directly in
//! the file is the reliable path.
//!
//! Flow per track:
//!   1. HTTP GET the album_art_url (Spotify CDN — public, no auth).
//!   2. Write the bytes to a sibling temp file (`<basename>.cover.jpg`).
//!   3. ffmpeg copies the existing audio + the cover image into a new
//!      m4a, tagging the image stream with `disposition=attached_pic`
//!      so receivers treat it as cover art rather than a video track.
//!   4. Atomically rename the new file over the original.
//!
//! Idempotent enough to re-run on already-embedded files (ffmpeg just
//! replaces the existing cover). Skipped silently if ffmpeg isn't
//! installed — the rest of the app keeps working, AirPlay receivers
//! just don't get art.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

#[derive(Debug, thiserror::Error)]
pub enum ArtworkError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg exited with status {0}")]
    Ffmpeg(i32),
    #[error("ffmpeg not found on PATH (brew install ffmpeg)")]
    FfmpegMissing,
}

/// Download `art_url` and embed it into `m4a_path` as cover art.
/// Replaces the original file on success; leaves it untouched on error
/// (the partial temp files are cleaned up regardless).
pub async fn embed_artwork(
    m4a_path: &Path,
    art_url: &str,
) -> Result<(), ArtworkError> {
    // 1. Download the cover.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let resp = client.get(art_url).send().await?.error_for_status()?;
    let bytes = resp.bytes().await?;

    // 2. Write to a sibling temp file. Using sibling rather than
    // /tmp because ffmpeg's input/output paths get logged, and a
    // sibling makes debugging easier if something goes wrong.
    let art_temp = m4a_path.with_extension("beetbot-cover.jpg");
    let out_temp = m4a_path.with_extension("beetbot-with-art.m4a");
    tokio::fs::write(&art_temp, &bytes).await?;

    // 3. Run ffmpeg. -map 0:a takes the audio from input 0,
    //    -map 1:v takes the image as a "video" stream from input 1,
    //    -c copy avoids re-encoding (fast, lossless),
    //    -disposition:v:0 attached_pic flags the video stream as
    //    cover art (this is what makes receivers/players treat it as
    //    artwork instead of a tiny video track to play).
    // Resolve ffmpeg explicitly — a bare "ffmpeg" fails when the app is
    // launched from Finder/Dock (minimal PATH without Homebrew).
    let ffmpeg_bin = crate::library::ffmpeg::ffmpeg_path()
        .unwrap_or_else(|| std::path::PathBuf::from("ffmpeg"));
    let ffmpeg = tokio::process::Command::new(&ffmpeg_bin)
        .args([
            "-y",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(m4a_path)
        .arg("-i")
        .arg(&art_temp)
        .args([
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-c",
            "copy",
            "-disposition:v:0",
            "attached_pic",
            "-metadata:s:v",
            "title=Album cover",
            "-metadata:s:v",
            "comment=Cover (front)",
        ])
        .arg(&out_temp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;

    let status = match ffmpeg {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_file(&art_temp).await;
            return Err(ArtworkError::FfmpegMissing);
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&art_temp).await;
            return Err(ArtworkError::Io(e));
        }
    };
    let _ = tokio::fs::remove_file(&art_temp).await;
    if !status.success() {
        let _ = tokio::fs::remove_file(&out_temp).await;
        return Err(ArtworkError::Ffmpeg(status.code().unwrap_or(-1)));
    }

    // 4. Atomic-ish replace. tokio::fs::rename on the same filesystem
    // is atomic on POSIX; if the dest exists it's overwritten.
    tokio::fs::rename(&out_temp, m4a_path).await?;
    Ok(())
}

/// Fast check: does the m4a already have an embedded "video" stream
/// (which is how cover art is stored in MP4 containers)? Avoids
/// re-embedding on every backfill pass.
async fn has_embedded_art(m4a_path: &Path) -> bool {
    let out = tokio::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=nw=1",
        ])
        .arg(m4a_path)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains("codec_type=video")
        }
        _ => false,
    }
}

/// One-time backfill: walk every downloaded track that has an
/// album_art_url and embed the art if not already present. Runs in
/// the background with a small concurrency cap so it doesn't pin the
/// CPU on startup. Silent — emits no UI events. Logs progress to the
/// tracing log file so an admin can confirm.
///
/// Idempotent: tracks whose m4a already carries cover art are
/// skipped via ffprobe.
pub fn spawn_backfill_task(db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        // Small delay so we don't compete with the rest of the app's
        // startup work (DB migrations, server bind, mDNS announce, …).
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;

        let rows: Vec<(i64, String, Option<String>)> = {
            let conn = db.lock().expect("db mutex poisoned");
            let mut stmt = match conn.prepare(
                "SELECT id, local_path, album_art_url
                 FROM tracks
                 WHERE local_path IS NOT NULL
                   AND album_art_url IS NOT NULL",
            ) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(?e, "artwork backfill: query prepare");
                    return;
                }
            };
            let iter = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            });
            match iter {
                Ok(it) => it.filter_map(|r| r.ok()).collect(),
                Err(e) => {
                    tracing::warn!(?e, "artwork backfill: query map");
                    return;
                }
            }
        };

        if rows.is_empty() {
            return;
        }
        tracing::info!(
            count = rows.len(),
            "artwork backfill: scanning for tracks missing cover art"
        );

        let mut processed = 0usize;
        let mut embedded = 0usize;
        let mut skipped_present = 0usize;
        let mut errored = 0usize;
        for (track_id, local_path, art_url) in rows {
            let Some(art_url) = art_url else { continue };
            let path: PathBuf = local_path.into();
            if !path.exists() {
                continue;
            }
            processed += 1;
            if has_embedded_art(&path).await {
                skipped_present += 1;
                continue;
            }
            match embed_artwork(&path, &art_url).await {
                Ok(()) => {
                    embedded += 1;
                    tracing::debug!(track_id, "artwork backfill: embedded");
                }
                Err(ArtworkError::FfmpegMissing) => {
                    tracing::warn!(
                        "artwork backfill: ffmpeg not on PATH — aborting backfill"
                    );
                    return;
                }
                Err(e) => {
                    errored += 1;
                    tracing::warn!(track_id, ?e, "artwork backfill: embed failed");
                }
            }
            // Light throttle so this doesn't peg the CPU. ffmpeg
            // -c copy is fast (~100-300 ms per track on macOS) but
            // we're not in a rush.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        tracing::info!(
            processed,
            embedded,
            skipped_present,
            errored,
            "artwork backfill: done"
        );
    });
}

