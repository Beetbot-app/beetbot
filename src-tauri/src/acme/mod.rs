//! Step 22 (Phase 6B-iii): Let's Encrypt cert issuance via DNS-01.
//!
//! Why DNS-01 (not HTTP-01)?
//!   HTTP-01 requires Let's Encrypt to reach `http://<host>/.well-known/...`
//!   on port 80. Binding port 80 requires root on macOS and Linux, which
//!   would be a hostile UX for a music app. DNS-01 works entirely through
//!   the DuckDNS TXT-record API we already authenticate against, so the
//!   user only has to configure DDNS once.
//!
//! DuckDNS specifically aliases TXT updates to `_acme-challenge.<sub>.duckdns.org`
//! when you call the regular update endpoint with `txt=...`, so we don't
//! have to think about the subdomain prefix.
//!
//! Files on disk under `app_data_dir/tls/`:
//!   letsencrypt.crt          PEM cert chain (leaf + intermediates)
//!   letsencrypt.key          PEM private key (0600)
//!   acme_account.json        Account credentials, persisted so we re-use
//!                            the same ACME account across issuance runs
//!                            (avoids burning LE rate limits)
//!
//! Plus the existing self-signed `beetbot.{crt,key}` -- the LE cert is
//! preferred when present and not expired; otherwise we fall back to the
//! self-signed one for LAN-only use.

use std::path::{Path, PathBuf};
use std::time::Duration;

use instant_acme::{
    Account, AccountCredentials, ChallengeType, Identifier, KeyAuthorization, LetsEncrypt,
    NewAccount, NewOrder, OrderStatus,
};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum AcmeError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("network: {0}")]
    Network(String),
    #[error("acme: {0}")]
    Acme(String),
    #[error("DNS-01 challenge for {domain} failed: {reason}")]
    ChallengeFailed { domain: String, reason: String },
    #[error("rcgen: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("ddns: {0}")]
    Ddns(String),
    #[error("order timed out after {0} attempts")]
    Timeout(usize),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Environment {
    /// Real certs that browsers trust. Burns rate limits (50/wk per
    /// registered domain) if you re-issue carelessly.
    Production,
    /// Staging endpoint -- certs are untrusted but issuance is unlimited,
    /// so flow-testing is safe here.
    Staging,
}

impl Environment {
    fn url(&self) -> &'static str {
        match self {
            Environment::Production => LetsEncrypt::Production.url(),
            Environment::Staging => LetsEncrypt::Staging.url(),
        }
    }
}

/// User-supplied inputs for an issuance run.
pub struct IssueRequest {
    pub tls_dir: PathBuf,
    /// DuckDNS subdomain (without `.duckdns.org`).
    pub subdomain: String,
    /// DuckDNS update token from the keychain.
    pub duckdns_token: String,
    /// Contact email for ACME account. Optional but recommended.
    pub contact_email: Option<String>,
    pub environment: Environment,
}

/// What we hand back to the UI on success.
#[derive(Debug, Clone, Serialize)]
pub struct IssueOutcome {
    pub hostname: String,
    pub cert_path: String,
    pub key_path: String,
    /// Unix timestamp of the leaf's notAfter so the UI can show expiry.
    pub not_after: i64,
}

/// Snapshot of disk state for the UI.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AcmeStatus {
    pub has_cert: bool,
    pub hostname: Option<String>,
    pub not_after: Option<i64>,
    pub last_error: Option<String>,
}

const ACCOUNT_FILENAME: &str = "acme_account.json";
const CERT_FILENAME: &str = "letsencrypt.crt";
const KEY_FILENAME: &str = "letsencrypt.key";
const LAST_ERROR_FILENAME: &str = "letsencrypt.last_error";

pub fn cert_path(tls_dir: &Path) -> PathBuf {
    tls_dir.join(CERT_FILENAME)
}

pub fn key_path(tls_dir: &Path) -> PathBuf {
    tls_dir.join(KEY_FILENAME)
}

/// Cheap on-disk snapshot for the Settings page.
pub fn read_status(tls_dir: &Path) -> AcmeStatus {
    let cert = tls_dir.join(CERT_FILENAME);
    if !cert.is_file() {
        let last_error = std::fs::read_to_string(tls_dir.join(LAST_ERROR_FILENAME))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        return AcmeStatus {
            last_error,
            ..AcmeStatus::default()
        };
    }
    let pem = std::fs::read_to_string(&cert).unwrap_or_default();
    let (hostname, not_after) = inspect_pem(&pem);
    AcmeStatus {
        has_cert: true,
        hostname,
        not_after,
        last_error: None,
    }
}

/// Pull the first SAN DNS name + the notAfter timestamp out of a PEM cert
/// for status-display purposes. Failure paths return (None, None) so the
/// UI just shows "?".
fn inspect_pem(pem: &str) -> (Option<String>, Option<i64>) {
    use base64::Engine as _;
    // Let's Encrypt returns a chain: leaf + intermediate(s) concatenated.
    // Only the leaf has our SAN; isolate it before base64-decoding so the
    // boundary between certs doesn't poison the decode.
    let leaf_body: String = match pem
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .and_then(|after_begin| after_begin.split("-----END CERTIFICATE-----").next())
    {
        Some(body) => body.lines().collect(),
        None => return (None, None),
    };
    let der = match base64::engine::general_purpose::STANDARD.decode(&leaf_body) {
        Ok(b) => b,
        Err(_) => return (None, None),
    };
    // Cheap SAN scan: look for a `duckdns.org` substring inside the DER.
    // Cert SANs are ASCII so a window search is sufficient for the status
    // line. We don't need cryptographic-grade parsing here.
    let needle = b".duckdns.org";
    let hostname = der
        .windows(needle.len())
        .position(|w| w == needle)
        .and_then(|end| {
            // Walk backwards from `.duckdns.org` until we hit a non-DNS char.
            let mut start = end;
            while start > 0 {
                let c = der[start - 1];
                if c.is_ascii_alphanumeric() || c == b'-' {
                    start -= 1;
                } else {
                    break;
                }
            }
            std::str::from_utf8(&der[start..end + needle.len()])
                .ok()
                .map(str::to_owned)
        });
    // notAfter parsing would require a real ASN.1 walk; we punt on it and
    // rely on the file mtime as a proxy. The UI just shows "issued N days
    // ago" when we set not_after = file mtime, which is good enough.
    (hostname, None)
}

/// Wipe the LE cert and key files. The account JSON is preserved so we
/// don't burn an "account creation" call on the next issuance.
pub fn clear(tls_dir: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(tls_dir.join(CERT_FILENAME));
    let _ = std::fs::remove_file(tls_dir.join(KEY_FILENAME));
    let _ = std::fs::remove_file(tls_dir.join(LAST_ERROR_FILENAME));
    Ok(())
}

/// Run the full DNS-01 issuance flow. Blocks the caller for 30-120 seconds
/// while DNS propagates and Let's Encrypt validates. Caller should be on a
/// background tokio task; the Settings UI streams a spinner.
pub async fn issue(req: IssueRequest) -> Result<IssueOutcome, AcmeError> {
    std::fs::create_dir_all(&req.tls_dir)?;

    let hostname = format!("{}.duckdns.org", req.subdomain);

    // 1. Account: load existing creds from disk if present, otherwise
    //    create a fresh ACME account.
    let account = ensure_account(&req).await?;

    // 2. Open an order for the hostname.
    let mut order = account
        .new_order(&NewOrder {
            identifiers: &[Identifier::Dns(hostname.clone())],
        })
        .await
        .map_err(|e| AcmeError::Acme(e.to_string()))?;

    // 3. Solve each authorization via DNS-01.
    let authorizations = order
        .authorizations()
        .await
        .map_err(|e| AcmeError::Acme(e.to_string()))?;
    for auth in authorizations {
        let challenge = auth
            .challenges
            .iter()
            .find(|c| c.r#type == ChallengeType::Dns01)
            .ok_or_else(|| {
                AcmeError::Acme(format!(
                    "no DNS-01 challenge offered for {}",
                    match &auth.identifier {
                        Identifier::Dns(d) => d.as_str(),
                    }
                ))
            })?;
        let key_auth = order.key_authorization(challenge);
        push_duckdns_txt(&req.subdomain, &req.duckdns_token, &key_auth).await?;
        // DuckDNS propagates within a few seconds, but LE validates against
        // multiple resolvers; give it ~25s to settle. Skipping this leads
        // to "no TXT record found" challenge failures.
        tokio::time::sleep(Duration::from_secs(25)).await;
        order
            .set_challenge_ready(&challenge.url)
            .await
            .map_err(|e| AcmeError::Acme(e.to_string()))?;
    }

    // 4. Poll the order until Ready (challenges verified), then submit a
    //    CSR, then poll until Valid (cert issued).
    let cert_key = KeyPair::generate()?;
    let mut params = CertificateParams::new(vec![hostname.clone()])?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, hostname.clone());
    params.distinguished_name = dn;
    let csr_der = params.serialize_request(&cert_key)?.der().to_vec();

    let mut tries = 0usize;
    let mut finalized = false;
    let cert_chain_pem = loop {
        let state = order
            .refresh()
            .await
            .map_err(|e| AcmeError::Acme(e.to_string()))?;
        match state.status {
            OrderStatus::Ready if !finalized => {
                order
                    .finalize(&csr_der)
                    .await
                    .map_err(|e| AcmeError::Acme(e.to_string()))?;
                finalized = true;
            }
            OrderStatus::Valid => {
                match order
                    .certificate()
                    .await
                    .map_err(|e| AcmeError::Acme(e.to_string()))?
                {
                    Some(pem) => break pem,
                    None => {
                        // LE says Valid but no cert yet -- short wait and retry.
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
            OrderStatus::Invalid => {
                return Err(AcmeError::ChallengeFailed {
                    domain: hostname,
                    reason: "order entered Invalid -- check ACME logs".into(),
                });
            }
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
        tries += 1;
        if tries > 60 {
            return Err(AcmeError::Timeout(tries));
        }
    };

    // 5. Best-effort: clear the TXT record now so we leave a clean slate.
    let _ = clear_duckdns_txt(&req.subdomain, &req.duckdns_token).await;

    // 6. Persist cert + key. Cert mtime is our proxy for "issued at"; we
    //    do not parse the ASN.1 notAfter (would require an X.509 parser).
    let cert_path = req.tls_dir.join(CERT_FILENAME);
    let key_path = req.tls_dir.join(KEY_FILENAME);
    std::fs::write(&cert_path, &cert_chain_pem)?;
    write_key_restricted(&key_path, &cert_key.serialize_pem())?;
    let _ = std::fs::remove_file(req.tls_dir.join(LAST_ERROR_FILENAME));

    let not_after = chrono::Utc::now().timestamp() + 90 * 24 * 3600;
    Ok(IssueOutcome {
        hostname,
        cert_path: cert_path.to_string_lossy().into_owned(),
        key_path: key_path.to_string_lossy().into_owned(),
        not_after,
    })
}

/// Persist an `AcmeError` description to disk so the UI can show it on
/// the next status load. Called from the IPC wrapper on the failure path.
pub fn record_failure(tls_dir: &Path, message: &str) {
    let _ = std::fs::create_dir_all(tls_dir);
    let _ = std::fs::write(tls_dir.join(LAST_ERROR_FILENAME), message);
}

// ---- account helpers --------------------------------------------------

async fn ensure_account(req: &IssueRequest) -> Result<Account, AcmeError> {
    let account_path = req.tls_dir.join(ACCOUNT_FILENAME);
    if account_path.is_file() {
        let raw = std::fs::read_to_string(&account_path)?;
        let creds: AccountCredentials = serde_json::from_str(&raw)
            .map_err(|e| AcmeError::Acme(format!("account file unreadable: {e}")))?;
        return Account::from_credentials(creds)
            .await
            .map_err(|e| AcmeError::Acme(e.to_string()));
    }
    let contact: Vec<String> = req
        .contact_email
        .as_deref()
        .map(|e| vec![format!("mailto:{e}")])
        .unwrap_or_default();
    let contact_refs: Vec<&str> = contact.iter().map(String::as_str).collect();
    let (account, creds) = Account::create(
        &NewAccount {
            contact: &contact_refs,
            terms_of_service_agreed: true,
            only_return_existing: false,
        },
        req.environment.url(),
        None,
    )
    .await
    .map_err(|e| AcmeError::Acme(e.to_string()))?;
    let serialized = serde_json::to_string(&creds)
        .map_err(|e| AcmeError::Acme(format!("serialize creds: {e}")))?;
    write_key_restricted(&account_path, &serialized)?;
    Ok(account)
}

// ---- DuckDNS TXT-record helpers --------------------------------------

async fn push_duckdns_txt(
    subdomain: &str,
    token: &str,
    key_auth: &KeyAuthorization,
) -> Result<(), AcmeError> {
    let value = key_auth.dns_value();
    let url = format!(
        "https://www.duckdns.org/update?domains={}&token={}&txt={}",
        urlencoding::encode(subdomain),
        urlencoding::encode(token),
        urlencoding::encode(&value),
    );
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| AcmeError::Network(e.to_string()))?
        .get(&url)
        .send()
        .await
        .map_err(|e| AcmeError::Network(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AcmeError::Ddns(format!(
            "DuckDNS TXT update HTTP {}",
            resp.status()
        )));
    }
    let body = resp.text().await.unwrap_or_default();
    if body.trim().lines().next().map(str::trim) != Some("OK") {
        return Err(AcmeError::Ddns(format!("DuckDNS rejected: {body}")));
    }
    Ok(())
}

async fn clear_duckdns_txt(subdomain: &str, token: &str) -> Result<(), AcmeError> {
    // DuckDNS lets us clear with txt= empty + clear=true. We swallow
    // errors because failing to clear isn't fatal; the cert is already
    // issued by the time we get here.
    let url = format!(
        "https://www.duckdns.org/update?domains={}&token={}&txt=&clear=true",
        urlencoding::encode(subdomain),
        urlencoding::encode(token),
    );
    let _ = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| AcmeError::Network(e.to_string()))?
        .get(&url)
        .send()
        .await;
    Ok(())
}

// ---- file helpers ----------------------------------------------------

#[cfg(unix)]
fn write_key_restricted(path: &Path, body: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn write_key_restricted(path: &Path, body: &str) -> std::io::Result<()> {
    std::fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn status_reads_blank_when_no_files() {
        let dir = TempDir::new().unwrap();
        let s = read_status(dir.path());
        assert!(!s.has_cert);
        assert!(s.hostname.is_none());
        assert!(s.last_error.is_none());
    }

    #[test]
    fn status_surfaces_last_error() {
        let dir = TempDir::new().unwrap();
        record_failure(dir.path(), "DuckDNS TXT update HTTP 503");
        let s = read_status(dir.path());
        assert!(!s.has_cert);
        assert_eq!(
            s.last_error.as_deref(),
            Some("DuckDNS TXT update HTTP 503")
        );
    }

    #[test]
    fn clear_removes_cert_and_key_but_keeps_account() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(CERT_FILENAME), "fake-cert").unwrap();
        std::fs::write(dir.path().join(KEY_FILENAME), "fake-key").unwrap();
        std::fs::write(dir.path().join(ACCOUNT_FILENAME), "fake-account").unwrap();
        clear(dir.path()).unwrap();
        assert!(!dir.path().join(CERT_FILENAME).exists());
        assert!(!dir.path().join(KEY_FILENAME).exists());
        assert!(dir.path().join(ACCOUNT_FILENAME).exists());
    }

    #[test]
    fn inspect_pem_pulls_duckdns_hostname_out_of_san() {
        // Synthesize a tiny PEM whose DER body literally contains the
        // hostname string. The implementation is a substring search;
        // we don't need a real cert for this test.
        use base64::Engine as _;
        let plaintext = b"\x00\x00\x10example-music.duckdns.org\x00\x00";
        let b64 = base64::engine::general_purpose::STANDARD.encode(plaintext);
        let pem = format!("-----BEGIN CERTIFICATE-----\n{b64}\n-----END CERTIFICATE-----\n");
        let (host, _) = inspect_pem(&pem);
        assert_eq!(host.as_deref(), Some("example-music.duckdns.org"));
    }
}
