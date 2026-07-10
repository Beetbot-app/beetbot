//! Generic title/string normalization utilities shared by metadata backfill.
//!
//! Plain string helpers used by the Deezer metadata backfill to compare a local
//! track against a candidate hit.

/// Lowercase, collapse the common feat./featuring/ft. spellings into "feat",
/// normalize "&" to "and", then drop everything that is not ASCII
/// alphanumeric (including whitespace).
///
/// Examples:
///   "Chico (feat. Within Roots and Stevie Ross)" -> "chicofeatwithinrootsandstevieross"
///   "Chico (feat. Withinroots & Stevie Ross)"    -> "chicofeatwithinrootsandstevieross"
///   "Loading"                                    -> "loading"
pub fn normalize_title(s: &str) -> String {
    let mut t = s.to_lowercase();
    // Map alternate spellings of "featuring" to the canonical "feat".
    for pat in ["featuring", "feat.", "ft.", " ft "] {
        t = t.replace(pat, "feat");
    }
    // Map "&" to "and" before we strip non-alphanumerics. Pad with spaces so
    // "x&y" becomes "x and y" rather than "xandy".
    t = t.replace('&', " and ");
    t.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Modifier words that mean a recording is a different version (live / remix /
/// cover / karaoke / instrumental / sped up / …). Used by the backfill to veto
/// adopting a hit's ISRC/art when one title carries a modifier the other lacks.
pub const TITLE_MODIFIERS: &[&str] = &[
    "live",
    "cover",
    "remix",
    "sped up",
    "slowed",
    "8d audio",
    "nightcore",
    "karaoke",
    "instrumental",
    "lyrics only",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_title_collapses_feat_and_ampersand() {
        assert_eq!(
            normalize_title("Chico (feat. Within Roots and Stevie Ross)"),
            "chicofeatwithinrootsandstevieross"
        );
        assert_eq!(
            normalize_title("Chico (feat. Withinroots & Stevie Ross)"),
            "chicofeatwithinrootsandstevieross"
        );
        assert_eq!(normalize_title("Loading"), "loading");
        assert_eq!(normalize_title("Song A ft. Person"), "songafeatperson");
        assert_eq!(normalize_title("Song B featuring Other"), "songbfeatother");
    }
}
