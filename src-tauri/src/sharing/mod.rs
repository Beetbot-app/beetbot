//! Sharing this server with other people, through whatever provider the host
//! build supplies.
//!
//! The open build has no provider. [`active_provider`] then returns a no-op that
//! reports itself unavailable, every call fails closed, and both user interfaces
//! render nothing — so this module costs the open product a trait object and
//! changes none of its behaviour.
//!
//! Deliberately provider-agnostic, exactly like [`crate::acquisition`]: nothing
//! here names a service, a protocol, or a product. The display name is a string
//! that arrives at runtime, so the copy around it reads correctly whoever
//! supplies it.
//!
//! It is also deliberately SMALL. A provider may well manage a whole computer's
//! worth of people, apps and folders; this cares about one question — who can
//! open THIS server, and how do I add or remove somebody. Anything richer belongs
//! in the provider's own surface, not bolted onto a music player.

use std::sync::Arc;

use serde::Serialize;

/// Somebody who can open this server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingPerson {
    pub email: String,
    /// Opaque id used to remove them. Meaningful only to the provider.
    pub account_id: String,
    /// True for whoever owns the server. They cannot be removed.
    pub is_owner: bool,
    /// True once they have accepted; false while the invitation is outstanding.
    pub accepted: bool,
}

/// Everyone with access, plus the provider's name for the copy around them.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SharingPeople {
    pub provider_name: String,
    pub people: Vec<SharingPerson>,
}

/// Why a sharing call could not be completed.
///
/// Two cases only, because there are only two useful reactions: hide the feature,
/// or show the person what the provider said. Inventing a taxonomy here would
/// mean translating the provider's words into our own and losing the specifics
/// that make them worth showing ("that does not look like an email address").
#[derive(Debug, thiserror::Error)]
pub enum SharingError {
    /// No provider, or it is not connected yet. The interface hides.
    #[error("sharing is not available")]
    Unavailable,
    /// The provider refused, in words meant to be shown to a person.
    #[error("{0}")]
    Refused(String),
}

/// The seam a host build implements to offer sharing.
///
/// Implementations do the network work, so every method may block; call them off
/// the request path where that matters.
pub trait SharingProvider: Send + Sync {
    /// Stable identity for diagnostics. Not shown to anyone.
    fn name(&self) -> &'static str;

    /// Whether sharing can be managed right now. False in the open build, and
    /// false when a provider exists but is not connected to an account yet.
    fn can_manage(&self) -> bool;

    /// Everyone who can open this server.
    fn people(&self) -> Result<SharingPeople, SharingError>;

    /// Invite somebody by email, giving them access to this server and nothing
    /// else. What "this server" means is the provider's business.
    fn invite(&self, email: &str) -> Result<(), SharingError>;

    /// Take away somebody's access.
    fn revoke(&self, account_id: &str) -> Result<(), SharingError>;
}

/// The stand-in when no provider was registered — the entire open build.
struct NoSharing;

impl SharingProvider for NoSharing {
    fn name(&self) -> &'static str {
        "none"
    }
    fn can_manage(&self) -> bool {
        false
    }
    fn people(&self) -> Result<SharingPeople, SharingError> {
        Err(SharingError::Unavailable)
    }
    fn invite(&self, _email: &str) -> Result<(), SharingError> {
        Err(SharingError::Unavailable)
    }
    fn revoke(&self, _account_id: &str) -> Result<(), SharingError> {
        Err(SharingError::Unavailable)
    }
}

static PROVIDER: std::sync::OnceLock<Arc<dyn SharingProvider>> = std::sync::OnceLock::new();

/// Install the provider ONCE at startup. Later calls are silent no-ops, matching
/// [`crate::acquisition::register_provider`]. The open build never calls this.
#[allow(dead_code)] // host seam: the open build relies on the default-on-read.
pub fn register_provider(p: Arc<dyn SharingProvider>) {
    let _ = PROVIDER.set(p);
}

/// The active provider, defaulting to the no-op so the open build needs no
/// wiring and behaves exactly as it did before this module existed.
pub fn active_provider() -> Arc<dyn SharingProvider> {
    PROVIDER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoSharing))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_open_build_offers_no_sharing() {
        // Not registered in this test binary, so this is the real default.
        let p = active_provider();
        assert!(!p.can_manage());
        assert!(matches!(p.people(), Err(SharingError::Unavailable)));
        assert!(matches!(p.invite("a@b.c"), Err(SharingError::Unavailable)));
        assert!(matches!(p.revoke("acc"), Err(SharingError::Unavailable)));
    }

    #[test]
    fn a_refusal_keeps_the_words_it_arrived_with() {
        // The interface shows these verbatim, so a provider's careful wording
        // must not be flattened into a generic failure on the way through.
        let e = SharingError::Refused("that does not look like an email address".into());
        assert_eq!(e.to_string(), "that does not look like an email address");
    }
}
