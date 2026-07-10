//! Locating an `ffmpeg` binary for local-file transcoding + artwork embedding.

use std::path::PathBuf;

/// Absolute path to an `ffmpeg` binary.
///
/// macOS GUI apps launched from Finder/Dock inherit a minimal PATH that
/// omits Homebrew's `/opt/homebrew/bin` (Apple Silicon) and `/usr/local/bin`
/// (Intel), so a bare `ffmpeg`/`ffprobe` lookup fails even when ffmpeg is
/// installed. Resolve the binary ourselves: the common Homebrew prefixes
/// first, then whatever is on PATH, then the system location.
pub fn ffmpeg_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
    ];
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("ffmpeg"));
        }
    }
    candidates.push(PathBuf::from("/usr/bin/ffmpeg"));
    candidates.into_iter().find(|p| p.is_file())
}
