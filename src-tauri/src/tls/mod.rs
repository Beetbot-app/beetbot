//! Self-signed TLS cert generation for LAN HTTPS.
//!
//! Why this exists: Safari (iOS especially) refuses to expose Cache API +
//! Service Workers on plain HTTP unless the host is `localhost` /
//! `127.0.0.1`. `.local` mDNS hostnames and LAN IPs don't qualify as secure
//! contexts. To get offline playback / PWA installability on an iPhone
//! that's just on the same Wi-Fi, we have to serve HTTPS -- which means
//! a cert. There's no CA for `<hostname>.local`, so we generate our own
//! self-signed cert and provide an in-app flow for the user to trust it on
//! their device.
//!
//! Storage layout under `app_data_dir/tls/`:
//!   beetbot.crt  -- PEM cert, world-readable
//!   beetbot.key  -- PEM key,  0600 (Unix); never leaves the host
//!
//! Validity is 10 years. Apple's 398-day max-validity policy only applies
//! to certs that chain through a system-trusted root CA -- user-installed
//! self-signed certs are exempt.
//!
//! SAN list:
//!   - `<hostname>.local`   (stable across LAN IP changes)
//!   - `localhost`
//!   - `127.0.0.1`, `::1`
//!   - The current LAN IPv4 (so the cert also works if the user types the IP)

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use rcgen::{
    CertificateParams, DistinguishedName, DnType, KeyPair, SanType,
};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("rcgen: {0}")]
    Rcgen(#[from] rcgen::Error),
}

#[derive(Debug, Clone)]
pub struct TlsArtifacts {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    /// PEM-encoded cert, kept in memory so the cert-download endpoint can
    /// serve it without a re-read from disk per request.
    pub cert_pem: String,
}

/// Load existing cert+key from `tls_dir`, or generate a fresh pair and
/// persist them. Returns paths suitable for `axum_server`'s
/// `RustlsConfig::from_pem_file`.
pub fn ensure_cert(
    tls_dir: &Path,
    hostname_bare: &str,
    lan_ip: Option<IpAddr>,
) -> Result<TlsArtifacts, TlsError> {
    std::fs::create_dir_all(tls_dir)?;
    let cert_path = tls_dir.join("beetbot.crt");
    let key_path = tls_dir.join("beetbot.key");

    if cert_path.is_file() && key_path.is_file() {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        // We don't re-verify the SAN list here -- if the user's LAN IP
        // changed, the cert may not match the new IP, but the .local
        // hostname remains valid and that's what the QR code points at.
        // A future migration could detect SAN drift and regenerate.
        return Ok(TlsArtifacts {
            cert_path,
            key_path,
            cert_pem,
        });
    }

    let (cert_pem, key_pem) = generate_pem_pair(hostname_bare, lan_ip)?;
    std::fs::write(&cert_path, &cert_pem)?;
    write_key_restricted(&key_path, &key_pem)?;
    Ok(TlsArtifacts {
        cert_path,
        key_path,
        cert_pem,
    })
}

fn generate_pem_pair(
    hostname_bare: &str,
    lan_ip: Option<IpAddr>,
) -> Result<(String, String), TlsError> {
    let dns_local = format!("{}.local", hostname_bare.trim_end_matches(".local"));

    let mut params = CertificateParams::new(vec![])?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Beetbot LAN");
    dn.push(DnType::OrganizationName, "Beetbot");
    params.distinguished_name = dn;

    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(365 * 10);

    let mut sans: Vec<SanType> = vec![
        SanType::DnsName(dns_local.parse().unwrap()),
        SanType::DnsName("localhost".parse().unwrap()),
        SanType::IpAddress("127.0.0.1".parse().unwrap()),
        SanType::IpAddress("::1".parse().unwrap()),
    ];
    if let Some(ip) = lan_ip {
        sans.push(SanType::IpAddress(ip));
    }
    params.subject_alt_names = sans;

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;
    Ok((cert.pem(), key_pair.serialize_pem()))
}

#[cfg(unix)]
fn write_key_restricted(path: &Path, key_pem: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, key_pem)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn write_key_restricted(path: &Path, key_pem: &str) -> std::io::Result<()> {
    std::fs::write(path, key_pem)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn generates_and_persists_a_cert() {
        let dir = TempDir::new().unwrap();
        let art = ensure_cert(dir.path(), "TestHost", Some("192.168.1.42".parse().unwrap()))
            .expect("first gen");
        assert!(art.cert_path.is_file());
        assert!(art.key_path.is_file());
        assert!(art.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
        let key_pem = std::fs::read_to_string(&art.key_path).unwrap();
        assert!(key_pem.contains("PRIVATE KEY"));
    }

    #[test]
    fn second_call_loads_existing_files_unchanged() {
        let dir = TempDir::new().unwrap();
        let first = ensure_cert(dir.path(), "TestHost", None).unwrap();
        let second = ensure_cert(dir.path(), "AnotherHost", None).unwrap();
        // Even though we passed a different hostname, the existing cert is
        // reused -- we don't regenerate as long as both files are present.
        assert_eq!(first.cert_pem, second.cert_pem);
    }

    #[test]
    fn cert_contains_dot_local_san() {
        let dir = TempDir::new().unwrap();
        let art = ensure_cert(dir.path(), "Example-MacBook-Pro", None).unwrap();
        // Decode the PEM and look for the .local DNS name. The simplest
        // check: pem-decode -> der -> look for the literal hostname in the
        // bytes. SAN values are stored as ASCII so a substring search is
        // sufficient for this smoke test.
        let pem_body: String = art
            .cert_pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(pem_body.replace('\n', ""))
            .unwrap();
        let needle = b"Example-MacBook-Pro.local";
        assert!(
            der.windows(needle.len()).any(|w| w == needle),
            "SAN list should include Example-MacBook-Pro.local"
        );
    }

    use base64::Engine as _;
}
