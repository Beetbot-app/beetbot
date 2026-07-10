//! Backfill missing track metadata (ISRC + album art) from Deezer.
//!
//! Exportify CSV imports arrive with no cover art and no ISRC — the CSV export
//! carries neither column — so a largely Exportify-built library shows the ♪
//! placeholder for most songs. This module looks each gap up on Deezer's free
//! API and fills the blanks.
//!
//! Correctness discipline: a *wrong* ISRC is worse than none — it would tag a
//! track with another recording's identity. We therefore only adopt a Deezer
//! hit's ISRC/art when the hit is confidently the *same* song:
//! normalized title AND primary-artist match AND duration within 2 seconds.
//! Everything is COALESCE-written by the caller so an existing value is never
//! clobbered — we only fill NULLs.

use crate::deezer::{DeezerClient, TrackHit};
use crate::textnorm::normalize_title;

/// Coarse genre buckets, each with the substrings (from Deezer's genre names)
/// that map into it. Order is the tie-break when an album's genre matches
/// several buckets (earlier = higher priority); the most "genre-defining"
/// buckets come first, with Pop and Electronic last (so "Dance" → Electronic,
/// but a "Pop"-named genre wins over generic modifiers).
const GENRE_BUCKETS: &[(&str, &[&str])] = &[
    ("Hip-Hop", &["hip hop", "hip-hop", "rap", "trap", "drill", "grime"]),
    ("R&B", &["r&b", "rnb", "soul", "funk", "motown", "blues"]),
    ("Country", &["country", "americana", "bluegrass"]),
    ("Metal", &["metal", "metalcore", "hardcore"]),
    ("Reggae", &["reggae", "dancehall", "ska", "dub"]),
    ("Latin", &["latin", "reggaeton", "salsa", "bachata", "cumbia", "brazil"]),
    ("Jazz", &["jazz", "bebop", "swing", "bossa"]),
    ("Classical", &["classical", "orchestra", "baroque", "opera"]),
    ("Folk", &["folk", "singer-songwriter", "acoustic"]),
    (
        "Rock",
        &["rock", "punk", "grunge", "emo", "alternative", "indie"],
    ),
    ("Pop", &["pop", "k-pop", "j-pop"]),
    (
        "Electronic",
        &[
            "electro", "edm", "house", "techno", "dubstep", "trance", "dance",
            "ambient", "garage", "drum & bass",
        ],
    ),
];

/// Fold a Deezer genre name into one coarse bucket, or `None` if nothing
/// matches (e.g. "Films/Games", "Soundtracks"). First matching bucket wins.
pub fn genre_bucket(genre: &str) -> Option<String> {
    let g = genre.to_lowercase();
    GENRE_BUCKETS
        .iter()
        .find(|(_, kws)| kws.iter().any(|kw| g.contains(kw)))
        .map(|(bucket, _)| bucket.to_string())
}

/// Parse a Deezer `release_date` ("YYYY-MM-DD") to a 4-digit year. Deezer uses
/// "0000-00-00" for unknown dates, which this correctly rejects (year 0).
pub fn parse_year(release_date: &str) -> Option<i64> {
    let head: String = release_date.chars().take(4).collect();
    if head.len() == 4 && head.chars().all(|c| c.is_ascii_digit()) {
        match head.parse::<i64>() {
            Ok(y) if y >= 1900 => Some(y),
            _ => None,
        }
    } else {
        None
    }
}

/// A track that's missing artwork and/or ISRC, pulled from the DB.
#[derive(Debug, Clone)]
pub struct TrackGap {
    pub id: i64,
    pub title: String,
    /// The track's first/primary artist (Spotify lists the primary first).
    pub primary_artist: String,
    pub duration_ms: i64,
    /// The track's existing ISRC, if it already has one (so it's only missing
    /// art). When present we can do an *exact* `/track/isrc:` art lookup.
    pub existing_isrc: Option<String>,
    /// Whether the track is missing album art (for honest per-field counts).
    pub missing_art: bool,
    /// Whether the track is missing its release year (for Decade Mixes).
    pub missing_year: bool,
    /// Whether the track is missing its coarse genre bucket (for Genre Mixes).
    pub missing_genre: bool,
}

/// What we resolved for a gap. Any field may be `None` if Deezer didn't provide
/// it or we couldn't confidently match; the caller COALESCE-writes whichever is
/// present. `album_id` is the Deezer album the genre is looked up from.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub isrc: Option<String>,
    pub album_art_url: Option<String>,
    pub release_year: Option<i64>,
    pub album_id: Option<u64>,
}

/// True when two raw strings refer to the same thing: their normalized forms
/// are equal, or their *base* forms (parenthetical feat/version tails stripped)
/// are equal. Deliberately no loose substring containment — on real library
/// data it added zero coverage over base-equality while letting "Love" match
/// "Lovers".
fn same_song_text(a_raw: &str, b_raw: &str) -> bool {
    let (a, b) = (normalize_title(a_raw), normalize_title(b_raw));
    if !a.is_empty() && a == b {
        return true;
    }
    let (ab, bb) = (base_title(a_raw), base_title(b_raw));
    !ab.is_empty() && ab == bb
}

/// Whether an iTunes search hit is credibly the same song: the title must
/// match (via [`same_song_text`]), and when both artist strings are non-empty
/// they must share at least one token. Token overlap (not equality/containment)
/// because the library side may be a joined string ("张紫宁 / 李鑫一") while
/// iTunes reports one canonical artist — sharing any name is enough for ART.
pub fn itunes_hit_matches(
    title: &str,
    artist: &str,
    hit_track: &str,
    hit_artist: &str,
) -> bool {
    // `same_song_text` normalizes to ASCII alphanumerics, which empties
    // non-Latin titles ("逐玉" → "") and can then never match — the very rows
    // this fallback exists for. When the LOCAL title is non-Latin, compare
    // paren/dash-stripped raw forms instead (so "逐玉" matches iTunes'
    // "逐玉 (影视原声带)" or "逐玉 (OST)"), still requiring exact equality of
    // what remains.
    let title_ok = if normalize_title(title).is_empty() {
        let (a, b) = (raw_base(title), raw_base(hit_track));
        !a.is_empty() && a == b
    } else {
        same_song_text(title, hit_track)
    };
    if !title_ok {
        return false;
    }
    // Same different-recording veto the Deezer path uses: a karaoke/live/
    // tribute rendition of the right title must not donate its art.
    if title_modifier_mismatch(title, hit_track) {
        return false;
    }
    let toks = |s: &str| -> std::collections::HashSet<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let (a, b) = (toks(artist), toks(hit_artist));
    if a.is_empty() || b.is_empty() {
        return true;
    }
    // The shared token must be MEANINGFUL: a stopword ("The" in "The Band" vs
    // "The Weeknd") or a bare number must not bridge unrelated artists — wrong
    // art writes once via COALESCE and there's no UI to clear it.
    const STOPWORDS: &[&str] = &[
        "the", "a", "an", "and", "of", "la", "los", "el", "de", "band", "dj", "mc",
    ];
    a.intersection(&b).any(|t| {
        !STOPWORDS.contains(&t.as_str()) && !t.chars().all(|c| c.is_ascii_digit())
    })
}

/// iTunes artwork URLs embed their raster size ("…/100x100bb.jpg"); ask the
/// same CDN path for the 600x600 rendition instead.
pub fn itunes_upscale_art(url: &str) -> String {
    url.replace("100x100bb", "600x600bb")
}

/// Best-effort album-art lookup via the keyless iTunes Search API — the
/// fallback when Deezer has no match at all (notably CJK/regional releases
/// like OSTs). Verified against the hit's own title/artist before use, and
/// paced ~3s/call to stay well under Apple's ~20 req/min guideline. Any
/// failure just yields None — the next backfill run retries.
/// Outcome of an iTunes art lookup. `NoMatch` is DEFINITIVE (the API answered
/// and nothing acceptable was in it) — safe to record so the row isn't
/// re-attempted every launch. `Unavailable` is transient (network/HTTP/parse
/// failure) and must NOT be recorded, mirroring the MBID cache's
/// only-cache-definitive-results rule.
pub enum ItunesArt {
    Found(String),
    NoMatch,
    Unavailable,
}

/// Best-guess iTunes storefront for a title. The default (US) catalog often
/// lacks regional releases entirely — verified live: a Chinese drama OST is
/// absent from the US storefront but fully present (with art) on CN. Kana
/// decides Japanese before Han (Japanese text mixes kanji + kana); pure Han →
/// CN; Hangul → KR; anything else → the default storefront.
pub fn itunes_country_for(title: &str) -> Option<&'static str> {
    let mut han = false;
    let mut hangul = false;
    for c in title.chars() {
        match c as u32 {
            0x3040..=0x30FF => return Some("jp"), // hiragana/katakana
            0xAC00..=0xD7AF => hangul = true,
            0x4E00..=0x9FFF => han = true,
            _ => {}
        }
    }
    if hangul {
        Some("kr")
    } else if han {
        Some("cn")
    } else {
        None
    }
}

/// The search term for a track. Non-Latin titles search better STRIPPED — the
/// parenthetical tail usually names the drama/edition, which poisons iTunes'
/// literal search (verified live: the raw OST title returned a DIFFERENT
/// drama's same-named song; the stripped one found the real track). Artist
/// joiner punctuation ("A / B") is flattened to spaces for the same reason.
pub fn itunes_search_term(title: &str, artist: &str) -> String {
    let t = if normalize_title(title).is_empty() {
        raw_base(title)
    } else {
        title.trim().to_string()
    };
    let a = artist.replace(['/', ';', '&', ','], " ");
    let a = a.split_whitespace().collect::<Vec<_>>().join(" ");
    if a.is_empty() { t } else { format!("{t} {a}") }
}

pub async fn itunes_art_lookup(
    http: &reqwest::Client,
    title: &str,
    artist: &str,
) -> ItunesArt {
    if title.trim().is_empty() {
        // Permanently unmatchable — nothing to search by.
        return ItunesArt::NoMatch;
    }
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let term = itunes_search_term(title, artist);
    let mut query: Vec<(&str, &str)> = vec![
        ("term", term.as_str()),
        ("media", "music"),
        ("entity", "song"),
        ("limit", "5"),
    ];
    if let Some(country) = itunes_country_for(title) {
        query.push(("country", country));
    }
    let resp = match http
        .get("https://itunes.apple.com/search")
        .query(&query)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return ItunesArt::Unavailable,
    };
    let Ok(v) = resp.json::<serde_json::Value>().await else {
        return ItunesArt::Unavailable;
    };
    let Some(results) = v.get("results").and_then(|r| r.as_array()) else {
        return ItunesArt::Unavailable; // unexpected shape — don't record a miss
    };
    let found = results.iter().find_map(|r| {
        let hit_track = r.get("trackName")?.as_str()?;
        let hit_artist = r.get("artistName").and_then(|a| a.as_str()).unwrap_or("");
        if !itunes_hit_matches(title, artist, hit_track, hit_artist) {
            return None;
        }
        let art = r.get("artworkUrl100")?.as_str()?;
        Some(itunes_upscale_art(art))
    });
    match found {
        Some(url) => ItunesArt::Found(url),
        None => ItunesArt::NoMatch,
    }
}

/// [`base_title`] minus the ASCII-only normalize step, so non-Latin titles
/// survive: strips parenthetical/bracket groups (ASCII and full-width) and any
/// trailing " - …" tail, drops CJK title-quote marks (《》「」『』 are
/// punctuation, not content), lowercases, collapses whitespace. Used by the
/// non-Latin branch of the iTunes matcher, where `normalize_title` would strip
/// the whole string to "".
fn raw_base(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth: i32 = 0;
    for c in s.chars() {
        match c {
            '(' | '[' | '（' | '［' | '【' => depth += 1,
            ')' | ']' | '）' | '］' | '】' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            '《' | '》' | '「' | '」' | '『' | '』' => {}
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    for sep in [" - ", " \u{2013} ", " \u{2014} "] {
        if let Some(idx) = out.find(sep) {
            out.truncate(idx);
        }
    }
    out.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A title with parenthetical/bracket groups and any trailing " - …" version
/// marker removed, then normalized. Bridges "True Love" vs "True Love (feat.
/// X)" and "Song" vs "Song - Remastered 2011" without trusting an unrelated
/// substring.
fn base_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth: i32 = 0;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    for sep in [" - ", " \u{2013} ", " \u{2014} "] {
        if let Some(idx) = out.find(sep) {
            out.truncate(idx);
        }
    }
    normalize_title(&out)
}

/// A search-friendly title: parenthetical/bracket groups and any trailing
/// " - …" version marker removed, whitespace collapsed — but real words kept
/// (unlike [`base_title`], which strips to bare alphanumerics). Deezer's search
/// can return *zero* hits for a query containing "(with X)" / "(feat. X)" /
/// "- Remaster", so we search with this cleaned form first.
fn clean_for_search(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth: i32 = 0;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    for sep in [" - ", " \u{2013} ", " \u{2014} "] {
        if let Some(idx) = out.find(sep) {
            out.truncate(idx);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when one title carries a "different recording" marker (live / remix /
/// cover / karaoke / instrumental / sped up / …) that the other does not — in
/// which case they are NOT the same recording even if their base titles match.
/// Reuses [`crate::textnorm::TITLE_MODIFIERS`] so the two stay in sync. The check
/// is symmetric: it fires whether the Deezer hit OR the local track is the
/// variant, because adopting either's ISRC for the other is wrong.
fn title_modifier_mismatch(local_title: &str, hit_title: &str) -> bool {
    let l = local_title.to_lowercase();
    let h = hit_title.to_lowercase();
    crate::textnorm::TITLE_MODIFIERS
        .iter()
        .any(|m| l.contains(m) != h.contains(m))
}

/// Conservative same-recording test before we trust a Deezer hit's ISRC/art.
/// Requires the primary artist to match (exact, normalized) AND the title to
/// match (exact or with a feat/version tail stripped) AND no "different
/// recording" modifier to distinguish them AND the durations to be within 2
/// seconds. When the local duration is unknown (0) there's no duration guard,
/// so we tighten to *exact* normalized title + artist equality instead.
///
/// A wrong ISRC mis-tags a track with another recording's identity, so every
/// gate here fails closed: a false reject just means "no backfill".
pub fn confirm_match(gap: &TrackGap, hit: &TrackHit) -> bool {
    let la = normalize_title(&gap.primary_artist);
    // No artist to corroborate with → too risky to adopt a foreign ISRC.
    if la.is_empty() {
        return false;
    }
    // Artist names have no feat/version tails, so compare them by exact
    // normalized equality only — never via base_title (which would truncate a
    // name like "Kanye West - Deluxe" at the dash and over-match).
    let ha = normalize_title(&hit.artist.name);
    if la != ha {
        return false;
    }

    if gap.duration_ms <= 0 {
        let lt = normalize_title(&gap.title);
        let ht = normalize_title(&hit.title);
        return !lt.is_empty() && lt == ht;
    }

    // Title may differ only by a stripped feat/version tail…
    if !same_song_text(&gap.title, &hit.title) {
        return false;
    }
    // …but never by a live/remix/cover/etc. marker, even when the base titles
    // match and the durations happen to line up.
    if title_modifier_mismatch(&gap.title, &hit.title) {
        return false;
    }
    let local_s = gap.duration_ms / 1000;
    (hit.duration as i64 - local_s).abs() <= 2
}

/// Resolve one gap against Deezer.
///
/// - If the track already has an ISRC (so it's only missing art), do an exact
///   `/track/isrc:` lookup — no fuzzy matching needed, the ISRC is the key.
/// - Otherwise search by "artist title", take the first hit that passes
///   [`confirm_match`], and adopt its ISRC + cover. If the search hit somehow
///   lacks an ISRC, fall back to `/track/{id}` (which always carries it).
pub async fn resolve_gap(client: &DeezerClient, gap: &TrackGap) -> Resolved {
    // Year + album id accumulate across paths so a trusted ISRC lookup's
    // values aren't lost if it lacks cover art and we fall through to search.
    let mut release_year: Option<i64> = None;
    let mut album_id: Option<u64> = None;

    // Exact path: we already trust this track's ISRC. The /track/isrc payload
    // carries cover + release_date + album id, so one call yields art, the
    // release year, and the album to read the genre from.
    if let Some(isrc) = gap.existing_isrc.as_deref() {
        if !isrc.is_empty() {
            if let Ok(hit) = client.get_track_by_isrc(isrc).await {
                release_year = hit.release_date.as_deref().and_then(parse_year);
                album_id = Some(hit.album.id);
                let art = hit.album.best_cover();
                if art.is_some() {
                    return Resolved {
                        isrc: None, // already set; never rewrite it
                        album_art_url: art,
                        release_year,
                        album_id,
                    };
                }
            }
            // Exact lookup failed or lacked art → fall through to a text search
            // as a backstop (still gated by confirm_match below).
        }
    }

    // Search with a cleaned title first; fall back to the raw title if that
    // yields no confirmed match. confirm_match always uses the *full* title, so
    // the cleaner query never loosens match quality.
    let with_artist = |t: &str| -> String {
        if gap.primary_artist.is_empty() {
            t.to_string()
        } else {
            format!("{} {}", gap.primary_artist, t)
        }
    };
    let clean = clean_for_search(&gap.title);
    let mut queries: Vec<String> = vec![with_artist(&clean)];
    if clean != gap.title.trim() {
        queries.push(with_artist(gap.title.trim()));
    }

    let mut found: Option<TrackHit> = None;
    for q in &queries {
        if q.trim().is_empty() {
            continue;
        }
        if let Ok(hits) = client.search_tracks(q, 5).await {
            if let Some(h) = hits.into_iter().find(|h| confirm_match(gap, h)) {
                found = Some(h);
                break;
            }
        }
    }
    let Some(hit) = found else {
        // No confirmed text match, but a trusted ISRC lookup above may still
        // have yielded a year + album to read the genre from — return those.
        return Resolved {
            isrc: None,
            album_art_url: None,
            release_year,
            album_id,
        };
    };

    // Only fill the ISRC if this track was actually missing one.
    let isrc = if gap.existing_isrc.is_some() {
        None
    } else {
        match hit.isrc.clone() {
            Some(i) if !i.is_empty() => Some(i),
            _ => client
                .get_track(hit.id)
                .await
                .ok()
                .and_then(|t| t.isrc)
                .filter(|i| !i.is_empty()),
        }
    };

    // Search hits usually lack release_date; fill year/album only if the ISRC
    // path above didn't already (a later album fetch covers the year otherwise).
    if album_id.is_none() {
        album_id = Some(hit.album.id);
    }
    if release_year.is_none() {
        release_year = hit.release_date.as_deref().and_then(parse_year);
    }

    Resolved {
        isrc,
        album_art_url: hit.album.best_cover(),
        release_year,
        album_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deezer::{AlbumRef, ArtistRef, TrackHit};

    fn hit(title: &str, artist: &str, dur: u32, isrc: Option<&str>) -> TrackHit {
        TrackHit {
            id: 1,
            title: title.into(),
            duration: dur,
            artist: ArtistRef { name: artist.into() },
            album: AlbumRef {
                id: 1,
                title: "Album".into(),
                cover_xl: Some("xl.jpg".into()),
                cover_big: None,
                cover_medium: None,
            },
            isrc: isrc.map(Into::into),
            release_date: None,
            preview: None,
            explicit_lyrics: false,
            rank: 0,
        }
    }

    fn gap(title: &str, artist: &str, dur_ms: i64) -> TrackGap {
        TrackGap {
            id: 1,
            title: title.into(),
            primary_artist: artist.into(),
            duration_ms: dur_ms,
            existing_isrc: None,
            missing_art: true,
            missing_year: true,
            missing_genre: true,
        }
    }

    #[test]
    fn itunes_storefront_and_term() {
        // Script → storefront (kana wins over kanji for Japanese text).
        assert_eq!(itunes_country_for("逐玉"), Some("cn"));
        assert_eq!(itunes_country_for("残酷な天使のテーゼ"), Some("jp"));
        assert_eq!(itunes_country_for("소리꾼"), Some("kr"));
        assert_eq!(itunes_country_for("Hello"), None);
        // Non-Latin terms search stripped (the paren tail names the drama and
        // poisons literal search); artist joiners flatten to spaces.
        assert_eq!(
            itunes_search_term("一念 (影视剧《逐玉》插曲)", "张紫宁 / 李鑫一"),
            "一念 张紫宁 李鑫一"
        );
        // Latin titles keep their raw form (feat-tails help disambiguate).
        assert_eq!(
            itunes_search_term("True Love (feat. X)", "Ye"),
            "True Love (feat. X) Ye"
        );
        assert_eq!(itunes_search_term("Solo", ""), "Solo");
    }

    #[test]
    fn itunes_hit_matching_and_upscale() {
        // Title must match; artist needs only token overlap.
        assert!(itunes_hit_matches("逐玉", "张紫宁 / 李鑫一", "逐玉", "张紫宁"));
        // Non-Latin titles match through paren/dash suffixes and CJK quote
        // marks — the shapes iTunes actually returns for OSTs.
        assert!(itunes_hit_matches("逐玉", "张紫宁", "逐玉 (影视原声带)", "张紫宁"));
        assert!(itunes_hit_matches("逐玉", "张紫宁", "逐玉 (OST)", "张紫宁"));
        assert!(itunes_hit_matches("《逐玉》", "张紫宁", "逐玉", "张紫宁"));
        assert!(
            !itunes_hit_matches("逐玉", "张紫宁", "逐玉主题曲", "张紫宁"),
            "a genuinely different non-Latin title must still reject"
        );
        assert!(itunes_hit_matches("True Love", "Ye", "True Love (feat. X)", "Ye"));
        assert!(
            !itunes_hit_matches("Love", "Adele", "Lovers", "Adele"),
            "different song must reject even with the right artist"
        );
        assert!(
            !itunes_hit_matches("Hello", "Adele", "Hello", "Lionel Richie"),
            "no artist token overlap must reject"
        );
        // Empty library artist → title alone decides (best-effort art).
        assert!(itunes_hit_matches("Hello", "", "Hello", "Adele"));
        // A shared stopword or bare number must NOT bridge unrelated artists.
        assert!(
            !itunes_hit_matches("Home", "The Band", "Home", "The Weeknd"),
            "shared 'the' alone must reject"
        );
        assert!(
            !itunes_hit_matches("Song 2", "Blur 182", "Song 2", "Roc 182"),
            "shared bare number alone must reject"
        );
        assert!(
            itunes_hit_matches(
                "Home",
                "Edward Sharpe",
                "Home",
                "Edward Sharpe & The Magnetic Zeros"
            ),
            "a real (non-stopword) shared token still accepts"
        );
        // Different-recording veto: karaoke/live renditions must not donate art.
        assert!(
            !itunes_hit_matches("Hello", "Adele", "Hello (Karaoke)", "Adele"),
            "karaoke rendition must reject"
        );
        assert_eq!(
            itunes_upscale_art("https://x.mzstatic.com/a/100x100bb.jpg"),
            "https://x.mzstatic.com/a/600x600bb.jpg"
        );
    }

    #[test]
    fn exact_title_artist_duration_accepts() {
        assert!(confirm_match(
            &gap("Rich Spirit", "Kendrick Lamar", 202_000),
            &hit("Rich Spirit", "Kendrick Lamar", 202, Some("USUM72208971")),
        ));
    }

    #[test]
    fn feat_tail_accepts_with_duration() {
        // Spotify clean title vs Deezer's "(feat. …)" variant, same recording.
        assert!(confirm_match(
            &gap("True Love", "Kanye West", 148_000),
            &hit("True Love (feat. XXXTENTACION)", "Kanye West", 149, None),
        ));
    }

    #[test]
    fn version_suffix_accepts() {
        assert!(confirm_match(
            &gap("Out of Time", "The Weeknd", 214_000),
            &hit("Out of Time - Remastered", "The Weeknd", 213, None),
        ));
    }

    #[test]
    fn wrong_artist_rejects() {
        assert!(!confirm_match(
            &gap("Faded", "Sickick", 211_000),
            &hit("Faded", "Alan Walker", 212, None),
        ));
    }

    #[test]
    fn wrong_duration_rejects() {
        // Same title + artist but a clearly different cut (e.g. an extended mix).
        assert!(!confirm_match(
            &gap("Faded", "Sickick", 211_000),
            &hit("Faded", "Sickick", 240, None),
        ));
    }

    #[test]
    fn different_song_same_artist_rejects() {
        assert!(!confirm_match(
            &gap("Rich Spirit", "Kendrick Lamar", 202_000),
            &hit("Count Me Out", "Kendrick Lamar", 283, None),
        ));
    }

    #[test]
    fn substring_artist_does_not_overmatch() {
        // "love" must not match "lovers" as a title via containment.
        assert!(!confirm_match(
            &gap("Love", "Some Artist", 200_000),
            &hit("Lovers", "Some Artist", 200, None),
        ));
    }

    #[test]
    fn unknown_duration_requires_exact_title() {
        // No duration guard → the feat-tail variant must be rejected…
        assert!(!confirm_match(
            &gap("True Love", "Kanye West", 0),
            &hit("True Love (feat. XXXTENTACION)", "Kanye West", 149, None),
        ));
        // …but an exact title+artist still matches.
        assert!(confirm_match(
            &gap("True Love", "Kanye West", 0),
            &hit("True Love", "Kanye West", 149, None),
        ));
    }

    #[test]
    fn live_version_rejects_even_with_close_duration() {
        // base_title would bridge "Hey Jude - Live" to "Hey Jude"; the modifier
        // guard must veto it so the live recording's ISRC is never adopted.
        assert!(!confirm_match(
            &gap("Hey Jude", "The Beatles", 431_000),
            &hit("Hey Jude - Live", "The Beatles", 430, Some("WRONGISRC")),
        ));
    }

    #[test]
    fn remix_rejects_for_non_remix_track() {
        assert!(!confirm_match(
            &gap("Sicko Mode", "Travis Scott", 312_000),
            &hit("Sicko Mode (Remix)", "Travis Scott", 311, None),
        ));
    }

    #[test]
    fn matching_remix_on_both_sides_accepts() {
        // If the user's track itself is the remix, the same-remix hit is fine.
        assert!(confirm_match(
            &gap("Sicko Mode (Remix)", "Travis Scott", 312_000),
            &hit("Sicko Mode - Remix", "Travis Scott", 311, None),
        ));
    }

    #[test]
    fn artist_dash_is_not_truncated() {
        // A malformed artist "Kanye West - Deluxe" must NOT match "Kanye West".
        assert!(!confirm_match(
            &gap("Some Track", "Kanye West - Deluxe", 200_000),
            &hit("Some Track", "Kanye West", 200, None),
        ));
    }

    #[test]
    fn clean_for_search_strips_parens_and_version() {
        assert_eq!(clean_for_search("Fair Trade (with Travis Scott)"), "Fair Trade");
        assert_eq!(clean_for_search("Out of Time - Remastered"), "Out of Time");
        assert_eq!(clean_for_search("True Love (feat. XXXTENTACION)"), "True Love");
        assert_eq!(clean_for_search("Rich Spirit"), "Rich Spirit");
    }

    #[test]
    fn empty_artist_rejects() {
        assert!(!confirm_match(
            &gap("Rich Spirit", "", 202_000),
            &hit("Rich Spirit", "Kendrick Lamar", 202, None),
        ));
    }
}
