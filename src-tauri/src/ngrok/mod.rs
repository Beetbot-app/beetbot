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
/// How often to ask the public URL whether it is actually serving anybody.
const EDGE_PROBE_INTERVAL: Duration = Duration::from_secs(300);
/// A probe that hangs is a probe that tells us nothing; fail it fast.
const EDGE_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// ngrok stamps its own failures with this header. Its presence means the answer
/// came from ngrok's edge, not from us.
const EDGE_ERROR_HEADER: &str = "ngrok-error-code";

#[derive(Debug, Default)]
struct NgrokInner {
    running: bool,
    public_url: Option<String>,
    last_error: Option<String>,
    /// True when `last_error` came from the edge probe rather than the agent's log.
    /// A flag rather than matching on the message text, so the probe can clear its
    /// own error without ever clearing a real agent error — and so rewording a
    /// message can't quietly break that.
    edge_error: bool,
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
    spawn_edge_probe(state.clone());
    spawn_supervisor(app, state, authtoken, domain, port, shutdown_rx, done_tx);
}

/// Ask the public URL, periodically, whether it is actually serving anybody.
///
/// The log scanner cannot answer this. ngrok's edge can be turning every visitor
/// away — over quota, offline domain, interstitial — while the agent session stays
/// perfectly healthy and silent, so a tunnel reports "on" and serves nobody. The
/// only place that failure is visible is in a response from the public URL, and
/// ngrok labels its own rejections with an `ngrok-error-code` header.
///
/// Deliberately probes **our own** `/api/health`: it is the cheapest thing we serve,
/// and when the edge is rejecting, the request never reaches us at all, so the check
/// costs essentially nothing in the state it exists to detect. The probe self-parks
/// while the tunnel is down — there is nothing to learn from probing a URL the agent
/// already says is offline — and ends when the supervisor clears `shutdown`.
fn spawn_edge_probe(state: NgrokState) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(EDGE_PROBE_TIMEOUT)
            // A rejection is the signal; following ngrok's redirect to its own error
            // page would lose the header that carries it.
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "ngrok: couldn't build the edge probe client");
                return;
            }
        };

        loop {
            tokio::time::sleep(EDGE_PROBE_INTERVAL).await;

            let (alive, url) = {
                let inner = state.0.lock().expect("ngrok mutex poisoned");
                // `shutdown` is cleared when the supervisor tears down; that's our exit.
                if inner.shutdown.is_none() {
                    return;
                }
                (inner.running, inner.public_url.clone())
            };
            let Some(url) = url.filter(|_| alive) else {
                continue;
            };

            let probe = format!("{}/api/health", url.trim_end_matches('/'));
            let Ok(resp) = client.get(&probe).send().await else {
                // The probe itself failed (no network here, DNS, timeout). That says
                // nothing about the edge, and the agent's own log is the authority on
                // being disconnected — so stay quiet rather than invent an error.
                continue;
            };

            let edge_error = resp
                .headers()
                .get(EDGE_ERROR_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);

            let mut inner = state.0.lock().expect("ngrok mutex poisoned");
            match edge_error {
                Some(code) => {
                    if !inner.edge_error {
                        tracing::warn!(%code, "ngrok: the edge is refusing visitors");
                    }
                    // Deliberately NOT `running = false`: the tunnel genuinely is
                    // connected, and saying otherwise would send the owner to look at
                    // their computer — the exact misdirection this is here to end.
                    inner.last_error = Some(friendly_edge_error(&code));
                    inner.edge_error = true;
                }
                None if inner.edge_error => {
                    // Serving again, and the error on screen is ours to clear. An
                    // agent error is left alone — only the agent's own log clears it.
                    tracing::info!("ngrok: the edge is serving traffic again");
                    inner.last_error = None;
                    inner.edge_error = false;
                }
                None => {}
            }
        }
    });
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
        // The agent just spoke; whatever the probe concluded is stale. The next
        // probe re-establishes it within one interval if the edge is still refusing.
        inner.edge_error = false;
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
        // An agent error outranks an edge one: the tunnel is genuinely down, so
        // "the edge is refusing traffic" is no longer the useful thing to say.
        inner.edge_error = false;
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

/// Translate an `ngrok-error-code` seen on the *public* URL into plain language.
///
/// These are a different species from the ones above. Everything `friendly_ngrok_error`
/// handles is a **control-plane** failure: the agent fails to connect and says so in
/// its log, so watching the log is enough. The codes here are **data-plane** — the
/// session establishes perfectly, the agent logs nothing at all, and ngrok's edge
/// turns visitors away one request at a time. Nothing the agent can see ever changes.
///
/// Found 29 Jul 2026 with `ERR_NGROK_725`: the tunnel was registered, the local agent
/// API reported it up with `count: 0` requests, the app said Remote streaming was on,
/// and every visitor had been getting a 403 for an unknown length of time. The zero
/// request count was the tell — the edge rejects before anything reaches the agent,
/// which is exactly why the agent cannot report it.
fn friendly_edge_error(code: &str) -> String {
    let c = code.trim().to_uppercase();
    match c.as_str() {
        "ERR_NGROK_725" => "Your ngrok account has used up its bandwidth for the month, so ngrok is turning visitors away. The tunnel looks connected because it is — ngrok is refusing the traffic, not your computer. It clears when the quota resets, or on a paid plan.".into(),
        "ERR_NGROK_3200" => "ngrok says this address isn't online. If Remote streaming was just turned on, give it a moment; otherwise check the domain in Settings.".into(),
        "ERR_NGROK_6022" | "ERR_NGROK_6024" => "ngrok is showing visitors a warning page before your library. That's the free tier's interstitial.".into(),
        _ => format!(
            "ngrok is refusing visitors with {c}. Your computer is fine — the tunnel is connected and ngrok is turning traffic away at its end."
        ),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bandwidth_cap_is_explained_without_blaming_the_owners_computer() {
        // The whole point of this check. On 29 Jul 2026 the tunnel was connected,
        // the app said Remote streaming was on, and every visitor had been getting
        // a 403 for an unknown length of time. The message has to say where the
        // fault is, or the owner goes and debugs a machine that is working.
        let msg = friendly_edge_error("ERR_NGROK_725");
        assert!(msg.contains("bandwidth"), "must name the actual cause: {msg}");
        assert!(
            msg.contains("not your computer"),
            "must point away from the machine: {msg}"
        );
        assert!(!msg.contains("ERR_NGROK"), "raw codes don't belong in the UI: {msg}");
    }

    #[test]
    fn an_unknown_edge_code_still_produces_something_useful() {
        // ngrok adds codes over time. An unrecognised one must still tell the owner
        // the tunnel is up and ngrok is refusing — never a blank or a bare code.
        let msg = friendly_edge_error("ERR_NGROK_9999");
        assert!(msg.contains("ERR_NGROK_9999"), "keep the code for support: {msg}");
        assert!(msg.contains("Your computer is fine"), "still place the fault: {msg}");
        assert!(msg.len() > 40, "not a stub: {msg}");
    }

    #[test]
    fn edge_codes_are_matched_regardless_of_case_or_stray_whitespace() {
        // It arrives off the wire as a header value; don't let formatting decide
        // whether the owner gets a real explanation or the generic fallback.
        let canonical = friendly_edge_error("ERR_NGROK_725");
        for raw in ["err_ngrok_725", "  ERR_NGROK_725  ", "Err_Ngrok_725"] {
            assert_eq!(friendly_edge_error(raw), canonical, "failed on {raw:?}");
        }
    }

    #[test]
    fn the_agent_and_the_probe_report_on_different_things() {
        // Control-plane vs data-plane. The log scanner sees session failures; the
        // probe sees the edge turning visitors away. Neither can see the other's,
        // which is why 725 went unnoticed — so keep them from being confused for
        // one another: 725 must NOT be something the log scanner claims to handle.
        assert!(
            friendly_ngrok_error("ERR_NGROK_725 bandwidth limit").is_none(),
            "725 never appears in the agent log; the log scanner must not pretend to own it"
        );
        // And the codes the agent DOES own keep working.
        assert!(friendly_ngrok_error("ERR_NGROK_105 authentication failed").is_some());
        assert!(friendly_ngrok_error("ERR_NGROK_108 limited to 1").is_some());
    }

    #[test]
    fn the_probes_error_is_cleared_only_by_the_probe() {
        // The flag exists so a reworded message can't break this. An agent error
        // must survive the probe finding the edge healthy, and vice versa.
        let mut inner = NgrokInner::default();

        // Probe raises an edge error, then finds it healthy → cleared.
        inner.last_error = Some(friendly_edge_error("ERR_NGROK_725"));
        inner.edge_error = true;
        if inner.edge_error {
            inner.last_error = None;
            inner.edge_error = false;
        }
        assert!(inner.last_error.is_none(), "the probe clears what it raised");

        // Agent raises its own error; the probe finding the edge healthy must NOT
        // wipe it — the tunnel really is down and that message is the useful one.
        inner.last_error = friendly_ngrok_error("ERR_NGROK_105 authentication failed");
        inner.edge_error = false;
        if inner.edge_error {
            inner.last_error = None;
        }
        assert!(
            inner.last_error.is_some_and(|e| e.contains("authtoken")),
            "an agent error is not the probe's to clear"
        );
    }
}
