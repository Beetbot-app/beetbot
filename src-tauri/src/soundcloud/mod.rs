//! SoundCloud public-playlist (set) importer.
//!
//! SoundCloud's API needs an OAuth app, but its *public* web player ships a
//! `client_id` baked into a JS asset bundle, and the same `api-v2.soundcloud.com`
//! endpoints the web player calls work with that id. So — exactly like the Apple
//! Music importer — we work off a public playlist/set share link and never ask
//! the user for a key.
//!
//! Unlike Apple Music, SoundCloud does NOT embed the tracklist in the page HTML.
//! Instead we:
//!   1. Extract a public `client_id` from the homepage's JS bundle (cached).
//!   2. Resolve the playlist URL via `/resolve` → `{title, track_count, tracks}`.
//!   3. The `tracks` array is mostly id-only stubs, so batch-fetch full track
//!      objects via `/tracks?ids=...` (chunks of ≤50) and reassemble in order.
//!
//! We only read *metadata* here (title + artist + duration + artwork). There is
//! no audio download — Beetbot is local-first; the user attaches their own
//! files to each imported track.

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use tokio::sync::Mutex;

/// A desktop-browser UA — soundcloud.com serves the JS bundle (and the
/// api-v2 endpoints accept the extracted client_id) for a real browser.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                  AppleWebKit/605.1.15 (KHTML, like Gecko) \
                  Version/16.0 Safari/605.1.15";

#[derive(Debug, thiserror::Error)]
pub enum ScError {
    #[error("not a SoundCloud playlist or set link")]
    NotAPlaylist,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("couldn't extract a SoundCloud client id (their web player may have changed)")]
    NoClientId,
    #[error(
        "Couldn't read that SoundCloud link — make sure it's a public playlist/set."
    )]
    ResolveFailed,
    #[error("that SoundCloud link isn't a playlist/set")]
    NotASet,
    #[error("no readable tracks on that SoundCloud playlist")]
    NoTracks,
}

/// One track parsed from a SoundCloud playlist.
#[derive(Debug, Clone, Serialize)]
pub struct ScTrack {
    pub title: String,
    pub artist: String,
    pub duration_ms: i64,
    pub artwork_url: Option<String>,
    /// SoundCloud's numeric track id, stringified (for the synthetic id).
    pub source_id: String,
}

/// A playlist + its tracks, in playlist order.
#[derive(Debug, Clone, Serialize)]
pub struct ScPlaylist {
    pub title: String,
    pub tracks: Vec<ScTrack>,
    /// SoundCloud's advertised `track_count`. If it exceeds `tracks.len()`,
    /// some entries were unreadable (e.g. deleted/private) — surface the gap.
    pub total_count: Option<usize>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("reqwest client builds")
}

/// Process-wide cache of the extracted public `client_id`. Re-extracted on
/// demand (and when an api-v2 call 401/403s).
fn client_id_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Return a usable public client_id, extracting + caching it on first use.
/// `force` re-extracts even if one is cached (used after a 401/403).
async fn get_client_id(http: &reqwest::Client, force: bool) -> Result<String, ScError> {
    let mut cache = client_id_cache().lock().await;
    if !force {
        if let Some(id) = cache.as_ref() {
            return Ok(id.clone());
        }
    }
    let id = extract_client_id(http).await?;
    *cache = Some(id.clone());
    Ok(id)
}

/// Scrape a public client_id from the SoundCloud homepage's JS bundles.
async fn extract_client_id(http: &reqwest::Client) -> Result<String, ScError> {
    let home = http
        .get("https://soundcloud.com/")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    // Asset bundle URLs look like
    // `https://a-v2.sndcdn.com/assets/0-abc123.js`. The client_id lives in the
    // LAST one (the others are vendor chunks). Walk them newest-last.
    let mut assets = find_asset_urls(&home);
    while let Some(asset_url) = assets.pop() {
        let Ok(resp) = http.get(&asset_url).send().await else {
            continue;
        };
        let Ok(js) = resp.text().await else {
            continue;
        };
        if let Some(id) = find_client_id(&js) {
            return Ok(id);
        }
    }
    Err(ScError::NoClientId)
}

/// All `https://<host>.sndcdn.com/assets/<name>.js` URLs in document order.
fn find_asset_urls(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("https://") {
        let tail = &rest[start..];
        // The URL ends at the first character that can't appear in one of these
        // script src attributes (quote, whitespace, angle bracket).
        let end = tail
            .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '>' || c.is_whitespace())
            .unwrap_or(tail.len());
        let candidate = &tail[..end];
        if is_sndcdn_asset(candidate) {
            out.push(candidate.to_string());
        }
        rest = &tail[end.max(1)..];
    }
    out
}

/// `https://<host>.sndcdn.com/assets/<...>.js` where host is `[a-z0-9-]+`.
fn is_sndcdn_asset(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let Some((host, path)) = rest.split_once('/') else {
        return false;
    };
    let Some(sub) = host.strip_suffix(".sndcdn.com") else {
        return false;
    };
    if sub.is_empty() || !sub.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return false;
    }
    path.starts_with("assets/") && url.ends_with(".js")
}

/// Pull the first 32-char alphanumeric value following a `client_id` key in a
/// JS bundle, matching `client_id[=:]"?<id>"?`.
fn find_client_id(js: &str) -> Option<String> {
    let mut rest = js;
    while let Some(at) = rest.find("client_id") {
        let after = &rest[at + "client_id".len()..];
        // Skip an optional `=` or `:` then an optional quote.
        let after = after.trim_start();
        let after = after.strip_prefix('=').or_else(|| after.strip_prefix(':')).unwrap_or(after);
        let after = after.trim_start();
        let after = after.strip_prefix('"').or_else(|| after.strip_prefix('\'')).unwrap_or(after);
        // Take the leading run of alphanumerics.
        let id: String = after.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if id.len() >= 32 {
            return Some(id.chars().take(32).collect());
        }
        rest = &rest[at + "client_id".len()..];
    }
    None
}

/// A soundcloud.com link (any path — `/resolve` decides if it's a real set).
fn is_soundcloud_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.contains("soundcloud.com/")
}

/// Fetch a public SoundCloud playlist/set by URL and return its tracklist.
pub async fn fetch_playlist(url: &str) -> Result<ScPlaylist, ScError> {
    let url = url.trim();
    if !is_soundcloud_url(url) {
        return Err(ScError::NotAPlaylist);
    }
    let http = client();

    // Resolve the playlist, retrying once with a freshly-extracted client_id if
    // the cached one was rejected (401/403).
    let resolved = match resolve(&http, url, false).await {
        Err(ScError::Http(e)) if is_auth_error(&e) => resolve(&http, url, true).await?,
        other => other?,
    };

    if resolved.get("kind").and_then(Value::as_str) != Some("playlist") {
        return Err(ScError::NotASet);
    }

    let title = resolved
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("SoundCloud playlist")
        .to_string();
    let total_count = resolved
        .get("track_count")
        .and_then(Value::as_u64)
        .map(|n| n as usize);

    // Collect every track id, in playlist order. The `tracks` array is a mix of
    // full objects and id-only stubs; we batch-fetch them all by id so they're
    // uniformly full and correctly ordered.
    let ids: Vec<u64> = resolved
        .get("tracks")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("id").and_then(Value::as_u64))
                .collect()
        })
        .unwrap_or_default();

    if ids.is_empty() {
        return Err(ScError::NoTracks);
    }

    let full = fetch_tracks_by_ids(&http, &ids).await?;

    // Index by id so we can reassemble in the original playlist order — the
    // /tracks endpoint may return them out of order or drop some.
    let mut by_id: std::collections::HashMap<u64, &Value> = std::collections::HashMap::new();
    for t in &full {
        if let Some(id) = t.get("id").and_then(Value::as_u64) {
            by_id.insert(id, t);
        }
    }

    let mut tracks = Vec::with_capacity(ids.len());
    for id in &ids {
        let Some(obj) = by_id.get(id) else { continue };
        if let Some(track) = map_track(obj) {
            tracks.push(track);
        }
    }

    if tracks.is_empty() {
        return Err(ScError::NoTracks);
    }

    Ok(ScPlaylist { title, tracks, total_count })
}

/// True for the auth failures that mean "the client_id is stale".
fn is_auth_error(e: &reqwest::Error) -> bool {
    matches!(
        e.status().map(|s| s.as_u16()),
        Some(401) | Some(403)
    )
}

/// GET `/resolve?url=...&client_id=...` → the resolved JSON object.
async fn resolve(
    http: &reqwest::Client,
    playlist_url: &str,
    force_new_id: bool,
) -> Result<Value, ScError> {
    let cid = get_client_id(http, force_new_id).await?;
    let api = format!(
        "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
        urlencoding::encode(playlist_url),
        urlencoding::encode(&cid),
    );
    let resp = http.get(&api).send().await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ScError::ResolveFailed);
    }
    let resp = resp.error_for_status()?;
    let v: Value = resp.json().await.map_err(|_| ScError::ResolveFailed)?;
    Ok(v)
}

/// Batch-fetch full track objects by id in chunks of ≤50.
async fn fetch_tracks_by_ids(
    http: &reqwest::Client,
    ids: &[u64],
) -> Result<Vec<Value>, ScError> {
    let cid = get_client_id(http, false).await?;
    let mut out: Vec<Value> = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(50) {
        let joined = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let api = format!(
            "https://api-v2.soundcloud.com/tracks?ids={}&client_id={}",
            joined, cid,
        );
        // Retry the chunk once with a fresh client_id on an auth error.
        let resp = match http.get(&api).send().await {
            Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => {
                let cid2 = get_client_id(http, true).await?;
                let api2 = format!(
                    "https://api-v2.soundcloud.com/tracks?ids={}&client_id={}",
                    joined, cid2,
                );
                http.get(&api2).send().await?
            }
            Ok(r) => r,
            Err(e) => return Err(ScError::Http(e)),
        };
        let resp = resp.error_for_status()?;
        if let Ok(Value::Array(arr)) = resp.json::<Value>().await {
            out.extend(arr);
        }
    }
    Ok(out)
}

/// Map a full SoundCloud track object to our `ScTrack`. Returns `None` for
/// entries with an empty/missing title.
fn map_track(obj: &Value) -> Option<ScTrack> {
    let title = obj.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if title.is_empty() {
        return None;
    }
    let id = obj.get("id").and_then(Value::as_u64)?;
    let artist = obj
        .get("user")
        .and_then(|u| u.get("username"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    // `full_duration` covers the full track (vs a preview `duration`); prefer it
    // when present and positive.
    let duration_ms = obj
        .get("full_duration")
        .and_then(Value::as_i64)
        .filter(|&d| d > 0)
        .or_else(|| obj.get("duration").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(0);
    let artwork_url = obj
        .get("artwork_url")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Some(ScTrack {
        title: title.to_string(),
        artist,
        duration_ms,
        artwork_url,
        source_id: id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_detection() {
        assert!(is_soundcloud_url(
            "https://soundcloud.com/dawning_records/sets/ibiza-summer-mix-2026-lounge"
        ));
        assert!(!is_soundcloud_url("https://music.apple.com/us/playlist/abc/pl.x"));
    }

    #[test]
    fn detects_sndcdn_asset_urls() {
        assert!(is_sndcdn_asset("https://a-v2.sndcdn.com/assets/0-abc123.js"));
        assert!(is_sndcdn_asset("https://a1.sndcdn.com/assets/sound-9f3.js"));
        assert!(!is_sndcdn_asset("https://a-v2.sndcdn.com/assets/style.css"));
        assert!(!is_sndcdn_asset("https://example.com/assets/app.js"));
    }

    #[test]
    fn finds_asset_urls_in_html() {
        let html = r#"<script src="https://a-v2.sndcdn.com/assets/2-vendor.js"></script>
                      <script crossorigin src="https://a-v2.sndcdn.com/assets/49-app.js"></script>"#;
        let urls = find_asset_urls(html);
        assert_eq!(urls.len(), 2);
        // The LAST one is the app bundle that carries the client_id.
        assert_eq!(urls.last().unwrap(), "https://a-v2.sndcdn.com/assets/49-app.js");
    }

    #[test]
    fn extracts_client_id_from_js() {
        // Both `:` and `=` separators, quoted and bare, 32-char alphanumerics.
        let js1 = r#"e.exports={client_id:"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"}"#;
        assert_eq!(
            find_client_id(js1).as_deref(),
            Some("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
        );
        let js2 = r#"?client_id=ZZZZ1111yyyy2222xxxx3333wwww4444&foo"#;
        assert_eq!(
            find_client_id(js2).as_deref(),
            Some("ZZZZ1111yyyy2222xxxx3333wwww4444")
        );
        // A short token must be skipped, and a real 32-char one found later.
        let js3 = r#"client_id:"short" ... client_id="abcdefghij0123456789abcdefghij99""#;
        assert_eq!(
            find_client_id(js3).as_deref(),
            Some("abcdefghij0123456789abcdefghij99")
        );
        assert_eq!(find_client_id("no id here"), None);
    }

    #[test]
    fn maps_track_fields() {
        let v = serde_json::json!({
            "id": 12345u64,
            "title": "  Sunset Lounge  ",
            "full_duration": 240000,
            "duration": 30000,
            "artwork_url": "https://i1.sndcdn.com/artworks-x-large.jpg",
            "user": { "username": "Dawning Records" }
        });
        let t = map_track(&v).unwrap();
        assert_eq!(t.title, "Sunset Lounge");
        assert_eq!(t.artist, "Dawning Records");
        assert_eq!(t.duration_ms, 240000); // full_duration wins
        assert_eq!(t.source_id, "12345");
        assert_eq!(
            t.artwork_url.as_deref(),
            Some("https://i1.sndcdn.com/artworks-x-large.jpg")
        );

        // Empty title → skipped.
        assert!(map_track(&serde_json::json!({ "id": 1u64, "title": "  " })).is_none());

        // No full_duration → falls back to duration.
        let v2 = serde_json::json!({ "id": 7u64, "title": "X", "duration": 9999 });
        assert_eq!(map_track(&v2).unwrap().duration_ms, 9999);
    }
}
