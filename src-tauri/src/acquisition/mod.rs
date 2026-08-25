//! The single open/closed acquisition boundary.
//!
//! In the OPEN product a catalog track (`status='pending'`, `local_path` NULL)
//! becomes playable ONLY when the user imports a file they already own — there
//! is no automatic acquisition. The CLOSED engine will later implement this same
//! trait to match + download audio, injecting its provider at startup instead.
//!
//! Mirrors [`crate::ddns`]'s provider pattern (a `thiserror` enum + an
//! `#[async_trait]` object-safe trait + a process-wide `OnceLock`). `ddns` has no
//! registry today (it hardcodes its impl), so the `register_provider` /
//! `active_provider` layer is built here on the same `OnceLock` idiom. The open
//! build never calls `register_provider`: `active_provider()` defaults to the
//! built-in [`LocalFileProvider`] on read, so the boundary adds ZERO wiring and
//! is behavior-identical.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rusqlite::Connection;

/// Error vocabulary for acquisition. The `Display` strings are kept identical to
/// the legacy `import_local_file` error strings so the frontend's error UX is
/// byte-identical; the `Provider` catch-all lets the closed engine add
/// match/download failure modes without editing this enum.
#[derive(Debug, thiserror::Error)]
pub enum AcquisitionError {
    /// No audio for this track and the provider can't acquire it unaided.
    /// `LocalFileProvider` returns this for [`AcquireSource::Auto`] (the open
    /// build never takes that path). The engine rarely emits it.
    #[error("no audio available for this track; import a file")]
    Unavailable,
    /// Source file the user pointed at does not exist / is not a file.
    #[error("File not found: {0}")]
    FileNotFound(String),
    /// ffmpeg transcode failed or ffmpeg is missing — carries the exact
    /// human-readable string `transcode_to_m4a` already produces.
    #[error("{0}")]
    Transcode(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Catch-all (lock poisoning, library helpers, future engine failures).
    #[error("{0}")]
    Provider(String),
}

/// Superset of every track `status` value across both products. Core defines
/// ALL variants; `LocalFileProvider` only ever constructs `Downloaded` (and
/// `Failed` on a hard error). `Pending`/`NeedsReview`/`Skipped` are existing
/// core states; `Matching`/`Downloading`/`Matched` are reserved for the engine
/// so any shared `match status { .. }` compiles when the engine is linked. The
/// on-disk TEXT values are unchanged (kebab/lower) and `tracks.status` has no
/// CHECK constraint, so introducing the enum needs no migration.
// Superset: the open build only ever constructs `Downloaded`; the other
// variants exist so engine-aware `match status {…}` compiles when linked.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackStatus {
    Pending,
    Downloaded,
    NeedsReview,
    Failed,
    Skipped,
    Matching,
    Downloading,
    Matched,
}

impl TrackStatus {
    /// The on-disk TEXT representation (unchanged from today's literals).
    pub fn as_db_str(self) -> &'static str {
        match self {
            TrackStatus::Pending => "pending",
            TrackStatus::Downloaded => "downloaded",
            TrackStatus::NeedsReview => "needs-review",
            TrackStatus::Failed => "failed",
            TrackStatus::Skipped => "skipped",
            TrackStatus::Matching => "matching",
            TrackStatus::Downloading => "downloading",
            TrackStatus::Matched => "matched",
        }
    }
}

/// How an [`AcquisitionProvider::acquire`] call should source audio.
// `Auto` is the engine path; the open build only ever constructs `UserFile`.
#[allow(dead_code)]
pub enum AcquireSource {
    /// The user pointed at a file they already own (today's only open path).
    UserFile(PathBuf),
    /// "Make it playable however you can." `LocalFileProvider` returns
    /// [`AcquisitionError::Unavailable`]; the engine will match + download.
    Auto,
}

/// The columns an acquire writes, returned to core so the single
/// `UPDATE tracks SET …` stays in one place (uniform status-writing).
pub struct AcquisitionOutcome {
    pub local_path: String,
    pub file_size_bytes: Option<i64>,
    pub status: TrackStatus,
    pub match_method: &'static str,
}

/// The one boundary the closed engine implements. `LocalFileProvider` satisfies
/// it via the user-import flow; an `EngineProvider` would satisfy it by
/// match + download.
#[async_trait]
pub trait AcquisitionProvider: Send + Sync {
    /// Stable identity, like [`crate::ddns`]'s provider. Built-in: `"local-file"`.
    #[allow(dead_code)] // identity hook; consumed by the engine / diagnostics.
    fn name(&self) -> &'static str;

    /// Whether resolving a catalog row should auto-start acquisition.
    /// `LocalFileProvider` returns `false` (resolve stays metadata-only); the
    /// engine returns `true`. Lets shared "open this catalog track" call-sites
    /// stay behavior-identical — the open build never auto-acquires.
    #[allow(dead_code)] // engine seam; the open build never auto-acquires.
    fn auto_acquires(&self) -> bool {
        false
    }

    /// Make this catalog track playable — THE load-bearing seam. The built-in
    /// runs the exact import body (validate → resolve dir → build basename →
    /// copy/transcode → embed artwork → stat) and returns the columns to write;
    /// for [`AcquireSource::Auto`] it returns [`AcquisitionError::Unavailable`].
    /// Takes the `AppHandle` (for the download dir) and the DB handle directly
    /// (a `tauri::State` can't be stored in a long-lived provider — same reason
    /// `ddns` keeps its own `Arc<Mutex<Connection>>`).
    async fn acquire(
        &self,
        app: &tauri::AppHandle,
        db: &Arc<Mutex<Connection>>,
        track_id: i64,
        source: AcquireSource,
    ) -> Result<AcquisitionOutcome, AcquisitionError>;

    /// Resolve a `track_id` to a currently-playable local file path, or `None`.
    /// This is the `/stream` lookup made provider-aware; the built-in runs the
    /// identical `SELECT local_path`, so `stream_track` stays byte-identical.
    fn resolve_local_path(
        &self,
        conn: &Connection,
        track_id: i64,
    ) -> Result<Option<String>, AcquisitionError>;

    /// Resolve a track to a seekable LOCAL file for *immediate* playback without
    /// permanently acquiring it — the "stream it now" path behind
    /// `/stream/{id}/live`. The built-in open provider has no source to stream
    /// and returns `Ok(None)` (the route then 404s and the player previews); a
    /// full-build provider resolves the source and remuxes it to a temp file,
    /// returning a path the caller range-serves. Default = `Ok(None)` so the
    /// open build needs no implementation.
    ///
    /// `background` distinguishes a listener actively waiting on this stream
    /// (a tap, a cast) from a warm-up the player fires for the NEXT queue
    /// entries. Providers that queue or prioritize work may let foreground
    /// requests overtake background ones; the built-in provider ignores it.
    #[allow(unused_variables)]
    async fn live_path(
        &self,
        app: &tauri::AppHandle,
        db: &Arc<Mutex<Connection>>,
        track_id: i64,
        background: bool,
    ) -> Result<Option<String>, AcquisitionError> {
        Ok(None)
    }

    /// When did instant streaming degrade to its slower route, if it has?
    /// `None` = healthy (or the provider doesn't track it — the built-in one
    /// serves local files only, where there is nothing to degrade). Unix
    /// seconds when set; surfaced by `/api/streaming/health` so the UI can
    /// say so instead of leaving users to wonder why first plays got slow.
    #[allow(unused_variables)]
    async fn live_health(&self, db: &Arc<Mutex<Connection>>) -> Option<i64> {
        None
    }
}

/// The built-in open provider: audio comes only from user-imported files.
pub struct LocalFileProvider;

#[async_trait]
impl AcquisitionProvider for LocalFileProvider {
    fn name(&self) -> &'static str {
        "local-file"
    }

    async fn acquire(
        &self,
        app: &tauri::AppHandle,
        db: &Arc<Mutex<Connection>>,
        track_id: i64,
        source: AcquireSource,
    ) -> Result<AcquisitionOutcome, AcquisitionError> {
        // The open product has no automatic acquisition — only user files.
        let src = match source {
            AcquireSource::UserFile(p) => p,
            AcquireSource::Auto => return Err(AcquisitionError::Unavailable),
        };
        if !src.is_file() {
            return Err(AcquisitionError::FileNotFound(
                src.to_string_lossy().to_string(),
            ));
        }

        let (title, artists_json, art_url): (String, String, Option<String>) = {
            let conn = db
                .lock()
                .map_err(|e| AcquisitionError::Provider(e.to_string()))?;
            conn.query_row(
                "SELECT title, artists, album_art_url FROM tracks WHERE id = ?1",
                rusqlite::params![track_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?
        };
        let artists: Vec<String> = serde_json::from_str(&artists_json).unwrap_or_default();

        let dest_dir = {
            let conn = db
                .lock()
                .map_err(|e| AcquisitionError::Provider(e.to_string()))?;
            crate::library::resolve_download_dir(app, &conn)
                .map_err(AcquisitionError::Provider)?
        };
        std::fs::create_dir_all(&dest_dir).map_err(|e| AcquisitionError::Io(e.to_string()))?;
        let basename = crate::library::filename::build_basename(&artists, &title);
        let dest = dest_dir.join(format!("{basename}.m4a"));

        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_lowercase);
        let copy_verbatim = matches!(ext.as_deref(), Some("m4a") | Some("aac") | Some("mp4"));
        if copy_verbatim {
            if src != dest {
                std::fs::copy(&src, &dest).map_err(|e| AcquisitionError::Io(e.to_string()))?;
            }
        } else {
            crate::transcode_to_m4a(&src, &dest)
                .await
                .map_err(AcquisitionError::Transcode)?;
        }

        // Best-effort cover art embedded into the imported file.
        if let Some(url) = art_url {
            if let Err(e) = crate::library::artwork::embed_artwork(&dest, &url).await {
                tracing::warn!(track_id, ?e, "import: embed_artwork failed (continuing)");
            }
        }

        let size = std::fs::metadata(&dest).ok().map(|m| m.len() as i64);
        let dest_str = dest.to_string_lossy().to_string();
        Ok(AcquisitionOutcome {
            local_path: dest_str,
            file_size_bytes: size,
            status: TrackStatus::Downloaded,
            match_method: "manual-file",
        })
    }

    fn resolve_local_path(
        &self,
        conn: &Connection,
        track_id: i64,
    ) -> Result<Option<String>, AcquisitionError> {
        // Identical to the legacy `stream_track` lookup. A missing row / DB
        // error surfaces as `Err`; the caller maps it to `None` (404), matching
        // the old `.ok().flatten()`.
        let local_path: Option<String> = conn.query_row(
            "SELECT local_path FROM tracks WHERE id = ?1",
            rusqlite::params![track_id],
            |r| r.get(0),
        )?;
        Ok(local_path)
    }
}

// ---- Process-wide registry (mirrors ddns's OnceLock idiom) ----------------

static PROVIDER: std::sync::OnceLock<Arc<dyn AcquisitionProvider>> = std::sync::OnceLock::new();

/// Install the active provider ONCE at startup (subsequent calls are silent
/// no-ops, like `ddns::install_db_handle`). The closed engine calls this from
/// its own init, before the server starts; the open build never calls it.
#[allow(dead_code)] // engine seam: the open build relies on the default-on-read.
pub fn register_provider(p: Arc<dyn AcquisitionProvider>) {
    let _ = PROVIDER.set(p);
}

/// The active provider. Defaults to the built-in [`LocalFileProvider`] when none
/// was registered, so the open build is behavior-identical without any wiring.
pub fn active_provider() -> Arc<dyn AcquisitionProvider> {
    PROVIDER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(LocalFileProvider))
}
