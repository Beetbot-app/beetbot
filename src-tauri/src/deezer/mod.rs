//! Deezer public Web API client.
//!
//! We use Deezer for catalog search instead of Spotify because Spotify's
//! Feb 2026 dev-mode tightening capped /v1/search at 10 results and gates
//! larger quotas behind a 250k-MAU bar that personal projects can't clear.
//! Deezer's public API requires no authentication for catalog reads,
//! returns ISRC directly in track responses, and has comparable mainstream
//! coverage (~90M tracks).
//!
//! Endpoints we wrap (all GET, no auth):
//!
//!   /search?q=...&limit=N             — track search (returns ISRC in payload)
//!   /search/album?q=...&limit=N       — album search
//!   /album/{id}/tracks                — tracks on a given album
//!   /track/isrc:{isrc}                — single track lookup by ISRC
//!
//! Rate limiting: Deezer's public docs are sparse on numbers but the
//! community consensus is ~50 req/sec per IP. Our usage (one request per
//! human keystroke after a 350ms debounce) is nowhere near that, so we
//! don't bother with explicit retry-after handling. 4xx/5xx responses
//! surface as `DeezerError::Api { status, body }`.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.deezer.com";

#[derive(Debug, thiserror::Error)]
pub enum DeezerError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("deezer API error {status}: {body}")]
    Api { status: u16, body: String },
}

// ---- Wire-level deserialization types --------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct SearchTrackPage {
    pub data: Vec<TrackHit>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchAlbumPage {
    pub data: Vec<AlbumHit>,
}

/// `/chart` response: parallel top-N lists. Each section is just the same
/// `data: [...]` envelope the search endpoints use, so we nest the
/// existing page types. We only consume tracks/albums/artists (Deezer
/// also returns `playlists` and `podcasts`, which we ignore).
#[derive(Debug, Clone, Deserialize)]
pub struct ChartPage {
    pub tracks: SearchTrackPage,
    pub albums: SearchAlbumPage,
    pub artists: SearchArtistPage,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenrePage {
    pub data: Vec<GenreHit>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenreHit {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub picture_medium: Option<String>,
    #[serde(default)]
    pub picture_big: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistPage {
    pub data: Vec<PlaylistHit>,
}

/// A Deezer playlist as returned by `/chart/{id}/playlists` (the curated
/// genre playlists). `user` is the playlist's creator.
#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistHit {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub picture_medium: Option<String>,
    #[serde(default)]
    pub picture_big: Option<String>,
    #[serde(default)]
    pub nb_tracks: Option<i64>,
    #[serde(default)]
    pub user: Option<PlaylistUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistUser {
    pub name: String,
}

/// `/playlist/{id}` — playlist metadata + its tracks. (Uses `creator` for the
/// owner, unlike the chart-list shape which uses `user`.)
#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistDetail {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub picture_medium: Option<String>,
    #[serde(default)]
    pub picture_big: Option<String>,
    #[serde(default)]
    pub nb_tracks: Option<i64>,
    #[serde(default)]
    pub creator: Option<PlaylistUser>,
    #[serde(default)]
    pub tracks: Option<PlaylistTracksInner>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistTracksInner {
    #[serde(default)]
    pub data: Vec<TrackHit>,
}

/// Track payload as returned by /search. `/search` includes `isrc` for most
/// tracks, but it can be absent on some; `/track/{id}` and `/track/isrc:{isrc}`
/// always carry it. `#[serde(default)]` lets either shape deserialize, and
/// callers fall back to `get_track` when a search hit's ISRC is missing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackHit {
    pub id: u64,
    pub title: String,
    pub duration: u32,
    pub artist: ArtistRef,
    pub album: AlbumRef,
    /// Present on /track/{id} and /track/isrc responses, and usually on
    /// /search hits too; optional so callers handle the occasional absence.
    #[serde(default)]
    pub isrc: Option<String>,
    /// FULL credits (primary first) — e.g. ["James Blake", "Travis Scott",
    /// "Ludwig Göransson"] where `artist` alone says only "James Blake".
    /// Present on /track/{id} and /track/isrc:{isrc}; ABSENT on /search and
    /// album-tracklist hits, so an empty vec means "not provided", never
    /// "solo track".
    #[serde(default)]
    pub contributors: Vec<ArtistRef>,
    /// "YYYY-MM-DD". Present on /track/{id} and /track/isrc responses; absent on
    /// /search hits. The release year (for Home's Decade Mixes) is parsed from it.
    #[serde(default)]
    pub release_date: Option<String>,
    /// Public 30-second preview clip (MP3 URL). Present on /search and
    /// /album/{id}/tracks responses; no auth, no DRM. Used to audition a
    /// track before downloading.
    #[serde(default)]
    pub preview: Option<String>,
    /// Whether Deezer flags the track as having explicit lyrics. Present
    /// on /search, /chart, /artist/{id}/top. Drives the "E" badge.
    #[serde(default)]
    pub explicit_lyrics: bool,
    /// Deezer popularity rank (higher = more popular; ~0..1,000,000). Present on
    /// /search, /chart, /artist/{id}/top and /artist/{id}/radio; absent (→ 0) on
    /// some endpoints. Used by radio's ranking layer for popularity diversification.
    #[serde(default)]
    pub rank: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtistRef {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlbumRef {
    pub id: u64,
    pub title: String,
    pub cover_xl: Option<String>,
    pub cover_big: Option<String>,
    pub cover_medium: Option<String>,
}

/// MD5 of the empty string — the hash Deezer serves as its "no artwork" cover.
/// When an album has no art, Deezer doesn't omit the field or 404: it hands back
/// a perfectly well-formed cover URL built on this hash (and 302s real-but-
/// artless hashes to it). Storing one paints a grey placeholder disc on every
/// tile that album backs, which reads as "our art is broken" rather than
/// "this album has no cover".
pub const NO_COVER_MD5: &str = "d41d8cd98f00b204e9800998ecf8427e";

/// True for Deezer's blank/placeholder images. Deezer signals "no art" two ways:
/// a well-formed URL built on `NO_COVER_MD5`, OR one with an EMPTY hash segment —
/// e.g. `.../images/artist//1000x1000-...` (note the `//`). Real images always
/// carry a 32-char hash, so a `//` anywhere in the PATH (past the scheme's own
/// `://`) means the hash is empty and the image is a placeholder.
fn is_blank_image(u: &str) -> bool {
    u.contains(NO_COVER_MD5)
        || u.split_once("://")
            .map_or(false, |(_, rest)| rest.contains("//"))
}

/// Drop a cover/picture URL that is Deezer's known placeholder, so callers fall
/// through to the next size / source / track instead of persisting a dud.
///
/// NOTE: this only catches art Deezer *tells* us is missing. An album whose art
/// is pulled later keeps a real-looking hash and only reveals itself as a
/// placeholder by redirecting to a blank at fetch time — that class needs a
/// network probe, so it can't be caught here.
fn real_cover(url: Option<String>) -> Option<String> {
    url.filter(|u| !is_blank_image(u))
}

impl AlbumRef {
    pub fn best_cover(&self) -> Option<String> {
        real_cover(self.cover_xl.clone())
            .or_else(|| real_cover(self.cover_big.clone()))
            .or_else(|| real_cover(self.cover_medium.clone()))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlbumHit {
    pub id: u64,
    pub title: String,
    /// Optional on /artist/{id}/albums responses (which already know
    /// the artist from the URL path and elide it from the per-album
    /// objects). Always present on /search/album results.
    #[serde(default)]
    pub artist: Option<ArtistRef>,
    pub cover_xl: Option<String>,
    pub cover_big: Option<String>,
    pub cover_medium: Option<String>,
    /// e.g. "album" | "single" | "ep" | "compile"
    #[serde(default)]
    pub record_type: Option<String>,
    /// "YYYY-MM-DD". Optional on search-result albums (only present on
    /// /album/{id} lookups for most labels), so default-skip silently.
    #[serde(default)]
    pub release_date: Option<String>,
    /// Total tracks on the album. Not always present in /search responses.
    #[serde(default)]
    pub nb_tracks: Option<u32>,
}

impl AlbumHit {
    pub fn best_cover(&self) -> Option<String> {
        real_cover(self.cover_xl.clone())
            .or_else(|| real_cover(self.cover_big.clone()))
            .or_else(|| real_cover(self.cover_medium.clone()))
    }
}

/// Full `/album/{id}` payload — the only Deezer endpoint that returns the
/// album's `genres` list (plus a reliable `release_date`). Used by the
/// metadata backfill.
#[derive(Debug, Clone, Deserialize)]
pub struct AlbumDetail {
    // `title` + `cover_*` let `get_album_tracks` stamp the album name/cover onto
    // the per-track rows, which Deezer returns without them.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cover_xl: Option<String>,
    #[serde(default)]
    pub cover_big: Option<String>,
    #[serde(default)]
    pub cover_medium: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub genres: DeezerGenreList,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DeezerGenreList {
    #[serde(default)]
    pub data: Vec<DeezerGenreName>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeezerGenreName {
    pub name: String,
}

impl AlbumDetail {
    /// The album's primary genre name, if any (Deezer lists them main-first).
    pub fn primary_genre(&self) -> Option<&str> {
        self.genres
            .data
            .iter()
            .map(|g| g.name.as_str())
            .find(|n| !n.is_empty())
    }

    /// Best available cover URL (largest first).
    pub fn best_cover(&self) -> Option<String> {
        real_cover(self.cover_xl.clone())
            .or_else(|| real_cover(self.cover_big.clone()))
            .or_else(|| real_cover(self.cover_medium.clone()))
    }
}

/// /search/artist response.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchArtistPage {
    pub data: Vec<ArtistHit>,
}

/// Artist hit from /search/artist or /artist/{id} lookups. Image
/// fields are nullable for artists with no photo set.
#[derive(Debug, Clone, Deserialize)]
pub struct ArtistHit {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub picture_xl: Option<String>,
    #[serde(default)]
    pub picture_big: Option<String>,
    #[serde(default)]
    pub picture_medium: Option<String>,
    /// Total albums the artist has on Deezer. Not present on every
    /// payload; we surface it when available so the UI can show
    /// "12 albums" subtitles.
    #[serde(default)]
    pub nb_album: Option<u32>,
    /// Listener / fan count. Treat as a "popularity" hint when
    /// ranking duplicates.
    #[serde(default)]
    pub nb_fan: Option<u64>,
}

impl ArtistHit {
    /// Like `best_cover`, drop Deezer's blank placeholder (built on
    /// `NO_COVER_MD5`) — Deezer hands back a well-formed picture URL on that hash
    /// for artists with no photo, so callers see `None` instead of persisting a
    /// grey silhouette. This is also how we tell a real artist from a phantom
    /// combined-credit ("Marshmello & Omar LinX") entity, which never has a photo.
    pub fn best_picture(&self) -> Option<String> {
        real_cover(self.picture_xl.clone())
            .or_else(|| real_cover(self.picture_big.clone()))
            .or_else(|| real_cover(self.picture_medium.clone()))
    }
}

/// /artist/{id}/albums response. Each item is the same `AlbumHit`
/// shape we use for /search/album except `artist` may be omitted
/// (the caller already knows which artist's discography this is).
#[derive(Debug, Clone, Deserialize)]
pub struct ArtistAlbumsPage {
    pub data: Vec<AlbumHit>,
}

/// Tracks on a given album. Deezer denormalizes a flat list with each
/// item carrying the same shape as TrackHit but without the album-level
/// cover (you got that from the album request that brought you here).
#[derive(Debug, Clone, Deserialize)]
pub struct AlbumTracksPage {
    pub data: Vec<AlbumTrackHit>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlbumTrackHit {
    pub id: u64,
    pub title: String,
    pub duration: u32,
    pub artist: ArtistRef,
    /// ISRC is sometimes present on /album/{id}/tracks responses, often
    /// not. We'll surface it when it's there.
    #[serde(default)]
    pub isrc: Option<String>,
    /// Public 30-second preview clip (MP3 URL), same as on /search hits.
    /// Present on /album/{id}/tracks responses; lets the album drill-in
    /// audition tracks before importing.
    #[serde(default)]
    pub preview: Option<String>,
    /// Explicit-lyrics flag (drives the "E" badge), when present.
    #[serde(default)]
    pub explicit_lyrics: bool,
}

// ---- Client -----------------------------------------------------------

/// Process-wide rate gate: the earliest instant the next Deezer request may
/// START. Global (not a client field) because the app constructs a fresh
/// DeezerClient at a dozen+ call sites and the browse pre-warm + metadata
/// backfill run concurrently — pacing has to be shared across all of them, or
/// the burst keeps tripping Deezer's ~50 req / 5s per-IP cap.
static DEEZER_RATE_GATE: OnceLock<Mutex<Instant>> = OnceLock::new();

#[derive(Clone)]
pub struct DeezerClient {
    http: reqwest::Client,
}

impl DeezerClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("Beetbot/0.2 (+https://github.com/beetbot-app/beetbot)")
                .build()
                .expect("reqwest client build"),
        }
    }

    pub async fn search_tracks(
        &self,
        q: &str,
        limit: u32,
    ) -> Result<Vec<TrackHit>, DeezerError> {
        let mut url = url::Url::parse(&format!("{API_BASE}/search"))
            .expect("hardcoded search URL parses");
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("limit", &limit.to_string());
        let page: SearchTrackPage = self.get_json(url.as_str()).await?;
        Ok(page.data)
    }

    pub async fn search_albums(
        &self,
        q: &str,
        limit: u32,
    ) -> Result<Vec<AlbumHit>, DeezerError> {
        let mut url = url::Url::parse(&format!("{API_BASE}/search/album"))
            .expect("hardcoded album-search URL parses");
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("limit", &limit.to_string());
        let page: SearchAlbumPage = self.get_json(url.as_str()).await?;
        Ok(page.data)
    }

    pub async fn search_artists(
        &self,
        q: &str,
        limit: u32,
    ) -> Result<Vec<ArtistHit>, DeezerError> {
        let mut url = url::Url::parse(&format!("{API_BASE}/search/artist"))
            .expect("hardcoded artist-search URL parses");
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("limit", &limit.to_string());
        let page: SearchArtistPage = self.get_json(url.as_str()).await?;
        Ok(page.data)
    }

    /// Playlist search (`/search/playlist`) — the editorial / user playlists
    /// that match the query, so Discover's curated playlists are findable from
    /// the search bar. Returns the same `PlaylistHit` shape as the genre charts.
    pub async fn search_playlists(
        &self,
        q: &str,
        limit: u32,
    ) -> Result<Vec<PlaylistHit>, DeezerError> {
        let mut url = url::Url::parse(&format!("{API_BASE}/search/playlist"))
            .expect("hardcoded playlist-search URL parses");
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("limit", &limit.to_string());
        let page: PlaylistPage = self.get_json(url.as_str()).await?;
        Ok(page.data)
    }

    /// Full album list for an artist. Deezer's `/artist/{id}/albums`
    /// returns paginated chunks but we just grab the first 100 — covers
    /// even the most prolific catalogs without an additional pagination
    /// dance.
    pub async fn get_artist_albums(
        &self,
        artist_id: u64,
    ) -> Result<Vec<AlbumHit>, DeezerError> {
        let url = format!("{API_BASE}/artist/{artist_id}/albums?limit=100");
        let page: ArtistAlbumsPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    pub async fn get_album_tracks(
        &self,
        album_id: u64,
    ) -> Result<Vec<AlbumTrackHit>, DeezerError> {
        let url = format!("{API_BASE}/album/{album_id}/tracks?limit=200");
        let page: AlbumTracksPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// An artist's most popular tracks, by Deezer's own ranking. The
    /// track objects carry the same shape as /search hits (album +
    /// cover + 30s preview), so they deserialize into `TrackHit` and
    /// reuse the catalog-track plumbing downstream.
    pub async fn get_artist_top(
        &self,
        artist_id: u64,
        limit: u32,
    ) -> Result<Vec<TrackHit>, DeezerError> {
        let url = format!("{API_BASE}/artist/{artist_id}/top?limit={limit}");
        let page: SearchTrackPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// "Fans also like" — related artists. Same `ArtistHit` shape as
    /// /search/artist, so the UI reuses the artist grid directly.
    pub async fn get_artist_related(
        &self,
        artist_id: u64,
    ) -> Result<Vec<ArtistHit>, DeezerError> {
        let url = format!("{API_BASE}/artist/{artist_id}/related?limit=20");
        let page: SearchArtistPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// Deezer "smart radio" for an artist (`/artist/{id}/radio`) — ~25 tracks that
    /// span the artist AND sonically-adjacent neighbours (cross-artist, editorial,
    /// non-deterministic so re-rolls give variety). This is genuine TRACK-level
    /// adjacency with no MusicBrainz/MBID dependency, used to seed radio discovery.
    pub async fn get_artist_radio(&self, artist_id: u64) -> Result<Vec<TrackHit>, DeezerError> {
        let url = format!("{API_BASE}/artist/{artist_id}/radio");
        let page: SearchTrackPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// Global charts: the top tracks, albums, and artists right now. Each
    /// section reuses the same hit shapes as search, so the Browse UI can
    /// render them with the existing track list + album/artist grids.
    pub async fn get_chart(&self, limit: u32) -> Result<ChartPage, DeezerError> {
        let url = format!("{API_BASE}/chart?limit={limit}");
        self.get_json(&url).await
    }

    /// Per-genre chart (`/chart/{genre_id}`) — same shape as the global chart.
    /// genre_id 0 is "All" (equivalent to /chart).
    pub async fn get_chart_genre(
        &self,
        genre_id: i64,
        limit: u32,
    ) -> Result<ChartPage, DeezerError> {
        let url = format!("{API_BASE}/chart/{genre_id}?limit={limit}");
        self.get_json(&url).await
    }

    /// Deezer's genre taxonomy (`/genre`) with cover art for each genre.
    pub async fn get_genres(&self) -> Result<Vec<GenreHit>, DeezerError> {
        let url = format!("{API_BASE}/genre");
        let page: GenrePage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// Top artists *within* a genre (`/genre/{id}/artists`). Genuinely
    /// genre-filtered (unlike `/chart/{id}` tracks), so the genre page's
    /// artist row stays on-genre.
    pub async fn get_genre_artists(
        &self,
        genre_id: i64,
    ) -> Result<Vec<ArtistHit>, DeezerError> {
        let url = format!("{API_BASE}/genre/{genre_id}/artists");
        let page: SearchArtistPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// Curated playlists for a genre (`/chart/{id}/playlists`) — e.g. "90s
    /// Hits", "Chill Hits". The Spotify-style "Popular [genre] playlists" row.
    pub async fn get_chart_playlists(
        &self,
        genre_id: i64,
        limit: u32,
    ) -> Result<Vec<PlaylistHit>, DeezerError> {
        let url = format!("{API_BASE}/chart/{genre_id}/playlists?limit={limit}");
        let page: PlaylistPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// A playlist's metadata + tracks (`/playlist/{id}`).
    pub async fn get_playlist(&self, id: i64) -> Result<PlaylistDetail, DeezerError> {
        let url = format!("{API_BASE}/playlist/{id}");
        self.get_json(&url).await
    }

    /// A playlist's full track list (`/playlist/{id}/tracks`).
    pub async fn get_playlist_tracks(
        &self,
        id: i64,
        limit: u32,
    ) -> Result<Vec<TrackHit>, DeezerError> {
        let url = format!("{API_BASE}/playlist/{id}/tracks?limit={limit}");
        let page: SearchTrackPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// Deezer's editorial "new releases" feed (genre 0 = All). Albums in
    /// the same `AlbumHit` shape as /search/album.
    pub async fn get_editorial_releases(
        &self,
        limit: u32,
    ) -> Result<Vec<AlbumHit>, DeezerError> {
        let url = format!("{API_BASE}/editorial/0/releases?limit={limit}");
        let page: SearchAlbumPage = self.get_json(&url).await?;
        Ok(page.data)
    }

    /// A single track by Deezer id (`/track/{id}`). Unlike a /search hit, this
    /// payload reliably carries the `isrc`. Deserializes into the same
    /// `TrackHit` shape (extra fields are ignored).
    pub async fn get_track(&self, id: u64) -> Result<TrackHit, DeezerError> {
        let url = format!("{API_BASE}/track/{id}");
        self.get_json(&url).await
    }

    /// A single track looked up by ISRC (`/track/isrc:{isrc}`) — an exact
    /// lookup, no fuzzy matching. Used to fetch the correct cover for a track
    /// that already has a trustworthy ISRC.
    pub async fn get_track_by_isrc(&self, isrc: &str) -> Result<TrackHit, DeezerError> {
        let url = format!("{API_BASE}/track/isrc:{isrc}");
        self.get_json(&url).await
    }

    /// Full album object (`/album/{id}`) — carries `release_date` and the
    /// album's `genres` list, neither of which appears on track payloads. Used
    /// by the metadata backfill to label tracks with a coarse genre bucket.
    pub async fn get_album(&self, album_id: u64) -> Result<AlbumDetail, DeezerError> {
        let url = format!("{API_BASE}/album/{album_id}");
        self.get_json(&url).await
    }

    /// GET + decode with backoff-and-retry on Deezer's "Quota limit exceeded"
    /// (the in-band error code 4). The public API caps at ~50 requests / 5s per
    /// IP and the window is short, so a brief wait usually turns a transient
    /// limit into a real response instead of an error surfaced to the user.
    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> Result<T, DeezerError> {
        const BACKOFFS_MS: [u64; 2] = [1500, 2500];
        let mut attempt = 0usize;
        loop {
            let result = self.get_json_once(url).await;
            if attempt < BACKOFFS_MS.len() {
                if let Err(DeezerError::Api { status, body }) = &result {
                    if *status == 4 || body.contains("Quota limit exceeded") {
                        let wait = BACKOFFS_MS[attempt];
                        attempt += 1;
                        tracing::warn!(
                            url,
                            attempt,
                            wait_ms = wait,
                            "deezer quota limit; backing off and retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(wait)).await;
                        continue;
                    }
                }
            }
            return result;
        }
    }

    /// Reserve the next request slot, spacing Deezer calls ≥110ms apart (≈45/5s)
    /// to stay under the public API's ~50 req / 5s per-IP cap. Uses the global
    /// gate so every client instance and every concurrent caller (pre-warm,
    /// backfill, search) paces against one another. Holds the lock only to
    /// reserve a slot, never across the await.
    async fn throttle(&self) {
        const MIN_INTERVAL: Duration = Duration::from_millis(110);
        let gate = DEEZER_RATE_GATE.get_or_init(|| Mutex::new(Instant::now()));
        let wait = {
            let mut slot = gate.lock().unwrap();
            let now = Instant::now();
            let next = (*slot + MIN_INTERVAL).max(now);
            *slot = next;
            next.saturating_duration_since(now)
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn get_json_once<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> Result<T, DeezerError> {
        self.throttle().await;
        let resp = self.http.get(url).send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?;

        // Log and bail on any HTTP-level failure first, so a degraded Deezer
        // (503, rate-limit) always leaves a trace in the logs — even when the
        // body also happens to be a well-formed `{ "error": ... }` envelope.
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes).into_owned();
            tracing::warn!(url, status = status.as_u16(), %body, "deezer API error");
            return Err(DeezerError::Api {
                status: status.as_u16(),
                body: format!("{url}: {body}"),
            });
        }

        // Deezer is unusual: even on a 200 OK they sometimes return a
        // top-level `{ "error": { ... } }` envelope (e.g. when an album
        // ID doesn't exist, or a quota trip — code 4). Detect that and
        // translate to a real error before serde tries to decode into the
        // expected shape and explodes with a confusing serde message.
        if let Ok(env) = serde_json::from_slice::<DeezerErrorEnvelope>(&bytes) {
            if let Some(err) = env.error {
                return Err(DeezerError::Api {
                    status: err.code.unwrap_or_else(|| status.as_u16() as i64) as u16,
                    body: format!("{}: {}", err.error_type.unwrap_or_default(), err.message.unwrap_or_default()),
                });
            }
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            let preview: String =
                String::from_utf8_lossy(&bytes).chars().take(400).collect();
            tracing::error!(url, error = %e, body_preview = %preview, "deezer decode failed");
            DeezerError::Api {
                status: 0,
                body: format!("decode failed at {url}: {e}; preview: {preview}"),
            }
        })
    }
}

impl Default for DeezerClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Deezer's in-band error envelope. Comes back inside an HTTP 200 body
/// for some failure modes (notably "not found" on /album/{id}/tracks),
/// which is why we peek at the bytes before deserializing into the
/// caller's expected shape.
#[derive(Debug, Clone, Deserialize)]
struct DeezerErrorEnvelope {
    #[serde(default)]
    error: Option<DeezerErrorInner>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeezerErrorInner {
    #[serde(default, rename = "type")]
    error_type: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real shape of /search?q=ice&limit=1 captured 2026-05.
    const SEARCH_RESPONSE: &str = r#"{
        "data": [
            {
                "id": 916424,
                "title": "Ice Ice Baby",
                "duration": 277,
                "artist": {"name": "Vanilla Ice"},
                "album": {
                    "id": 91234,
                    "title": "To the Extreme",
                    "cover_medium": "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg",
                    "cover_big": "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg",
                    "cover_xl": "https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg"
                }
            }
        ],
        "total": 300
    }"#;

    #[test]
    fn decodes_search_response() {
        let page: SearchTrackPage = serde_json::from_str(SEARCH_RESPONSE).unwrap();
        assert_eq!(page.data.len(), 1);
        let t = &page.data[0];
        assert_eq!(t.id, 916424);
        assert_eq!(t.title, "Ice Ice Baby");
        assert_eq!(t.duration, 277);
        assert_eq!(t.artist.name, "Vanilla Ice");
        assert_eq!(t.album.title, "To the Extreme");
        assert_eq!(
            t.album.best_cover().as_deref(),
            Some("https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg")
        );
    }

    /// Album search response sample with `record_type`.
    const ALBUM_SEARCH_RESPONSE: &str = r#"{
        "data": [
            {
                "id": 30220511,
                "title": "Random Access Memories",
                "artist": {"name": "Daft Punk"},
                "cover_medium": "https://e-cdns-images.dzcdn.net/images/cover/xyz/250x250-000000-80-0-0.jpg",
                "cover_big": null,
                "cover_xl": null,
                "record_type": "album",
                "release_date": "2013-05-17",
                "nb_tracks": 13
            }
        ]
    }"#;

    #[test]
    fn decodes_album_search() {
        let page: SearchAlbumPage = serde_json::from_str(ALBUM_SEARCH_RESPONSE).unwrap();
        let a = &page.data[0];
        assert_eq!(a.id, 30220511);
        assert_eq!(a.title, "Random Access Memories");
        assert_eq!(a.nb_tracks, Some(13));
        assert_eq!(a.record_type.as_deref(), Some("album"));
        assert!(a.best_cover().is_some());
    }

    /// Deezer's "in-band error envelope" surface: an HTTP 200 with a body
    /// like {"error":{...}} that we have to detect before serde tries to
    /// decode into the success shape.
    const ERROR_ENVELOPE: &str = r#"{
        "error": {
            "type": "DataException",
            "message": "no data",
            "code": 800
        }
    }"#;

    #[test]
    fn decodes_in_band_error_envelope() {
        let env: DeezerErrorEnvelope = serde_json::from_str(ERROR_ENVELOPE).unwrap();
        let inner = env.error.expect("inner error decodes");
        assert_eq!(inner.error_type.as_deref(), Some("DataException"));
        assert_eq!(inner.message.as_deref(), Some("no data"));
        assert_eq!(inner.code, Some(800));
    }

    const ARTIST_SEARCH_RESPONSE: &str = r#"{
        "data": [
            {
                "id": 27,
                "name": "Daft Punk",
                "picture_medium": "https://example.com/m.jpg",
                "picture_big": "https://example.com/b.jpg",
                "picture_xl": "https://example.com/xl.jpg",
                "nb_album": 27,
                "nb_fan": 5400000
            }
        ],
        "total": 50
    }"#;

    #[test]
    fn decodes_artist_search() {
        let page: SearchArtistPage = serde_json::from_str(ARTIST_SEARCH_RESPONSE).unwrap();
        assert_eq!(page.data.len(), 1);
        let a = &page.data[0];
        assert_eq!(a.id, 27);
        assert_eq!(a.name, "Daft Punk");
        assert_eq!(a.nb_album, Some(27));
        assert_eq!(a.nb_fan, Some(5_400_000));
        assert_eq!(a.best_picture().as_deref(), Some("https://example.com/xl.jpg"));
    }

    /// /artist/{id}/albums responses sometimes elide the `artist` field
    /// on each album object (the caller already knows whose discography
    /// this is). Our AlbumHit now treats `artist` as optional.
    const ARTIST_ALBUMS_RESPONSE: &str = r#"{
        "data": [
            {
                "id": 30220511,
                "title": "Random Access Memories",
                "cover_medium": "https://example.com/x-m.jpg",
                "cover_big": "https://example.com/x-b.jpg",
                "record_type": "album",
                "release_date": "2013-05-17",
                "nb_tracks": 13
            }
        ],
        "total": 1
    }"#;

    #[test]
    fn decodes_artist_albums_without_per_item_artist() {
        let page: ArtistAlbumsPage = serde_json::from_str(ARTIST_ALBUMS_RESPONSE).unwrap();
        assert_eq!(page.data.len(), 1);
        let a = &page.data[0];
        assert_eq!(a.title, "Random Access Memories");
        // Crucially: artist is None here, and that's not an error.
        assert!(a.artist.is_none());
    }

    #[test]
    fn album_cover_prefers_xl_then_big_then_medium() {
        let only_medium = AlbumRef {
            id: 1,
            title: "X".into(),
            cover_xl: None,
            cover_big: None,
            cover_medium: Some("m".into()),
        };
        assert_eq!(only_medium.best_cover().as_deref(), Some("m"));

        let big_and_medium = AlbumRef {
            id: 2,
            title: "Y".into(),
            cover_xl: None,
            cover_big: Some("b".into()),
            cover_medium: Some("m".into()),
        };
        assert_eq!(big_and_medium.best_cover().as_deref(), Some("b"));

        let all_three = AlbumRef {
            id: 3,
            title: "Z".into(),
            cover_xl: Some("xl".into()),
            cover_big: Some("b".into()),
            cover_medium: Some("m".into()),
        };
        assert_eq!(all_three.best_cover().as_deref(), Some("xl"));
    }

    #[test]
    fn best_picture_drops_deezer_blank_placeholders() {
        let real = "https://cdn-images.dzcdn.net/images/artist/abc123def456/1000x1000-000000-80-0-0.jpg";
        // Empty-hash blank (what Deezer returns for a phantom collab credit with
        // no photo) — note the "//" in the path.
        let empty_hash = "https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg";
        // NO_COVER_MD5 blank (md5 of the empty string).
        let md5_blank = format!(
            "https://cdn-images.dzcdn.net/images/artist/{NO_COVER_MD5}/1000x1000-000000-80-0-0.jpg"
        );

        let with = |xl: &str| ArtistHit {
            id: 1,
            name: "A".into(),
            picture_xl: Some(xl.into()),
            picture_big: None,
            picture_medium: None,
            nb_fan: None,
            nb_album: None,
        };

        assert_eq!(with(real).best_picture().as_deref(), Some(real));
        assert_eq!(with(empty_hash).best_picture(), None);
        assert_eq!(with(&md5_blank).best_picture(), None);
    }
}
