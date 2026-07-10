//! Step 20 (Phase 6B-i): network reachability probe.
//!
//! Tells the user *whether* remote streaming would work on their current
//! network, without changing anything. Three signals:
//!
//!   1. Public IP    -- fetched from a STUN-like HTTPS echo service
//!                      (api.ipify.org). One DNS lookup + one GET per
//!                      probe; nothing is persisted.
//!   2. CGNAT verdict -- if the public IP lands inside 100.64.0.0/10 the
//!                      user is on a carrier-grade NAT and outbound
//!                      port forwarding is impossible regardless of UPnP.
//!   3. UPnP / NAT-PMP -- ask the local Internet Gateway Device for its
//!                      external IP via SSDP/UPnP. If it answers, we'd
//!                      be able to map ports later. We do NOT create a
//!                      mapping here; that's deferred to step 22.
//!
//! Plan §6.1 calls these "components" of the public-IP detection step.
//! This module is the read-only diagnostic surface.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use igd_next::PortMappingProtocol;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct NetworkProbe {
    pub lan_ip: Option<String>,
    pub public_ip: Option<String>,
    pub cgnat_likely: bool,
    pub upnp_available: bool,
    pub upnp_external_ip: Option<String>,
    /// Human-readable verdict that drives the Settings UI banner.
    pub verdict: Verdict,
    /// Free-form notes the user may want to read.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// Public IP is routable + UPnP works. Remote streaming should work
    /// after we set up DDNS + TLS in later steps.
    RemoteReachable,
    /// We have a public IP but UPnP failed. The user may still be able to
    /// port-forward manually, but the automated path won't work.
    NeedsManualPortForward,
    /// User is behind CGNAT or some equivalent gate. Remote streaming via
    /// our self-hosted approach is not possible -- they'd need a relay.
    BlockedByCgnat,
    /// We couldn't fetch the public IP at all (offline, blocked, etc.).
    NoInternet,
}

pub async fn probe() -> NetworkProbe {
    let lan_ip = local_ip_address::local_ip()
        .ok()
        .map(|ip| ip.to_string());

    let mut notes: Vec<String> = Vec::new();
    let public_ip = fetch_public_ip().await;
    if public_ip.is_none() {
        notes.push(
            "Couldn't reach api.ipify.org -- offline, DNS blocked, or the service is down."
                .into(),
        );
    }

    let cgnat_likely = public_ip
        .as_ref()
        .and_then(|s| s.parse::<IpAddr>().ok())
        .map(is_cgnat)
        .unwrap_or(false);
    if cgnat_likely {
        notes.push(
            "Your public IP is inside the carrier-grade NAT range (100.64.0.0/10). \
             Remote streaming via self-hosting isn't possible on this network."
                .into(),
        );
    }

    let upnp = probe_upnp().await;
    if let Some(err) = upnp.as_ref().err() {
        notes.push(format!("UPnP discovery failed: {err}"));
    }
    let (upnp_available, upnp_external_ip) = match &upnp {
        Ok(ip) => (true, Some(ip.to_string())),
        Err(_) => (false, None),
    };

    let verdict = if public_ip.is_none() {
        Verdict::NoInternet
    } else if cgnat_likely {
        Verdict::BlockedByCgnat
    } else if upnp_available {
        Verdict::RemoteReachable
    } else {
        Verdict::NeedsManualPortForward
    };

    NetworkProbe {
        lan_ip,
        public_ip,
        cgnat_likely,
        upnp_available,
        upnp_external_ip,
        verdict,
        notes,
    }
}

pub async fn fetch_public_ip() -> Option<String> {
    // Plain-text endpoint that just echoes the requester's IP. The HTTPS
    // version is preferred so a captive portal can't lie to us.
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?
        .get("https://api.ipify.org")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let trimmed = body.trim();
    // Sanity check: should parse as an IP address.
    if trimmed.parse::<IpAddr>().is_ok() {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// True if the address is inside 100.64.0.0/10 -- the IANA-allocated range
/// for carrier-grade NAT. Customers on this range can't be reached from
/// the open internet without their ISP's help.
fn is_cgnat(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            a == 100 && (64..=127).contains(&b)
        }
        IpAddr::V6(_) => false,
    }
}

async fn probe_upnp() -> Result<IpAddr, String> {
    // 1.5-second SSDP discovery. The default igd-next timeout is longer;
    // we cap it so the Settings probe doesn't appear to hang.
    let gateway = search_gateway_fast().await?;
    let ip = gateway
        .get_external_ip()
        .await
        .map_err(|e| e.to_string())?;
    Ok(ip)
}

/// Discover the local Internet Gateway Device with a short SSDP timeout.
/// Shared by the read-only probe and the port-mapping helpers so they all
/// fail fast instead of hanging the UI when no UPnP router answers.
async fn search_gateway_fast() -> Result<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, String>
{
    // 2-second discovery window. Slightly longer than the diagnostic probe
    // because actually mapping ports is worth waiting a beat for, but still
    // short enough that the enable toggle feels responsive.
    let opts = igd_next::SearchOptions {
        timeout: Some(Duration::from_millis(2_000)),
        ..Default::default()
    };
    igd_next::aio::tokio::search_gateway(opts)
        .await
        .map_err(|e| e.to_string())
}

/// Lease length (seconds) we ask the router to hold each mapping for. Finite
/// so a crash/quit doesn't leave a permanent hole punched in the firewall;
/// the refresher re-adds it well before this expires.
const MAPPING_LEASE_SECS: u32 = 3_600;
/// Description the router shows for our mappings in its admin UI.
const MAPPING_DESC: &str = "Beetbot";

/// Open TCP port mappings on the router for each of `ports`, forwarding the
/// external port to the same internal port on `local_ip`. Idempotent: a
/// router reporting the mapping already exists (same client, same ports) is
/// treated as success. Returns the first hard error encountered.
///
/// Degrades gracefully: if no UPnP gateway answers, the caller records the
/// error and falls back to manual port-forward instructions.
pub async fn open_port_mapping(local_ip: Ipv4Addr, ports: &[u16]) -> Result<(), String> {
    let gateway = search_gateway_fast().await?;
    let mut first_err: Option<String> = None;
    for &port in ports {
        let local_addr = SocketAddr::new(IpAddr::V4(local_ip), port);
        let res = gateway
            .add_port(
                PortMappingProtocol::TCP,
                port,
                local_addr,
                MAPPING_LEASE_SECS,
                MAPPING_DESC,
            )
            .await;
        match res {
            Ok(()) => {}
            // Some routers only accept permanent leases. Retry once with an
            // infinite lease (0) before giving up on this port.
            Err(igd_next::AddPortError::OnlyPermanentLeasesSupported) => {
                if let Err(e) = gateway
                    .add_port(
                        PortMappingProtocol::TCP,
                        port,
                        local_addr,
                        0,
                        MAPPING_DESC,
                    )
                    .await
                {
                    if !is_already_mapped(&e) && first_err.is_none() {
                        first_err = Some(e.to_string());
                    }
                }
            }
            Err(e) => {
                // An existing identical mapping (our own, from a prior run or
                // refresher tick) is not a failure.
                if !is_already_mapped(&e) && first_err.is_none() {
                    first_err = Some(e.to_string());
                }
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Remove the TCP port mappings we previously opened. Best-effort: a router
/// reporting no such mapping (already gone, or never created) is ignored.
/// Returns the first hard error.
pub async fn close_port_mapping(ports: &[u16]) -> Result<(), String> {
    let gateway = search_gateway_fast().await?;
    let mut first_err: Option<String> = None;
    for &port in ports {
        if let Err(e) = gateway
            .remove_port(PortMappingProtocol::TCP, port)
            .await
        {
            if !matches!(e, igd_next::RemovePortError::NoSuchPortMapping)
                && first_err.is_none()
            {
                first_err = Some(e.to_string());
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Best-effort fetch of the router's external (WAN) IP via UPnP, for display
/// alongside the mapping status. Returns `None` if no gateway answers.
pub async fn fetch_upnp_external_ip() -> Option<String> {
    let gateway = search_gateway_fast().await.ok()?;
    gateway.get_external_ip().await.ok().map(|ip| ip.to_string())
}

/// True when an `add_port` error means the mapping is effectively already in
/// place for us. `PortInUse` covers a router that re-reports our own mapping
/// as a conflict; treating it as success keeps the refresher idempotent.
fn is_already_mapped(err: &igd_next::AddPortError) -> bool {
    matches!(err, igd_next::AddPortError::PortInUse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgnat_range_detection() {
        assert!(is_cgnat("100.64.0.1".parse().unwrap()));
        assert!(is_cgnat("100.100.0.1".parse().unwrap()));
        assert!(is_cgnat("100.127.255.255".parse().unwrap()));
    }

    #[test]
    fn non_cgnat_addresses_pass_through() {
        // Outside the carrier-grade range but still numerically nearby.
        assert!(!is_cgnat("100.63.0.1".parse().unwrap()));
        assert!(!is_cgnat("100.128.0.1".parse().unwrap()));
        // Common public + private ranges shouldn't false-positive.
        assert!(!is_cgnat("8.8.8.8".parse().unwrap()));
        assert!(!is_cgnat("192.168.1.1".parse().unwrap()));
        assert!(!is_cgnat("10.0.0.1".parse().unwrap()));
        assert!(!is_cgnat("172.16.0.1".parse().unwrap()));
    }

    #[test]
    fn ipv6_is_never_cgnat() {
        // 100::/64 is the IPv6 discard-only range; not CGNAT.
        assert!(!is_cgnat("100::1".parse().unwrap()));
        assert!(!is_cgnat("::1".parse().unwrap()));
    }
}
