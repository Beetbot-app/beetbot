//! Who a request is, when it arrives through a sharing provider.
//!
//! A provider that signs visitors in stamps their verified identity onto every
//! request it forwards, having first stripped any copy the visitor tried to send.
//! That stripping is the whole basis for believing these headers: without it they
//! would be a request body with a fancy name.
//!
//! What it buys us: somebody the owner shared this server with gets their OWN
//! Beetbot account — their own playlists, their own history — without anybody
//! setting one up, and without them ever meeting a pairing code.
//!
//! ## Why the owner is deliberately excluded
//!
//! The owner also arrives with an identity when they open their own library from
//! their phone. Giving them an identity-bound profile would mint a SECOND account
//! beside the one they use on the Mac, and split their library in half. So the
//! owner keeps the path they already have — pick a profile, the session
//! remembers it — and only guests are auto-provisioned.

use axum::http::HeaderMap;

/// The provider name stored against an auto-created profile. A single string, so
/// that if a second provider ever appears the two cannot collide in the profile
/// table.
pub(crate) const IDENTITY_PROVIDER: &str = "meradomo";

const SUB_HEADER: &str = "x-meradomo-user";
const EMAIL_HEADER: &str = "x-meradomo-email";
const ROLE_HEADER: &str = "x-meradomo-role";

/// A guest: somebody signed in through a provider who is not the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Guest {
    /// The provider's stable id for this person. What their profile is keyed on.
    pub sub: String,
    /// Their address, for the profile's display name. May be empty.
    pub email: String,
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The guest this request belongs to, if it belongs to one.
///
/// Returns `None` for the owner, for a request with no identity at all (the
/// desktop, a paired phone on the local network), and for an identity with no
/// stable id — which is not an identity, whatever else it carries.
pub(crate) fn guest_of(headers: &HeaderMap) -> Option<Guest> {
    let role = header(headers, ROLE_HEADER);
    if role == Some("owner") {
        return None;
    }
    // No role at all means no provider in front — a bare local request. Treat it
    // as nobody rather than guessing, so the LAN path is untouched by any of this.
    role?;
    let sub = header(headers, SUB_HEADER)?;
    Some(Guest {
        sub: sub.to_string(),
        email: header(headers, EMAIL_HEADER).unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn a_guest_is_recognised() {
        let g = guest_of(&headers(&[
            (ROLE_HEADER, "member"),
            (SUB_HEADER, "acct-123"),
            (EMAIL_HEADER, "sam@example.com"),
        ]))
        .expect("a signed-in visitor is a guest");
        assert_eq!(g.sub, "acct-123");
        assert_eq!(g.email, "sam@example.com");
    }

    #[test]
    fn the_owner_is_not_a_guest() {
        // Otherwise opening your own library from your own phone would mint a
        // second account beside the one on your Mac and split your library.
        assert_eq!(
            guest_of(&headers(&[
                (ROLE_HEADER, "owner"),
                (SUB_HEADER, "acct-owner"),
                (EMAIL_HEADER, "me@example.com"),
            ])),
            None
        );
    }

    #[test]
    fn a_local_request_is_nobody() {
        assert_eq!(guest_of(&HeaderMap::new()), None);
    }

    #[test]
    fn an_identity_with_no_stable_id_is_not_an_identity() {
        assert_eq!(
            guest_of(&headers(&[(ROLE_HEADER, "member"), (EMAIL_HEADER, "sam@example.com")])),
            None
        );
        assert_eq!(
            guest_of(&headers(&[(ROLE_HEADER, "member"), (SUB_HEADER, "   ")])),
            None
        );
    }

    #[test]
    fn an_address_is_optional() {
        // A provider that gives us an id but no address still identifies somebody;
        // the profile just falls back to a generic name.
        let g = guest_of(&headers(&[(ROLE_HEADER, "member"), (SUB_HEADER, "acct-1")])).unwrap();
        assert_eq!(g.email, "");
    }
}
