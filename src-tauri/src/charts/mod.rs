//! External chart sources that complement Deezer.
//!
//!  - **Apple Music RSS** (`rss.applemarketingtools.com`): official, free, no
//!    key. Gives a clean global "most-played" songs feed.
//!  - **Last.fm** (`tag.getTopTracks`): community tag charts (genre = tag), so
//!    a genre page reflects how listeners actually tag tracks instead of a
//!    label's catalogue genre. Needs a free API key.
//!
//! Both return bare `(title, artist)` pairs; the caller resolves each to a
//! Deezer track to get cover art, a preview clip, and the add-to-library flow.

use serde::Deserialize;

/// A title + primary-artist pair from an external chart.
pub type ChartPair = (String, String);

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Beetbot/0.2")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .expect("reqwest client builds")
}

// ---- Apple Music RSS --------------------------------------------------

#[derive(Deserialize)]
struct AppleFeedEnvelope {
    feed: AppleFeed,
}
#[derive(Deserialize)]
struct AppleFeed {
    results: Vec<AppleResult>,
}
#[derive(Deserialize)]
struct AppleResult {
    name: String,
    #[serde(rename = "artistName")]
    artist_name: String,
}

/// Apple Music's most-played songs for a country (e.g. "us"). Official, free.
pub async fn apple_top_songs(country: &str, limit: u32) -> Result<Vec<ChartPair>, String> {
    let url = format!(
        "https://rss.applemarketingtools.com/api/v2/{country}/music/most-played/{limit}/songs.json"
    );
    let env: AppleFeedEnvelope = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(env
        .feed
        .results
        .into_iter()
        .map(|r| (r.name, r.artist_name))
        .collect())
}

// ---- iTunes RSS (genre-filtered, current top songs) -------------------

#[derive(Deserialize)]
struct ItunesEnvelope {
    feed: ItunesFeed,
}
#[derive(Deserialize)]
struct ItunesFeed {
    #[serde(default)]
    entry: Vec<ItunesEntry>,
}
#[derive(Deserialize)]
struct ItunesEntry {
    #[serde(rename = "im:name")]
    name: ItunesLabel,
    #[serde(rename = "im:artist")]
    artist: ItunesLabel,
    #[serde(rename = "im:releaseDate", default)]
    release_date: Option<ItunesLabel>,
}
#[derive(Deserialize)]
struct ItunesLabel {
    label: String,
}

/// An album from iTunes' genre top-albums feed, with its release date (so the
/// caller can build both a "top albums" row and a date-sorted "new releases").
pub struct AppleAlbum {
    pub name: String,
    pub artist: String,
    pub release_date: Option<String>,
}

/// Apple/iTunes RSS top songs *for a genre* (e.g. id 14 = Pop). Current week,
/// genre-accurate, free, no key. Drops alternate versions (a cappella /
/// instrumental / sped up) that otherwise clutter the top of the list.
pub async fn apple_genre_songs(
    country: &str,
    genre_id: u32,
    limit: u32,
) -> Result<Vec<ChartPair>, String> {
    let url = format!(
        "https://itunes.apple.com/{country}/rss/topsongs/limit={limit}/genre={genre_id}/json"
    );
    let env: ItunesEnvelope = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let pairs = env
        .feed
        .entry
        .into_iter()
        .map(|e| (e.name.label, e.artist.label))
        .collect();
    Ok(dedup_versions(pairs))
}

/// Apple/iTunes RSS top *albums* for a genre. Current chart; used for the
/// genre "Top albums" and (sorted by release date) "New releases" rows.
pub async fn apple_genre_albums(
    country: &str,
    genre_id: u32,
    limit: u32,
) -> Result<Vec<AppleAlbum>, String> {
    let url = format!(
        "https://itunes.apple.com/{country}/rss/topalbums/limit={limit}/genre={genre_id}/json"
    );
    let env: ItunesEnvelope = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(env
        .feed
        .entry
        .into_iter()
        .map(|e| AppleAlbum {
            name: e.name.label,
            artist: e.artist.label,
            release_date: e.release_date.map(|l| l.label),
        })
        .collect())
}

/// Collapse alternate versions of the same song (same base title + artist):
/// "X", "X (a cappella)", "X (instrumental)" → just "X".
fn dedup_versions(pairs: Vec<ChartPair>) -> Vec<ChartPair> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (title, artist) in pairs {
        let base = title.split(" (").next().unwrap_or(&title).trim().to_ascii_lowercase();
        if seen.insert(format!("{base}|{}", artist.to_ascii_lowercase())) {
            out.push((title, artist));
        }
    }
    out
}

/// Map a Deezer genre name to an iTunes/Apple genre id (for the genre-filtered
/// top-songs feed). `None` for genres without a clean Apple equivalent — the
/// caller then falls back to Last.fm or Deezer.
pub fn deezer_genre_to_apple_id(name: &str) -> Option<u32> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "pop" => 14,
        "rap/hip hop" => 18,
        "rock" => 21,
        "dance" => 17,
        "r&b" => 15,
        "soul & funk" => 15,
        "alternative" => 20,
        "christian" => 22,
        "electro" => 7,
        "reggae" => 24,
        "country" => 6,
        "latin music" | "reggaeton" => 12,
        "jazz" => 11,
        "classical" => 5,
        "blues" => 2,
        "folk" => 10,
        "kids" => 4,
        "metal" => 21, // Apple nests metal under Rock at the top level
        "k-pop" | "kpop" => 51,
        "j-pop" | "jpop" => 27,
        _ => return None,
    })
}

// ---- Billboard (weekly, genre-specific charts) ------------------------
//
// Billboard publishes genuine *weekly* genre charts (Hot Rap Songs, Hot
// Country Songs, …) — unlike the iTunes feed (a sales chart that mixes in
// nostalgia) or Last.fm tags (all-time). There's no official API, so we read
// the public chart page's server-rendered HTML. It's the best free source for
// a real "top songs this week" per genre; the caller falls back to iTunes when
// Billboard has no matching chart or the fetch/parse fails.

/// A browser-like client — Billboard serves a bot-blocked page to unusual
/// user-agents, so we present a normal desktop Chrome UA.
fn billboard_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
             AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("reqwest client builds")
}

/// Map a Deezer genre name to a Billboard chart slug (the `/charts/{slug}/`
/// path). `None` for genres Billboard doesn't chart as *songs* (K-Pop, Jazz,
/// Classical, Reggae, Folk, world music, …) — the caller then falls back to the
/// iTunes genre feed / Last.fm tag.
pub fn deezer_genre_to_billboard_chart(name: &str) -> Option<&'static str> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "pop" => "pop-songs",                            // Pop Airplay
        "rap/hip hop" => "rap-song",                     // Hot Rap Songs
        "r&b" | "soul & funk" => "r-b-hip-hop-songs",    // Hot R&B/Hip-Hop Songs
        "country" => "country-songs",                    // Hot Country Songs
        "rock" => "rock-songs",                          // Hot Rock & Alternative Songs
        "alternative" => "hot-alternative-songs",        // Hot Alternative Songs
        "metal" => "hot-hard-rock-songs",                // Hot Hard Rock Songs
        "reggaeton" => "latin-rhythm-airplay",           // Latin Rhythm Airplay
        "latin music" => "latin-songs",                  // Hot Latin Songs
        "dance" | "electro" => "dance-electronic-songs", // Hot Dance/Electronic
        "christian" => "christian-songs",                // Hot Christian Songs
        _ => return None,
    })
}

/// Billboard's weekly chart for a genre slug, as `(title, artist)` pairs in
/// rank order. Scrapes the public chart page (no official API). Returns an
/// error on a non-200 or when nothing parses, so the caller can fall back.
pub async fn billboard_genre_songs(slug: &str, limit: u32) -> Result<Vec<ChartPair>, String> {
    let url = format!("https://www.billboard.com/charts/{slug}/");
    let body = billboard_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<ChartPair> = Vec::new();
    // Each ranked entry sits in an `o-chart-results-list-row-container`. Within
    // a row, the first `id="title-of-a-story"` heading is the song title and
    // the first `c-label` span after it is the artist credit.
    for chunk in body.split("o-chart-results-list-row-container").skip(1) {
        let Some(title) = extract_after(chunk, "id=\"title-of-a-story\"", "</h3>") else {
            continue;
        };
        let title = strip_html(&title);
        if title.is_empty() {
            continue;
        }
        // Artist: first non-empty c-label span following the title.
        let rest = chunk.split("</h3>").nth(1).unwrap_or("");
        let artist = primary_artist(&first_clabel(rest));
        if artist.is_empty() {
            continue;
        }
        out.push((title, artist));
        if out.len() as u32 >= limit {
            break;
        }
    }
    if out.is_empty() {
        return Err(format!("billboard: parsed no rows from {url}"));
    }
    Ok(out)
}

/// Limit how many songs any one (lead) artist contributes, so a chart-bombing
/// album drop (e.g. an artist holding 20 of the top 25) doesn't fill the whole
/// row with one name. Preserves rank order.
pub fn cap_per_artist(pairs: Vec<ChartPair>, max_per: usize) -> Vec<ChartPair> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (title, artist) in pairs {
        let key = artist.to_ascii_lowercase();
        let c = counts.entry(key).or_insert(0);
        if *c < max_per {
            *c += 1;
            out.push((title, artist));
        }
    }
    out
}

/// The lead artist for a Deezer search: Billboard credits read "X Featuring Y"
/// or "X & Y". We drop the "Featuring …" tail (too specific to resolve well)
/// but keep "&" collaborations, which are usually billed on the track itself.
fn primary_artist(credit: &str) -> String {
    credit
        .split(" Featuring")
        .next()
        .unwrap_or(credit)
        .trim()
        .to_string()
}

/// Return the text between the first occurrence of `marker` (then its closing
/// `>`) and `end`. Used to pull a tag's inner HTML out of the row chunk.
fn extract_after(haystack: &str, marker: &str, end: &str) -> Option<String> {
    let start = haystack.find(marker)?;
    let after_marker = &haystack[start + marker.len()..];
    let gt = after_marker.find('>')?;
    let inner = &after_marker[gt + 1..];
    let e = inner.find(end)?;
    Some(inner[..e].to_string())
}

/// First non-empty `<span class="… c-label …">…</span>` in `s`, tags stripped.
fn first_clabel(s: &str) -> String {
    let mut cursor = s;
    loop {
        let Some(pos) = cursor.find("c-label") else {
            return String::new();
        };
        let rest = &cursor[pos..];
        let Some(gt) = rest.find('>') else {
            return String::new();
        };
        let after = &rest[gt + 1..];
        let Some(end) = after.find("</span>") else {
            return String::new();
        };
        let content = strip_html(&after[..end]);
        if !content.is_empty() {
            return content;
        }
        cursor = &after[end..];
    }
}

/// Strip HTML tags and unescape the handful of entities Billboard emits.
fn strip_html(s: &str) -> String {
    let mut text = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    text.replace("&amp;amp;", "&")
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&rsquo;", "\u{2019}")
        .replace("&#8217;", "\u{2019}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&#8216;", "\u{2018}")
        .replace("&ldquo;", "\u{201C}")
        .replace("&#8220;", "\u{201C}")
        .replace("&rdquo;", "\u{201D}")
        .replace("&#8221;", "\u{201D}")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&hellip;", "\u{2026}")
        .replace("&#8230;", "\u{2026}")
        .replace("&ndash;", "\u{2013}")
        .replace("&#8211;", "\u{2013}")
        .replace("&mdash;", "\u{2014}")
        .replace("&#8212;", "\u{2014}")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

// ---- Last.fm ----------------------------------------------------------

#[derive(Deserialize)]
struct LfmTagTopTracks {
    tracks: LfmTracks,
}
#[derive(Deserialize)]
struct LfmTracks {
    #[serde(default)]
    track: Vec<LfmTrack>,
}
#[derive(Deserialize)]
struct LfmTrack {
    name: String,
    artist: LfmArtist,
}
#[derive(Deserialize)]
struct LfmArtist {
    name: String,
}

/// App-wide default Last.fm API key, injected at build time via the
/// `BEETBOT_LASTFM_KEY` env var (set in a *gitignored*
/// `src-tauri/.cargo/config.toml` so it compiles into the binary but never
/// lands in the public source). `None` when unset — Browse genres then need a
/// per-user key (Settings) or fall back to Deezer's charts.
pub fn default_lastfm_key() -> Option<&'static str> {
    match option_env!("BEETBOT_LASTFM_KEY") {
        Some(k) if !k.is_empty() => Some(k),
        _ => None,
    }
}

/// Last.fm top tracks for a tag (genre). Requires a free API key.
pub async fn lastfm_tag_top_tracks(
    api_key: &str,
    tag: &str,
    limit: u32,
) -> Result<Vec<ChartPair>, String> {
    let mut url = url::Url::parse("https://ws.audioscrobbler.com/2.0/")
        .expect("lastfm base url parses");
    url.query_pairs_mut()
        .append_pair("method", "tag.gettoptracks")
        .append_pair("tag", tag)
        .append_pair("api_key", api_key)
        .append_pair("format", "json")
        .append_pair("limit", &limit.to_string());
    let body: LfmTagTopTracks = client()
        .get(url.as_str())
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(body
        .tracks
        .track
        .into_iter()
        .map(|t| (t.name, t.artist.name))
        .collect())
}

#[derive(Deserialize)]
struct LfmArtistTopTags {
    #[serde(default)]
    toptags: LfmTopTagList,
}
#[derive(Deserialize, Default)]
struct LfmTopTagList {
    #[serde(default)]
    tag: Vec<LfmTagEntry>,
}
#[derive(Deserialize)]
struct LfmTagEntry {
    name: String,
    #[serde(default)]
    count: i64,
}

/// Last.fm top tags for an artist — crowd-sourced descriptors like "shoegaze",
/// "dream pop", "lo-fi". Returns up to `limit` `(tag, weight 0-100)` strongest
/// first. Best-effort: an empty Vec on any network/parse error or no tags (a
/// Last.fm `{"error":...}` body simply deserializes to no `toptags`). The
/// `api_key` is the hub's shared key — this is always called server-side.
pub async fn lastfm_artist_top_tags(api_key: &str, artist: &str, limit: usize) -> Vec<(String, i64)> {
    let mut url = match url::Url::parse("https://ws.audioscrobbler.com/2.0/") {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    url.query_pairs_mut()
        .append_pair("method", "artist.gettoptags")
        .append_pair("artist", artist)
        .append_pair("autocorrect", "1")
        .append_pair("api_key", api_key)
        .append_pair("format", "json");
    let resp = match client().get(url.as_str()).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let parsed: LfmArtistTopTags = match resp.json().await {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut tags: Vec<(String, i64)> = parsed
        .toptags
        .tag
        .into_iter()
        .map(|t| (t.name.trim().to_lowercase(), t.count))
        .filter(|(n, _)| !n.is_empty())
        .collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1));
    tags.truncate(limit);
    tags
}

/// Last.fm `artist.getSimilar` — a similarity graph INDEPENDENT of ListenBrainz
/// and name-based (no MBID needed). `match` is a clean 0..1 score; we return names
/// ranked by it. Widens the radio candidate pool and breaks ListenBrainz's
/// popularity skew. Best-effort: empty on any error / missing key.
pub async fn lastfm_similar_artists(api_key: &str, artist: &str, limit: usize) -> Vec<String> {
    let mut url = match url::Url::parse("https://ws.audioscrobbler.com/2.0/") {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    url.query_pairs_mut()
        .append_pair("method", "artist.getsimilar")
        .append_pair("artist", artist)
        .append_pair("autocorrect", "1")
        .append_pair("limit", &limit.to_string())
        .append_pair("api_key", api_key)
        .append_pair("format", "json");
    let resp = match client().get(url.as_str()).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let parsed: LfmSimilarArtists = match resp.json().await {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut artists: Vec<(String, f64)> = parsed
        .similarartists
        .artist
        .into_iter()
        .map(|a| (a.name, a.match_score.parse::<f64>().unwrap_or(0.0)))
        .filter(|(n, _)| !n.trim().is_empty())
        .collect();
    artists.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    artists.into_iter().map(|(n, _)| n).take(limit).collect()
}

/// Last.fm `track.getSimilar` — genuine SONG-to-SONG similarity (collaborative
/// filtering over scrobbles), returned newest-match-first. Returns (track_name,
/// artist_name) pairs to resolve to a playable Deezer track. This is Beetbot's
/// primary track-level discovery source (ListenBrainz similar-recordings returns
/// empty in practice). Best-effort: empty on any error / missing key / no title.
pub async fn lastfm_track_similar(
    api_key: &str,
    artist: &str,
    track: &str,
    limit: usize,
) -> Vec<(String, String)> {
    let mut url = match url::Url::parse("https://ws.audioscrobbler.com/2.0/") {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    url.query_pairs_mut()
        .append_pair("method", "track.getsimilar")
        .append_pair("artist", artist)
        .append_pair("track", track)
        .append_pair("autocorrect", "1")
        .append_pair("limit", &limit.to_string())
        .append_pair("api_key", api_key)
        .append_pair("format", "json");
    let resp = match client().get(url.as_str()).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let parsed: LfmSimilarTracks = match resp.json().await {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    // Last.fm returns them already ranked by `match` (descending), so preserve order.
    parsed
        .similartracks
        .track
        .into_iter()
        .map(|t| (t.name, t.artist.name))
        .filter(|(t, a)| !t.trim().is_empty() && !a.trim().is_empty())
        .take(limit)
        .collect()
}

#[derive(Deserialize)]
struct LfmSimilarTracks {
    #[serde(default)]
    similartracks: LfmSimilarTrackList,
}
#[derive(Deserialize, Default)]
struct LfmSimilarTrackList {
    #[serde(default)]
    track: Vec<LfmSimilarTrack>,
}
#[derive(Deserialize)]
struct LfmSimilarTrack {
    name: String,
    #[serde(default)]
    artist: LfmSimilarTrackArtist,
}
#[derive(Deserialize, Default)]
struct LfmSimilarTrackArtist {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct LfmSimilarArtists {
    #[serde(default)]
    similarartists: LfmSimilarArtistList,
}
#[derive(Deserialize, Default)]
struct LfmSimilarArtistList {
    #[serde(default)]
    artist: Vec<LfmSimilarArtist>,
}
#[derive(Deserialize)]
struct LfmSimilarArtist {
    name: String,
    /// Last.fm returns the match as a STRING ("0.99"); 0..1 for artist.getSimilar.
    #[serde(default, rename = "match")]
    match_score: String,
}

/// Map a Deezer genre name to a Last.fm tag. Last.fm tags are forgiving, so
/// this just lowercases and handles a few compound names; an unknown tag
/// simply returns no results and the caller falls back to Deezer.
pub fn genre_to_tag(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    match n.as_str() {
        "rap/hip hop" => "hip-hop".into(),
        "r&b" => "rnb".into(),
        "soul & funk" => "soul".into(),
        "latin music" => "latin".into(),
        "films/games" => "soundtrack".into(),
        "brazilian music" => "brazilian".into(),
        "african music" => "african".into(),
        "asian music" => "asian".into(),
        other => other
            .split(['/', '&'])
            .next()
            .unwrap_or(other)
            .trim()
            .replace(' ', "-"),
    }
}
