//! Exportify CSV importer.
//!
//! [Exportify](https://exportify.net/) dumps a Spotify playlist as a CSV with
//! one row per track. We map those rows into our `playlists`, `tracks`, and
//! `playlist_tracks` tables.
//!
//! Because the CSV does not carry a Spotify playlist ID, we synthesise one of
//! the form `csv:<sanitized name>` and treat re-imports under the same name as
//! updates to the existing playlist (tracklist is replaced; tracks themselves
//! are de-duplicated by their real Spotify track ID).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::DateTime;
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("missing required column: {0}")]
    MissingColumn(&'static str),
    #[error("playlist name could not be inferred; pass one explicitly")]
    MissingPlaylistName,
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
}

#[derive(Debug, Serialize, Clone)]
pub struct ImportSummary {
    pub playlist_id: i64,
    pub playlist_name: String,
    pub tracks_added: usize,
    pub tracks_existing: usize,
    pub rows_skipped: usize,
    /// When the source playlist was bigger than the import cap, this is its
    /// TOTAL track count (we imported fewer). None = nothing was cut off.
    pub truncated_total: Option<usize>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct BulkImportSummary {
    pub playlists_imported: usize,
    pub tracks_added: usize,
    pub tracks_existing: usize,
    pub rows_skipped: usize,
    pub failures: Vec<BulkImportFailure>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BulkImportFailure {
    pub file: String,
    pub error: String,
}

/// Import everything inside an Exportify "Export All" archive.
///
/// The archive is a flat zip of `<playlist name>.csv` files. We extract to a
/// temp dir, call [`import_exportify_csv`] for each CSV, and accumulate a
/// [`BulkImportSummary`]. Individual file failures are recorded but do not
/// abort the rest of the batch.
pub fn import_exportify_archive(
    conn: &mut Connection,
    zip_path: &Path,
) -> Result<BulkImportSummary, ImportError> {
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let extract_dir = tempfile::TempDir::new()?;

    let mut summary = BulkImportSummary::default();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let rel = rel.to_owned();
        // Skip directories and Apple's __MACOSX cruft.
        if entry.is_dir()
            || rel
                .components()
                .any(|c| c.as_os_str() == "__MACOSX" || c.as_os_str().to_string_lossy().starts_with("._"))
        {
            continue;
        }
        let Some(ext) = rel.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("csv") {
            continue;
        }

        let out_path: PathBuf = extract_dir.path().join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;
        drop(out);

        let playlist_name = rel
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_owned);
        match import_exportify_csv(conn, &out_path, playlist_name.as_deref()) {
            Ok(s) => {
                summary.playlists_imported += 1;
                summary.tracks_added += s.tracks_added;
                summary.tracks_existing += s.tracks_existing;
                summary.rows_skipped += s.rows_skipped;
            }
            Err(e) => {
                summary.failures.push(BulkImportFailure {
                    file: rel.display().to_string(),
                    error: e.to_string(),
                });
            }
        }
    }

    Ok(summary)
}

/// Import an Exportify CSV from disk. If `playlist_name` is `None`, falls back
/// to the file stem.
pub fn import_exportify_csv(
    conn: &mut Connection,
    csv_path: &Path,
    playlist_name: Option<&str>,
) -> Result<ImportSummary, ImportError> {
    let name = playlist_name
        .map(str::to_owned)
        .or_else(|| {
            csv_path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_owned)
        })
        .ok_or(ImportError::MissingPlaylistName)?;

    let mut file = File::open(csv_path)?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    import_from_str(conn, &buf, &name)
}

/// Same as [`import_exportify_csv`] but consumes the CSV as a string. Useful
/// for tests and for callers that already have the bytes in memory.
pub fn import_from_str(
    conn: &mut Connection,
    csv: &str,
    playlist_name: &str,
) -> Result<ImportSummary, ImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(csv.as_bytes());

    let headers = reader.headers()?.clone();
    let idx = ColumnIndex::from_headers(&headers)?;

    let tx = conn.transaction()?;

    let synthetic_spotify_id = format!("csv:{}", slug(playlist_name));
    let snapshot = format!("csv-import:{}", chrono::Utc::now().timestamp());

    // Upsert the playlist by synthetic spotify_id.
    tx.execute(
        "INSERT INTO playlists
             (spotify_id, name, snapshot_id, track_count, last_synced_at, profile_id)
         VALUES (?1, ?2, ?3, 0, strftime('%s','now'),
                 (SELECT COALESCE(MIN(id), 1) FROM profiles))
         ON CONFLICT(spotify_id) DO UPDATE SET
             name = excluded.name,
             snapshot_id = excluded.snapshot_id,
             last_synced_at = excluded.last_synced_at",
        params![synthetic_spotify_id, playlist_name, snapshot],
    )?;
    let playlist_id: i64 = tx.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![synthetic_spotify_id],
        |r| r.get(0),
    )?;

    // Wipe the old tracklist; we replace it wholesale on every import.
    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
    )?;

    let mut tracks_added = 0usize;
    let mut tracks_existing = 0usize;
    let mut rows_skipped = 0usize;

    for (position, record) in reader.records().enumerate() {
        let record = record?;
        let row = match Row::extract(&record, &idx) {
            Some(r) => r,
            None => {
                rows_skipped += 1;
                continue;
            }
        };

        let artists_json = serde_json::to_string(&row.artists)?;

        let inserted = tx.execute(
            "INSERT INTO tracks (spotify_id, title, artists, album, album_art_url, duration_ms, isrc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(spotify_id) DO NOTHING",
            params![
                row.spotify_id,
                row.title,
                artists_json,
                row.album,
                row.album_art_url,
                row.duration_ms,
                row.isrc,
            ],
        )?;
        if inserted == 1 {
            tracks_added += 1;
        } else {
            tracks_existing += 1;
        }

        let track_id: i64 = tx.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![row.spotify_id],
            |r| r.get(0),
        )?;

        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![playlist_id, track_id, position as i64, row.added_at],
        )?;
    }

    let total = tracks_added + tracks_existing;
    tx.execute(
        "UPDATE playlists SET track_count = ?1 WHERE id = ?2",
        params![total as i64, playlist_id],
    )?;
    tx.commit()?;

    Ok(ImportSummary {
        playlist_id,
        playlist_name: playlist_name.to_owned(),
        tracks_added,
        tracks_existing,
        rows_skipped,
        truncated_total: None,
    })
}

/// Insert a playlist scraped from a public Apple Music link.
///
/// Apple Music audio is DRM-locked, so tracks are stored metadata-only with the
/// default `pending` status, exactly like a Spotify import — the user attaches
/// their own audio file to each afterwards. Re-importing the same link updates
/// the playlist in place (synthetic id `apple:<slug>`).
pub fn insert_apple_music_playlist(
    conn: &mut Connection,
    profile_id: i64,
    source_url: &str,
    playlist: &crate::apple::ApplePlaylist,
) -> Result<ImportSummary, ImportError> {
    let name = if playlist.title.trim().is_empty() {
        "Apple Music playlist".to_string()
    } else {
        playlist.title.trim().to_string()
    };
    let synthetic_spotify_id = format!("apple:{}", slug(source_url));
    let snapshot = format!("apple-import:{}", chrono::Utc::now().timestamp());

    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO playlists
             (spotify_id, name, snapshot_id, track_count, last_synced_at, profile_id)
         VALUES (?1, ?2, ?3, 0, strftime('%s','now'), ?4)
         ON CONFLICT(spotify_id) DO UPDATE SET
             name = excluded.name,
             snapshot_id = excluded.snapshot_id,
             last_synced_at = excluded.last_synced_at",
        params![synthetic_spotify_id, name, snapshot, profile_id],
    )?;
    let playlist_id: i64 = tx.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![synthetic_spotify_id],
        |r| r.get(0),
    )?;

    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
    )?;

    let mut tracks_added = 0usize;
    let mut tracks_existing = 0usize;
    let mut rows_skipped = 0usize;

    for (position, t) in playlist.tracks.iter().enumerate() {
        if t.title.trim().is_empty() {
            rows_skipped += 1;
            continue;
        }
        let track_key = if t.id.trim().is_empty() {
            format!("{}|{}", t.title.trim(), t.artist.trim())
        } else {
            t.id.trim().to_string()
        };
        let track_sid = format!("apple:track:{}", slug(&track_key));
        let artist = if t.artist.trim().is_empty() {
            "Unknown artist".to_string()
        } else {
            t.artist.trim().to_string()
        };
        let artists_json = serde_json::to_string(&vec![artist])?;

        // An upsert reports 1 changed row for BOTH branches, so check
        // existence first to keep the added/existing counts honest.
        let existed: bool = tx
            .query_row(
                "SELECT 1 FROM tracks WHERE spotify_id = ?1",
                params![track_sid],
                |_| Ok(()),
            )
            .is_ok();

        // Metadata only — default `pending` status; the user attaches their
        // own audio file afterwards (Apple audio is DRM-locked).
        tx.execute(
            "INSERT INTO tracks
                 (spotify_id, title, artists, album, album_art_url, duration_ms, isrc)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL)
             ON CONFLICT(spotify_id) DO UPDATE SET
                 title = excluded.title,
                 artists = excluded.artists,
                 album_art_url = excluded.album_art_url,
                 duration_ms = excluded.duration_ms,
                 updated_at = strftime('%s','now')",
            params![track_sid, t.title, artists_json, t.artwork_url, t.duration_ms],
        )?;
        if existed {
            tracks_existing += 1;
        } else {
            tracks_added += 1;
        }

        let track_id: i64 = tx.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![track_sid],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))",
            params![playlist_id, track_id, position as i64],
        )?;
    }

    let total = tracks_added + tracks_existing;
    tx.execute(
        "UPDATE playlists SET track_count = ?1 WHERE id = ?2",
        params![total as i64, playlist_id],
    )?;
    tx.commit()?;

    // If the page advertised more tracks than it actually embedded, the render
    // was truncated (very large playlists) — surface that rather than silently
    // importing a prefix.
    let truncated_total = playlist
        .total_count
        .filter(|&n| n > playlist.tracks.len());

    Ok(ImportSummary {
        playlist_id,
        playlist_name: name,
        tracks_added,
        tracks_existing,
        rows_skipped,
        truncated_total,
    })
}

/// Insert a playlist scraped from a public SoundCloud playlist/set link.
///
/// Metadata only — Beetbot is local-first, so there's no audio download:
/// tracks are stored with `local_path` NULL and the default `pending` status,
/// exactly like the Apple Music import. The user attaches
/// their own audio file to each track afterwards. Re-importing the same link
/// updates the playlist in place (synthetic id `soundcloud:<slug>`).
pub fn insert_soundcloud_playlist(
    conn: &mut Connection,
    profile_id: i64,
    source_url: &str,
    playlist: &crate::soundcloud::ScPlaylist,
) -> Result<ImportSummary, ImportError> {
    let name = if playlist.title.trim().is_empty() {
        "SoundCloud playlist".to_string()
    } else {
        playlist.title.trim().to_string()
    };
    let synthetic_spotify_id = format!("soundcloud:{}", slug(source_url));
    let snapshot = format!("soundcloud-import:{}", chrono::Utc::now().timestamp());

    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO playlists
             (spotify_id, name, snapshot_id, track_count, last_synced_at, profile_id)
         VALUES (?1, ?2, ?3, 0, strftime('%s','now'), ?4)
         ON CONFLICT(spotify_id) DO UPDATE SET
             name = excluded.name,
             snapshot_id = excluded.snapshot_id,
             last_synced_at = excluded.last_synced_at",
        params![synthetic_spotify_id, name, snapshot, profile_id],
    )?;
    let playlist_id: i64 = tx.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![synthetic_spotify_id],
        |r| r.get(0),
    )?;

    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
    )?;

    let mut tracks_added = 0usize;
    let mut tracks_existing = 0usize;
    let mut rows_skipped = 0usize;

    for (position, t) in playlist.tracks.iter().enumerate() {
        if t.title.trim().is_empty() {
            rows_skipped += 1;
            continue;
        }
        let track_key = if t.source_id.trim().is_empty() {
            format!("{}|{}", t.title.trim(), t.artist.trim())
        } else {
            t.source_id.trim().to_string()
        };
        let track_sid = format!("soundcloud:track:{}", slug(&track_key));
        let artist = if t.artist.trim().is_empty() {
            "Unknown artist".to_string()
        } else {
            t.artist.trim().to_string()
        };
        let artists_json = serde_json::to_string(&vec![artist])?;

        // An upsert reports 1 changed row for BOTH branches, so check
        // existence first to keep the added/existing counts honest.
        let existed: bool = tx
            .query_row(
                "SELECT 1 FROM tracks WHERE spotify_id = ?1",
                params![track_sid],
                |_| Ok(()),
            )
            .is_ok();

        // Metadata only — album NULL, local_path NULL + default status, so the
        // track shows in the library awaiting a user-attached file.
        tx.execute(
            "INSERT INTO tracks
                 (spotify_id, title, artists, album, album_art_url, duration_ms, isrc)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL)
             ON CONFLICT(spotify_id) DO UPDATE SET
                 title = excluded.title,
                 artists = excluded.artists,
                 album_art_url = excluded.album_art_url,
                 duration_ms = excluded.duration_ms,
                 updated_at = strftime('%s','now')",
            params![track_sid, t.title, artists_json, t.artwork_url, t.duration_ms],
        )?;
        if existed {
            tracks_existing += 1;
        } else {
            tracks_added += 1;
        }

        let track_id: i64 = tx.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![track_sid],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))",
            params![playlist_id, track_id, position as i64],
        )?;
    }

    let total = tracks_added + tracks_existing;
    tx.execute(
        "UPDATE playlists SET track_count = ?1 WHERE id = ?2",
        params![total as i64, playlist_id],
    )?;
    tx.commit()?;

    // If SoundCloud advertised more tracks than we could read (deleted/private
    // entries dropped during fetch), surface the gap rather than hiding it.
    let truncated_total = playlist
        .total_count
        .filter(|&n| n > playlist.tracks.len());

    Ok(ImportSummary {
        playlist_id,
        playlist_name: name,
        tracks_added,
        tracks_existing,
        rows_skipped,
        truncated_total,
    })
}

struct ColumnIndex {
    track_uri: usize,
    track_name: usize,
    artist_names: usize,
    album_name: Option<usize>,
    album_image_url: Option<usize>,
    duration_ms: usize,
    isrc: Option<usize>,
    added_at: Option<usize>,
}

impl ColumnIndex {
    fn from_headers(headers: &csv::StringRecord) -> Result<Self, ImportError> {
        let find = |name: &str| -> Option<usize> {
            headers.iter().position(|h| h.eq_ignore_ascii_case(name))
        };
        // Exportify's column names have drifted between versions, so we accept
        // the historical aliases as well as the current ones.
        let find_any = |aliases: &[&str]| -> Option<usize> { aliases.iter().find_map(|n| find(n)) };
        let required_any = |aliases: &[&str], label: &'static str| -> Result<usize, ImportError> {
            find_any(aliases).ok_or(ImportError::MissingColumn(label))
        };
        Ok(Self {
            track_uri: required_any(&["Track URI"], "Track URI")?,
            track_name: required_any(&["Track Name"], "Track Name")?,
            artist_names: required_any(&["Artist Name(s)"], "Artist Name(s)")?,
            album_name: find_any(&["Album Name"]),
            album_image_url: find_any(&["Album Image URL"]),
            duration_ms: required_any(
                &["Duration (ms)", "Track Duration (ms)"],
                "Duration (ms)",
            )?,
            isrc: find_any(&["ISRC"]),
            added_at: find_any(&["Added At"]),
        })
    }
}

struct Row {
    spotify_id: String,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    isrc: Option<String>,
    added_at: Option<i64>,
}

impl Row {
    fn extract(record: &csv::StringRecord, idx: &ColumnIndex) -> Option<Self> {
        let raw_uri = record.get(idx.track_uri)?.trim();
        let spotify_id = parse_track_id(raw_uri)?;
        let title = non_empty(record.get(idx.track_name)?)?;
        let artists = parse_artists(record.get(idx.artist_names)?);
        let album = idx.album_name.and_then(|i| non_empty(record.get(i)?));
        let album_art_url = idx
            .album_image_url
            .and_then(|i| non_empty(record.get(i)?));
        let duration_ms: i64 = record.get(idx.duration_ms)?.trim().parse().ok()?;
        let isrc = idx.isrc.and_then(|i| non_empty(record.get(i)?));
        let added_at = idx
            .added_at
            .and_then(|i| non_empty(record.get(i)?))
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|dt| dt.timestamp());
        Some(Self {
            spotify_id,
            title,
            artists,
            album,
            album_art_url,
            duration_ms,
            isrc,
            added_at,
        })
    }
}

fn parse_track_id(raw: &str) -> Option<String> {
    // Accept either a bare ID (22 chars), a `spotify:track:<id>` URI, or an
    // `open.spotify.com/track/<id>` URL.
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("spotify:track:") {
        return Some(rest.split('?').next()?.to_owned());
    }
    if let Some(idx) = raw.find("/track/") {
        let tail = &raw[idx + "/track/".len()..];
        let id = tail.split(['?', '/']).next()?;
        return Some(id.to_owned());
    }
    Some(raw.to_owned())
}

fn parse_artists(raw: &str) -> Vec<String> {
    // Exportify's "Artist Name(s)" joins multiple artists with ';'
    // ("Yebba;A$AP Rocky") — and a single artist name can legitimately contain
    // a comma ("Tyler, The Creator"). So when a ';' is present it IS the
    // joiner: split only on it (preserving in-name commas); otherwise fall
    // back to ',' for comma-joined exports. Splitting on neither used to store
    // "A;B" as ONE artist, which split albums/artists and dodged bans.
    let sep = if raw.contains(';') { ';' } else { ',' };
    raw.split(sep)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Repair helper for the ~275 legacy rows imported before `parse_artists`
/// split on ';' (Exportify's joiner): split every element of a stored artists
/// array on ';', trim, and de-dupe case-insensitively (order-preserving).
/// Returns None when the list is already clean (nothing to rewrite) so the
/// startup fixup can skip the UPDATE.
pub(crate) fn split_semicolon_artist_list(v: &[String]) -> Option<Vec<String>> {
    if !v.iter().any(|a| a.contains(';')) {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let split: Vec<String> = v
        .iter()
        .flat_map(|a| a.split(';'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_lowercase()))
        .map(str::to_owned)
        .collect();
    if split.is_empty() { None } else { Some(split) }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_owned()) }
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn fresh_db() -> (Connection, tempfile::NamedTempFile) {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        (conn, tmp)
    }

    const SAMPLE_CSV: &str = "\
Track URI,Track Name,Artist URI(s),Artist Name(s),Album Name,Album Image URL,Track Duration (ms),ISRC,Added At
spotify:track:5ihS6UUlyQAfmp48eSkxuQ,The Less I Know The Better,spotify:artist:5INjqkS1o8h1imAzPqGZBb,Tame Impala,Currents,https://i.scdn.co/image/ab67616d0000b27392aff3c0f5d6e9d2f6cdb9c8,216320,AUUM71500379,2020-01-15T10:00:00Z
spotify:track:6habFhsOp2NvshLv26DqMb,Despacito,spotify:artist:4V8Sr092TqfHkfAA5fXXqG,\"Luis Fonsi, Daddy Yankee\",Vida,https://i.scdn.co/image/ab67616d0000b273ef76e0e9f0d7c2cb33dfe5ef,228827,USUM71700498,2017-04-03T12:00:00Z
,Track With No URI,spotify:artist:abc,Some Artist,Album,,180000,,
";

    #[test]
    fn split_semicolon_artist_list_repairs_only_dirty_rows() {
        // Dirty row → split, trimmed, case-insensitively deduped.
        assert_eq!(
            split_semicolon_artist_list(&["Aminé;Leon Thomas".into()]),
            Some(vec!["Aminé".into(), "Leon Thomas".into()])
        );
        assert_eq!(
            split_semicolon_artist_list(&["Drake; drake ;Future".into()]),
            Some(vec!["Drake".into(), "Future".into()])
        );
        // Clean rows → None (fixup skips the UPDATE; idempotent).
        assert_eq!(split_semicolon_artist_list(&["Tame Impala".into()]), None);
        assert_eq!(
            split_semicolon_artist_list(&["Tyler, The Creator".into()]),
            None,
            "in-name commas are legitimate — never rewritten"
        );
        assert_eq!(split_semicolon_artist_list(&[]), None);
    }

    #[test]
    fn parse_artists_semicolon_is_the_joiner_when_present() {
        // Exportify joins with ';' — split on it, preserving in-name commas.
        assert_eq!(
            parse_artists("Yebba;A$AP Rocky"),
            vec!["Yebba", "A$AP Rocky"]
        );
        assert_eq!(
            parse_artists("Tyler, The Creator;Kali Uchis"),
            vec!["Tyler, The Creator", "Kali Uchis"]
        );
        // No ';' → comma-joined exports still split on ','.
        assert_eq!(
            parse_artists("Luis Fonsi, Daddy Yankee"),
            vec!["Luis Fonsi", "Daddy Yankee"]
        );
        assert_eq!(parse_artists(" Solo Artist "), vec!["Solo Artist"]);
    }

    #[test]
    fn imports_a_basic_csv() {
        let (mut conn, _tmp) = fresh_db();
        let summary = import_from_str(&mut conn, SAMPLE_CSV, "My Mix").unwrap();
        assert_eq!(summary.tracks_added, 2);
        assert_eq!(summary.tracks_existing, 0);
        assert_eq!(summary.rows_skipped, 1, "row with empty Track URI must skip");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);

        let pcount: i64 = conn
            .query_row("SELECT track_count FROM playlists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pcount, 2);

        // Artists JSON is properly split for the multi-artist row.
        let artists: String = conn
            .query_row(
                "SELECT artists FROM tracks WHERE spotify_id = '6habFhsOp2NvshLv26DqMb'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(artists, r#"["Luis Fonsi","Daddy Yankee"]"#);
    }

    #[test]
    fn reimport_replaces_tracklist_but_dedupes_tracks() {
        let (mut conn, _tmp) = fresh_db();
        import_from_str(&mut conn, SAMPLE_CSV, "My Mix").unwrap();

        // Second import of the same CSV under the same name: no new tracks,
        // but tracklist gets rebuilt.
        let summary = import_from_str(&mut conn, SAMPLE_CSV, "My Mix").unwrap();
        assert_eq!(summary.tracks_added, 0);
        assert_eq!(summary.tracks_existing, 2);

        // Still exactly one playlist and exactly two playlist_tracks rows.
        let pl: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pl, 1);
        let pt: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pt, 2);
    }

    #[test]
    fn same_track_in_two_playlists_is_one_track_row() {
        let (mut conn, _tmp) = fresh_db();
        import_from_str(&mut conn, SAMPLE_CSV, "Mix A").unwrap();
        let s = import_from_str(&mut conn, SAMPLE_CSV, "Mix B").unwrap();
        assert_eq!(s.tracks_added, 0);
        assert_eq!(s.tracks_existing, 2);

        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tracks, 2);
        let pt: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pt, 4);
    }

    /// Header shape emitted by current Exportify builds (no "Track" prefix on
    /// Duration, columns reordered, audio-features tail). Regression test for
    /// the bug where we required "Track Duration (ms)" verbatim.
    const CURRENT_EXPORTIFY_CSV: &str = "\
Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature
spotify:track:0GQW2gDyxgT5IsNEM4osbJ,\"Loading\",\"Playing Robots Into Heaven\",\"James Blake\",2023-09-08,284551,45,false,,2026-03-19T13:10:21Z,\"\",\"Republic Records\",0.683,0.544,1,-8.614,0,0.0357,0.0881,0.129,0.1,0.0734,131.993,4
";

    #[test]
    fn imports_current_exportify_csv_with_duration_alias() {
        let (mut conn, _tmp) = fresh_db();
        let summary = import_from_str(&mut conn, CURRENT_EXPORTIFY_CSV, "Liked Songs").unwrap();
        assert_eq!(summary.tracks_added, 1);
        assert_eq!(summary.rows_skipped, 0);

        let (artists, duration): (String, i64) = conn
            .query_row(
                "SELECT artists, duration_ms FROM tracks WHERE spotify_id = '0GQW2gDyxgT5IsNEM4osbJ'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(artists, r#"["James Blake"]"#);
        assert_eq!(duration, 284551);
    }

    #[test]
    fn missing_required_column_errors() {
        let (mut conn, _tmp) = fresh_db();
        let bad = "Track Name,Artist Name(s)\nFoo,Bar\n";
        let err = import_from_str(&mut conn, bad, "x").unwrap_err();
        assert!(matches!(err, ImportError::MissingColumn(_)));
    }

    #[test]
    fn imports_a_zip_archive_of_csvs() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let (mut conn, _tmp) = fresh_db();

        let zip_path = std::env::temp_dir().join("beetbot-test-archive.zip");
        let _ = std::fs::remove_file(&zip_path);
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            z.start_file("Mix A.csv", opts).unwrap();
            z.write_all(SAMPLE_CSV.as_bytes()).unwrap();
            z.start_file("Mix B.csv", opts).unwrap();
            z.write_all(SAMPLE_CSV.as_bytes()).unwrap();
            // Apple cruft we should silently skip.
            z.start_file("__MACOSX/._Mix A.csv", opts).unwrap();
            z.write_all(b"junk").unwrap();
            z.finish().unwrap();
        }

        let summary = import_exportify_archive(&mut conn, &zip_path).unwrap();
        assert_eq!(summary.playlists_imported, 2);
        // Both CSVs share the same tracks, so 2 unique tracks added then 2 reused.
        assert_eq!(summary.tracks_added, 2);
        assert_eq!(summary.tracks_existing, 2);
        assert!(summary.failures.is_empty());

        let playlists: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(playlists, 2);

        let _ = std::fs::remove_file(&zip_path);
    }

    #[test]
    fn parses_track_id_in_three_shapes() {
        assert_eq!(
            parse_track_id("spotify:track:5ihS6UUlyQAfmp48eSkxuQ").as_deref(),
            Some("5ihS6UUlyQAfmp48eSkxuQ"),
        );
        assert_eq!(
            parse_track_id("https://open.spotify.com/track/5ihS6UUlyQAfmp48eSkxuQ?si=abc")
                .as_deref(),
            Some("5ihS6UUlyQAfmp48eSkxuQ"),
        );
        assert_eq!(
            parse_track_id("5ihS6UUlyQAfmp48eSkxuQ").as_deref(),
            Some("5ihS6UUlyQAfmp48eSkxuQ"),
        );
        assert_eq!(parse_track_id("   ").as_deref(), None);
    }
}
