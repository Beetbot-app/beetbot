//! In-app ngrok tunnel — an alternative to DuckDNS + router port-forwarding for
//! reaching the streaming server from the public internet.
//!
//! We run the **bundled `ngrok` CLI** as a managed sidecar process (a binary
//! shipped inside the app, spawned and supervised by it). The CLI is the
//! official, battle-tested agent — far more reliable at holding a long-lived
//! tunnel than the embeddable
//! library — yet from the user's side it's still "paste two values and it works":
//! the app ships the binary, spawns it, supervises it (restart on crash, kill on
//! exit), and feeds it the user's authtoken + domain. No separate install, no
//! terminal, no `ngrok.yml`.
//!
//! Lifecycle mirrors the UPnP supervisor — started/stopped when Remote streaming
//! is toggled, and on launch if already enabled. Forwards a public HTTPS endpoint
//! to `127.0.0.1:<streaming_port>`.
//!
//! Settings keys (same trust boundary as `ddns_token` — anyone who can read
//! library.db already has the whole library):
//!   ngrok_authtoken  -- secret agent token
//!   ngrok_domain     -- reserved domain, e.g. `foo.ngrok-free.dev`
//!
//! Runtime status (whether the tunnel is up, its public URL, last error) lives
//! in `NgrokState` and is NOT persisted.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::oneshot;

use crate::settings::{get_setting, set_setting};

const SETTING_AUTHTOKEN: &str = "ngrok_authtoken";
const SETTING_DOMAIN: &str = "ngrok_domain";

/// Name of the bundled sidecar binary (see `externalBin` in tauri.conf.json).
const SIDECAR: &str = "ngrok";
/// Pause before respawning the agent after it exits unexpectedly.
const RETRY_DELAY: Duration = Duration::from_secs(3);
/// How long app exit waits for the agent to be killed before proceeding anyway.
const STOP_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Default)]
struct NgrokInner {
    running: bool,
    public_url: Option<String>,
    last_error: Option<String>,
    /// Sending/dropping this asks the supervisor to stop (and kill the agent).
    /// Present while a supervisor is alive; also the "already running" guard.
    shutdown: Option<oneshot::Sender<()>>,
    /// Resolves once the supervisor has fully torn down (agent killed).
    done: Option<oneshot::Receiver<()>>,
}

#[derive(Clone)]
pub struct NgrokState(Arc<Mutex<NgrokInner>>);

impl NgrokState {
    pub fn new() -> Self {
        NgrokState(Arc::new(Mutex::new(NgrokInner::default())))
    }
}

impl Default for NgrokState {
    fn default() -> Self {
        Self::new()
    }
}

/// What the Settings UI renders: persisted config presence + live runtime status.
#[derive(Debug, Clone, Default, Serialize)]
pub struct NgrokStatus {
    pub has_authtoken: bool,
    pub domain: Option<String>,
    pub running: bool,
    pub public_url: Option<String>,
    pub last_error: Option<String>,
}

pub fn status(conn: &rusqlite::Connection, state: &NgrokState) -> NgrokStatus {
    let has_authtoken = read_authtoken(conn).is_some();
    let domain = read_domain(conn);
    let inner = state.0.lock().expect("ngrok mutex poisoned");
    NgrokStatus {
        has_authtoken,
        domain,
        running: inner.running,
        public_url: inner.public_url.clone(),
        last_error: inner.last_error.clone(),
    }
}

fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

pub fn read_authtoken(conn: &rusqlite::Connection) -> Option<String> {
    nonempty(get_setting(conn, SETTING_AUTHTOKEN).ok().flatten())
}

pub fn read_domain(conn: &rusqlite::Connection) -> Option<String> {
    nonempty(get_setting(conn, SETTING_DOMAIN).ok().flatten())
}

pub fn set_authtoken(conn: &rusqlite::Connection, authtoken: &str) -> rusqlite::Result<()> {
    set_setting(conn, SETTING_AUTHTOKEN, authtoken.trim())
}

pub fn set_domain(conn: &rusqlite::Connection, domain: &str) -> rusqlite::Result<()> {
    set_setting(conn, SETTING_DOMAIN, domain.trim())
}

pub fn clear_config(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    set_setting(conn, SETTING_AUTHTOKEN, "")?;
    set_setting(conn, SETTING_DOMAIN, "")?;
    Ok(())
}

/// Start (or no-op if already up) the ngrok agent forwarding to
/// `127.0.0.1:<port>`. Spawns + supervises the bundled CLI; status is filled in
/// from the supervisor task as the agent connects.
pub fn start(
    app: tauri::AppHandle,
    state: NgrokState,
    authtoken: String,
    domain: Option<String>,
    port: u16,
) {
    let (shutdown_rx, done_tx) = {
        let mut inner = state.0.lock().expect("ngrok mutex poisoned");
        if inner.shutdown.is_some() {
            return; // already running or starting
        }
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        inner.shutdown = Some(shutdown_tx);
        inner.done = Some(done_rx);
        inner.last_error = None;
        (shutdown_rx, done_tx)
    };
    spawn_supervisor(app, state, authtoken, domain, port, shutdown_rx, done_tx);
}

fn spawn_supervisor(
    app: tauri::AppHandle,
    state: NgrokState,
    authtoken: String,
    domain: Option<String>,
    port: u16,
    mut shutdown: oneshot::Receiver<()>,
    done: oneshot::Sender<()>,
) {
    tauri::async_runtime::spawn(async move {
        tracing::info!(port, ?domain, "ngrok: starting sidecar agent");
        let fallback_url = domain.as_ref().map(|d| format!("https://{d}"));

        let mut args: Vec<String> = vec!["http".into()];
        if let Some(d) = &domain {
            args.push(format!("--url={d}"));
        }
        args.push(port.to_string());
        // Machine-readable logs so we can detect connect/errors on stdout.
        args.push("--log=stdout".into());
        args.push("--log-format=json".into());

        // Respawn loop: the CLI maintains its own connection (incl. reconnects),
        // so it should rarely exit; if it ever does, we restart it. `shutdown`
        // breaks out and kills the agent.
        loop {
            let spawn = app
                .shell()
                .sidecar(SIDECAR)
                .map(|c| c.env("NGROK_AUTHTOKEN", &authtoken).args(&args))
                .and_then(|c| c.spawn());

            let (mut rx, child) = match spawn {
                Ok(pair) => pair,
                Err(e) => {
                    fail(&state, format!("couldn't start ngrok agent: {e}"));
                    tokio::select! {
                        _ = &mut shutdown => break,
                        _ = tokio::time::sleep(RETRY_DELAY) => continue,
                    }
                }
            };
            let mut child = Some(child);
            let mut pending = String::new();
            let mut stopped = false;

            loop {
                tokio::select! {
                    _ = &mut shutdown => {
                        if let Some(c) = child.take() {
                            let _ = c.kill();
                        }
                        stopped = true;
                        break;
                    }
                    ev = rx.recv() => match ev {
                        Some(CommandEvent::Stdout(bytes)) | Some(CommandEvent::Stderr(bytes)) => {
                            pending.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(nl) = pending.find('\n') {
                                let line: String = pending.drain(..=nl).collect();
                                ingest_log(&state, line.trim(), &fallback_url);
                            }
                        }
                        Some(CommandEvent::Terminated(payload)) => {
                            tracing::warn!(code = ?payload.code, "ngrok: agent exited");
                            break; // respawn
                        }
                        Some(_) => {}
                        None => break, // event stream closed → agent gone
                    },
                }
            }

            if stopped {
                break;
            }
            // Agent died on its own — mark down and retry unless asked to stop.
            {
                let mut inner = state.0.lock().expect("ngrok mutex poisoned");
                inner.running = false;
                inner.public_url = None;
            }
            tokio::select! {
                _ = &mut shutdown => break,
                _ = tokio::time::sleep(RETRY_DELAY) => {}
            }
        }

        tracing::info!("ngrok: agent stopped");
        {
            let mut inner = state.0.lock().expect("ngrok mutex poisoned");
            inner.running = false;
            inner.public_url = None;
            inner.shutdown = None;
        }
        let _ = done.send(());
    });
}

/// Parse a line of the agent's JSON log to update connection status.
fn ingest_log(state: &NgrokState, line: &str, fallback_url: &Option<String>) {
    if line.is_empty() {
        return;
    }
    let lower = line.to_lowercase();

    // Connected — initial bind OR a reconnect. ngrok logs one of these every time
    // it (re)establishes a session, so they're how we recover the status after a
    // transient drop (e.g. the Mac sleeping). Without catching the reconnect
    // events, the UI would stay stuck on the last error after a blip.
    let connected = lower.contains("started tunnel")
        || lower.contains("tunnel session started")
        || lower.contains("client session established")
        || lower.contains("join connections");
    if connected {
        let url = extract_json_str(line, "url").or_else(|| fallback_url.clone());
        let mut inner = state.0.lock().expect("ngrok mutex poisoned");
        let was_down = !inner.running;
        inner.running = true;
        if url.is_some() {
            inner.public_url = url;
        } else if inner.public_url.is_none() {
            inner.public_url = fallback_url.clone();
        }
        inner.last_error = None;
        if was_down {
            tracing::info!("ngrok: tunnel online");
        }
        return;
    }

    // A genuine, non-self-healing error we can explain in plain language.
    if let Some(friendly) = friendly_ngrok_error(line) {
        tracing::warn!(%line, "ngrok: agent error");
        let mut inner = state.0.lock().expect("ngrok mutex poisoned");
        inner.running = false;
        inner.last_error = Some(friendly);
        return;
    }

    // Transient connection wobble — the CLI reconnects on its own (almost always
    // a Mac sleep/wake or wifi blip). Reflect "not connected right now" but DON'T
    // surface a scary raw error; a reconnect event above will flip it back.
    if lower.contains("heartbeat timeout")
        || lower.contains("session closed")
        || lower.contains("reconnect")
        || lower.contains("no such host")
        || lower.contains("read eof")
    {
        let mut inner = state.0.lock().expect("ngrok mutex poisoned");
        inner.running = false;
        // Leave last_error clear — this is normal, self-healing reconnection.
    }
}

/// Translate the handful of ngrok errors that *won't* fix themselves into a plain
/// message for the user. Returns `None` for transient/unknown lines (handled as
/// reconnects), so we never dump raw JSON into the UI.
fn friendly_ngrok_error(line: &str) -> Option<String> {
    let l = line.to_lowercase();
    if line.contains("ERR_NGROK_105")
        || l.contains("authentication failed")
        || l.contains("invalid auth")
        || l.contains("authtoken")
    {
        return Some(
            "Your ngrok authtoken looks invalid — re-copy it from ngrok.com and paste it again."
                .into(),
        );
    }
    if line.contains("ERR_NGROK_334") || l.contains("already online") || l.contains("already bound")
    {
        return Some(
            "That ngrok domain is already in use by another ngrok session. Close the other one and try again."
                .into(),
        );
    }
    if line.contains("ERR_NGROK_108") || l.contains("limited to") || l.contains("simultaneous") {
        return Some(
            "ngrok's plan limit was hit (the free tier allows one tunnel at a time). Close other ngrok sessions."
                .into(),
        );
    }
    None
}

/// Pull a string value out of a flat JSON log line: `"key":"value"`.
fn extract_json_str(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn fail(state: &NgrokState, msg: String) {
    tracing::warn!(%msg, "ngrok tunnel error");
    let mut inner = state.0.lock().expect("ngrok mutex poisoned");
    inner.running = false;
    inner.public_url = None;
    inner.last_error = Some(msg);
}

/// Stop the tunnel if running (does not wait for the agent to exit). Idempotent.
pub fn stop(state: &NgrokState) {
    let mut inner = state.0.lock().expect("ngrok mutex poisoned");
    if let Some(tx) = inner.shutdown.take() {
        let _ = tx.send(());
    }
    inner.running = false;
    inner.public_url = None;
    inner.done = None;
}

/// Stop the tunnel and **block** until the agent has been killed (capped at
/// [`STOP_TIMEOUT`]). Call from the app's exit handler so we don't leave a
/// detached ngrok process behind after Beetbot quits.
pub fn shutdown_blocking(state: &NgrokState) {
    let (shutdown, done) = {
        let mut inner = state.0.lock().expect("ngrok mutex poisoned");
        (inner.shutdown.take(), inner.done.take())
    };
    let Some(shutdown) = shutdown else {
        return; // not running
    };
    let _ = shutdown.send(());
    if let Some(done) = done {
        let _ = tauri::async_runtime::block_on(async move {
            tokio::time::timeout(STOP_TIMEOUT + Duration::from_secs(1), done).await
        });
    }
}
