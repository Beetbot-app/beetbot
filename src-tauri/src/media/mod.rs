//! macOS Now Playing widget / media key integration via souvlaki.
//!
//! On macOS, souvlaki publishes track metadata to MPNowPlayingInfoCenter and
//! receives play / pause / skip events through MPRemoteCommandCenter --
//! which is what handles the dedicated media keys (F7-F9), headphone
//! buttons, AirPods double-tap, Control Center, and the lock screen.
//!
//! Souvlaki's event callback fires on whatever thread the platform delivers
//! the command on (main thread / GCD on macOS). We just funnel each event
//! into a Tauri `media-control` payload so the frontend store can react.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
    PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

pub struct MediaState(pub Arc<Mutex<MediaControls>>);

pub fn init(app: &AppHandle) -> Result<MediaControls, souvlaki::Error> {
    let config = PlatformConfig {
        dbus_name: "com.beetbot.app",
        display_name: "Beetbot",
        hwnd: None,
    };
    let mut controls = MediaControls::new(config)?;
    let emit_app = app.clone();
    controls.attach(move |event| {
        let action = match event {
            MediaControlEvent::Play => "play",
            MediaControlEvent::Pause => "pause",
            MediaControlEvent::Toggle => "toggle",
            MediaControlEvent::Next => "next",
            MediaControlEvent::Previous => "prev",
            MediaControlEvent::Stop => "stop",
            _ => return,
        };
        tracing::debug!(action, "media key event");
        let _ = emit_app.emit("media-control", action);
    })?;
    Ok(controls)
}

/// macOS Cocoa APIs (MPNowPlayingInfoCenter, MPRemoteCommandCenter) want to
/// be touched from the main thread. Tauri IPC handlers run on a Tokio worker
/// thread by default, so we route every souvlaki call through
/// `AppHandle::run_on_main_thread`. The closure clones its inputs because
/// it must outlive the original command frame.
fn on_main<F>(app: &AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    app.run_on_main_thread(f).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn media_set_track(
    app: AppHandle,
    state: tauri::State<'_, MediaState>,
    title: String,
    artist: String,
    album: Option<String>,
    art_url: Option<String>,
    duration_s: Option<u32>,
) -> Result<(), String> {
    let controls = state.0.clone();
    tracing::info!(%title, %artist, ?album, ?art_url, ?duration_s, "media_set_track");
    on_main(&app, move || {
        let mut c = match controls.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!(?e, "media controls mutex poisoned");
                return;
            }
        };
        if let Err(e) = c.set_metadata(MediaMetadata {
            title: Some(&title),
            artist: Some(&artist),
            album: album.as_deref(),
            cover_url: art_url.as_deref(),
            duration: duration_s.map(|s| Duration::from_secs(s as u64)),
        }) {
            tracing::error!(?e, "souvlaki set_metadata failed");
        }
    })
}

#[tauri::command]
pub fn media_set_playback(
    app: AppHandle,
    state: tauri::State<'_, MediaState>,
    playing: bool,
    position_s: Option<f64>,
) -> Result<(), String> {
    let controls = state.0.clone();
    tracing::info!(playing, ?position_s, "media_set_playback");
    on_main(&app, move || {
        let mut c = match controls.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!(?e, "media controls mutex poisoned");
                return;
            }
        };
        let progress =
            position_s.map(|s| MediaPosition(Duration::from_secs_f64(s.max(0.0))));
        let playback = if playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        };
        if let Err(e) = c.set_playback(playback) {
            tracing::error!(?e, "souvlaki set_playback failed");
        }
    })
}
