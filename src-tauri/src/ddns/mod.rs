//! Step 21 (Phase 6B-ii): Dynamic DNS.
//!
//! Maps a stable hostname (e.g. `example-music.duckdns.org`) to the user's
//! currently-rotating public IP so a phone on cellular has a fixed URL to
//! point at. The provider abstraction lets a future PR add Cloudflare /
//! No-IP / a custom webhook without touching the rest of the app.
//!
//! Storage:
//!   settings.ddns_subdomain      -- the bare name (no `.duckdns.org`)
//!   settings.ddns_last_ip        -- last IP we successfully pushed
//!   settings.ddns_last_update    -- unix timestamp of the last success
//!   settings.ddns_last_error     -- non-empty if the last attempt failed
//!   keychain "ddns_token"        -- DuckDNS update token (secret)
//!
//! Where the token is stored is covered in the note below; the guiding
//! principle is that secrets stay out of source control and the app bundle.

use std::net::IpAddr;
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::{Connection, params};

// Historical -- we used to store the DDNS token in the macOS keychain.
// In practice the `keyring` crate's v3 macOS path silently lost writes
// (`set_password` returned Ok but the entry never persisted) under our
// ad-hoc-signed dev binary. Rather than chase a backend bug we cannot
// reproduce, we keep the DDNS token in the SQLite settings table. The
// threat model is acceptable: anyone with read access to library.db
// already has the user's full music library, so adding one more secret to
// the same trust boundary doesn't weaken anything.
pub const KEYCHAIN_SERVICE: &str = "Beetbot";
pub const KEYCHAIN_USER: &str = "ddns_token";
const SETTING_TOKEN: &str = "ddns_token";

#[derive(Debug, thiserror::Error)]
pub enum DdnsError {
    #[error("no DDNS provider configured")]
    NotConfigured,
    #[error("network error: {0}")]
    Network(String),
    #[error("provider rejected the update: {0}")]
    ProviderRejected(String),
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[async_trait]
pub trait DdnsProvider: Send + Sync {
    fn name(&self) -> &'static str;
    /// Push `ip` to the provider. On success the returned String is the
    /// public hostname now pointing at it (e.g. `example.duckdns.org`).
    async fn update(&self, ip: IpAddr) -> Result<String, DdnsError>;
}

// ---- DuckDNS impl -----------------------------------------------------

pub struct DuckDns {
    pub subdomain: String,
    token: String,
}

impl DuckDns {
    pub fn new(subdomain: String, token: String) -> Self {
        Self { subdomain, token }
    }

    pub fn hostname(&self) -> String {
        format!("{}.duckdns.org", self.subdomain)
    }
}

#[async_trait]
impl DdnsProvider for DuckDns {
    fn name(&self) -> &'static str {
        "duckdns"
    }

    async fn update(&self, ip: IpAddr) -> Result<String, DdnsError> {
        // DuckDNS HTTPS endpoint, query-string auth. The response body is
        // either `OK` (with an optional `\n<ip>` confirming what they
        // recorded) or `KO`. Anything else means an HTTP-layer failure.
        // Docs: https://www.duckdns.org/spec.jsp
        let url = format!(
            "https://www.duckdns.org/update?domains={}&token={}&ip={}",
            urlencoding::encode(&self.subdomain),
            urlencoding::encode(&self.token),
            ip
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| DdnsError::Network(e.to_string()))?;
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| DdnsError::Network(e.to_string()))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| DdnsError::Network(e.to_string()))?;
        let first_line = body.lines().next().unwrap_or("").trim();
        if !status.is_success() {
            return Err(DdnsError::ProviderRejected(format!(
                "HTTP {status}: {first_line}"
            )));
        }
        match first_line {
            "OK" => Ok(self.hostname()),
            "KO" => Err(DdnsError::ProviderRejected(
                "DuckDNS returned KO -- check subdomain and token".into(),
            )),
            other => Err(DdnsError::ProviderRejected(format!(
                "unexpected response: {other}"
            ))),
        }
    }
}

// ---- Settings helpers --------------------------------------------------

pub fn get_subdomain(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'ddns_subdomain'",
        [],
        |r| r.get::<_, String>(0),
    )
    .map(|s| {
        let s = s.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_owned())
        }
    })
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn set_subdomain(conn: &Connection, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('ddns_subdomain', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![value],
    )?;
    Ok(())
}

pub fn clear_settings(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM settings WHERE key IN
            ('ddns_subdomain', 'ddns_last_ip', 'ddns_last_update', 'ddns_last_error')",
        [],
    )?;
    Ok(())
}

/// Read the DDNS token directly from the connection the caller already
/// holds. Use this from any code path that already has the DB mutex
/// locked (IPC handlers, load_status, etc.). Avoids re-locking the same
/// mutex and deadlocking the main thread.
pub fn read_token_from(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![SETTING_TOKEN],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| {
        let t = v.trim();
        if t.is_empty() { None } else { Some(t.to_owned()) }
    })
}

/// Lock-free helper for callers that have no `Connection` handle in
/// scope (e.g., the background updater task before it acquires the DB
/// mutex). MUST NOT be called while holding `DbState.0` -- doing so
/// double-locks the same mutex and freezes the UI.
pub fn read_token() -> Option<String> {
    let arc = DB.get()?;
    let conn = arc.lock().ok()?;
    read_token_from(&conn)
}

pub fn set_token(token: &str) -> Result<(), DdnsError> {
    let arc = DB
        .get()
        .ok_or_else(|| DdnsError::Keychain("DB handle not installed".into()))?;
    let conn = arc
        .lock()
        .map_err(|e| DdnsError::Keychain(format!("db lock: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTING_TOKEN, token.trim()],
    )?;
    Ok(())
}

pub fn clear_token() -> Result<(), DdnsError> {
    let arc = DB
        .get()
        .ok_or_else(|| DdnsError::Keychain("DB handle not installed".into()))?;
    let conn = arc
        .lock()
        .map_err(|e| DdnsError::Keychain(format!("db lock: {e}")))?;
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        params![SETTING_TOKEN],
    )?;
    Ok(())
}

/// Shared DB handle, populated once from `lib.rs::run`. Only used by the
/// background DDNS updater task and the ACME renew task, both of which
/// run on tokio worker threads that *do not* otherwise hold the
/// DbState mutex. Calling any DB-touching ddns helper from a context
/// that already holds `DbState.0.lock()` will deadlock the UI thread --
/// use the `_from(&conn)` variants there instead.
static DB: std::sync::OnceLock<std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>> =
    std::sync::OnceLock::new();

pub fn install_db_handle(db: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>) {
    let _ = DB.set(db);
}

// ---- Status + run-once helper -----------------------------------------

#[derive(Debug, Clone)]
pub struct UpdateOutcome {
    pub hostname: String,
    pub ip: IpAddr,
}

/// Attempt a single update. Returns the new hostname on success or a
/// description of what went wrong. Persists last_ip / last_update /
/// last_error on either path so the Settings UI can render the result.
pub async fn run_once(conn: &std::sync::Mutex<Connection>) -> Result<UpdateOutcome, DdnsError> {
    // Read config under the lock and drop it before the network call.
    let (subdomain, token) = {
        let c = conn.lock().expect("db mutex poisoned");
        let subdomain = get_subdomain(&c)?.ok_or(DdnsError::NotConfigured)?;
        drop(c);
        let token = read_token().ok_or(DdnsError::NotConfigured)?;
        (subdomain, token)
    };
    let ip_str = crate::network::fetch_public_ip()
        .await
        .ok_or_else(|| DdnsError::Network("couldn't fetch public IP".into()))?;
    let ip: IpAddr = ip_str
        .parse()
        .map_err(|_| DdnsError::Network(format!("garbage public IP: {ip_str}")))?;

    let provider = DuckDns::new(subdomain, token);
    let hostname_result = provider.update(ip).await;
    {
        let c = conn.lock().expect("db mutex poisoned");
        match &hostname_result {
            Ok(_host) => {
                let _ = c.execute(
                    "INSERT INTO settings (key, value) VALUES ('ddns_last_ip', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![ip.to_string()],
                );
                let _ = c.execute(
                    "INSERT INTO settings (key, value) VALUES
                       ('ddns_last_update', CAST(strftime('%s','now') AS TEXT))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [],
                );
                let _ = c.execute(
                    "DELETE FROM settings WHERE key = 'ddns_last_error'",
                    [],
                );
            }
            Err(e) => {
                let _ = c.execute(
                    "INSERT INTO settings (key, value) VALUES ('ddns_last_error', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![e.to_string()],
                );
            }
        }
    }
    let host = hostname_result?;
    Ok(UpdateOutcome { hostname: host, ip })
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DdnsStatus {
    pub subdomain: Option<String>,
    pub has_token: bool,
    pub hostname: Option<String>,
    pub last_ip: Option<String>,
    pub last_update_at: Option<i64>,
    pub last_error: Option<String>,
}

pub fn load_status(conn: &Connection) -> rusqlite::Result<DdnsStatus> {
    let subdomain = get_subdomain(conn)?;
    // Use the lock-free variant -- callers (notably the IPC handler) are
    // already holding the DB mutex, and locking it again would deadlock.
    let has_token = read_token_from(conn).is_some();
    let hostname = subdomain.as_ref().map(|s| format!("{s}.duckdns.org"));
    let last_ip = read_setting(conn, "ddns_last_ip")?;
    let last_update_at = read_setting(conn, "ddns_last_update")?
        .and_then(|s| s.parse::<i64>().ok());
    let last_error = read_setting(conn, "ddns_last_error")?;
    Ok(DdnsStatus {
        subdomain,
        has_token,
        hostname,
        last_ip,
        last_update_at,
        last_error,
    })
}

fn read_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duckdns_hostname_assembly() {
        let d = DuckDns::new("foo".into(), "secret".into());
        assert_eq!(d.hostname(), "foo.duckdns.org");
        assert_eq!(d.name(), "duckdns");
    }

    #[test]
    fn subdomain_round_trips_through_settings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        assert!(get_subdomain(&conn).unwrap().is_none());
        set_subdomain(&conn, "my-music").unwrap();
        assert_eq!(get_subdomain(&conn).unwrap().as_deref(), Some("my-music"));
        // Setting empty trims to None on next read.
        set_subdomain(&conn, "   ").unwrap();
        assert!(get_subdomain(&conn).unwrap().is_none());
    }

    #[test]
    fn load_status_reflects_settings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        set_subdomain(&conn, "example-music").unwrap();
        conn.execute(
            "INSERT INTO settings VALUES ('ddns_last_ip', '203.0.113.10')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings VALUES ('ddns_last_update', '1700000000')",
            [],
        )
        .unwrap();
        let status = load_status(&conn).unwrap();
        assert_eq!(status.subdomain.as_deref(), Some("example-music"));
        assert_eq!(status.hostname.as_deref(), Some("example-music.duckdns.org"));
        assert_eq!(status.last_ip.as_deref(), Some("203.0.113.10"));
        assert_eq!(status.last_update_at, Some(1_700_000_000));
        // We're not asserting has_token because the keychain state is
        // out of test control on macOS CI; the load itself working is
        // what matters.
    }
}
