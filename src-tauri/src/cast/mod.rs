//! Google Cast (Chromecast) device discovery and control.
//!
//! Milestone 1 of the Cast feature: discovery only. We browse the
//! mDNS service `_googlecast._tcp.local.` and keep an in-memory map
//! of devices we've seen, updated as PTR / SRV / TXT records flow
//! in from the LAN. The HTTP layer reads that map via [`list`].
//!
//! The actual Cast control protocol (TLS + protobuf to port 8009)
//! lives in a future milestone — this module just enumerates what's
//! out there so the phone UI can populate its picker.
//!
//! Why a separate mDNS daemon from the one in `crate::mdns`:
//! that daemon's job is to *publish* our LAN streaming service. It
//! could in principle be shared, but its `MdnsHandle` doesn't
//! expose the underlying `ServiceDaemon` and the memory cost of a
//! second daemon is negligible.
//!
//! Drop semantics: dropping the `CastDiscovery` shuts down the
//! daemon (best-effort) and the spawned background task exits when
//! the receiver disconnects.
//!
//! Chromecast TXT-record keys we care about (full schema is in
//! Google's protocol docs):
//!   - `id`: device UUID — globally unique, our primary key
//!   - `fn`: friendly name (e.g. "Living Room TV")
//!   - `md`: model description (e.g. "Chromecast", "Chromecast Ultra")

pub mod protocol;
pub mod session;

pub use session::{
    CastCommand, CastError, CastHandle, CastSession, CastStatus, MediaPayload,
};

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

const SERVICE_TYPE: &str = "_googlecast._tcp.local.";

/// A Chromecast / Cast-compatible target on the LAN.
#[derive(Debug, Clone, Serialize)]
pub struct CastDevice {
    /// Globally unique device UUID from the `id` TXT property.
    pub id: String,
    /// Human-readable name. Falls back to the mDNS instance name if
    /// the device doesn't advertise an `fn` (rare).
    pub friendly_name: String,
    /// Marketing model name from `md`: "Chromecast", "Chromecast Ultra",
    /// "Chromecast Audio", "Google Home", etc.
    pub model: Option<String>,
    /// mDNS hostname (e.g. `<uuid>.local.`). Useful for logging;
    /// the Cast TCP connection uses `ip:port` directly.
    pub host: String,
    /// TCP control port — always 8009 on real devices but read it
    /// from SRV rather than hard-coding in case of future changes.
    pub port: u16,
    /// First IPv4 address we resolved for the device. Required for
    /// the milestone-2 TLS connection.
    pub ip: Option<IpAddr>,
}

/// Long-lived Cast discovery state. Spawns a tokio task on creation
/// that keeps `devices` up to date in the background. Cheap to hold
/// onto across the app lifetime.
pub struct CastDiscovery {
    devices: Arc<RwLock<HashMap<String, CastDevice>>>,
    /// We keep the daemon alive for the duration of the struct;
    /// dropping it cancels the browse and disconnects the channel
    /// that the background task is reading from, so the task exits
    /// cleanly without us joining it.
    _daemon: ServiceDaemon,
}

impl CastDiscovery {
    /// Start a background discovery task. Returns immediately —
    /// `list()` will start populating as devices announce themselves
    /// over the next ~1-2 seconds.
    pub fn start() -> Result<Self, mdns_sd::Error> {
        let daemon = ServiceDaemon::new()?;
        let devices: Arc<RwLock<HashMap<String, CastDevice>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let receiver = daemon.browse(SERVICE_TYPE)?;

        let devices_for_task = devices.clone();
        // Tauri's setup hook runs outside of a free-standing tokio
        // runtime — we have to spawn on Tauri's runtime explicitly
        // or `tokio::spawn` panics with "no reactor running."
        tauri::async_runtime::spawn(async move {
            loop {
                match receiver.recv_async().await {
                    Ok(ServiceEvent::ServiceResolved(info)) => {
                        if let Some(device) = parse_device(&info) {
                            tracing::debug!(
                                id = %device.id,
                                name = %device.friendly_name,
                                ?device.ip,
                                "cast: discovered device"
                            );
                            let mut map = devices_for_task.write().await;
                            map.insert(device.id.clone(), device);
                        }
                    }
                    Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                        // `fullname` is the instance name + service
                        // suffix, not the TXT `id`. mDNS doesn't give
                        // us a clean key to remove by, so we just log
                        // and let the next ServiceResolved correct
                        // any staleness. In practice Chromecasts
                        // rarely leave the network mid-session.
                        tracing::debug!(%fullname, "cast: service removed event");
                    }
                    Ok(_) => {
                        // SearchStarted, ServiceFound (pre-resolve),
                        // etc. — not useful here.
                    }
                    Err(_) => {
                        // Channel disconnected — daemon was dropped.
                        break;
                    }
                }
            }
            tracing::debug!("cast: discovery task exited");
        });

        tracing::info!(service = %SERVICE_TYPE, "cast: discovery started");
        Ok(Self {
            devices,
            _daemon: daemon,
        })
    }

    /// Snapshot of currently-known devices, sorted by friendly name
    /// for stable UI ordering.
    pub async fn list(&self) -> Vec<CastDevice> {
        let map = self.devices.read().await;
        let mut v: Vec<CastDevice> = map.values().cloned().collect();
        v.sort_by(|a, b| a.friendly_name.cmp(&b.friendly_name));
        v
    }

    /// Look up one device by id. None if not seen since startup.
    pub async fn get(&self, id: &str) -> Option<CastDevice> {
        self.devices.read().await.get(id).cloned()
    }
}

/// Bundles discovery + the singleton active-session handle. Wrapped
/// in an `Arc` and dropped into `server::AppState.cast` so all the
/// Cast HTTP handlers can reach it.
pub struct CastManager {
    pub discovery: CastDiscovery,
    /// Only one device can be the audio target at a time. M2 keeps
    /// it singleton; if a second start request arrives we tear down
    /// the previous session first.
    pub active: Mutex<Option<CastHandle>>,
}

impl CastManager {
    pub fn start() -> Result<Self, mdns_sd::Error> {
        Ok(Self {
            discovery: CastDiscovery::start()?,
            active: Mutex::new(None),
        })
    }
}

fn parse_device(info: &mdns_sd::ServiceInfo) -> Option<CastDevice> {
    // `id` is required — it's our primary key. Anything without it
    // is either a half-resolved record or a non-Cast device that
    // happens to share the service type.
    let id = info.get_property_val_str("id")?.to_string();
    let friendly_name = info
        .get_property_val_str("fn")
        .map(str::to_string)
        .unwrap_or_else(|| info.get_fullname().to_string());
    let model = info
        .get_property_val_str("md")
        .map(str::to_string);
    let host = info.get_hostname().to_string();
    let port = info.get_port();
    // Prefer IPv4 — Chromecasts respond on both but v4 is universally
    // reachable from phones on the same Wi-Fi.
    let ip = info
        .get_addresses_v4()
        .iter()
        .next()
        .map(|v| IpAddr::V4(**v))
        .or_else(|| info.get_addresses().iter().next().copied());

    Some(CastDevice {
        id,
        friendly_name,
        model,
        host,
        port,
        ip,
    })
}
