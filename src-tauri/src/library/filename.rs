//! Filename construction for downloaded tracks.
//!
//! Plan §5.2 spells out the rules:
//!   1. NFC-normalize Unicode (so `é` is one codepoint, not two).
//!   2. Replace OS-illegal chars `< > : " / \ | ? *` (cross-platform safe
//!      set) and control chars with `_`.
//!   3. Strip leading / trailing whitespace and dots.
//!   4. Cap each component at 100 chars (filesystems typically allow 255,
//!      leave headroom for the extension and " (N)" collision suffix).
//!   5. Multi-artist join with ", ".
//!   6. Collision: append " (2)", " (3)", etc.
//!
//! `tracks.local_path` is the source of truth — never regenerate the path
//! from metadata after the file lands. The collision suffix means renames
//! in the DB would desync from disk otherwise.

use unicode_normalization::UnicodeNormalization;

const MAX_COMPONENT_CHARS: usize = 100;
const ILLEGAL: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Sanitise a single path component (no slashes ever land in the output).
pub fn sanitize_component(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    let cleaned: String = nfc
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let capped: String = trimmed.chars().take(MAX_COMPONENT_CHARS).collect();
    let capped = capped.trim().trim_matches('.').to_owned();
    if capped.is_empty() {
        "_".to_string()
    } else {
        capped
    }
}

/// Build the basename (no extension) for a track; the caller appends the audio
/// extension (e.g. `.m4a`).
pub fn build_basename(artists: &[String], title: &str) -> String {
    let joined = if artists.is_empty() {
        String::new()
    } else {
        artists.join(", ")
    };
    let artist_clean = sanitize_component(&joined);
    let title_clean = sanitize_component(title);
    if artist_clean == "_" {
        title_clean
    } else {
        format!("{artist_clean} - {title_clean}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_os_illegal_chars() {
        let s = sanitize_component(r#"Track / With \ Bad ? Chars : * < > | ""#);
        for bad in ILLEGAL {
            assert!(!s.contains(*bad), "left {bad:?} in {s:?}");
        }
    }

    #[test]
    fn strips_leading_trailing_whitespace_and_dots() {
        assert_eq!(sanitize_component("  ...Hello.  "), "Hello");
        assert_eq!(sanitize_component("."), "_");
        assert_eq!(sanitize_component("   "), "_");
    }

    #[test]
    fn nfc_normalizes_combining_chars() {
        // "café" with combining accent (4 codepoints) vs precomposed (4 chars).
        let decomposed = "cafe\u{0301}"; // e + combining acute
        let s = sanitize_component(decomposed);
        // NFC collapses to "café" (3 codepoints).
        assert_eq!(s, "café");
        assert_eq!(s.chars().count(), 4);
    }

    #[test]
    fn caps_each_component_at_100_chars() {
        let long = "x".repeat(500);
        assert_eq!(sanitize_component(&long).chars().count(), 100);
    }

    #[test]
    fn build_basename_joins_artists_with_comma() {
        assert_eq!(
            build_basename(&["Daft Punk".into(), "Pharrell Williams".into()], "Get Lucky"),
            "Daft Punk, Pharrell Williams - Get Lucky"
        );
    }

    #[test]
    fn build_basename_handles_missing_artist() {
        assert_eq!(build_basename(&[], "Anonymous Track"), "Anonymous Track");
    }
}
