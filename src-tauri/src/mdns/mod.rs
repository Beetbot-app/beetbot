//! Step 15: mDNS service announcement.
//!
//! Publishes the streaming server as `_localmusic._tcp.local.` so devices on
//! the same Wi-Fi can discover it via Bonjour / Avahi / generic mDNS service
//! browsers. macOS's built-in mDNSResponder already publishes the machine
//! hostname, so the printed URL (e.g. `http://Example-MacBook-Pro.local:47823/`)
//! resolves without our help -- this announcement is what makes Beetbot
//! show up in device discovery tools.
//!
//! The returned `MdnsHandle` owns the daemon thread; dropping it
//! deregisters the service.

use std::collections::HashMap;
use std::net::IpAddr;

use mdns_sd::{ServiceDaemon, ServiceInfo};

pub const SERVICE_TYPE: &str = "_localmusic._tcp.local.";

pub struct MdnsHandle {
    daemon: ServiceDaemon,
}

impl Drop for MdnsHandle {
    fn drop(&mut self) {
        // Best-effort. ServiceDaemon::shutdown returns a receiver we don't
        // need to wait on -- process exit will clean up anyway.
        let _ = self.daemon.shutdown();
    }
}

/// Register the streaming service. `hostname` is the bare machine name
/// (e.g. "Example-MacBook-Pro"); we suffix `.local.` ourselves.
pub fn announce(
    port: u16,
    lan_ip: IpAddr,
    hostname: &str,
) -> Result<MdnsHandle, mdns_sd::Error> {
    let daemon = ServiceDaemon::new()?;
    let instance_name = format!("{hostname}'s Music Library");
    let hostname_full = format!("{hostname}.local.");
    let mut props = HashMap::new();
    props.insert("version".to_string(), "1".to_string());

    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &hostname_full,
        lan_ip,
        port,
        Some(props),
    )?;
    daemon.register(info)?;
    tracing::info!(
        instance = %instance_name,
        host = %hostname_full,
        ?lan_ip,
        port,
        "mDNS service registered"
    );
    Ok(MdnsHandle { daemon })
}
