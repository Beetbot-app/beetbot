//! Phase 4 discovery (Signal 2: "sounds-like"). Extracts a compact audio feature
//! vector from each DOWNLOADED file via a numpy/scipy sidecar (audio_features.py,
//! which decodes through ffmpeg) and finds sonically-similar local tracks by
//! z-score-normalised feature distance. Strictly library-internal: we can only
//! analyse files we actually hold, so "sounds like" surfaces other DOWNLOADED
//! tracks — complementary to the metadata signals (tags, co-occurrence).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// The numpy/scipy extractor, shipped inside the binary and written to a cache
/// file at runtime — same `include_str!` trick as the SQL migrations, so there's
/// no separate bundling step.
const EXTRACTOR_PY: &str = include_str!("audio_features.py");

/// Bump when audio_features.py's vector layout changes so stored rows re-extract.
pub const FEATURES_VERSION: i64 = 1;

/// Files analysed per python invocation — amortises the ~1s numpy/scipy import.
const BATCH: usize = 24;

/// Feature-vector dimensionality: 7 scalars + 13 MFCC means + 12 chroma means.
const VEC_DIM: usize = 7 + 13 + 12;

#[derive(Deserialize)]
struct ExtractorLine {
    path: String,
    ok: bool,
    #[serde(default)]
    features: Option<Features>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Features {
    tempo: f64,
    rms: f64,
    zcr: f64,
    centroid: f64,
    bandwidth: f64,
    rolloff: f64,
    flatness: f64,
    mfcc: Vec<f64>,
    chroma: Vec<f64>,
}

fn python3_candidates() -> Vec<PathBuf> {
    // macOS GUI apps inherit a minimal PATH (same problem ffmpeg_path solves), and
    // Apple's /usr/bin/python3 usually lacks numpy/scipy — so list the common
    // Homebrew / python.org locations first, then PATH, then the system one last.
    let mut c = vec![
        PathBuf::from("/opt/homebrew/bin/python3"),
        PathBuf::from("/usr/local/bin/python3"),
        PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin/python3"),
    ];
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            c.push(dir.join("python3"));
        }
    }
    c.push(PathBuf::from("/usr/bin/python3"));
    c
}

/// First python3 on the system that can import numpy + scipy.fft (the extractor's
/// only deps). `None` ⇒ no suitable interpreter, so Signal 2 stays dormant and the
/// rest of discovery is unaffected.
pub fn usable_python3() -> Option<PathBuf> {
    for cand in python3_candidates() {
        if !cand.is_file() {
            continue;
        }
        let ok = std::process::Command::new(&cand)
            .args(["-c", "import numpy, scipy.fft"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Some(cand);
        }
    }
    None
}

fn write_extractor() -> Option<PathBuf> {
    let p = std::env::temp_dir().join(format!("beetbot-audio_features-v{FEATURES_VERSION}.py"));
    std::fs::write(&p, EXTRACTOR_PY).ok()?;
    Some(p)
}

fn select_pending(conn: &Connection, limit: usize) -> Vec<(i64, String)> {
    conn.prepare(
        "SELECT t.id, t.local_path FROM tracks t
         WHERE t.local_path IS NOT NULL AND t.local_path <> ''
           AND t.id NOT IN (SELECT track_id FROM track_features WHERE version = ?1)
           AND t.id NOT IN (SELECT track_id FROM track_features_failed)
         LIMIT ?2",
    )
    .and_then(|mut s| {
        s.query_map(params![FEATURES_VERSION, limit as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map(|rows| rows.filter_map(|x| x.ok()).collect())
    })
    .unwrap_or_default()
}

fn mark_failed(conn: &Connection, track_id: i64, reason: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO track_features_failed (track_id, reason) VALUES (?1, ?2)",
        params![track_id, reason],
    );
}

fn store_features(conn: &Connection, track_id: i64, f: &Features, raw: &str) {
    let _ = conn.execute(
        "INSERT INTO track_features
            (track_id, version, tempo, rms, zcr, centroid, bandwidth, rolloff, flatness, features)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(track_id) DO UPDATE SET
            version=excluded.version, tempo=excluded.tempo, rms=excluded.rms, zcr=excluded.zcr,
            centroid=excluded.centroid, bandwidth=excluded.bandwidth, rolloff=excluded.rolloff,
            flatness=excluded.flatness, features=excluded.features,
            extracted_at=strftime('%s','now')",
        params![
            track_id, FEATURES_VERSION, f.tempo, f.rms, f.zcr, f.centroid, f.bandwidth,
            f.rolloff, f.flatness, raw
        ],
    );
    // A previously-failed file that now succeeds should leave the failed set.
    let _ = conn.execute(
        "DELETE FROM track_features_failed WHERE track_id = ?1",
        params![track_id],
    );
}

/// Background sweep: extract audio features for every downloaded track that lacks
/// them, a batch at a time, pausing between batches so we never peg the CPU. Runs
/// once at startup and exits when the library is fully analysed. Idempotent and
/// resumable — each selected track ends with either a feature row or a failed row,
/// so the pending set strictly shrinks and the loop always terminates.
pub async fn run_audio_enrich(db: Arc<Mutex<Connection>>) {
    let Some(python) = usable_python3() else {
        tracing::info!("audio-enrich: no python3 with numpy+scipy; Signal 2 dormant");
        return;
    };
    let Some(ffmpeg) = crate::library::ffmpeg::ffmpeg_path() else {
        tracing::info!("audio-enrich: ffmpeg not found; Signal 2 dormant");
        return;
    };
    let Some(script) = write_extractor() else {
        tracing::warn!("audio-enrich: could not write extractor script");
        return;
    };
    let mut analysed = 0usize;
    loop {
        let batch = {
            let conn = db.lock().expect("db mutex poisoned");
            select_pending(&conn, BATCH)
        };
        if batch.is_empty() {
            break;
        }
        // Files present on disk get analysed; missing ones are marked failed now
        // so they're not re-selected forever.
        let mut present: Vec<(i64, String)> = Vec::new();
        {
            let conn = db.lock().expect("db mutex poisoned");
            for (id, path) in batch {
                if Path::new(&path).is_file() {
                    present.push((id, path));
                } else {
                    mark_failed(&conn, id, "file missing on disk");
                }
            }
        }
        if present.is_empty() {
            continue;
        }
        let by_path: HashMap<String, i64> =
            present.iter().map(|(i, p)| (p.clone(), *i)).collect();
        let mut cmd = tokio::process::Command::new(&python);
        cmd.arg(&script).arg(&ffmpeg);
        for (_, p) in &present {
            cmd.arg(p);
        }
        let output = match cmd.output().await {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(?e, "audio-enrich: extractor failed to launch; stopping");
                return;
            }
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let unreported: usize;
        {
            let conn = db.lock().expect("db mutex poisoned");
            let mut handled: std::collections::HashSet<i64> = std::collections::HashSet::new();
            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(rec) = serde_json::from_str::<ExtractorLine>(line) else {
                    continue;
                };
                let Some(&id) = by_path.get(&rec.path) else {
                    continue;
                };
                handled.insert(id);
                match (rec.ok, rec.features) {
                    (true, Some(f)) => {
                        let raw = serde_json::to_string(&f).unwrap_or_default();
                        store_features(&conn, id, &f, &raw);
                        analysed += 1;
                    }
                    _ => mark_failed(
                        &conn,
                        id,
                        rec.error.as_deref().unwrap_or("extract failed"),
                    ),
                }
            }
            // GUARANTEE PROGRESS: any present file the extractor didn't report a
            // line for (e.g. a hard crash / kill mid-batch, or truncated stdout)
            // is marked failed so it can't be re-selected forever — without this
            // the sweep could livelock on one pathological file.
            for (id, _) in &present {
                if !handled.contains(id) {
                    mark_failed(&conn, *id, "no extractor output");
                }
            }
            unreported = present.len() - handled.len();
        }
        // Surface a non-zero exit or any files the extractor didn't report on
        // (they're marked failed above) — logging the status + stderr tail turns an
        // otherwise-invisible batch problem into a debuggable event.
        if !output.status.success() || unreported > 0 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!(
                status = ?output.status,
                unreported,
                stderr = %stderr.trim(),
                "audio-enrich: batch incomplete or extractor exited non-zero"
            );
        }
        // Be gentle on the CPU between batches.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    tracing::info!(analysed, "audio-enrich: sweep complete");
}

fn parse_vector(features_json: &str) -> Option<Vec<f64>> {
    let f: Features = serde_json::from_str(features_json).ok()?;
    if f.mfcc.len() < 13 || f.chroma.len() < 12 {
        return None;
    }
    let mut v = Vec::with_capacity(VEC_DIM);
    v.extend_from_slice(&[
        f.tempo, f.rms, f.zcr, f.centroid, f.bandwidth, f.rolloff, f.flatness,
    ]);
    v.extend_from_slice(&f.mfcc[..13]);
    v.extend_from_slice(&f.chroma[..12]);
    Some(v)
}

/// Library-internal "sounds-like": the `limit` DOWNLOADED tracks whose audio
/// feature vector is closest to `seed`'s, by z-score-normalised Euclidean distance
/// across the analysed library (so every dimension contributes comparably). Returns
/// track ids nearest-first, excluding the seed. Empty when the seed has no features
/// or fewer than 2 tracks are analysed. Caller holds the connection (no re-lock).
/// Per-dimension mean + population std over `vecs` (the z-score basis). Std is
/// floored to 1.0 so a zero-variance dimension never divides by zero. Pure +
/// free (extracted from `audio_similar_ids`) so the math is unit-testable.
fn feature_basis(vecs: &[Vec<f64>], dim: usize) -> (Vec<f64>, Vec<f64>) {
    let n = vecs.len().max(1) as f64;
    let mut mean = vec![0.0f64; dim];
    for v in vecs {
        for d in 0..dim {
            mean[d] += v[d];
        }
    }
    for m in &mut mean {
        *m /= n;
    }
    let mut std = vec![0.0f64; dim];
    for v in vecs {
        for d in 0..dim {
            let e = v[d] - mean[d];
            std[d] += e * e;
        }
    }
    for s in &mut std {
        *s = (*s / n).sqrt();
        if *s == 0.0 {
            *s = 1.0;
        }
    }
    (mean, std)
}

/// Squared Euclidean distance between two raw feature vectors in z-scored space
/// (each dimension shifted by `mean`, scaled by `std`). 0 for identical vectors;
/// larger = less similar.
fn z_sq_distance(a: &[f64], b: &[f64], mean: &[f64], std: &[f64], dim: usize) -> f64 {
    let mut d2 = 0.0;
    for d in 0..dim {
        let za = (a[d] - mean[d]) / std[d];
        let zb = (b[d] - mean[d]) / std[d];
        let e = za - zb;
        d2 += e * e;
    }
    d2
}

pub fn audio_similar_ids(conn: &Connection, seed: i64, limit: usize) -> Vec<i64> {
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT track_id, features FROM track_features WHERE version = ?1")
        .and_then(|mut s| {
            s.query_map(params![FEATURES_VERSION], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    let mut ids: Vec<i64> = Vec::with_capacity(rows.len());
    let mut vecs: Vec<Vec<f64>> = Vec::with_capacity(rows.len());
    for (id, json) in rows {
        if let Some(v) = parse_vector(&json) {
            ids.push(id);
            vecs.push(v);
        }
    }
    let n = vecs.len();
    if n < 2 {
        return Vec::new();
    }
    let Some(seed_idx) = ids.iter().position(|&i| i == seed) else {
        return Vec::new();
    };
    // Z-score against a basis computed over the whole (downloaded) library, then
    // rank by squared z-distance. NOTE (imp 10): this stays LIBRARY-INTERNAL by
    // design (Option A) — neighbours are your OWN downloaded tracks, surfaced
    // honestly as "Because you played X" (the seed rotates daily, P2). Extending
    // it to unowned CATALOG tracks (Option B: features from Deezer previews + a
    // frozen/stored basis so distances stay comparable run-to-run) is a scoped
    // follow-up, not this pass.
    let dim = VEC_DIM;
    let (mean, std) = feature_basis(&vecs, dim);
    let mut scored: Vec<(i64, f64)> = Vec::with_capacity(n.saturating_sub(1));
    for (i, v) in vecs.iter().enumerate() {
        if i == seed_idx {
            continue;
        }
        let d2 = z_sq_distance(&vecs[seed_idx], v, &mean, &std, dim);
        scored.push((ids[i], d2));
    }
    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).map(|(id, _)| id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec_dim_is_32() {
        assert_eq!(VEC_DIM, 32);
    }

    #[test]
    fn z_distance_zero_for_identical() {
        let vecs = vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]];
        let (mean, std) = feature_basis(&vecs, 3);
        let a = vec![1.0, 2.0, 3.0];
        assert!(z_sq_distance(&a, &a, &mean, &std, 3).abs() < 1e-12);
    }

    #[test]
    fn z_distance_is_monotonic() {
        let vecs = vec![vec![0.0, 0.0], vec![10.0, 10.0], vec![5.0, 5.0]];
        let (mean, std) = feature_basis(&vecs, 2);
        let seed = [0.0, 0.0];
        let near = [1.0, 1.0];
        let far = [9.0, 9.0];
        assert!(
            z_sq_distance(&seed, &near, &mean, &std, 2)
                < z_sq_distance(&seed, &far, &mean, &std, 2),
            "a nearer vector must have a smaller z-distance"
        );
    }

    #[test]
    fn constant_dimension_floors_std_and_stays_finite() {
        // Dimension 0 has zero variance (all 5.0) → std floored to 1.0, no NaN/inf.
        let vecs = vec![vec![5.0, 1.0], vec![5.0, 9.0]];
        let (mean, std) = feature_basis(&vecs, 2);
        assert_eq!(std[0], 1.0, "zero-variance dim floored to 1.0");
        let d = z_sq_distance(&vecs[0], &vecs[1], &mean, &std, 2);
        assert!(d.is_finite() && d > 0.0);
    }
}
