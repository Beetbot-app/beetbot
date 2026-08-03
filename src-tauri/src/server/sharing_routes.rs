//! `/api/sharing/*` — managing who else can open this server.
//!
//! Separate from `server/mod.rs` because that file is already far past the size
//! anything should be, and because everything here turns on ONE question that
//! deserves to be readable on its own: is the caller the owner?
//!
//! ## Why the usual owner test is not enough
//!
//! Elsewhere in this server, "the owner" means [`super::is_this_machine`] — the
//! desktop webview, talking to its own backing server over loopback. That is
//! exactly right for a device list and exactly wrong here, because the owner
//! managing sharing from their own phone is the whole point of the feature: they
//! are away from the Mac, which is when they are most likely to want to share it.
//!
//! A request through a sharing provider arrives from loopback too (the proxy sits
//! in front), so loopback cannot separate the owner's phone from a guest's. What
//! can is the identity the provider stamps on every request it forwards, AFTER
//! stripping any copy the visitor tried to send. So the rule is:
//!
//!   this machine  →  owner
//!   forwarded, role says owner  →  owner
//!   forwarded, role says anything else  →  not the owner
//!   anything else (a paired phone on the LAN, say)  →  not the owner
//!
//! That last line matters. A phone paired over the local network has no verified
//! identity at all — pairing proves somebody typed a six-digit code, not who they
//! are. Letting it invite people would turn a code on a fridge into a way to hand
//! out access.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::sharing::{self, SharingError};

use super::{is_this_machine, AppState};

/// The identity header a sharing provider stamps on a forwarded request. Any
/// inbound copy is stripped by the provider before this one is written, which is
/// the only reason it can be believed.
const ROLE_HEADER: &str = "x-meradomo-role";

/// Whether the caller may manage who else can open this server.
///
/// Pure so the rule is testable without a running server: `this_machine` is the
/// trust classification, `forwarded_role` the verified role of a visitor arriving
/// through a provider.
pub(crate) fn may_manage(this_machine: bool, forwarded_role: Option<&str>) -> bool {
    if this_machine {
        return true;
    }
    matches!(forwarded_role, Some("owner"))
}

fn caller_may_manage(headers: &HeaderMap, addr: &SocketAddr) -> bool {
    let role = headers
        .get(ROLE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    may_manage(is_this_machine(headers, addr), role)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharingStatusBody {
    /// Whether to show the sharing interface at all.
    can_manage: bool,
    /// The provider's display name, for the copy around it.
    provider_name: String,
}

impl SharingStatusBody {
    /// Nothing to show. The same answer for a guest, for a build with no
    /// provider, and for a provider that cannot be reached — the interface has
    /// no use for the difference, and a guest must not be able to infer one.
    fn hidden() -> Self {
        Self {
            can_manage: false,
            provider_name: String::new(),
        }
    }
}

/// `GET /api/sharing/status` — whether to show the interface, and what to call it.
///
/// Answers for every caller rather than refusing, because "you may not manage
/// sharing" is exactly what a guest's client needs to know in order to hide the
/// section. The write routes below still refuse outright.
pub(super) async fn sharing_status(
    State(_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // The caller check is pure header work, so it happens here. Everything below
    // touches the provider and therefore the network.
    if !caller_may_manage(&headers, &addr) {
        return Json(SharingStatusBody::hidden()).into_response();
    }

    // ONE hop off the runtime, not two: `can_manage` and the provider's name are
    // both network calls, and a handler that answers a status probe should not
    // make two round trips to say one thing.
    let named = off_thread(|| {
        let provider = sharing::active_provider();
        if !provider.can_manage() {
            return Ok(None);
        }
        Ok(Some(provider.people()?.provider_name))
    })
    .await;

    match named {
        Ok(Some(provider_name)) => Json(SharingStatusBody {
            can_manage: true,
            provider_name,
        })
        .into_response(),
        // No provider, not connected, or it could not be reached. All of them mean
        // the same thing to the interface: there is nothing to show.
        Ok(None) | Err(_) => Json(SharingStatusBody::hidden()).into_response(),
    }
}

/// `GET /api/sharing/people` — everyone who can open this server.
pub(super) async fn sharing_people(
    State(_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !caller_may_manage(&headers, &addr) {
        return forbidden();
    }
    match off_thread(|| sharing::active_provider().people()).await {
        Ok(people) => Json(people).into_response(),
        Err(e) => sharing_error(e),
    }
}

/// Run a provider call off the async runtime.
///
/// A provider talks to something over the network, so every method may block.
/// Blocking here would stall the thread that is also serving audio, which is the
/// one thing this server must never do.
async fn off_thread<T, F>(f: F) -> Result<T, SharingError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, SharingError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        // The task panicked or the runtime is shutting down. Neither is a
        // refusal, and neither is a success.
        Err(_) => Err(SharingError::Unavailable),
    }
}

#[derive(Deserialize)]
pub(super) struct InviteBody {
    email: String,
}

/// `POST /api/sharing/invite` — share this server with somebody by email.
pub(super) async fn sharing_invite(
    State(_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<InviteBody>,
) -> Response {
    if !caller_may_manage(&headers, &addr) {
        return forbidden();
    }
    let email = body.email.trim().to_string();
    match off_thread(move || sharing::active_provider().invite(&email)).await {
        Ok(()) => StatusCode::CREATED.into_response(),
        Err(e) => sharing_error(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RevokeBody {
    account_id: String,
}

/// `POST /api/sharing/revoke` — take somebody's access away.
pub(super) async fn sharing_revoke(
    State(_state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RevokeBody>,
) -> Response {
    if !caller_may_manage(&headers, &addr) {
        return forbidden();
    }
    let account_id = body.account_id.clone();
    match off_thread(move || sharing::active_provider().revoke(&account_id)).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => sharing_error(e),
    }
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "not_owner" })),
    )
        .into_response()
}

/// A provider's refusal, kept in its own words. The interface shows the message,
/// so flattening it here would replace something specific and actionable with
/// something generic.
fn sharing_error(e: SharingError) -> Response {
    let status = match e {
        SharingError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        SharingError::Refused(_) => StatusCode::BAD_REQUEST,
    };
    (
        status,
        Json(serde_json::json!({ "error": e.to_string() })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::may_manage;

    /// Every provider call must go through `off_thread`.
    ///
    /// Not style — correctness. A provider talks over the network with a blocking
    /// client, and starting one of those inside a Tokio worker panics the thread
    /// outright ("Cannot drop a runtime in a context where blocking is not
    /// allowed"). The handler then returns nothing at all: no status line, no
    /// body, just a closed connection, which reads on the client as "the server
    /// is broken" rather than as anything to do with sharing.
    ///
    /// This happened. `sharing_status` called `can_manage()` directly while the
    /// other three handlers were already off-thread, and every unit test passed
    /// because the rule they check is pure. Only running the app found it.
    #[test]
    fn no_handler_calls_the_provider_on_the_async_runtime() {
        let whole = include_str!("sharing_routes.rs");
        let production = whole.split("#[cfg(test)]").next().unwrap();

        for (i, line) in production.lines().enumerate() {
            if !line.contains("sharing::active_provider()") {
                continue;
            }
            // Either the call is inside an off_thread closure on the same line,
            // or it is inside the multi-line closure `off_thread` was handed —
            // in which case the line is indented well past handler level.
            let inside_off_thread = line.contains("off_thread(");
            let inside_closure = line.starts_with("        ");
            assert!(
                inside_off_thread || inside_closure,
                "line {} calls the provider on the runtime thread: {}",
                i + 1,
                line.trim(),
            );
        }
    }

    /// The desktop webview, talking to its own server.
    #[test]
    fn this_machine_may_manage() {
        assert!(may_manage(true, None));
    }

    /// The owner, on their phone, through a sharing provider. The case the whole
    /// feature exists for: they are away from the Mac, which is exactly when they
    /// want to share it.
    #[test]
    fn the_owner_through_a_provider_may_manage() {
        assert!(may_manage(false, Some("owner")));
    }

    /// Somebody the owner shared with. They can play music; they cannot hand out
    /// access to somebody else's computer.
    ///
    /// The comparison is exact — no case folding, no "starts with". Padding is
    /// dealt with once, at the header boundary in `caller_may_manage`, so this
    /// rule never has to guess what a nearly-matching value meant.
    #[test]
    fn a_guest_may_not_manage() {
        assert!(!may_manage(false, Some("member")));
        assert!(!may_manage(false, Some("")));
        assert!(!may_manage(false, Some("OWNER")));
        assert!(!may_manage(false, Some("owner ")));
        assert!(!may_manage(false, Some("owner,member")));
    }

    /// A phone paired over the local network. Pairing proves somebody typed a
    /// six-digit code, not who they are — so it must not be a way to hand out
    /// access.
    #[test]
    fn a_paired_lan_device_may_not_manage() {
        assert!(!may_manage(false, None));
    }
}
