//! Phase 1 discovery (Signal 3): rich per-artist Last.fm tags for "more like
//! this vibe" similarity. Tags live in `artist_tags`, keyed by a normalized
//! primary-artist name, and are kept SEPARATE from the coarse `tracks.genre`
//! bucket (which the Deezer backfill already fills well).
//!
//! - [`run_tag_enrich`] sweeps the library, fetching Last.fm top tags once per
//!   distinct primary artist (rate-limited), recording every artist it looks up
//!   so it is incremental across runs.
//! - [`tag_similar_artists`] ranks the user's OWN library artists by how
//!   strongly their tags overlap a seed artist's — blended into radio so it
//!   reflects the user's vibe graph and works even when ListenBrainz has nothing
//!   for a seed.

use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Stable key for an artist name: trimmed, whitespace-collapsed, lowercased.
/// Truncates at the first ';' first — legacy CSV imports stored multi-artist
/// strings as one element ("Aminé;Leon Thomas"), and keying on the PRIMARY
/// artist makes the Library's album/artist grouping (this fn is the registered
/// `artist_key()` SQL scalar) merge those rows with the artist's own, instead
/// of growing fake "A;B" artists and duplicate albums.
pub fn artist_key(name: &str) -> String {
    let primary = name.split(';').next().unwrap_or(name);
    primary.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Primary (first) artist from a stored `artists` JSON array string
/// (e.g. `["James Blake"]`).
fn primary_artist(artists_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(artists_json).ok()?;
    let first = v.as_array()?.first()?.as_str()?.trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

/// Distinct primary artists in the library that haven't been tag-fetched yet.
fn artists_needing_tags(conn: &Connection) -> Vec<String> {
    let fetched: HashSet<String> = match conn.prepare("SELECT artist_key FROM artist_tags_fetched") {
        Ok(mut stmt) => stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map(|it| it.flatten().collect())
            .unwrap_or_default(),
        Err(_) => HashSet::new(),
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let Ok(mut stmt) = conn.prepare("SELECT artists FROM tracks WHERE artists IS NOT NULL") else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return out;
    };
    for aj in rows.flatten() {
        if let Some(name) = primary_artist(&aj) {
            let key = artist_key(&name);
            if !fetched.contains(&key) && seen.insert(key) {
                out.push(name);
            }
        }
    }
    out
}

/// Sweep the library, fetching Last.fm top tags once per not-yet-fetched
/// artist. Rate-limited to ~4 req/s (well under Last.fm's limit). Best-effort;
/// records every artist looked up (even tag-less ones) so it never repeats and
/// is cheap on later runs.
pub async fn run_tag_enrich(db: Arc<Mutex<Connection>>, api_key: String) {
    let artists = {
        let conn = db.lock().expect("db mutex poisoned");
        artists_needing_tags(&conn)
    };
    if artists.is_empty() {
        return;
    }
    tracing::info!(count = artists.len(), "tag-enrich: fetching Last.fm artist tags");
    for name in artists {
        let tags = crate::charts::lastfm_artist_top_tags(&api_key, &name, 8).await;
        let key = artist_key(&name);
        {
            let conn = db.lock().expect("db mutex poisoned");
            for (tag, weight) in &tags {
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO artist_tags (artist_key, tag, weight) VALUES (?1, ?2, ?3)",
                    rusqlite::params![key, tag, weight],
                );
            }
            let _ = conn.execute(
                "INSERT OR REPLACE INTO artist_tags_fetched (artist_key, artist_name, fetched_at)
                 VALUES (?1, ?2, strftime('%s','now'))",
                rusqlite::params![key, name],
            );
        }
        // Stay polite to Last.fm (~4 req/s).
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    tracing::info!("tag-enrich: done");
}

/// Library artists whose Last.fm tags overlap the seed's, ranked by weighted
/// overlap (seed_weight × candidate_weight, summed over shared tags). Returns
/// display names for blending into radio. Empty when the seed hasn't been
/// enriched yet (so it degrades gracefully to the existing ListenBrainz graph).
pub fn tag_similar_artists(db: &Arc<Mutex<Connection>>, seed_artist: &str, limit: usize) -> Vec<String> {
    let conn = db.lock().expect("db mutex poisoned");
    let seed_key = artist_key(seed_artist);

    // The seed's own tag weights.
    let seed_w: HashMap<String, i64> = match conn
        .prepare("SELECT tag, weight FROM artist_tags WHERE artist_key = ?1")
    {
        Ok(mut stmt) => stmt
            .query_map(rusqlite::params![seed_key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map(|it| it.flatten().collect())
            .unwrap_or_default(),
        Err(_) => return Vec::new(),
    };
    if seed_w.is_empty() {
        return Vec::new();
    }

    // Candidate artists sharing any of those tags, scored by weighted overlap.
    let tag_keys: Vec<String> = seed_w.keys().cloned().collect();
    let placeholders = std::iter::repeat("?").take(tag_keys.len()).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT artist_key, tag, weight FROM artist_tags WHERE tag IN ({placeholders})");
    let mut score: HashMap<String, i64> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(&sql) {
        if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(tag_keys.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        }) {
            for (ak, tag, w) in rows.flatten() {
                if ak == seed_key {
                    continue;
                }
                let sw = seed_w.get(&tag).copied().unwrap_or(0);
                *score.entry(ak).or_insert(0) += sw * w;
            }
        }
    }
    if score.is_empty() {
        return Vec::new();
    }

    let mut ranked: Vec<(String, i64)> = score.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.truncate(limit);

    // Map normalized keys back to display names.
    ranked
        .into_iter()
        .filter_map(|(k, _)| {
            conn.query_row(
                "SELECT artist_name FROM artist_tags_fetched WHERE artist_key = ?1",
                rusqlite::params![k],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
        .collect()
}
