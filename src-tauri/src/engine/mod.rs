//! Native audio engine.
//!
//! Replaces what the two webview `<audio>` elements did: load a path/URL,
//! play/pause/seek/volume, position ticks, and ended/error signals — but
//! decoding + output happen natively (rodio + symphonia → CoreAudio) instead of
//! through WebKit's Web Audio, which is where the EQ/Normalize/Mono effects
//! broke (see `src/lib/audiofx.ts`). Handles both downloaded files and streamed
//! `/live` tracks (fetched fully into memory over loopback — seekable).
//!
//! Threading: rodio's output stream (a cpal `Stream`) is `!Send`, so ALL audio
//! objects (the sink, the mixer, the current `Player`) live on one dedicated
//! engine thread. The frontend talks to it through a command channel; the
//! current position/duration are mirrored into atomics so the sync
//! `engine_position` getter (used for the queue-handoff snapshot) never has to
//! round-trip. Events (tick / ended / advanced / error) are emitted to the JS.
//!
//! Built out over the surrounding module: crossfade + preload (`deck_b`), the
//! EQ/Normalize/mono DSP (`fx`) + per-track loudness (`loudness`), repeat-one
//! looping, and an output-device supervisor that rebuilds the sink when the
//! default output changes. The frontend uses it only when the "Native audio
//! engine (beta)" flag is on; everything else falls back to the webview player.

use std::io::{BufReader, Cursor, Read, Seek};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rodio::cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

mod fx;
mod loudness;
use fx::{FxChain, FxShared};
use loudness::{measure, measure_bytes, LoudnessCache};

/// Position-tick cadence. Matches the ~4 Hz the webview `onTimeUpdate` drove, so
/// play-logging (logPlay / ms_played) behaves identically.
const TICK: Duration = Duration::from_millis(250);

/// Commands the frontend sends to the engine thread. One writer (the store's
/// intent), the engine obeys — the same single-writer rule the element driver
/// followed.
enum EngineCmd {
    /// Load a source and begin playing (or paused, per `playing`), seeking to
    /// `start_at` seconds first. `source` is either a local filesystem path or
    /// an http:// URL (streamed tracks; fetched fully into memory, seekable).
    /// `duration_ms` is the catalog length for the tick payload.
    Load {
        source: String,
        duration_ms: u64,
        start_at: f64,
        playing: bool,
    },
    Play,
    Pause,
    Seek(f64),
    SetVolume(f32),
    /// Stop + release the current track (profile switch / cast handoff).
    Stop,
    /// Crossfade duration in seconds (0 = off).
    SetCrossfade(f64),
    /// Repeat-one on/off — the engine loops the current track when it ends.
    SetRepeatOne(bool),
    /// Preload the next track into deck B (paused, silent) for a gapless
    /// crossfade near the end of the current track. Replaces any existing
    /// preloaded deck.
    PreloadNext { source: String, duration_ms: u64 },
    Shutdown,
}

/// Shared handle stored in Tauri state (Send + Sync). Holds the command sender
/// plus the live position/duration atomics for the sync getter.
pub struct AudioEngine {
    tx: Sender<EngineCmd>,
    position_ms: Arc<AtomicU64>,
    fx: Arc<FxShared>,
}

#[derive(Serialize, Clone)]
struct TickPayload {
    position: f64,
    duration: f64,
}

#[derive(Serialize, Clone)]
struct EndedPayload {
    completed: bool,
}

#[derive(Serialize, Clone)]
struct ErrorPayload {
    message: String,
}

#[derive(Serialize, Clone)]
struct BufferingPayload {
    active: bool,
}

#[derive(Serialize, Clone)]
struct AdvancedPayload {
    position: f64,
}

/// In-flight crossfade: ramp deck A → 0 and deck B → target over `dur`.
struct Crossfade {
    started: Instant,
    dur: Duration,
    target_vol: f32,
}

impl AudioEngine {
    /// Spawn the engine thread and return the state handle. Never fails the app:
    /// if the output device can't be opened the thread logs and still accepts
    /// commands (silent), so playback simply produces nothing until a device
    /// is available — the UI keeps working.
    pub fn spawn(app: AppHandle) -> AudioEngine {
        let (tx, rx) = std::sync::mpsc::channel::<EngineCmd>();
        let position_ms = Arc::new(AtomicU64::new(0));
        let duration_ms = Arc::new(AtomicU64::new(0));
        let fx = Arc::new(FxShared::new());
        let pos_for_thread = position_ms.clone();
        let fx_for_thread = fx.clone();
        // Loudness cache persisted next to the library data.
        let cache_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("loudness_cache.json"));
        let loudness = LoudnessCache::load(cache_path);
        // Pre-scan the downloaded library in the background so Normalize is ready
        // on first play, not just on replay (best-effort, default library dir).
        if let Ok(data_dir) = app.path().app_data_dir() {
            let dir = data_dir.join("library");
            let cache = loudness.clone();
            std::thread::Builder::new()
                .name("beetbot-loudness-prescan".into())
                .spawn(move || loudness::prescan(dir, cache))
                .ok();
        }
        std::thread::Builder::new()
            .name("beetbot-audio".into())
            .spawn(move || engine_thread(app, rx, pos_for_thread, duration_ms, fx_for_thread, loudness))
            .expect("spawn audio engine thread");
        AudioEngine {
            tx,
            position_ms,
            fx,
        }
    }

    fn send(&self, cmd: EngineCmd) {
        // A dropped receiver only happens on shutdown; ignore.
        let _ = self.tx.send(cmd);
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.tx.send(EngineCmd::Shutdown);
    }
}

/// The engine thread. Owns every audio object (all `!Send`). Blocks on the
/// command channel with a TICK timeout; each timeout emits a position tick and
/// checks for end-of-track.
fn engine_thread(
    app: AppHandle,
    rx: Receiver<EngineCmd>,
    position_ms: Arc<AtomicU64>,
    duration_ms: Arc<AtomicU64>,
    fx: Arc<FxShared>,
    loudness: Arc<LoudnessCache>,
) {
    // Open the default output; keep the sink alive for the whole thread (it owns
    // the CoreAudio stream). The sink is rebuilt in place by the device
    // supervisor (below) when the output device changes, so it's `mut` and the
    // mixer is fetched fresh (`sink.mixer()`) at each use rather than held.
    let output_dead = Arc::new(AtomicBool::new(false));
    let mut sink = match open_output(&output_dead) {
        Some(s) => s,
        None => {
            tracing::error!("audio engine: no output device; running silent");
            // Still drain commands so senders don't block, but produce no audio.
            drain_silently(&rx);
            return;
        }
    };
    let mut current_device_name = default_output_name();
    // The current + preloaded source strings, kept so the supervisor can
    // re-create the players on a new device at their current position.
    let mut current_source: Option<String> = None;
    let mut current_dur: u64 = 0;
    let mut next_source: Option<String> = None;
    let mut tick_count: u64 = 0;

    let mut player: Option<rodio::Player> = None;
    let mut volume: f32 = 1.0;
    let mut playing = false;
    // True while a loaded track is expected to be producing sound — used to
    // distinguish "ended" (queue drained) from "never loaded".
    let mut has_track = false;
    // Skip end-detection on the first tick after a load, before the source is
    // guaranteed to have been pulled (avoids a spurious immediate "ended").
    let mut just_loaded = false;
    // Crossfade: deck B is the preloaded next track; `crossfading` is the
    // in-flight ramp; `crossfade_secs` is the configured duration.
    let mut deck_b: Option<rodio::Player> = None;
    let mut next_dur: u64 = 0;
    let mut crossfade_secs: f64 = 0.0;
    let mut crossfading: Option<Crossfade> = None;
    // Repeat-one: loop the current track natively (the frontend can't reload it
    // via a track-id change since the id doesn't change).
    let mut repeat_one = false;

    // Finer tick while a crossfade ramp is running, for a smooth fade.
    const CROSSFADE_STEP: Duration = Duration::from_millis(60);
    loop {
        let timeout = if crossfading.is_some() { CROSSFADE_STEP } else { TICK };
        match rx.recv_timeout(timeout) {
            Ok(EngineCmd::Load {
                source,
                duration_ms: dur,
                start_at,
                playing: want_play,
            }) => {
                if let Some(p) = player.take() {
                    p.stop();
                }
                // A direct load cancels any pending preload / crossfade.
                if let Some(b) = deck_b.take() {
                    b.stop();
                }
                next_source = None;
                crossfading = None;
                let new_player: Option<rodio::Player> = if source.starts_with("http") {
                    // Streamed track: fetch the (complete, range-served) file
                    // fully into memory over loopback — seekable + reliable.
                    // The engine thread blocks during the fetch; buffering event
                    // covers the wait. fetch_stream also resolves Normalize.
                    let _ = app.emit("engine://buffering", BufferingPayload { active: true });
                    let result = fetch_stream(&source, &loudness).and_then(|(bytes, n, lufs, peak)| {
                        make_player(sink.mixer(), Cursor::new(bytes), n, volume, start_at, want_play, &fx, lufs, peak)
                    });
                    let _ = app.emit("engine://buffering", BufferingPayload { active: false });
                    match result {
                        Ok(p) => Some(p),
                        Err(e) => {
                            emit_error(&app, format!("stream: {e}"));
                            None
                        }
                    }
                } else {
                    let (t_lufs, t_peak) = norm_for(&source, &loudness);
                    match std::fs::File::open(&source) {
                        Ok(file) => match make_player(sink.mixer(), BufReader::new(file), file_len(&source), volume, start_at, want_play, &fx, t_lufs, t_peak) {
                            Ok(p) => Some(p),
                            Err(e) => {
                                emit_error(&app, format!("decode: {e}"));
                                None
                            }
                        },
                        Err(e) => {
                            emit_error(&app, format!("open {source}: {e}"));
                            None
                        }
                    }
                };
                if let Some(p) = new_player {
                    playing = want_play;
                    has_track = true;
                    just_loaded = true;
                    duration_ms.store(dur, Ordering::Relaxed);
                    position_ms.store((start_at.max(0.0) * 1000.0) as u64, Ordering::Relaxed);
                    player = Some(p);
                    current_source = Some(source);
                    current_dur = dur;
                }
            }
            Ok(EngineCmd::Play) => {
                playing = true;
                if let Some(p) = &player {
                    p.play();
                }
            }
            Ok(EngineCmd::Pause) => {
                playing = false;
                if let Some(p) = &player {
                    p.pause();
                }
            }
            Ok(EngineCmd::Seek(secs)) => {
                if let Some(p) = &player {
                    let _ = p.try_seek(Duration::from_secs_f64(secs.max(0.0)));
                    position_ms.store((secs.max(0.0) * 1000.0) as u64, Ordering::Relaxed);
                }
            }
            Ok(EngineCmd::SetVolume(v)) => {
                volume = v.clamp(0.0, 1.0);
                // Don't fight an in-flight crossfade ramp; it reasserts `volume`
                // on the promoted deck when it finishes.
                if crossfading.is_none() {
                    if let Some(p) = &player {
                        p.set_volume(volume);
                    }
                }
            }
            Ok(EngineCmd::Stop) => {
                if let Some(p) = player.take() {
                    p.stop();
                }
                if let Some(b) = deck_b.take() {
                    b.stop();
                }
                crossfading = None;
                playing = false;
                has_track = false;
                current_source = None;
                next_source = None;
                position_ms.store(0, Ordering::Relaxed);
            }
            Ok(EngineCmd::SetCrossfade(secs)) => {
                crossfade_secs = secs.max(0.0);
            }
            Ok(EngineCmd::SetRepeatOne(v)) => {
                repeat_one = v;
            }
            Ok(EngineCmd::PreloadNext {
                source,
                duration_ms: nd,
            }) => {
                if let Some(b) = deck_b.take() {
                    b.stop();
                }
                // Build deck B paused + silent (prerolled). A streamed source
                // blocks the thread briefly here, but the active deck keeps
                // playing off its own already-loaded buffer.
                let built = if source.starts_with("http") {
                    fetch_stream(&source, &loudness).and_then(|(bytes, n, lufs, peak)| {
                        make_player(sink.mixer(), Cursor::new(bytes), n, 0.0, 0.0, false, &fx, lufs, peak)
                    })
                } else {
                    let (t_lufs, t_peak) = norm_for(&source, &loudness);
                    std::fs::File::open(&source)
                        .map_err(|e| e.to_string())
                        .and_then(|f| make_player(sink.mixer(), BufReader::new(f), file_len(&source), 0.0, 0.0, false, &fx, t_lufs, t_peak))
                };
                match built {
                    Ok(b) => {
                        deck_b = Some(b);
                        next_dur = nd;
                        next_source = Some(source);
                    }
                    Err(e) => emit_error(&app, format!("preload: {e}")),
                }
            }
            Ok(EngineCmd::Shutdown) => break,
            Err(RecvTimeoutError::Timeout) => {
                // Device supervisor: rebuild the output when the stream died
                // (error callback flag) or the default output device changed
                // (polled ~every 2 s), then re-create the current track on the
                // new device at its position. This keeps native playback
                // following headphone / AirPods / output-device switches —
                // rodio's one-shot default stream wouldn't otherwise move.
                tick_count = tick_count.wrapping_add(1);
                let mut needs_rebuild = output_dead.load(Ordering::Relaxed);
                if !needs_rebuild && tick_count % 8 == 0 {
                    if let (Some(now), Some(cur)) =
                        (default_output_name(), current_device_name.as_deref())
                    {
                        if now != cur {
                            needs_rebuild = true;
                        }
                    }
                }
                if needs_rebuild {
                    let pos = position_ms.load(Ordering::Relaxed) as f64 / 1000.0;
                    let was_playing = playing;
                    let src = current_source.clone();
                    let dur = current_dur;
                    if let Some(a) = player.take() {
                        a.stop();
                    }
                    if let Some(b) = deck_b.take() {
                        b.stop();
                    }
                    crossfading = None;
                    next_source = None;
                    match open_output(&output_dead) {
                        Some(s) => {
                            sink = s;
                            output_dead.store(false, Ordering::Relaxed);
                            current_device_name = default_output_name();
                            if let Some(source) = src {
                                let rebuilt = if source.starts_with("http") {
                                    fetch_stream(&source, &loudness).and_then(|(b, n, l, pk)| {
                                        make_player(sink.mixer(), Cursor::new(b), n, volume, pos, was_playing, &fx, l, pk)
                                    })
                                } else {
                                    let (l, pk) = norm_for(&source, &loudness);
                                    std::fs::File::open(&source).map_err(|e| e.to_string()).and_then(|f| {
                                        make_player(sink.mixer(), BufReader::new(f), file_len(&source), volume, pos, was_playing, &fx, l, pk)
                                    })
                                };
                                match rebuilt {
                                    Ok(p) => {
                                        has_track = true;
                                        just_loaded = true;
                                        duration_ms.store(dur, Ordering::Relaxed);
                                        player = Some(p);
                                    }
                                    Err(e) => {
                                        has_track = false;
                                        emit_error(&app, format!("device rebuild: {e}"));
                                    }
                                }
                            } else {
                                has_track = false;
                            }
                            tracing::info!("audio engine: output device rebuilt");
                        }
                        None => {
                            // No device available right now; retry next tick.
                            output_dead.store(true, Ordering::Relaxed);
                        }
                    }
                }
                let mut replay_now = false;
                if let Some(cf) = &crossfading {
                    // Ramp step: deck A → 0, deck B → target.
                    let frac = (cf.started.elapsed().as_secs_f32()
                        / cf.dur.as_secs_f32().max(0.001))
                    .clamp(0.0, 1.0);
                    if let Some(a) = &player {
                        a.set_volume(cf.target_vol * (1.0 - frac));
                    }
                    if let Some(b) = &deck_b {
                        b.set_volume(cf.target_vol * frac);
                    }
                    if frac >= 1.0 {
                        // Promote deck B to the active player.
                        if let Some(a) = player.take() {
                            a.stop();
                        }
                        if let Some(b) = deck_b.take() {
                            let pos = b.get_pos().as_secs_f64();
                            b.set_volume(volume);
                            duration_ms.store(next_dur, Ordering::Relaxed);
                            position_ms.store((pos * 1000.0) as u64, Ordering::Relaxed);
                            has_track = true;
                            just_loaded = true;
                            player = Some(b);
                            current_source = next_source.take();
                            current_dur = next_dur;
                            let _ = app.emit("engine://advanced", AdvancedPayload { position: pos });
                        }
                        crossfading = None;
                    }
                } else if let Some(p) = &player {
                    let pos = p.get_pos().as_secs_f64();
                    position_ms.store((pos * 1000.0) as u64, Ordering::Relaxed);
                    let dur = duration_ms.load(Ordering::Relaxed) as f64 / 1000.0;
                    let _ = app.emit("engine://tick", TickPayload { position: pos, duration: dur });
                    let remaining = dur - pos;
                    if !just_loaded
                        && playing
                        && crossfade_secs > 0.0
                        && deck_b.is_some()
                        && dur > 0.0
                        && remaining <= crossfade_secs
                        && remaining > 0.15
                    {
                        // Begin the crossfade: play deck B silent, ramp over the
                        // remaining time (capped at crossfade_secs).
                        if let Some(b) = &deck_b {
                            b.set_volume(0.0);
                            b.play();
                        }
                        crossfading = Some(Crossfade {
                            started: Instant::now(),
                            dur: Duration::from_secs_f64(remaining.min(crossfade_secs).max(0.05)),
                            target_vol: volume,
                        });
                    } else if has_track && !just_loaded && playing && p.empty() {
                        if repeat_one && current_source.is_some() {
                            // Repeat-one: loop the current track. Handled after
                            // this borrow of `player` ends (needs to replace it).
                            replay_now = true;
                        } else {
                            // End of track, no crossfade + no repeat. Clear the
                            // retained source so a later device rebuild can't
                            // resurrect a finished track (the frontend loads next).
                            has_track = false;
                            playing = false;
                            current_source = None;
                            let _ = app.emit("engine://ended", EndedPayload { completed: true });
                        }
                    }
                    just_loaded = false;
                }
                if replay_now {
                    // Loop: re-create the current track from the start, playing.
                    if let Some(source) = current_source.clone() {
                        if let Some(a) = player.take() {
                            a.stop();
                        }
                        let rebuilt = if source.starts_with("http") {
                            fetch_stream(&source, &loudness).and_then(|(b, n, l, pk)| {
                                make_player(sink.mixer(), Cursor::new(b), n, volume, 0.0, true, &fx, l, pk)
                            })
                        } else {
                            let (l, pk) = norm_for(&source, &loudness);
                            std::fs::File::open(&source).map_err(|e| e.to_string()).and_then(|f| {
                                make_player(sink.mixer(), BufReader::new(f), file_len(&source), volume, 0.0, true, &fx, l, pk)
                            })
                        };
                        match rebuilt {
                            Ok(np) => {
                                just_loaded = true;
                                position_ms.store(0, Ordering::Relaxed);
                                player = Some(np);
                                let _ = app.emit(
                                    "engine://tick",
                                    TickPayload { position: 0.0, duration: current_dur as f64 / 1000.0 },
                                );
                            }
                            Err(e) => {
                                has_track = false;
                                playing = false;
                                current_source = None;
                                emit_error(&app, format!("repeat: {e}"));
                            }
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Output failed to open: keep draining commands so the frontend never blocks.
fn drain_silently(rx: &Receiver<EngineCmd>) {
    while let Ok(cmd) = rx.recv() {
        if matches!(cmd, EngineCmd::Shutdown) {
            break;
        }
    }
}

fn emit_error(app: &AppHandle, message: String) {
    tracing::warn!(%message, "audio engine error");
    let _ = app.emit("engine://error", ErrorPayload { message });
}

/// Build a Player for a reader (file or in-memory stream): decode, connect to
/// the mixer, set volume, seek, and start playing/paused. Runs on the engine
/// thread. Errors as a String so both source arms can share it.
#[allow(clippy::too_many_arguments)]
fn make_player<R: Read + Seek + Send + Sync + 'static>(
    mixer: &rodio::mixer::Mixer,
    reader: R,
    byte_len: u64,
    volume: f32,
    start_at: f64,
    want_play: bool,
    fx: &Arc<FxShared>,
    track_lufs: Option<f32>,
    track_peak_db: Option<f32>,
) -> Result<rodio::Player, String> {
    // `with_byte_len` gives Symphonia the stream length AND marks it seekable —
    // required to parse MP4/M4A (its `moov` index must be seeked to) and to seek
    // at all. Plain `Decoder::new` leaves it non-seekable, which makes downloaded
    // AAC/MP4 fail to decode outright and makes streamed tracks un-seekable.
    let decoder = rodio::Decoder::builder()
        .with_data(reader)
        .with_byte_len(byte_len)
        .build()
        .map_err(|e| e.to_string())?;
    let p = rodio::Player::connect_new(mixer);
    p.set_volume(volume);
    // Route decoded audio through the FX chain (EQ / mono / Normalize / limiter).
    // Shared EQ/mono params keep both decks consistent through a crossfade; the
    // Normalize gain is per-track (the loaded track's measured loudness).
    p.append(FxChain::new(decoder, fx.clone(), track_lufs, track_peak_db));
    if start_at > 0.0 {
        let _ = p.try_seek(Duration::from_secs_f64(start_at));
    }
    if want_play {
        p.play();
    } else {
        p.pause();
    }
    Ok(p)
}

/// Look up a local source's measured loudness for the Normalize gain. On a cache
/// miss for a local file, kicks a background scan (so the NEXT play normalizes)
/// and returns None (this play stays at unity gain). Streamed http sources are
/// skipped — no stable key and the file isn't necessarily fully local.
fn norm_for(source: &str, cache: &Arc<LoudnessCache>) -> (Option<f32>, Option<f32>) {
    if source.starts_with("http") {
        return (None, None);
    }
    if let Some(m) = cache.get(source) {
        return (Some(m.lufs), Some(m.peak_db));
    }
    if cache.try_claim(source) {
        let path = source.to_string();
        let cache = cache.clone();
        std::thread::spawn(move || {
            if let Some(m) = measure(&path) {
                cache.insert_and_save(path.clone(), m);
            }
            cache.release(&path);
        });
    }
    (None, None)
}

/// Open the default output as a rodio sink, wiring an error callback that flags
/// the supervisor to rebuild when the device disappears or the stream is
/// invalidated (headphones unplugged, AirPods dropped, output switched). The
/// callback runs on cpal's thread, so it only flips an atomic. Returns None if
/// no output device is currently available (thread then runs silent + retries).
fn open_output(dead: &Arc<AtomicBool>) -> Option<rodio::MixerDeviceSink> {
    let flag = dead.clone();
    rodio::DeviceSinkBuilder::from_default_device()
        .ok()?
        .with_error_callback(move |e| {
            if matches!(
                e,
                rodio::cpal::StreamError::DeviceNotAvailable
                    | rodio::cpal::StreamError::StreamInvalidated
            ) {
                flag.store(true, Ordering::Relaxed);
            }
        })
        .open_stream()
        .ok()
}

/// Name of the current default output device, for change detection. None if the
/// name can't be read (treated as "no observable change" so we don't churn).
// cpal's DeviceTrait::name is deprecated in the rodio re-export; the name is
// only used to detect a device change, so the plain name is exactly what we want.
#[allow(deprecated)]
fn default_output_name() -> Option<String> {
    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}

/// File size in bytes (0 if unreadable). Fed to the decoder as the stream length
/// so Symphonia can seek (parse MP4 + honor seeks).
fn file_len(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Stable Normalize cache key for a streamed source. The /live URL carries a
/// changing `?t=` token, so we key by the stream id from the path
/// (`.../stream/{id}[/live]?...` → `stream:{id}`). None if not a stream URL.
fn stream_key(url: &str) -> Option<String> {
    let after = url.split("/stream/").nth(1)?;
    let id = after.split(['/', '?']).next()?;
    if id.is_empty() {
        None
    } else {
        Some(format!("stream:{id}"))
    }
}

/// Fetch a streamed source into memory and resolve its Normalize gain. On a
/// cache hit (by stream id) the loudness is applied to this play; on a miss the
/// already-fetched bytes are measured in the background + cached, so the NEXT
/// play of that track is normalized. Returns (bytes, byte_len, lufs, peak_db).
fn fetch_stream(
    url: &str,
    loudness: &Arc<LoudnessCache>,
) -> Result<(Vec<u8>, u64, Option<f32>, Option<f32>), String> {
    let key = stream_key(url);
    let cached = key.as_ref().and_then(|k| loudness.get(k));
    let bytes = fetch_bytes(url)?;
    let len = bytes.len() as u64;
    let (lufs, peak) = match cached {
        Some(m) => (Some(m.lufs), Some(m.peak_db)),
        None => {
            // Measure these bytes off-thread for next time (keyed by stream id),
            // deduped + concurrency-capped so a skip-storm can't spawn a scan per
            // skip.
            if let Some(k) = key {
                if loudness.try_claim(&k) {
                    let b = bytes.clone();
                    let c = loudness.clone();
                    std::thread::spawn(move || {
                        if let Some(m) = measure_bytes(b) {
                            c.insert_and_save(k.clone(), m);
                        }
                        c.release(&k);
                    });
                }
            }
            (None, None)
        }
    };
    Ok((bytes, len, lufs, peak))
}

/// Fetch a URL fully into memory (blocking). Loopback + a complete, range-served
/// file, so the whole (small AAC) track downloads fast; buffering it up front
/// gives a seekable in-memory source and avoids progressive-stream fragility.
fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = reqwest::blocking::get(url).map_err(|e| e.to_string())?;
    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

// ---------------------------------------------------------------------------
// Tauri commands — thin sends onto the engine channel.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn engine_load(
    engine: tauri::State<'_, AudioEngine>,
    source: String,
    duration_ms: u64,
    start_at: f64,
    playing: bool,
) {
    engine.send(EngineCmd::Load {
        source,
        duration_ms,
        start_at,
        playing,
    });
}

#[tauri::command]
pub fn engine_play(engine: tauri::State<'_, AudioEngine>) {
    engine.send(EngineCmd::Play);
}

#[tauri::command]
pub fn engine_pause(engine: tauri::State<'_, AudioEngine>) {
    engine.send(EngineCmd::Pause);
}

#[tauri::command]
pub fn engine_seek(engine: tauri::State<'_, AudioEngine>, secs: f64) {
    engine.send(EngineCmd::Seek(secs));
}

#[tauri::command]
pub fn engine_set_volume(engine: tauri::State<'_, AudioEngine>, volume: f32) {
    engine.send(EngineCmd::SetVolume(volume));
}

#[tauri::command]
pub fn engine_stop(engine: tauri::State<'_, AudioEngine>) {
    engine.send(EngineCmd::Stop);
}

/// Sync getter for the current position (seconds) — reads the atomic, no
/// round-trip. Backs the queue-handoff snapshot.
#[tauri::command]
pub fn engine_position(engine: tauri::State<'_, AudioEngine>) -> f64 {
    engine.position_ms.load(Ordering::Relaxed) as f64 / 1000.0
}

#[tauri::command]
pub fn engine_set_crossfade(engine: tauri::State<'_, AudioEngine>, secs: f64) {
    engine.send(EngineCmd::SetCrossfade(secs));
}

#[tauri::command]
pub fn engine_set_repeat_one(engine: tauri::State<'_, AudioEngine>, enabled: bool) {
    engine.send(EngineCmd::SetRepeatOne(enabled));
}

#[tauri::command]
pub fn engine_preload_next(
    engine: tauri::State<'_, AudioEngine>,
    source: String,
    duration_ms: u64,
) {
    engine.send(EngineCmd::PreloadNext { source, duration_ms });
}

/// Update the EQ / mono / Normalize effects (lock-free; applies to both decks
/// live). `loudness_target` is the Normalize target in LUFS (e.g. -14).
#[tauri::command]
pub fn engine_set_fx(
    engine: tauri::State<'_, AudioEngine>,
    eq_enabled: bool,
    gains: Vec<f32>,
    mono: bool,
    normalize: bool,
    loudness_target: f32,
) {
    let mut g = [0.0f32; 6];
    for (i, v) in gains.iter().take(6).enumerate() {
        g[i] = *v;
    }
    engine.fx.set(eq_enabled, g, mono, normalize, loudness_target);
}
