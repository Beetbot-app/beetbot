//! Per-track loudness measurement + cache for the native engine's Normalize.
//!
//! ReplayGain-style: measure each track's integrated loudness (LUFS) and true
//! peak (dBTP) once with `ebur128`, cache the result (persisted as JSON next to
//! the library), and hand it to the FX chain so it can apply a static gain
//! toward the user's loudness target. Measurement is lazy + off-thread: the
//! first play of an un-scanned track plays at unity gain and kicks a background
//! scan; every later play of that track is normalized. Streamed tracks are
//! skipped (no stable path key, and the file isn't necessarily local).

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Max concurrent background loudness measurements. Bounds CPU + memory under a
/// skip-storm (each scan is a full decode + true-peak pass, and a streamed scan
/// also holds a copy of the track's bytes). Excess tracks measure on a later play.
const MAX_INFLIGHT: usize = 2;

/// A track's measured loudness. `lufs` is integrated loudness (ITU-R BS.1770);
/// `peak_db` is the max true peak in dBTP (≤ 0 for un-clipped material).
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Measured {
    pub lufs: f32,
    pub peak_db: f32,
}

/// Loudness cache: a source-path → Measured map, persisted to `path` as JSON.
pub struct LoudnessCache {
    map: Mutex<HashMap<String, Measured>>,
    /// Keys currently reserved for measurement (dedupe + concurrency cap).
    inflight: Mutex<HashSet<String>>,
    /// Serializes file writes so concurrent scanners can't interleave them.
    write_lock: Mutex<()>,
    path: Option<PathBuf>,
}

impl LoudnessCache {
    /// Load from disk (empty if absent / unreadable / no path).
    pub fn load(path: Option<PathBuf>) -> Arc<LoudnessCache> {
        let map = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<HashMap<String, Measured>>(&b).ok())
            .unwrap_or_default();
        Arc::new(LoudnessCache {
            map: Mutex::new(map),
            inflight: Mutex::new(HashSet::new()),
            write_lock: Mutex::new(()),
            path,
        })
    }

    pub fn get(&self, key: &str) -> Option<Measured> {
        self.map.lock().ok()?.get(key).copied()
    }

    /// Reserve a slot to measure `key` on a background thread. Returns false if
    /// it's already cached, already being measured, or the concurrency cap is hit
    /// (it'll get measured on a later play). Every `true` must be paired with a
    /// `release(key)` when the measurement finishes.
    pub fn try_claim(&self, key: &str) -> bool {
        if self.get(key).is_some() {
            return false;
        }
        let mut inflight = match self.inflight.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if inflight.len() >= MAX_INFLIGHT || inflight.contains(key) {
            return false;
        }
        inflight.insert(key.to_string());
        true
    }

    /// Release a slot claimed by `try_claim`.
    pub fn release(&self, key: &str) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.remove(key);
        }
    }

    /// Insert a measurement and persist the whole map (best-effort — a failed
    /// write just means a re-scan next launch). Writers are serialized by
    /// `write_lock` and snapshot the latest map under a brief `map` lock, so the
    /// file write never happens while holding `map` — keeping the hot-path
    /// `get()` (called at track start) off the I/O path.
    pub fn insert_and_save(&self, key: String, m: Measured) {
        if let Ok(mut map) = self.map.lock() {
            map.insert(key, m);
        } else {
            return;
        }
        let _writing = match self.write_lock.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let bytes = match self.map.lock() {
            Ok(map) => serde_json::to_vec(&*map).ok(),
            Err(_) => return,
        };
        if let (Some(path), Some(bytes)) = (&self.path, bytes) {
            let _ = std::fs::write(path, bytes);
        }
    }
}

fn is_audio(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("m4a" | "mp4" | "mp3" | "flac" | "aac" | "wav" | "ogg" | "m4b")
    )
}

/// Background pre-scan: measure every un-cached audio file in `dir` so Normalize
/// is ready on a track's FIRST play instead of only on replay. Throttled (a
/// small sleep between files) so it stays a background citizen, and lazy (skips
/// anything already cached), so repeat launches do almost nothing. Best-effort:
/// only the default library dir is walked; a custom download dir still gets
/// measured lazily on play.
pub fn prescan(dir: PathBuf, cache: Arc<LoudnessCache>) {
    // Let the app settle + any initial playback start before we start decoding.
    std::thread::sleep(Duration::from_secs(5));
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_audio(&path) {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        if cache.get(&key).is_some() {
            continue;
        }
        // The pre-scan is single-threaded + throttled, so it doesn't use the
        // on-demand concurrency cap (it must measure every file, not skip under
        // contention). A rare overlap with an on-demand scan of the same file
        // just measures twice; insert_and_save is idempotent + write-serialized.
        if let Some(m) = measure(&key) {
            cache.insert_and_save(key, m);
        }
        std::thread::sleep(Duration::from_millis(75));
    }
}

/// Measure a local file's integrated loudness + true peak. Decodes the whole
/// track once (in bounded chunks so a long track doesn't balloon memory) and
/// feeds `ebur128`. Returns None if the file can't be decoded or the result
/// isn't finite (e.g. digital silence → -inf LUFS). Runs on a background thread.
pub fn measure(path: &str) -> Option<Measured> {
    let file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    // Byte length + seekable, same as playback — required to decode MP4/M4A.
    let dec = rodio::Decoder::builder()
        .with_data(BufReader::new(file))
        .with_byte_len(len)
        .build()
        .ok()?;
    measure_decoder(dec)
}

/// Measure loudness from in-memory audio bytes (a streamed /live track already
/// fetched into memory). Same as `measure`, but the source is a Cursor.
pub fn measure_bytes(bytes: Vec<u8>) -> Option<Measured> {
    let len = bytes.len() as u64;
    let dec = rodio::Decoder::builder()
        .with_data(Cursor::new(bytes))
        .with_byte_len(len)
        .build()
        .ok()?;
    measure_decoder(dec)
}

/// Feed a decoder through ebur128 → integrated LUFS + max true peak (dBTP).
/// None if the audio can't be measured (e.g. digital silence → -inf LUFS).
fn measure_decoder<S>(dec: S) -> Option<Measured>
where
    S: rodio::Source + Iterator<Item = f32>,
{
    let channels = rodio::Source::channels(&dec).get() as u32;
    let rate = rodio::Source::sample_rate(&dec).get();
    if channels == 0 || rate == 0 {
        return None;
    }
    let mut ebu =
        ebur128::EbuR128::new(channels, rate, ebur128::Mode::I | ebur128::Mode::TRUE_PEAK).ok()?;
    let ch = channels as usize;
    let chunk = 8192 * ch;
    let mut buf: Vec<f32> = Vec::with_capacity(chunk);
    for s in dec {
        buf.push(s);
        if buf.len() >= chunk {
            if ebu.add_frames_f32(&buf).is_err() {
                return None;
            }
            buf.clear();
        }
    }
    // Feed the frame-aligned remainder (guard against a truncated final frame).
    let n = buf.len() - (buf.len() % ch);
    if n > 0 {
        let _ = ebu.add_frames_f32(&buf[..n]);
    }
    let lufs = ebu.loudness_global().ok()? as f32;
    if !lufs.is_finite() {
        return None;
    }
    let mut peak_lin = 0.0f64;
    for c in 0..channels {
        if let Ok(p) = ebu.true_peak(c) {
            if p > peak_lin {
                peak_lin = p;
            }
        }
    }
    let peak_db = if peak_lin > 0.0 {
        (20.0 * peak_lin.log10()) as f32
    } else {
        -120.0
    };
    Some(Measured { lufs, peak_db })
}
