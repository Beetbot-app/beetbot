//! Phase 2 discovery (Signal 1): similarity from the user's OWN data, via
//! PLAYLIST CO-OCCURRENCE. Artists whose tracks the user repeatedly groups into
//! the same playlists as a seed artist are treated as similar — Spotify's
//! "playlists as documents, songs as words" trick, applied to the local library.
//!
//! Big "everything" playlists are down-weighted (1/size) so a focused 30-track
//! playlist counts far more than a 400-track dump. Reads existing tables only
//! (no schema change); the primary artist is the first element of the `artists`
//! JSON array via SQLite's json1.

use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// Library artist names that co-occur with `seed_artist` across the user's
/// playlists, ranked by size-weighted co-occurrence. Returns display names (with
/// original casing) for blending into radio. Empty when the seed isn't in any
/// playlist.
pub fn playlist_cooccur_artists(
    db: &Arc<Mutex<Connection>>,
    seed_artist: &str,
    limit: usize,
) -> Vec<String> {
    let conn = db.lock().expect("db mutex poisoned");
    let seed_key = crate::tags::artist_key(seed_artist);
    // Normalization is done with the `artist_key` SQL scalar function (registered in
    // db::open) so both the seed bind (?1 = artist_key(seed) below) and every table-side
    // comparison use IDENTICAL Unicode-aware keying — see db/mod.rs for why inline
    // lower(trim(...)) silently dropped names like "ROSALÍA". Playlist size counts
    // DISTINCT tracks, and the candidate set is deduped on (playlist_id, track_id) so a
    // track listed twice in one playlist can't double-count toward an artist's score.
    let sql = "\
        WITH seed_tracks AS (\
            SELECT id FROM tracks \
            WHERE artists IS NOT NULL \
              AND artist_key(json_extract(artists, '$[0]')) = ?1\
        ),\
        pl_sizes AS (\
            SELECT playlist_id, COUNT(DISTINCT track_id) AS sz \
            FROM playlist_tracks GROUP BY playlist_id\
        ),\
        seed_playlists AS (\
            SELECT DISTINCT pt.playlist_id, s.sz \
            FROM playlist_tracks pt JOIN pl_sizes s ON s.playlist_id = pt.playlist_id \
            WHERE pt.track_id IN (SELECT id FROM seed_tracks)\
        ),\
        candidates AS (\
            SELECT DISTINCT pt2.playlist_id, pt2.track_id \
            FROM playlist_tracks pt2 \
            JOIN seed_playlists sp ON sp.playlist_id = pt2.playlist_id\
        )\
        SELECT json_extract(t.artists, '$[0]') AS name, SUM(1.0 / sp.sz) AS score \
        FROM candidates c \
        JOIN seed_playlists sp ON sp.playlist_id = c.playlist_id \
        JOIN tracks t ON t.id = c.track_id \
        WHERE t.artists IS NOT NULL \
          AND artist_key(json_extract(t.artists, '$[0]')) <> ?1 \
        GROUP BY artist_key(json_extract(t.artists, '$[0]')) \
        ORDER BY score DESC \
        LIMIT ?2";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let names = match stmt.query_map(rusqlite::params![seed_key, limit as i64], |r| {
        r.get::<_, Option<String>>(0)
    }) {
        Ok(it) => it.flatten().flatten().collect(),
        Err(_) => Vec::new(),
    };
    names
}
