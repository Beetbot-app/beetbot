//! Apple Music public-playlist importer.
//!
//! Apple Music's API (MusicKit) is gated behind a paid Apple Developer
//! account, so — exactly like the SoundCloud importer — we work off a *public*
//! playlist share link instead. A public Apple Music playlist page
//! (`https://music.apple.com/<store>/playlist/.../pl.xxxx`) is server-rendered
//! and embeds the full tracklist as JSON in a
//! `<script id="serialized-server-data">` tag (title + artistName + duration +
//! artwork per song) plus an `application/ld+json` block carrying the playlist
//! name.
//!
//! We only read *metadata* here (titles + artists). Apple Music audio is
//! DRM-locked, so tracks land metadata-only and the user attaches their own
//! audio file to each — just like a Spotify or SoundCloud import.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum AppleError {
    #[error("not an Apple Music playlist or album link")]
    NotAPlaylist,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("couldn't find the tracklist on that page (is the playlist public?)")]
    NoTracks,
}

/// One track parsed from the Apple Music page.
#[derive(Debug, Clone, Serialize)]
pub struct AppleTrack {
    /// Apple's catalog id for the song (stable per-track id); may be empty.
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: i64,
    pub artwork_url: Option<String>,
}

/// A playlist + its tracks, in playlist order.
#[derive(Debug, Clone, Serialize)]
pub struct ApplePlaylist {
    pub title: String,
    pub tracks: Vec<AppleTrack>,
    /// The playlist's advertised total track count, taken from the page's
    /// ld+json `track` list (an SEO block independent of the rendered
    /// tracklist). If this exceeds `tracks.len()`, the page only embedded a
    /// prefix and the import is truncated — compare to warn the user.
    pub total_count: Option<usize>,
}

fn client() -> reqwest::Client {
    // A real browser UA — music.apple.com serves the SSR HTML (with the
    // embedded JSON) to browsers; a bare client UA can get a stripped page.
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/605.1.15 (KHTML, like Gecko) \
             Version/17.0 Safari/605.1.15",
        )
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("reqwest client builds")
}

/// Fetch a public Apple Music playlist by URL and return its tracklist.
pub async fn fetch_playlist(url: &str) -> Result<ApplePlaylist, AppleError> {
    let url = url.trim();
    if !is_apple_catalog_url(url) {
        return Err(AppleError::NotAPlaylist);
    }

    let html = client().get(url).send().await?.error_for_status()?.text().await?;

    let tracks = parse_tracks(&html);
    if tracks.is_empty() {
        return Err(AppleError::NoTracks);
    }
    let title = parse_playlist_name(&html).unwrap_or_else(|| "Apple Music playlist".to_string());
    let total_count = parse_ld_track_count(&html);

    Ok(ApplePlaylist { title, tracks, total_count })
}

/// A music.apple.com link that points at a playlist (`/playlist/`) or an album
/// (`/album/`) — both embed a tracklist we can read. Artist/song/search pages
/// don't, so they're rejected.
fn is_apple_catalog_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.contains("music.apple.com") && (u.contains("/playlist/") || u.contains("/album/"))
}

/// Pull the text between `<script ... id="<id>" ...>` and the next `</script>`.
fn extract_script_by_id<'a>(html: &'a str, id: &str) -> Option<&'a str> {
    let needle = format!("id=\"{id}\"");
    let at = html.find(&needle)?;
    // Find the end of the opening <script ...> tag that contains the id.
    let gt = html[at..].find('>')? + at + 1;
    let end = html[gt..].find("</script>")? + gt;
    Some(html[gt..end].trim())
}

/// Pull the first `application/ld+json` block.
fn extract_ld_json(html: &str) -> Option<&str> {
    let at = html.find("application/ld+json")?;
    let gt = html[at..].find('>')? + at + 1;
    let end = html[gt..].find("</script>")? + gt;
    Some(html[gt..end].trim())
}

/// Playlist display name from the ld+json `MusicPlaylist` block.
fn parse_playlist_name(html: &str) -> Option<String> {
    let raw = extract_ld_json(html)?;
    let v: Value = serde_json::from_str(raw).ok()?;
    // ld+json may be a single object or an array of them.
    let name = match &v {
        Value::Array(items) => items
            .iter()
            .find_map(|it| it.get("name").and_then(Value::as_str)),
        _ => v.get("name").and_then(Value::as_str),
    }?;
    let name = name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Number of entries in the ld+json `MusicPlaylist.track` array — the
/// playlist's full advertised length, used to detect a truncated render.
fn parse_ld_track_count(html: &str) -> Option<usize> {
    let raw = extract_ld_json(html)?;
    let v: Value = serde_json::from_str(raw).ok()?;
    let obj = match &v {
        Value::Array(items) => items
            .iter()
            .find(|it| it.get("track").map(Value::is_array).unwrap_or(false))?,
        other => other,
    };
    let n = obj.get("track").and_then(Value::as_array)?.len();
    if n == 0 {
        None
    } else {
        Some(n)
    }
}

/// Parse the embedded `serialized-server-data` JSON and return the tracklist.
///
/// The page contains several arrays of "shelf items"; the real tracklist is
/// the *longest* array whose elements look like songs (have both a `title` and
/// an `artistName`). Picking the longest such array avoids contaminating the
/// import with "you might also like" recommendation shelves.
fn parse_tracks(html: &str) -> Vec<AppleTrack> {
    let Some(raw) = extract_script_by_id(html, "serialized-server-data") else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };

    let best = best_song_array(&root);

    let mut out: Vec<AppleTrack> = Vec::with_capacity(best.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for obj in best {
        let title = obj.get("title").and_then(Value::as_str).unwrap_or("").trim();
        let artist = obj.get("artistName").and_then(Value::as_str).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        // Dedup: by Apple id when present, else by title|artist.
        let key = if id.is_empty() {
            format!("{}|{}", title.to_lowercase(), artist.to_lowercase())
        } else {
            id.clone()
        };
        if !seen.insert(key) {
            continue;
        }
        let duration_ms = obj
            .get("duration")
            .and_then(|d| d.as_i64().or_else(|| d.as_f64().map(|f| f as i64)))
            .unwrap_or(0)
            .max(0);
        let artwork_url = obj
            .get("artwork")
            .and_then(|a| a.get("url"))
            .and_then(Value::as_str)
            .map(expand_artwork_template);

        out.push(AppleTrack {
            id,
            title: title.to_string(),
            artist: artist.to_string(),
            duration_ms,
            artwork_url,
        });
    }
    out
}

/// Walk the whole JSON tree and return the longest array of song-like objects.
fn best_song_array(root: &Value) -> Vec<&serde_json::Map<String, Value>> {
    let mut best: Vec<&serde_json::Map<String, Value>> = Vec::new();
    let mut stack: Vec<&Value> = vec![root];
    while let Some(node) = stack.pop() {
        match node {
            Value::Array(arr) => {
                let songs: Vec<&serde_json::Map<String, Value>> =
                    arr.iter().filter_map(as_song_obj).collect();
                if songs.len() > best.len() {
                    best = songs;
                }
                for e in arr {
                    stack.push(e);
                }
            }
            Value::Object(map) => {
                for v in map.values() {
                    stack.push(v);
                }
            }
            _ => {}
        }
    }
    best
}

/// An object is "song-like" if it carries both a string `title` and a string
/// `artistName` — the signature Apple uses for track rows.
fn as_song_obj(v: &Value) -> Option<&serde_json::Map<String, Value>> {
    let obj = v.as_object()?;
    let has_title = obj.get("title").and_then(Value::as_str).is_some();
    let has_artist = obj.get("artistName").and_then(Value::as_str).is_some();
    if has_title && has_artist {
        Some(obj)
    } else {
        None
    }
}

/// Apple artwork URLs are templates like `…/{w}x{h}{c}.{f}`. Fill them in for a
/// reasonably sized square cover.
fn expand_artwork_template(url: &str) -> String {
    url.replace("{w}", "300")
        .replace("{h}", "300")
        .replace("{c}", "")
        .replace("{f}", "jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_detection() {
        assert!(is_apple_catalog_url(
            "https://music.apple.com/us/playlist/a-list-pop/pl.5ee8333d"
        ));
        // Albums are now accepted too.
        assert!(is_apple_catalog_url(
            "https://music.apple.com/us/album/random-access-memories/617154241"
        ));
        // Artist and search pages have no embedded tracklist.
        assert!(!is_apple_catalog_url(
            "https://music.apple.com/us/artist/daft-punk/5468295"
        ));
        assert!(!is_apple_catalog_url("https://open.spotify.com/playlist/abc"));
    }

    #[test]
    fn artwork_template_expands() {
        assert_eq!(
            expand_artwork_template("https://is1.mzstatic.com/a/{w}x{h}{c}.{f}"),
            "https://is1.mzstatic.com/a/300x300.jpg"
        );
    }

    #[test]
    fn ld_track_count_reads_track_array_len() {
        let html = r#"<script type="application/ld+json">
            {"@type":"MusicPlaylist","name":"X",
             "track":[{"name":"a"},{"name":"b"},{"name":"c"}]}
        </script>"#;
        assert_eq!(parse_ld_track_count(html), Some(3));
        // ld+json as an array of blocks; pick the one carrying `track`.
        let html2 = r#"<script type="application/ld+json">
            [{"@type":"BreadcrumbList"},
             {"@type":"MusicPlaylist","track":[{"name":"a"},{"name":"b"}]}]
        </script>"#;
        assert_eq!(parse_ld_track_count(html2), Some(2));
        // No track array → None.
        let html3 = r#"<script type="application/ld+json">{"name":"X"}</script>"#;
        assert_eq!(parse_ld_track_count(html3), None);
    }

    /// Live smoke test against a real public Apple Music playlist. Ignored by
    /// default (needs network); run with `cargo test -- --ignored apple`.
    #[tokio::test]
    #[ignore]
    async fn fetches_real_public_playlist() {
        let pl = fetch_playlist(
            "https://music.apple.com/us/playlist/a-list-pop/pl.5ee8333dbe944d9f9151e97d92d1ead9",
        )
        .await
        .expect("fetch should succeed");
        assert!(!pl.title.is_empty(), "playlist should have a name");
        assert!(pl.tracks.len() > 10, "expected a full tracklist, got {}", pl.tracks.len());
        let first = &pl.tracks[0];
        assert!(!first.title.is_empty());
        assert!(!first.artist.is_empty());
        // The ld+json advertised count should match the embedded tracklist (no
        // truncation at this size) — guards the truncation cross-check.
        if let Some(total) = pl.total_count {
            assert_eq!(
                total,
                pl.tracks.len(),
                "ld+json count {total} != embedded {}",
                pl.tracks.len()
            );
        }
        eprintln!(
            "[apple] '{}' -> {} tracks (advertised {:?}); first: {} — {} ({}ms)",
            pl.title, pl.tracks.len(), pl.total_count, first.title, first.artist, first.duration_ms
        );
    }

    #[test]
    fn picks_longest_song_array() {
        // Two shelves: a 3-song "recommendations" and a 2-song tracklist — the
        // longer one wins. (Sanity check for the selection heuristic.)
        let json = serde_json::json!({
            "a": { "items": [
                {"title": "Rec1", "artistName": "X"},
                {"title": "Rec2", "artistName": "Y"},
                {"title": "Rec3", "artistName": "Z"}
            ]},
            "b": { "items": [
                {"title": "Real1", "artistName": "A", "duration": 1000},
                {"title": "Real2", "artistName": "B", "duration": 2000}
            ]}
        });
        let best = best_song_array(&json);
        assert_eq!(best.len(), 3);
    }
}
