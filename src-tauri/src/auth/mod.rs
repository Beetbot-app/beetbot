//! Step 23 (Phase 6B-iv): pairing code + rate limiter + security log.
//!
//! Three load-bearing primitives the public-mode network guard depends on:
//!
//!   PairingState  -- the 6-digit code on the desktop screen. Lives in
//!                    memory only (never SQLite) and rotates every 5 min
//!                    so a glance-and-leak doesn't grant forever-access.
//!                    Constant-time comparison so timing attacks can't
//!                    leak digits.
//!
//!   RateLimiter   -- per-IP attempt window on /api/session and
//!                    /api/pair. 5 attempts per 60 s; the 6th attempt
//!                    waits out an exponentially growing penalty (10 s,
//!                    20 s, 40 s, ...). Keeps brute-force at a crawl
//!                    even from cooperating IPs.
//!
//!   SecurityLog   -- append-only file at <app_data_dir>/security.log.
//!                    Every auth failure / rate-limited reject logs one
//!                    line so the user can read it back from Settings
//!                    without diving into the rotating tracing log.

use std::collections::HashMap;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use rand::Rng;

// ---- pairing code ----------------------------------------------------

pub const PAIRING_CODE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub struct PairingState {
    /// Current 6-digit code (always exactly 6 ASCII digits with leading
    /// zeros preserved).
    pub code: String,
    /// When `code` was generated. `is_fresh` re-rolls when this is
    /// older than `PAIRING_CODE_TTL`.
    pub generated_at: Instant,
}

impl PairingState {
    /// Construct with a freshly rolled code.
    pub fn new() -> Self {
        Self {
            code: roll_code(),
            generated_at: Instant::now(),
        }
    }

    /// Returns the current code, rotating it if expired. Always read
    /// through this function -- never touch `.code` directly.
    pub fn current(&mut self) -> &str {
        if self.generated_at.elapsed() >= PAIRING_CODE_TTL {
            self.code = roll_code();
            self.generated_at = Instant::now();
        }
        &self.code
    }

    /// Seconds remaining before the code rotates.
    pub fn seconds_until_rotation(&self) -> i64 {
        let elapsed = self.generated_at.elapsed();
        PAIRING_CODE_TTL
            .saturating_sub(elapsed)
            .as_secs()
            .try_into()
            .unwrap_or(0)
    }

    /// Constant-time comparison so a side-channel attacker can't deduce
    /// digits from response timing.
    pub fn verify(&mut self, attempt: &str) -> bool {
        // Rotate-as-needed so a stale code can't be accepted.
        let current = self.current();
        if attempt.len() != current.len() {
            return false;
        }
        let mut diff = 0u8;
        for (a, b) in attempt.bytes().zip(current.bytes()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

impl Default for PairingState {
    fn default() -> Self {
        Self::new()
    }
}

fn roll_code() -> String {
    let mut rng = rand::thread_rng();
    let n: u32 = rng.gen_range(0..1_000_000);
    format!("{n:06}")
}

// ---- rate limiter ----------------------------------------------------

const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX_ATTEMPTS: u32 = 5;
const RATE_INITIAL_PENALTY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default)]
struct PerIpState {
    /// Timestamps of attempts in the current window (head is oldest).
    /// We don't need bounded length because expired entries get pruned
    /// every check.
    attempts: Vec<Instant>,
    /// Exponential-backoff penalty doubles on every burst.
    next_penalty: Duration,
    /// If set, no attempt is allowed before this timestamp.
    locked_until: Option<Instant>,
}

#[derive(Debug, Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<HashMap<IpAddr, PerIpState>>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateCheck {
    Allowed,
    /// Caller is locked out; retry after this duration.
    Locked { retry_in: Duration },
}

impl RateLimiter {
    /// Record an attempt from `ip`. Returns `Allowed` if the request can
    /// proceed, or `Locked` with the remaining lockout. Callers that get
    /// `Locked` should respond 429 and persist a security-log line.
    pub fn check(&self, ip: IpAddr) -> RateCheck {
        let now = Instant::now();
        let mut map = self.inner.lock().expect("rate limiter poisoned");
        let entry = map.entry(ip).or_default();

        if let Some(until) = entry.locked_until {
            if now < until {
                return RateCheck::Locked {
                    retry_in: until - now,
                };
            }
            entry.locked_until = None;
        }

        entry
            .attempts
            .retain(|t| now.duration_since(*t) <= RATE_WINDOW);
        if entry.attempts.len() as u32 >= RATE_MAX_ATTEMPTS {
            let penalty = if entry.next_penalty.is_zero() {
                RATE_INITIAL_PENALTY
            } else {
                entry.next_penalty
            };
            entry.locked_until = Some(now + penalty);
            entry.next_penalty = penalty.saturating_mul(2);
            entry.attempts.clear();
            return RateCheck::Locked { retry_in: penalty };
        }
        entry.attempts.push(now);
        RateCheck::Allowed
    }

    /// Called from success paths so a legitimate caller's penalty
    /// counter doesn't compound forever.
    pub fn reset(&self, ip: IpAddr) {
        let mut map = self.inner.lock().expect("rate limiter poisoned");
        map.remove(&ip);
    }
}

// ---- security log ----------------------------------------------------

#[derive(Debug, Clone)]
pub struct SecurityLog {
    path: PathBuf,
}

impl SecurityLog {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The log file path. Read only by tests today; nothing in production reads
    /// it back through the struct.
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a single line. Best-effort -- if the file is unwritable we
    /// log a warning to the rotating tracing log but never panic the
    /// request handler.
    pub fn append(&self, ip: IpAddr, event: &str, detail: &str) {
        let line = format!(
            "{ts} ip={ip} event={event} detail={detail}\n",
            ts = Utc::now().to_rfc3339(),
        );
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let result = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
        if let Err(e) = result {
            tracing::warn!(?e, path = %self.path.display(), "security.log append failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_always_six_digits() {
        for _ in 0..20 {
            let c = roll_code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|ch| ch.is_ascii_digit()));
        }
    }

    #[test]
    fn verify_matches_exact_code() {
        let mut state = PairingState::new();
        let code = state.code.clone();
        assert!(state.verify(&code));
        assert!(!state.verify("000000"));
        assert!(!state.verify("0000000"));
        assert!(!state.verify("12345"));
    }

    #[test]
    fn rate_limiter_allows_first_five_attempts() {
        let limiter = RateLimiter::default();
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        for i in 0..5 {
            assert_eq!(limiter.check(ip), RateCheck::Allowed, "attempt {i}");
        }
        let blocked = limiter.check(ip);
        assert!(matches!(blocked, RateCheck::Locked { .. }));
    }

    #[test]
    fn rate_limiter_resets_after_success_call() {
        let limiter = RateLimiter::default();
        let ip: IpAddr = "9.9.9.9".parse().unwrap();
        for _ in 0..3 {
            limiter.check(ip);
        }
        limiter.reset(ip);
        // Fresh budget after reset.
        for _ in 0..5 {
            assert_eq!(limiter.check(ip), RateCheck::Allowed);
        }
    }

    #[test]
    fn security_log_appends_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        let log = SecurityLog::new(dir.path().join("security.log"));
        log.append(
            "192.168.1.66".parse().unwrap(),
            "pair_failed",
            "wrong code",
        );
        log.append(
            "1.2.3.4".parse().unwrap(),
            "rate_limited",
            "60s backoff",
        );
        let contents = std::fs::read_to_string(log.path()).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("ip=192.168.1.66"));
        assert!(lines[0].contains("event=pair_failed"));
        assert!(lines[1].contains("event=rate_limited"));
    }
}
