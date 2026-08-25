//! Step 14: LAN streaming server.
//!
//! Embedded `axum` HTTP server running on a tokio task spawned from Tauri's
//! setup hook. Binds 0.0.0.0:<streaming_port> when the streaming_enabled
//! setting is on; bound IP is filtered at the connection layer so only
//! peers on RFC1918 / link-local / loopback can reach any route.
//!
//! Endpoints (all JSON unless noted, all gated by a session token after the
//! initial /api/session call):
//!
//!   GET  /api/health        -> liveness check (no auth)
//!   GET  /api/session       -> issue a new session token
//!   GET  /api/playlists     -> library list
//!   GET  /api/playlists/:id -> playlist detail + tracks
//!   GET  /api/tracks/:id    -> track metadata
//!   GET  /api/tracks/:id/art -> redirect to album art URL
//!   GET  /stream/:track_id  -> audio stream with Range support
//!
//! The pairing flow from plan §7.2 is deferred to step 14b; for now any
//! peer that passes the IP guard can request a token. Pairing toggle in
//! settings is wired so it's available for that follow-up.

mod identity;
mod sharing_routes;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    /// PEM-encoded self-signed cert served at /cert/beetbot.crt so phones
    /// can install it and trust HTTPS. None during HTTP-only deployments.
    pub cert_pem: Option<Arc<String>>,
    /// Bare machine hostname (no .local suffix) for the .mobileconfig
    /// payload identifier.
    pub hostname_bare: Option<Arc<String>>,
    /// Step 23: pairing code state. Always present; the require-pairing
    /// setting decides whether handlers actually consult it.
    pub pairing: Arc<Mutex<crate::auth::PairingState>>,
    pub rate_limiter: crate::auth::RateLimiter,
    pub security_log: Arc<crate::auth::SecurityLog>,
    /// Chromecast discovery + active-session state. `None` when the
    /// mDNS daemon failed to start (rare; the Cast UI then just sees
    /// an empty device list instead of crashing the server).
    pub cast: Option<Arc<crate::cast::CastManager>>,
    /// HTTP port the streaming server is listening on. Used by Cast
    /// to construct stream URLs the Chromecast can reach (e.g.
    /// `http://<lan-ip>:<port>/stream/<id>`).
    pub streaming_port: u16,
    /// Shared reqwest client for outbound calls (MusicBrainz / ListenBrainz
    /// artist-graph lookups, etc.). Built with only a connect timeout; cheap to
    /// clone (Arc inside).
    pub proxy_http: reqwest::Client,
    /// Tauri app handle, handed to the active acquisition provider to fetch a
    /// track on demand the first time `/stream` is hit for one that has no
    /// local file yet. The built-in open provider never auto-acquires, so this
    /// goes unused in the open build.
    pub app: tauri::AppHandle,
}

/// A paired device idle longer than this is treated as expired: its token stops
/// working and it drops off the "Active sessions" list, so the list only ever
/// reflects genuinely-recent devices (and a device you forgot can't linger
/// valid forever). One constant to tune. The desktop's own loopback session
/// heartbeats on every request, so it never idle-expires while the app runs.
pub const SESSION_IDLE_EXPIRY_SECS: i64 = 24 * 60 * 60;

impl AppState {
    fn is_valid_session(&self, token: &str) -> bool {
        let hash = sha256_hex(token);
        let conn = self.db.lock().expect("db mutex poisoned");
        let r = conn.query_row(
            "SELECT 1 FROM streaming_sessions
             WHERE token_sha256 = ?1 AND revoked_at IS NULL
               AND last_seen_at >= strftime('%s','now') - ?2",
            params![hash, SESSION_IDLE_EXPIRY_SECS],
            |_| Ok(()),
        );
        let ok = matches!(r, Ok(()));
        if ok {
            // Best-effort heartbeat.
            let _ = conn.execute(
                "UPDATE streaming_sessions SET last_seen_at = strftime('%s','now')
                 WHERE token_sha256 = ?1",
                params![hash],
            );
        }
        ok
    }

    /// The profile this session is bound to (set via POST /api/session/profile
    /// after PIN verification), or None if no profile has been selected on this
    /// device yet. The server uses THIS — not a client-supplied `profile_id` —
    /// as the acting profile for a paired (non-loopback) device, so a phone
    /// can't act as a profile it never authenticated to.
    fn session_profile(&self, token: &str) -> Option<i64> {
        let hash = sha256_hex(token);
        let conn = self.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT profile_id FROM streaming_sessions
             WHERE token_sha256 = ?1 AND revoked_at IS NULL",
            params![hash],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    /// Bind this session to `profile_id` (the profile picked on this device).
    /// Idempotent; overwrites on a profile switch. Returns false if no live
    /// session matches the token.
    fn set_session_profile(&self, token: &str, profile_id: i64) -> bool {
        let hash = sha256_hex(token);
        let conn = self.db.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE streaming_sessions SET profile_id = ?1 WHERE token_sha256 = ?2",
            params![profile_id, hash],
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }
}

/// Build the shared Router once -- HTTP and HTTPS listeners use it side by
/// side. The IP allowlist + state layers are applied here so each handler
/// sees the same view of the world regardless of scheme.
fn build_router(state: AppState, web_dir: Option<PathBuf>) -> Router {
    let mut app = Router::new()
        .route("/api/health", get(health))
        // Plain-text build probe. Auth-free (still behind the IP allowlist)
        // so it can be opened directly in a phone browser to confirm which
        // build is actually answering a given URL — invaluable when a stale
        // shell or a misrouted port-forward makes the UI look out of date.
        .route("/version", get(version_probe))
        .route("/api/session", get(session_handler))
        .route(
            "/api/session/profile",
            axum::routing::post(bind_session_profile),
        )
        .route("/api/profiles", get(list_profiles_handler))
        .route(
            "/api/profiles/{id}",
            axum::routing::delete(delete_profile_handler)
                .patch(update_profile_handler),
        )
        .route(
            "/api/profiles/{id}/avatar",
            get(profile_avatar_handler)
                .post(set_profile_avatar_handler)
                .delete(clear_profile_avatar_handler)
                // A photo straight off a modern phone camera is routinely
                // several MB; axum's 2MB default would reject the ordinary
                // case. Bounded anyway — this writes a file to the hub.
                .layer(axum::extract::DefaultBodyLimit::max(AVATAR_MAX_BYTES)),
        )
        .route(
            "/api/profiles/{id}/verify",
            axum::routing::post(verify_profile_pin_handler),
        )
        .route("/api/pair", get(pair_status).post(pair_submit))
        // Sharing this server with other people. Owner-only, where "owner" has to
        // mean more than loopback — see sharing_routes.rs.
        .route("/api/sharing/status", get(sharing_routes::sharing_status))
        .route("/api/sharing/people", get(sharing_routes::sharing_people))
        .route(
            "/api/sharing/invite",
            axum::routing::post(sharing_routes::sharing_invite),
        )
        .route(
            "/api/sharing/revoke",
            axum::routing::post(sharing_routes::sharing_revoke),
        )
        .route(
            "/api/playlists",
            get(list_playlists).post(create_playlist),
        )
        // Flat "all my songs" list for the phone's Library › Songs tab (the
        // desktop reads the same set via Tauri IPC).
        .route("/api/library/songs", get(get_library_songs))
        .route(
            "/api/playlists/import",
            axum::routing::post(import_playlist),
        )
        .route(
            "/api/playlists/{id}",
            get(get_playlist)
                .patch(rename_playlist_handler)
                .delete(delete_playlist_handler),
        )
        .route("/api/playlists/{id}/art", get(get_playlist_art))
        // Serves Deezer editorial playlist covers with the baked-in "DEEZER"
        // wordmark scrubbed out. Referenced by opaque md5 only (see
        // scrub_playlist_cover); no token — public cover art.
        .route("/api/cover-scrub/{md5}", get(cover_scrub))
        .route("/api/tracks/{id}", get(get_track))
        .route("/api/tracks/{id}/art", get(get_track_art))
        .route("/api/tracks/{id}/like", axum::routing::post(like_track))
        .route(
            "/api/tracks/{id}/acquire",
            axum::routing::post(acquire_track_handler),
        )
        .route("/api/tracks/{id}/playlists", get(get_track_playlists))
        .route("/api/tracks/resolve", axum::routing::post(resolve_catalog_track))
        .route(
            "/api/tracks/resolve-batch",
            axum::routing::post(resolve_catalog_tracks),
        )
        .route("/api/tracks/liked", get(liked_tracks))
        .route("/api/plays", axum::routing::post(log_play))
        .route(
            "/api/feedback/ban",
            axum::routing::post(ban_artist_handler),
        )
        .route(
            "/api/profile-kv",
            get(profile_kv_get_handler).put(profile_kv_put_handler),
        )
        .route("/api/station", get(station_handler))
        .route("/api/plays/finish", axum::routing::post(finish_play))
        .route("/api/stats", get(get_stats))
        .route(
            "/api/playlists/{id}/tracks",
            axum::routing::post(add_track_to_playlist),
        )
        .route("/api/search", get(spotify_search))
        .route("/api/browse", get(browse))
        .route("/api/home", get(home_handler))
        .route("/api/home/report", get(home_report_handler))
        .route("/api/genres", get(list_genres))
        .route("/api/genres/{id}/artists", get(genre_artists))
        .route("/api/catalog/playlists/{id}", get(get_catalog_playlist))
        .route("/api/albums/{id}/tracks", get(get_album_tracks))
        .route(
            "/api/albums/import",
            axum::routing::post(import_album),
        )
        .route("/api/artists/{id}/albums", get(get_artist_albums))
        .route("/api/artists/{id}/top", get(get_artist_top_tracks))
        .route("/api/artists/{id}/related", get(get_artist_related))
        .route("/api/radio/similar", get(get_radio_similar))
        .route("/api/artists/bio", get(artist_bio))
        .route("/api/artists/appears-on", get(artist_appears_on))
        .route("/api/lyrics", get(get_lyrics))
        .route("/api/cast/devices", get(list_cast_devices))
        .route("/api/cast/status", get(cast_status))
        .route("/api/cast/start", axum::routing::post(cast_start))
        .route("/api/cast/stop", axum::routing::post(cast_stop))
        .route("/api/cast/control", axum::routing::post(cast_control))
        .route("/api/devices", get(devices_list))
        .route(
            "/api/devices/heartbeat",
            axum::routing::post(devices_heartbeat),
        )
        .route("/api/handoff", get(handoff_get).post(handoff_post))
        .route(
            "/api/remote-command",
            get(remote_command_get).post(remote_command_post),
        )
        .route(
            "/api/tracks/playlists",
            axum::routing::patch(patch_track_playlists),
        )
        .route("/stream/{id}", get(stream_track))
        .route("/stream/{id}/live", get(stream_track_live))
        .route("/api/streaming/health", get(streaming_health))
        // The /cert routes are deliberately auth-free: phones download the
        // cert *before* they can establish HTTPS / a session. IP allowlist
        // still applies, so only LAN peers can fetch.
        .route("/cert", get(cert_landing))
        .route("/cert/beetbot.crt", get(cert_pem_download))
        .route("/cert/beetbot.mobileconfig", get(mobileconfig_download));

    if let Some(dir) = web_dir {
        if dir.is_dir() {
            tracing::info!(?dir, "serving web player bundle");
            let index = dir.join("index.html");
            app = app.fallback_service(
                ServeDir::new(&dir)
                    .append_index_html_on_directories(true)
                    .not_found_service(ServeFile::new(index)),
            );
        } else {
            tracing::warn!(?dir, "web player bundle directory missing -- run `pnpm build`");
        }
    }

    // CORS: the Tauri desktop webview loads from `tauri://localhost`
    // (Wry's custom protocol on macOS), which makes every fetch to
    // `http://127.0.0.1:47823` cross-origin. The phone web player is
    // same-origin so it doesn't need this. Allow any origin — auth is
    // already enforced by the IP allowlist + session token layer
    // beneath, and `OPTIONS` preflights need to succeed before that
    // layer can examine the real request.
    //
    // Layering order in axum is outer → inner: cors_layer added LAST
    // here runs FIRST on incoming requests (it short-circuits the
    // preflight before ip_allowlist sees it).
    let cors_layer = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // `ip_allowlist` needs AppState (to consult the remote_streaming
    // setting and write to the security log), so use
    // `from_fn_with_state` rather than the stateless `from_fn`.
    app.layer(middleware::from_fn_with_state(state.clone(), ip_allowlist))
        .layer(cors_layer)
        .layer(middleware::from_fn(no_cache_shell))
        .with_state(state)
}

/// Plain-text build identifier. Derived at compile time from the crate
/// version so opening `/version` in any browser instantly reveals whether that
/// origin is serving the current build (vs. a cached shell or a different
/// machine behind a port-forward). No-cache so it's never served stale.
async fn version_probe() -> Response {
    const BUILD_TAG: &str = concat!("beetbot v", env!("CARGO_PKG_VERSION"));
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
        ],
        format!("Beetbot server OK\nbuild: {BUILD_TAG}\n"),
    )
        .into_response()
}

/// Force WebKit / iOS Safari to revalidate the PWA *shell* on every load.
///
/// `ServeDir` sends no `Cache-Control`, so Safari applies heuristic
/// freshness and caches `index.html` (and `sw.js`). That's catastrophic for
/// updates: the cached `index.html` keeps pointing at the *old* hashed JS
/// bundle, and because it lives in Safari's shared network cache — not the
/// service worker — it survives even a PWA delete + re-add. The phone then
/// loads stale code no matter what, while `curl` (which bypasses that cache)
/// sees the new files.
///
/// Marking only the shell documents `no-cache, no-store` makes Safari fetch
/// a fresh `index.html` each launch; it references the new content-hashed
/// `/assets/*` (which stay immutably cacheable), so a new release is picked
/// up immediately. The service worker still caches the shell explicitly via
/// the Cache API for offline use — these directives only govern the HTTP
/// cache, which the SW bypasses.
async fn no_cache_shell(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let is_shell =
        path == "/" || path == "/index.html" || path.ends_with(".html") || path == "/sw.js";
    let mut res = next.run(req).await;
    if is_shell {
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
    }
    res
}

/// Plain HTTP listener. Use this for diagnostic / Android-without-cert
/// access. iOS Safari users who want offline cache or PWA install need
/// `run_https`.
pub async fn run(
    state: AppState,
    bind_ip: [u8; 4],
    port: u16,
    web_dir: Option<PathBuf>,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<()> {
    let app = build_router(state, web_dir);
    let addr = SocketAddr::from((bind_ip, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(?addr, "HTTP streaming server listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    // Graceful shutdown: when the oneshot fires (or its sender is
    // dropped), axum stops accepting new connections and drains
    // in-flight ones, which frees the bound port. `reconfigure_streaming`
    // awaits the spawned task afterwards so the port is fully released
    // before a fresh listener tries to rebind the same address.
    .with_graceful_shutdown(async move {
        let _ = shutdown.await;
    })
    .await?;
    Ok(())
}

/// Build the rustls config from PEM files. Sync — both axum-server's
/// `from_pem_file` and `from_pem` are async, so we drop a level and use
/// `from_config` with a manually-parsed `rustls::ServerConfig`. Letting
/// us call this from the Tauri setup hook without dragging in
/// `block_on`. Pulled out of `run_https` so the setup hook can construct
/// the config eagerly, hand a clone to the ACME renew path (which calls
/// `reload_from_pem_file` on it after issuance), then move the original
/// into the spawned server task.
pub fn build_rustls_config(
    cert_path: &std::path::Path,
    key_path: &std::path::Path,
) -> std::io::Result<axum_server::tls_rustls::RustlsConfig> {
    use std::io::{BufReader, Cursor};
    use std::sync::Arc;
    // rustls 0.23 made the crypto provider an explicit choice -- no global
    // default is set unless we install one. Best-effort install; if some
    // other call already set a default we ignore the error.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let cert_bytes = std::fs::read(cert_path)?;
    let key_bytes = std::fs::read(key_path)?;

    let mut cert_reader = BufReader::new(Cursor::new(&cert_bytes));
    let certs: Vec<_> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if certs.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no PEM certificates found in cert file",
        ));
    }

    let mut key_reader = BufReader::new(Cursor::new(&key_bytes));
    let key = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "no private key found in key file",
            )
        })?;

    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(
        server_config,
    )))
}

/// HTTPS listener using axum-server + rustls. `tls_config` is owned by
/// `run_https` for its lifetime; a clone of the same handle can be held
/// elsewhere (e.g. ACME renew code) to call `reload_from_pem_file()` --
/// updates propagate to in-flight + future connections atomically with
/// no server restart needed.
pub async fn run_https(
    state: AppState,
    port: u16,
    web_dir: Option<PathBuf>,
    tls_config: axum_server::tls_rustls::RustlsConfig,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<()> {
    let app = build_router(state, web_dir);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(?addr, "HTTPS streaming server listening");
    // axum-server drives graceful shutdown through a `Handle` rather than a
    // shutdown future. Bridge the oneshot to it: when the signal fires (or
    // the sender drops) ask the handle to drain and stop, which releases the
    // bound port so `reconfigure_streaming` can rebind if needed.
    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        let _ = shutdown.await;
        shutdown_handle.graceful_shutdown(Some(std::time::Duration::from_secs(3)));
    });
    axum_server::bind_rustls(addr, tls_config)
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    Ok(())
}

// ---- IP allow-list middleware -----------------------------------------

/// Default posture: reject any peer that isn't loopback / RFC1918 /
/// link-local. When `remote_streaming_enabled` is set in the DB the
/// posture relaxes: public IPs can hit `/api/pair`, `/api/health`, and
/// any route they already hold a valid session token for. Everything
/// else still 403s.
async fn ip_allowlist(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    req: Request,
    next: Next,
) -> Response {
    let ip = effective_client_ip(&addr, &headers);
    let lan = is_private_addr(&ip);
    if lan {
        return next.run(req).await;
    }

    // Public-IP path. Only allowed when the user has explicitly enabled
    // remote streaming -- and even then, only on a narrow set of routes.
    let remote_enabled = {
        let conn = state.db.lock().expect("db mutex poisoned");
        read_bool_setting(&conn, "remote_streaming_enabled").unwrap_or(false)
    };
    if !remote_enabled {
        tracing::warn!(?addr, "rejecting non-LAN peer (remote streaming disabled)");
        state
            .security_log
            .append(ip, "rejected_remote_disabled", req.uri().path());
        return StatusCode::FORBIDDEN.into_response();
    }

    let path = req.uri().path();
    // Anything that isn't a data route is auth-free for public peers:
    // the static SPA shell needs to load so the user can *see* the
    // pairing screen, then /api/pair lets them authenticate, then the
    // resulting token unlocks /api/* + /stream/*. Walled off:
    //   /api/* except /api/session, /api/pair, /api/health
    //   /stream/*
    //
    // /api/session is the entry-point handshake: it either issues a
    // token (when pairing isn't required) or returns 402 telling the
    // client to call /api/pair. Either way it must be reachable with
    // no token. The handler itself is rate-limited so this isn't a
    // brute-force vector.
    let needs_token = path.starts_with("/stream/")
        || (path.starts_with("/api/")
            && path != "/api/session"
            && path != "/api/pair"
            && path != "/api/health"
            // Public, opaque-md5 Deezer cover art (wordmark scrubbed) — carries
            // no library data, so it's served tokenless like /api/health. It
            // MUST be, in fact: the client references it in an <img src> (which
            // can't send an auth header) with no `?t=` token, so a remote phone
            // over the tunnel would otherwise 401 and show a broken cover.
            && !path.starts_with("/api/cover-scrub/"));

    if !needs_token {
        return next.run(req).await;
    }

    if let Some(token) = extract_token(&headers, &q) {
        if state.is_valid_session(&token) {
            return next.run(req).await;
        }
    }
    state.security_log.append(ip, "rejected_no_token", path);
    StatusCode::UNAUTHORIZED.into_response()
}

/// The effective client IP used for every trust decision below.
///
/// The desktop webview connects to its own backing server directly over
/// loopback and sends no forwarding header, so genuine loopback keeps owner
/// trust (pairing bypass + LAN allow). A reverse proxy / tunnel such as ngrok
/// *also* connects from loopback, but stamps the real remote client into
/// `X-Forwarded-For`. Without this, every tunnelled phone would inherit
/// loopback's pairing bypass — anyone holding the tunnel URL would be treated
/// as the owner.
///
/// Rule: only consult `X-Forwarded-For` when the TCP peer is loopback. This can
/// only ever *downgrade* trust — a non-loopback LAN/remote peer's forged header
/// is ignored (its real peer IP is used unchanged), and a tunnelled peer is
/// reclassified to its public address, which then faces the remote gate +
/// pairing. A direct remote attacker cannot make the TCP peer loopback, so the
/// only callers reaching the header branch are our own local processes: the
/// webview (sets no header) or our tunnel (sets a trustworthy one).
fn effective_client_ip(addr: &SocketAddr, headers: &HeaderMap) -> IpAddr {
    let peer = addr.ip();
    if !peer.is_loopback() {
        return peer;
    }
    forwarded_client(headers).unwrap_or(peer)
}

/// The client address a trusted single-hop proxy observed. With exactly one
/// trusted proxy in front (the tunnel), the RIGHTMOST `X-Forwarded-For` entry is
/// the address the proxy itself observed and appended; any entries to its left
/// may be client-supplied and are never trusted.
fn forwarded_client(headers: &HeaderMap) -> Option<IpAddr> {
    let raw = headers.get("x-forwarded-for")?.to_str().ok()?;
    raw.split(',').next_back()?.trim().parse::<IpAddr>().ok()
}

fn is_private_addr(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return true;
            }
            // IPv4-mapped IPv6 (::ffff:a.b.c.d) -- check the embedded v4.
            if let Some(v4) = v6_to_v4_mapped(v6) {
                return v4.is_loopback() || v4.is_private() || v4.is_link_local();
            }
            let segs = v6.segments();
            // fc00::/7 (unique local)
            if segs[0] & 0xfe00 == 0xfc00 {
                return true;
            }
            // fe80::/10 (link-local)
            if segs[0] & 0xffc0 == 0xfe80 {
                return true;
            }
            false
        }
    }
}

fn v6_to_v4_mapped(v6: &Ipv6Addr) -> Option<Ipv4Addr> {
    let segs = v6.segments();
    if segs[0] == 0 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 && segs[4] == 0
        && segs[5] == 0xffff
    {
        Some(Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            (segs[6] & 0xff) as u8,
            (segs[7] >> 8) as u8,
            (segs[7] & 0xff) as u8,
        ))
    } else {
        None
    }
}

// ---- Token helpers ----------------------------------------------------

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn sha256_hex(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    digest.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        write!(acc, "{b:02x}").ok();
        acc
    })
}

fn extract_token(headers: &HeaderMap, q: &TokenQuery) -> Option<String> {
    if let Some(ref t) = q.t {
        return Some(t.clone());
    }
    let h = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    h.strip_prefix("Bearer ").map(str::to_owned)
}

#[derive(Deserialize, Default)]
struct TokenQuery {
    t: Option<String>,
}

// ---- Auth helper ------------------------------------------------------

fn require_token(state: &AppState, headers: &HeaderMap, q: &TokenQuery) -> Result<(), Response> {
    let token = extract_token(headers, q).ok_or_else(|| {
        (StatusCode::UNAUTHORIZED, "missing session token").into_response()
    })?;
    if !state.is_valid_session(&token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid session token").into_response());
    }
    Ok(())
}

// ---- Handlers ---------------------------------------------------------

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct SessionResponse {
    session_token: String,
    device_label: String,
    pairing_required: bool,
    /// Whether this build can stream a not-yet-downloaded track on demand (the
    /// full build's engine resolves + remuxes the source). The open build leaves
    /// this false, so its UI keeps treating non-downloaded tracks as preview-only.
    live_stream: bool,
}

async fn session_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = effective_client_ip(&addr, &headers);
    // Loopback is the desktop webview hitting its own backing server — it
    // legitimately fetches a session on every page that needs a token, so never
    // rate-limit it (the limiter exists to slow REMOTE brute-force of the
    // session/pairing, and loopback already bypasses the pairing gate below).
    if !ip.is_loopback() {
        if let crate::auth::RateCheck::Locked { retry_in } = state.rate_limiter.check(ip) {
            state.security_log.append(
                ip,
                "rate_limited_session",
                &format!("retry_in={}s", retry_in.as_secs()),
            );
            return rate_limited_response(retry_in);
        }
    }
    // Read settings inline so a runtime toggle is picked up immediately.
    let pairing_required = {
        let conn = state.db.lock().expect("db mutex poisoned");
        read_bool_setting(&conn, "require_pairing_code").unwrap_or(false)
            || read_bool_setting(&conn, "remote_streaming_enabled").unwrap_or(false)
    };
    // Loopback is always safe: it's the Beetbot Tauri webview talking
    // to its own backing server. Skip the pairing gate so the desktop
    // UI can fetch a token even when public-mode pairing is on (which
    // is required for phone access from the internet).
    if pairing_required && !ip.is_loopback() {
        return (
            StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({"pairing_required": true})),
        )
            .into_response();
    }

    Json(issue_session_for(&state, ip, &headers)).into_response()
}

#[derive(Serialize)]
struct PairStatusResponse {
    pairing_required: bool,
    /// Seconds left on the current code rotation, present only when the
    /// user is on the SAME host as the desktop (i.e., loopback) -- never
    /// expose this for a public peer because it gives them a "guess
    /// faster, code is rotating" cue.
    seconds_until_rotation: Option<i64>,
}

async fn pair_status(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // Loopback is either the desktop webview OR a trusted local reverse proxy that
    // authenticates the visitor upstream before forwarding (it connects from
    // loopback and, unlike a tunnel, sets no `X-Forwarded-For`). `session_handler`
    // already exempts such peers from the pairing gate, so report pairing as NOT
    // required to them here too — otherwise a proxied, already-authenticated remote
    // visitor is shown a code prompt for a gate that will never actually apply.
    let is_loopback = effective_client_ip(&addr, &headers).is_loopback();
    let required = if is_loopback {
        false
    } else {
        let conn = state.db.lock().expect("db mutex poisoned");
        read_bool_setting(&conn, "require_pairing_code").unwrap_or(false)
            || read_bool_setting(&conn, "remote_streaming_enabled").unwrap_or(false)
    };
    let mut secs = None;
    if is_loopback {
        let pairing = state.pairing.lock().expect("pairing mutex poisoned");
        secs = Some(pairing.seconds_until_rotation());
    }
    Json(PairStatusResponse {
        pairing_required: required,
        seconds_until_rotation: secs,
    })
    .into_response()
}

#[derive(Deserialize)]
struct PairSubmit {
    code: String,
    device_label: Option<String>,
}

async fn pair_submit(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PairSubmit>,
) -> Response {
    let ip = effective_client_ip(&addr, &headers);
    if let crate::auth::RateCheck::Locked { retry_in } = state.rate_limiter.check(ip) {
        state.security_log.append(
            ip,
            "rate_limited_pair",
            &format!("retry_in={}s", retry_in.as_secs()),
        );
        return rate_limited_response(retry_in);
    }
    let ok = {
        let mut pairing = state.pairing.lock().expect("pairing mutex poisoned");
        pairing.verify(body.code.trim())
    };
    if !ok {
        state.security_log.append(ip, "pair_failed", "wrong code");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "invalid_code"})),
        )
            .into_response();
    }
    // Success path: clear rate-limit penalty so the legitimate caller's
    // next pair attempt from this device starts fresh, then issue a
    // session token just like the non-pair path.
    state.rate_limiter.reset(ip);
    let mut headers = headers;
    if let Some(label) = body.device_label.as_deref() {
        // Stuff the requested label into a synthetic header so
        // issue_session_for picks it up via the same UA path.
        if let Ok(v) = header::HeaderValue::from_str(label) {
            headers.insert(header::USER_AGENT, v);
        }
    }
    Json(issue_session_for(&state, ip, &headers)).into_response()
}

fn rate_limited_response(retry_in: std::time::Duration) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({"retry_after_seconds": retry_in.as_secs()})),
    )
        .into_response();
    if let Ok(v) = header::HeaderValue::from_str(&retry_in.as_secs().to_string()) {
        resp.headers_mut().insert(header::RETRY_AFTER, v);
    }
    resp
}

/// Mint a fresh session token + persist it. Shared by the LAN session
/// path and the post-pair path so device_label / IP plumbing stays in
/// one place.
fn issue_session_for(state: &AppState, ip: IpAddr, headers: &HeaderMap) -> SessionResponse {
    let token = generate_token();
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();
    let device_label = label_from_user_agent(&user_agent);
    let id = Uuid::new_v4().to_string();
    let hash = sha256_hex(&token);
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Err(e) = conn.execute(
            "INSERT INTO streaming_sessions
                 (id, token_sha256, device_label, ip_address, user_agent)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, hash, device_label, ip.to_string(), user_agent],
        ) {
            tracing::error!(?e, "failed to persist streaming session");
        }
        // Collapse the desktop webview's per-launch session churn (see the
        // helper's doc for why it's scoped by user_agent, not just loopback).
        if ip.is_loopback() {
            prune_own_stale_loopback_sessions(&conn, &id, &user_agent);
        }
    }
    SessionResponse {
        session_token: token,
        device_label,
        pairing_required: false,
        // Full build (engine registered) auto-acquires, so it can also live-stream
        // non-downloaded tracks; the open build leaves this false.
        live_stream: crate::acquisition::active_provider().auto_acquires(),
    }
}

/// How long a loopback session may sit idle before a fresh mint may prune it.
/// The desktop webview heartbeats `last_seen_at` on every request, so a running
/// app's session stays well inside this window and is never swept.
const LOOPBACK_PRUNE_IDLE_SECS: i64 = 120;

/// Prune the *desktop webview's own* dead prior-launch sessions when it mints a
/// fresh one, so the table doesn't grow one row per launch. Only stale rows are
/// touched — without the staleness guard, any second loopback `/api/session` (a
/// second launch, or a local probe like curl) revoked the *running* app's token,
/// 401ing its catalog fetches and breaking Discover/Browse until restart.
///
/// Scoped by `user_agent`, not merely by loopback, and here's why: a local
/// reverse-proxy tunnel that authenticates the visitor upstream then forwards
/// from loopback with no `X-Forwarded-For` (see `effective_client_ip`) also
/// reaches us as loopback, so a paired *phone* served that way has its session
/// stored under 127.0.0.1 too. It carries a phone UA, not the Mac webview's, so
/// matching the minting row's UA spares it. Before this, every desktop mint
/// deleted such a phone's token the moment it had been idle > the window,
/// bouncing the phone to the pairing screen mid-session.
fn prune_own_stale_loopback_sessions(conn: &Connection, keep_id: &str, user_agent: &str) {
    let _ = conn.execute(
        "DELETE FROM streaming_sessions
         WHERE id <> ?1
           AND (ip_address LIKE '127.%' OR ip_address = '::1')
           AND user_agent = ?2
           AND last_seen_at < strftime('%s','now') - ?3",
        params![keep_id, user_agent, LOOPBACK_PRUNE_IDLE_SECS],
    );
}

#[derive(Serialize)]
struct PlaylistRow {
    id: i64,
    name: String,
    track_count: i64,
    cover_url: Option<String>,
    source: &'static str,
    /// For album imports this is the album artist (so the library can show
    /// "Album · Artist"); for upstream playlists it's the playlist owner.
    /// `None` for plain local playlists.
    owner: Option<String>,
    /// Up to 4 track ids with *distinct* album art, in playlist order —
    /// the phone library renders these as a 2×2 mosaic tile (Spotify
    /// style). Their art is served (and service-worker cached) via
    /// /api/tracks/{id}/art. Fewer than 4 ⇒ the UI falls back to the
    /// single `cover_url`.
    cover_track_ids: Vec<i64>,
}

/// GET /api/profiles — list user profiles for the "who's using Beetbot?"
/// picker. Session-gated like everything else (the phone has a token before
/// it picks a profile). Never exposes PIN hashes — only a `has_pin` flag.
/// Which profiles a caller may be shown in the "who's using Beetbot?" picker.
///
/// Not everybody sees the same list, and the reason is the whole point of 4.3:
/// once somebody the owner shared with has an account here, a list of accounts
/// is a list of other people, and handing it to the wrong caller turns a picker
/// into a way to open somebody else's library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileView {
    /// The desktop. The owner runs this machine and sees every account on it.
    All,
    /// A guest signed in by a provider: their own account, and no sign that
    /// anybody else's exists.
    JustTheirs(i64),
    /// A device paired over the local network: the profiles that live on this
    /// machine. Pairing proves somebody typed a code that was on the screen, not
    /// who they are, so remote people's accounts are not theirs to see.
    LocalOnly,
}

fn profile_view(this_machine: bool, guest_profile: Option<i64>) -> ProfileView {
    if this_machine {
        return ProfileView::All;
    }
    match guest_profile {
        Some(id) => ProfileView::JustTheirs(id),
        None => ProfileView::LocalOnly,
    }
}

async fn list_profiles_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Resolved before the lock: it takes the lock itself.
    let view = profile_view(
        is_this_machine(&headers, &addr),
        guest_profile_id(&state, &headers),
    );
    let conn = state.db.lock().expect("db mutex poisoned");
    let listed = match view {
        ProfileView::All => crate::profiles::list(&conn),
        ProfileView::LocalOnly => crate::profiles::list_local(&conn),
        ProfileView::JustTheirs(id) => crate::profiles::get(&conn, id).map(|p| vec![p]),
    };
    match listed {
        Ok(list) => Json(list).into_response(),
        Err(e) => {
            tracing::error!(?e, "list_profiles");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Largest profile photo the hub will accept.
const AVATAR_MAX_BYTES: usize = 12 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct UpdateProfileBody {
    name: String,
}

/// May the caller edit this profile? The desktop owner may edit any; a paired
/// device may edit only the profile its own session is bound to. Mirrors
/// `delete_profile_handler`, including the 404 (not 403) so a paired device
/// can't probe which profile ids exist.
fn may_edit_profile_with_query(
    state: &AppState,
    headers: &HeaderMap,
    addr: &SocketAddr,
    q: &TokenQuery,
    id: i64,
) -> Option<Response> {
    if is_this_machine(headers, addr) {
        return None;
    }
    let Some(token) = extract_token(headers, q) else {
        return Some((StatusCode::UNAUTHORIZED, "missing session token").into_response());
    };
    if state.session_profile(&token) != Some(id) {
        return Some(StatusCode::NOT_FOUND.into_response());
    }
    None
}

/// PATCH /api/profiles/{id} — rename. The colour is carried through unchanged:
/// it is picked when the profile is created and has no editor on the phone, so
/// re-sending it would only be a way to lose it.
async fn update_profile_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
    Json(body): Json<UpdateProfileBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Some(r) = may_edit_profile_with_query(&state, &headers, &addr, &q, id) {
        return r;
    }
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name can't be empty").into_response();
    }
    if name.chars().count() > 60 {
        return (StatusCode::BAD_REQUEST, "name is too long").into_response();
    }
    let conn = state.db.lock().expect("db mutex poisoned");
    let current = match crate::profiles::get(&conn, id) {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match crate::profiles::update(&conn, id, &name, &current.avatar_color) {
        Ok(p) => Json(p).into_response(),
        Err(e) => {
            tracing::error!(?e, "update_profile");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// POST /api/profiles/{id}/avatar — raw image bytes, extension from the
/// content type. Stored beside the desktop's own avatars, and the previous
/// file is removed once the new one is recorded.
async fn set_profile_avatar_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
    body: axum::body::Bytes,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Some(r) = may_edit_profile_with_query(&state, &headers, &addr, &q, id) {
        return r;
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty image").into_response();
    }
    // Trust the bytes, not the header: an extension only decides the filename,
    // and the file is served back with its type sniffed from disk.
    let ext = match body.as_ref() {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [0x89, b'P', b'N', b'G', ..] => "png",
        [b'G', b'I', b'F', ..] => "gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        _ => return (StatusCode::BAD_REQUEST, "unsupported image format").into_response(),
    };
    // `Manager` scoped to this handler: the trait is only needed for the one
    // `.path()` call, and importing it at module scope would shadow nothing
    // useful while widening what the rest of this file can reach for.
    use tauri::Manager as _;
    let dir = match state.app.path().app_data_dir() {
        Ok(d) => d.join("library").join("avatars"),
        Err(e) => {
            tracing::error!(?e, "avatar dir");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::error!(?e, "avatar dir");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let dest = dir.join(format!("{id}-{}.{ext}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::write(&dest, &body) {
        tracing::error!(?e, "avatar write");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let dest_str = dest.to_string_lossy().into_owned();
    let old = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let old = crate::profiles::avatar_path(&conn, id).ok().flatten();
        if let Err(e) = crate::profiles::set_avatar(&conn, id, Some(&dest_str)) {
            tracing::error!(?e, "set_avatar");
            let _ = std::fs::remove_file(&dest);
            return StatusCode::NOT_FOUND.into_response();
        }
        old
    };
    // Only once the new path is recorded — a failure above must not leave the
    // profile pointing at a file we already deleted.
    if let Some(old) = old {
        if old != dest_str {
            let _ = std::fs::remove_file(old);
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// DELETE /api/profiles/{id}/avatar — back to the coloured initial.
async fn clear_profile_avatar_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Some(r) = may_edit_profile_with_query(&state, &headers, &addr, &q, id) {
        return r;
    }
    let old = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let old = crate::profiles::avatar_path(&conn, id).ok().flatten();
        if let Err(e) = crate::profiles::set_avatar(&conn, id, None) {
            tracing::error!(?e, "clear_avatar");
            return StatusCode::NOT_FOUND.into_response();
        }
        old
    };
    if let Some(old) = old {
        let _ = std::fs::remove_file(old);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// GET /api/profiles/{id}/avatar — serve a profile's custom photo (when set).
/// 404 for profiles with no avatar (the UI falls back to the colour tile).
async fn profile_avatar_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
    req: Request,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let path: Option<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        crate::profiles::avatar_path(&conn, id).ok().flatten()
    };
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path: PathBuf = path.into();
    if !path.exists() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match ServeFile::new(&path).oneshot(req).await {
        Ok(r) => r.into_response(),
        Err(e) => {
            tracing::error!(?e, "avatar serve");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct VerifyPinBody {
    pin: String,
}

#[derive(Serialize)]
struct VerifyPinOut {
    ok: bool,
}

/// POST /api/profiles/{id}/verify  body: { pin } — check a profile's PIN so
/// the phone can unlock a locked profile. Returns `{ ok: true }` for a
/// correct PIN (or a profile with no PIN set).
async fn verify_profile_pin_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
    Json(body): Json<VerifyPinBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Throttle remote PIN guessing — a 4-digit PIN is otherwise brute-forceable
    // in seconds. Shares the pairing rate limiter (per client IP, 5/60s +
    // exponential backoff); loopback (the desktop owner) is never limited.
    let ip = effective_client_ip(&addr, &headers);
    if !ip.is_loopback() {
        if let crate::auth::RateCheck::Locked { retry_in } = state.rate_limiter.check(ip) {
            state.security_log.append(
                ip,
                "rate_limited_pin",
                &format!("retry_in={}s", retry_in.as_secs()),
            );
            return rate_limited_response(retry_in);
        }
    }
    let result = {
        let conn = state.db.lock().expect("db mutex poisoned");
        crate::profiles::verify_pin(&conn, id, &body.pin)
    };
    match result {
        // A correct PIN (or a PIN-less profile) clears the IP's penalty.
        Ok(true) => {
            state.rate_limiter.reset(ip);
            Json(VerifyPinOut { ok: true }).into_response()
        }
        Ok(false) => {
            state.security_log.append(ip, "pin_failed", &format!("profile={id}"));
            Json(VerifyPinOut { ok: false }).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(serde::Deserialize)]
struct BindProfileBody {
    profile_id: i64,
    #[serde(default)]
    pin: String,
}

/// POST /api/session/profile  body: { profile_id, pin } — bind THIS session to
/// a profile after verifying its PIN server-side (a no-PIN profile binds
/// freely, matching the existing "casual privacy" model). The server then uses
/// this bound profile as the acting identity for per-profile mutations (see
/// `enforce_playlist_owner`) rather than trusting a client-supplied profile_id.
/// The phone calls it when a profile is picked, and again on a switch.
async fn bind_session_profile(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<BindProfileBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Same PIN-guessing throttle as /api/profiles/{id}/verify — binding a
    // session to a profile is the other path that checks a PIN.
    let ip = effective_client_ip(&addr, &headers);
    if !ip.is_loopback() {
        if let crate::auth::RateCheck::Locked { retry_in } = state.rate_limiter.check(ip) {
            state.security_log.append(
                ip,
                "rate_limited_pin",
                &format!("retry_in={}s", retry_in.as_secs()),
            );
            return rate_limited_response(retry_in);
        }
    }
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        // An account belonging to somebody signed in elsewhere is not selectable
        // here, whatever else the caller can prove. These accounts carry no PIN —
        // they were never meant to be picked from a list — so without this check
        // `verify_pin` would wave through an empty PIN and hand a device on the
        // local network a remote person's library.
        if crate::profiles::is_identity_bound(&conn, body.profile_id).unwrap_or(true) { // scope-exempt: this endpoint IS the binding
            state
                .security_log
                .append(ip, "bind_refused_identity_profile", &format!("profile={}", body.profile_id)); // scope-exempt: this endpoint IS the binding
            return (StatusCode::FORBIDDEN, "that profile belongs to someone else").into_response();
        }
        match crate::profiles::verify_pin(&conn, body.profile_id, &body.pin) { // scope-exempt: this endpoint IS the binding; the PIN above is the check
            Ok(true) => {}
            Ok(false) => {
                state
                    .security_log
                    .append(ip, "pin_failed", &format!("profile={}", body.profile_id)); // scope-exempt: this endpoint IS the binding; the PIN above is the check
                return (StatusCode::FORBIDDEN, "wrong PIN").into_response();
            }
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        }
    }
    // Correct PIN → clear the penalty for this IP.
    state.rate_limiter.reset(ip);
    let token = match extract_token(&headers, &q) {
        Some(t) => t,
        None => {
            return (StatusCode::UNAUTHORIZED, "missing session token").into_response()
        }
    };
    if state.set_session_profile(&token, body.profile_id) { // scope-exempt: this endpoint IS the binding; the PIN above is the check
        StatusCode::NO_CONTENT.into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "no live session").into_response()
    }
}

/// DELETE /api/profiles/{id} — a user deletes THEIR OWN profile from a paired
/// device. Authorization is the session binding (set via POST
/// /api/session/profile after PIN verification): a phone may delete exactly
/// the profile its session is bound to, never another one — while the
/// owner (the desktop, which already manages every profile from
/// Settings → Account) may delete any. The last remaining profile can't be
/// deleted; the "who's listening?" gate needs an answer to exist. Sessions
/// bound to the deleted profile unbind automatically (FK ON DELETE SET NULL),
/// dropping those devices back to the profile picker.
async fn delete_profile_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let ip = effective_client_ip(&addr, &headers);
    // `is_this_machine`, not `ip.is_loopback()`: behind the tunnel every paired
    // phone arrives from loopback, and "may delete any profile" is the single
    // most destructive thing on the other side of this branch. `ip` is still the
    // right thing to write to the audit log below — it just can't authorize.
    if !is_this_machine(&headers, &addr) {
        let Some(token) = extract_token(&headers, &q) else {
            return (StatusCode::UNAUTHORIZED, "missing session token").into_response();
        };
        if state.session_profile(&token) != Some(id) {
            // 404, not 403 — matching enforce_playlist_owner, so a paired
            // device can't probe which profile ids exist.
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    let avatar;
    {
        let mut conn = state.db.lock().expect("db mutex poisoned");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))
            .unwrap_or(0);
        if count <= 1 {
            return (StatusCode::CONFLICT, "the last profile can't be deleted").into_response();
        }
        avatar = crate::profiles::avatar_path(&conn, id).ok().flatten();
        if let Err(e) = crate::profiles::delete(&mut conn, id) {
            tracing::error!(?e, "delete_profile");
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    // Same cleanup as the desktop's delete command: the avatar file is ours.
    if let Some(p) = avatar {
        let _ = std::fs::remove_file(p);
    }
    state
        .security_log
        .append(ip, "profile_deleted", &format!("profile={id}"));
    StatusCode::NO_CONTENT.into_response()
}

/// Reject a per-profile playlist mutation when the caller doesn't own the
/// playlist. The owner (the desktop — its shared screens reach these HTTP
/// routes over loopback) is trusted and always allowed. A paired device
/// (phone) acts as the profile BOUND to its session, never a client-supplied
/// one: it must have a bound profile AND own the playlist, else 404 (which also
/// hides that another profile's playlist exists).
///
/// "Owner" is [`is_this_machine`], not loopback. Loopback alone let anything
/// through the Meradomo tunnel take this early return and mutate — rename, or
/// delete outright — a playlist belonging to any profile on the machine.
fn enforce_playlist_owner(
    state: &AppState,
    headers: &HeaderMap,
    addr: &SocketAddr,
    q: &TokenQuery,
    playlist_id: i64,
) -> Result<(), Response> {
    if is_this_machine(headers, addr) {
        return Ok(());
    }
    let acting = extract_token(headers, q).and_then(|t| state.session_profile(&t));
    let Some(acting) = acting else {
        return Err((StatusCode::FORBIDDEN, "no profile selected").into_response());
    };
    let owner: Option<i64> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT profile_id FROM playlists WHERE id = ?1",
            params![playlist_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .unwrap_or(None)
    };
    if owner == Some(acting) {
        Ok(())
    } else {
        Err((StatusCode::NOT_FOUND, "playlist not found").into_response())
    }
}

/// The profile a per-profile READ endpoint (library list, Home feed) should be
/// scoped to. Same trust model as `enforce_playlist_owner`:
///
/// - **This machine** is the desktop webview, which switches profiles in-app
///   without re-pairing, so its client-supplied `profile_id` is authoritative
///   (falling back to the default profile when absent). The test is
///   [`is_this_machine`], not loopback — see `scoped_profile_id`.
/// - A **paired device** (phone) is scoped to the profile BOUND to its session
///   and CANNOT widen that by passing a `profile_id` — so a stale or crafted
///   client can never read another profile's library.
/// - `None` means a paired-but-unbound session: callers must return an EMPTY
///   result (or a `profile_id IS NULL` scope) rather than fall back to the
///   owner's data, which is exactly the leak this closes.
fn read_scope_profile(
    state: &AppState,
    headers: &HeaderMap,
    addr: &SocketAddr,
    q: &TokenQuery,
    client_profile_id: Option<i64>,
) -> Option<i64> {
    let this_machine = is_this_machine(headers, addr);
    // Both lookups take the db lock, and each branch needs only one of them —
    // hence the closures.
    let default_profile = || {
        let conn = state.db.lock().expect("db mutex poisoned");
        crate::profiles::default_id(&conn).unwrap_or(1)
    };
    let guest_profile = || guest_profile_id(state, headers);
    let session_profile = || extract_token(headers, q).and_then(|t| state.session_profile(&t));
    read_scope_decision(
        this_machine,
        client_profile_id,
        default_profile,
        guest_profile,
        session_profile,
    )
}

/// The read-scoping rule, with the plumbing lifted out — the sibling of
/// [`scope_decision`], and pure for the same reason: `AppState` owns a
/// `tauri::AppHandle` and can't be built in a test, so the policy has to be
/// separable from it to ever be exercised directly.
///
/// It differs from `scope_decision` in one way, deliberately: for the owner an
/// absent claim resolves to the DEFAULT profile rather than to "no profile",
/// because these endpoints (a library list, a Home feed) have no sensible
/// no-profile answer — where `scope_decision`'s callers (KV, bans, stats) do.
///
/// `this_machine` carries the same warning as `scope_decision`'s: it must come
/// from [`is_this_machine`]. Loopback alone would make every tunnelled phone the
/// owner, and the owner branch here resolves to a REAL profile — so an unbound
/// phone would be handed the default profile's whole library.
fn read_scope_decision(
    this_machine: bool,
    client_profile_id: Option<i64>,
    default_profile: impl FnOnce() -> i64,
    guest_profile: impl FnOnce() -> Option<i64>,
    session_profile: impl FnOnce() -> Option<i64>,
) -> Option<i64> {
    if this_machine {
        // The trusted owner: its claim stands, and no claim means "whoever the
        // app opens as".
        return Some(client_profile_id.unwrap_or_else(default_profile));
    }
    // A guest a provider signed in reads their own account and nobody else's.
    // Note what does NOT happen here: no fallback to the default profile. A guest
    // whose account cannot be resolved reads nothing, exactly like an unbound
    // paired device, because the alternative is handing them the owner's library.
    if let Some(theirs) = guest_profile() {
        return Some(theirs);
    }
    // A paired device is its session, full stop — the claim is never consulted.
    // Unbound stays None: callers return an empty result rather than fall back
    // to the owner's data, which is exactly the leak this closes.
    session_profile()
}

/// The profile id a per-profile READ or WRITE endpoint must act on, hardened
/// against a paired device passing a crafted `profile_id` to reach ANOTHER
/// profile's personalization (favorites, play history, stats, KV, artist bans).
///
/// - **This machine** (the desktop webview, the trusted owner) keeps its
///   client-supplied value verbatim — its UI legitimately switches profiles
///   in-app, so behaviour is unchanged (including a `None`/no-profile scope).
/// - A **paired device** is FORCED onto the profile bound to its session and
///   cannot widen that with a `profile_id` param; a paired-but-unbound session
///   is rejected (the client must bind a profile first).
///
/// The owner test is [`is_this_machine`], NOT loopback: with the Meradomo tunnel
/// in front, the agent proxies to `127.0.0.1` and sends no `X-Forwarded-For`, so
/// a phone anywhere in the world also arrives from loopback. Trusting loopback
/// here handed every paired device the owner's powers — it could POST itself
/// into any profile's device list and read that list (`now_playing` included)
/// straight back, which is the exact leak the rule below is for.
///
/// Call this BEFORE taking the db lock — it locks internally via
/// `session_profile`, so a held `state.db` lock here would deadlock.
fn scoped_profile_id(
    state: &AppState,
    headers: &HeaderMap,
    addr: &SocketAddr,
    q: &TokenQuery,
    client_profile_id: Option<i64>,
) -> Result<Option<i64>, Response> {
    let this_machine = is_this_machine(headers, addr);
    // Lazy on purpose: each lookup takes the db lock, and no single branch needs
    // more than one of them.
    let guest_profile = || guest_profile_id(state, headers);
    let session_profile = || extract_token(headers, q).and_then(|t| state.session_profile(&t));
    scope_decision(this_machine, client_profile_id, guest_profile, session_profile)
        .ok_or_else(|| (StatusCode::FORBIDDEN, "no profile selected").into_response())
}

/// The profile belonging to the guest this request came from, creating it the
/// first time they arrive.
///
/// Returns `None` for anybody who is not a guest — the desktop, the owner, a
/// phone paired over the local network — so every other path is untouched.
fn guest_profile_id(state: &AppState, headers: &HeaderMap) -> Option<i64> {
    let guest = identity::guest_of(headers)?;
    let conn = state.db.lock().expect("db mutex poisoned");
    crate::profiles::ensure_for_identity(
        &conn,
        identity::IDENTITY_PROVIDER,
        &guest.sub,
        &guest.email,
    )
    .ok()
    .map(|p| p.id)
}

/// Who a request is allowed to read, with the plumbing lifted out: `this_machine`
/// is the trust classification, `client_profile_id` the CLAIM off the query
/// string, `guest_profile` the account of a visitor a provider has signed in, and
/// `session_profile` the profile the caller's token is actually bound to.
/// `None` = refuse.
///
/// `this_machine` must come from [`is_this_machine`] and not from loopback alone.
/// Loopback stopped meaning "the owner" the moment the tunnel arrived, and this
/// function cannot tell the difference — it believes whatever the shell hands it.
///
/// Pure so the rule that decides who reads whose data is unit-testable —
/// `scoped_profile_id` is a thin shell that gathers these inputs, and `AppState`
/// (which owns a `tauri::AppHandle`) can't be built in a test. Everything above
/// this line is I/O; everything in it is the actual policy.
fn scope_decision(
    this_machine: bool,
    client_profile_id: Option<i64>,
    guest_profile: impl FnOnce() -> Option<i64>,
    session_profile: impl FnOnce() -> Option<i64>,
) -> Option<Option<i64>> {
    if this_machine {
        // The desktop webview — the trusted owner, whose UI legitimately
        // switches profiles in-app. Its claim stands, `None` (no-profile scope)
        // included.
        return Some(client_profile_id);
    }
    // Somebody the owner shared with, signed in by a provider. They are their own
    // account and cannot be anybody else's: the claim is not consulted, so a
    // crafted `profile_id` cannot reach into a stranger's playlists.
    if let Some(theirs) = guest_profile() {
        return Some(Some(theirs));
    }
    // A paired device is whoever its session says it is. The claim is discarded
    // rather than checked-against: there is no request it could make that would
    // widen its scope. Unbound (paired, no profile chosen) reads nothing.
    session_profile().map(Some)
}

/// `/api/playlists?t=...&profile_id=N`. `profile_id` scopes the list to one
/// user profile, but a paired device is pinned to its session-bound profile
/// regardless (see `read_scope_profile`) — the param is only honoured over
/// loopback (the desktop).
#[derive(serde::Deserialize)]
struct PlaylistsQuery {
    t: Option<String>,
    profile_id: Option<i64>,
}

async fn list_playlists(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<PlaylistsQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    // Pin to the acting profile: loopback (desktop) may ask for any profile via
    // `profile_id`; a paired device is scoped to its session-bound profile and
    // an unbound one gets an empty list rather than the owner's library.
    let Some(profile_id) = read_scope_profile(&state, &headers, &addr, &tq, q.profile_id) else {
        return Json(Vec::<PlaylistRow>::new()).into_response();
    };
    let rows = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let mut stmt = match conn.prepare(
            "SELECT p.id, p.name,
                    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id),
                    COALESCE(
                        p.cover_url,
                        (SELECT t.album_art_url
                         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                         WHERE pt.playlist_id = p.id AND t.album_art_url IS NOT NULL
                         ORDER BY pt.position LIMIT 1)
                    ),
                    p.spotify_id,
                    p.owner,
                    -- Up to 4 distinct-art track ids for the mosaic tile.
                    -- One representative track per distinct album_art_url
                    -- (lowest position), ordered by position, capped at 4,
                    -- comma-joined for transport.
                    (SELECT group_concat(tid) FROM (
                        SELECT MIN(t.id) AS tid, MIN(pt.position) AS pos
                        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                        WHERE pt.playlist_id = p.id AND t.album_art_url IS NOT NULL
                        GROUP BY t.album_art_url
                        ORDER BY pos
                        LIMIT 4
                    ))
             FROM playlists p
             WHERE p.profile_id = ?1
               AND (
                 EXISTS (SELECT 1 FROM playlist_tracks pt2 WHERE pt2.playlist_id = p.id)
                 -- ...but a user-created (`local:`) playlist shows even when
                 -- empty; only empty IMPORTS stay hidden as ghosts.
                 OR p.spotify_id LIKE 'local:%'
             )
             ORDER BY p.name COLLATE NOCASE",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(?e, "list_playlists prepare");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        stmt.query_map([profile_id], |r| {
            let sid: String = r.get(4)?;
            // `csv:liked-songs` (the imported Spotify Liked Songs) and any
            // `liked:` playlist are the dedicated "liked" source — pinned to
            // the top of the library and badged with a heart.
            let source = if sid == "csv:liked-songs" || sid.starts_with("liked:") {
                "liked"
            } else if sid.starts_with("csv:") {
                "csv"
            } else if sid.starts_with("album:") {
                // Full albums imported via "Add album to library" — typed
                // distinctly from plain playlists so the library can filter
                // and label them "Album · Artist" (Spotify style).
                "album"
            } else if sid.starts_with("local:") {
                // Playlists created directly from the web player (or
                // anywhere else inside Beetbot) — not mirrored from any
                // upstream service.
                "local"
            } else if sid.starts_with("soundcloud:") {
                // Imported from a SoundCloud playlist link.
                "soundcloud"
            } else if sid.starts_with("apple:") {
                // Imported from a public Apple Music playlist link.
                "apple"
            } else {
                "spotify"
            };
            let owner: Option<String> = r.get(5)?;
            let cover_tids: Option<String> = r.get(6)?;
            let cover_track_ids = cover_tids
                .map(|s| {
                    s.split(',')
                        .filter_map(|x| x.trim().parse::<i64>().ok())
                        .collect::<Vec<i64>>()
                })
                .unwrap_or_default();
            Ok(PlaylistRow {
                id: r.get(0)?,
                name: r.get(1)?,
                track_count: r.get(2)?,
                cover_url: r.get(3)?,
                source,
                owner,
                cover_track_ids,
            })
        })
        .ok()
        .and_then(|i| i.collect::<Result<Vec<_>, _>>().ok())
        .unwrap_or_default()
    };
    Json(rows).into_response()
}

#[derive(Serialize)]
struct StreamTrack {
    id: i64,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    position: i64,
    has_audio: bool,
    /// Track lifecycle state -- the web player uses this to know whether the
    /// track has playable audio yet or still needs a file attached.
    status: String,
    /// Why the hub stopped trying, when it did. The phone polls this endpoint
    /// while a download runs; without the reason it can only say "it didn't
    /// work", which reads the same for an age-gated video (fixable -- point it
    /// at another upload) and an unmatchable one (nothing to do). Only the
    /// single-track read fills this in; the playlist lists leave it None
    /// rather than widen a query that returns hundreds of rows for a field
    /// that is NULL on nearly all of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_reason: Option<String>,
}

#[derive(Serialize)]
struct PlaylistDetail {
    id: i64,
    name: String,
    /// User-editable blurb (local playlists). NULL for most; the phone's
    /// Edit-details sheet reads and writes it, mirroring desktop.
    description: Option<String>,
    cover_url: Option<String>,
    /// Where the playlist came from (local/spotify/liked/album/csv/...). Imported
    /// playlists carry a synthetic import id.
    source: &'static str,
    tracks: Vec<StreamTrack>,
}

async fn get_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, id) {
        return r;
    }
    let conn = state.db.lock().expect("db mutex poisoned");
    let head = conn.query_row(
        "SELECT id, name, description,
                COALESCE(cover_url,
                    (SELECT t.album_art_url
                     FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                     WHERE pt.playlist_id = playlists.id AND t.album_art_url IS NOT NULL
                     ORDER BY pt.position LIMIT 1)),
                spotify_id
         FROM playlists WHERE id = ?1",
        params![id],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?, // description
                r.get::<_, Option<String>>(3)?, // cover_url
                r.get::<_, String>(4)?,          // spotify_id
            ))
        },
    );
    let (pid, name, description, cover_url, spotify_id) = match head {
        Ok(t) => t,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(e) => {
            tracing::error!(?e, "get_playlist head");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let order = crate::playlist_track_order(&conn, pid);
    let mut stmt = match conn.prepare(&format!(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms,
                pt.position, t.local_path, t.status
         FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
         WHERE pt.playlist_id = ?1 {order}"
    )) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(?e, "get_playlist tracks prepare");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let tracks: Vec<StreamTrack> = stmt
        .query_map(params![pid], |r| {
            let artists_json: String = r.get(2)?;
            let artists: Vec<String> =
                serde_json::from_str(&artists_json).unwrap_or_default();
            let local_path: Option<String> = r.get(7)?;
            Ok(StreamTrack {
                id: r.get(0)?,
                title: r.get(1)?,
                artists,
                album: r.get(3)?,
                album_art_url: r.get(4)?,
                duration_ms: r.get(5)?,
                position: r.get(6)?,
                has_audio: local_path.is_some(),
                status: r.get(8)?,
                failure_reason: None,
            })
        })
        .ok()
        .and_then(|i| i.collect::<Result<Vec<_>, _>>().ok())
        .unwrap_or_default();

    Json(PlaylistDetail {
        id: pid,
        name,
        description,
        cover_url,
        source: crate::playlist_source(&spotify_id),
        tracks,
    })
    .into_response()
}

/// GET /api/library/songs — every track reachable through the acting profile's
/// playlists (regular + Liked + saved albums), title-sorted. Mirrors the
/// desktop's `list_library_songs` IPC so the phone can offer a flat Songs tab.
async fn get_library_songs(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<PlaylistsQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let Some(profile_id) =
        read_scope_profile(&state, &headers, &addr, &tq, q.profile_id)
    else {
        return Json(Vec::<StreamTrack>::new()).into_response();
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut stmt = match conn.prepare(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms,
                t.local_path, t.status
         FROM tracks t
         WHERE t.id IN (
             SELECT pt.track_id FROM playlist_tracks pt
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE p.profile_id IS ?1
         )
           AND TRIM(t.title) <> ''
         ORDER BY t.title COLLATE NOCASE",
    ) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(?e, "library songs prepare");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let tracks: Vec<StreamTrack> = stmt
        .query_map(params![profile_id], |r| {
            let artists_json: String = r.get(2)?;
            let artists: Vec<String> =
                serde_json::from_str(&artists_json).unwrap_or_default();
            let local_path: Option<String> = r.get(6)?;
            Ok(StreamTrack {
                id: r.get(0)?,
                title: r.get(1)?,
                artists,
                album: r.get(3)?,
                album_art_url: r.get(4)?,
                duration_ms: r.get(5)?,
                position: 0,
                has_audio: local_path.is_some(),
                status: r.get(7)?,
                failure_reason: None,
            })
        })
        .ok()
        .and_then(|i| i.collect::<Result<Vec<_>, _>>().ok())
        .unwrap_or_default();
    Json(tracks).into_response()
}

/// DELETE /api/playlists/:id
///
/// Removes the playlist row. `playlist_tracks` rows are removed
/// automatically by the FK cascade. Track rows are NEVER touched —
/// they may still be in other playlists, and even when orphaned the
/// audio file on disk stays put (next match/import can re-link it).
///
/// Phone-only entry point; the desktop uses the `delete_playlist`
/// Tauri IPC command (defined in lib.rs) which calls the same
/// underlying `delete_playlist_row` helper.
async fn delete_playlist_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, id) {
        return r;
    }
    // Separate "protected" from "gone" BEFORE deleting: both come back as
    // `removed == false`, and answering 404 for a playlist the caller can
    // plainly see is the kind of misleading signal that costs someone an
    // afternoon. Favorites is the star button's anchor and cannot be deleted.
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if crate::is_anchor_playlist(&conn, id) {
            return (
                StatusCode::CONFLICT,
                "Favorites can't be deleted — it's where the star button saves songs.",
            )
                .into_response();
        }
    }
    let removed = {
        let conn = state.db.lock().expect("db mutex poisoned");
        match crate::delete_playlist_row(&conn, id) {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(?e, id, "delete_playlist: db error");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };
    if !removed {
        return StatusCode::NOT_FOUND.into_response();
    }
    tracing::info!(playlist_id = id, "playlist deleted via HTTP");
    Json(serde_json::json!({ "deleted": true })).into_response()
}

#[derive(Deserialize)]
struct RenamePlaylistBody {
    name: String,
    /// Optional. Absent ⇒ name-only edit (leaves the description untouched);
    /// present ⇒ also set it (blank clears it to NULL). Mirrors the desktop
    /// Edit-details IPC.
    #[serde(default)]
    description: Option<String>,
}

/// PATCH /api/playlists/:id  body: { name, description? }
///
/// Renames the playlist and, when `description` is present, sets it too.
/// Phone-only entry point; the desktop uses the `rename_playlist` Tauri IPC
/// command, which calls the same `rename_playlist_row` helper. Note:
/// re-importing an imported playlist would restore its original name (the
/// local rename isn't written back to the source archive).
async fn rename_playlist_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
    Json(body): Json<RenamePlaylistBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, id) {
        return r;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if name.chars().count() > 200 {
        return (StatusCode::BAD_REQUEST, "name too long").into_response();
    }
    let renamed = {
        let conn = state.db.lock().expect("db mutex poisoned");
        match crate::rename_playlist_row(&conn, id, name, body.description.as_deref()) {
            Ok(b) => b,
            Err(e) => {
                tracing::error!(?e, id, "rename_playlist: db error");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };
    if !renamed {
        return StatusCode::NOT_FOUND.into_response();
    }
    tracing::info!(playlist_id = id, %name, "playlist renamed via HTTP");
    Json(serde_json::json!({ "id": id, "name": name })).into_response()
}

/// GET /api/cast/devices
///
/// Returns the Chromecasts the host has seen on the LAN since
/// startup. First request after a fresh launch may return an
/// empty list while mDNS responses are still trickling in (give
/// it ~1-2 seconds); the client should re-poll if empty.
///
/// Milestone 1 of the Cast feature — discovery only. No playback
/// control yet; that lands in M2.
async fn list_cast_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let devices = match state.cast.as_ref() {
        Some(cast) => cast.discovery.list().await,
        None => Vec::new(),
    };
    Json(devices).into_response()
}

#[derive(Deserialize)]
struct CastStartBody {
    device_id: String,
    track_id: i64,
    /// Where to begin playback on the receiver, in seconds. The
    /// frontend passes the local <audio> element's currentTime when
    /// the user clicks Cast in the middle of a track, so the
    /// receiver picks up where they left off instead of restarting
    /// from 0. Optional — defaults to 0 (or, for a same-track speaker
    /// switch, to the prior session's currentTime).
    #[serde(default)]
    start_time: Option<f64>,
}

#[derive(Serialize)]
struct CastStartOut {
    device_id: String,
    device_name: String,
    stream_url: String,
}

/// POST /api/cast/start  body { device_id, track_id }
///
/// Looks up the track by id, constructs a LAN stream URL the Chromecast can
/// fetch (`/stream/{id}` for a downloaded file, `/stream/{id}/live` for a
/// streamed track — prepared/warmed here first so the receiver never times
/// out), and spins up a Cast session that LAUNCHes the Default Media Receiver
/// and LOADs the URL. Replaces any previously active cast session.
async fn cast_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<CastStartBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Some(cast) = state.cast.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "cast discovery is not running",
        )
            .into_response();
    };
    let Some(device) = cast.discovery.get(&body.device_id).await else {
        return (StatusCode::NOT_FOUND, "device not found").into_response();
    };
    let Some(ip) = device.ip else {
        return (
            StatusCode::CONFLICT,
            "device has no resolved IP yet — try again",
        )
            .into_response();
    };

    // Pull track metadata + local_path. `local_path.is_none()` means it's a
    // streamed (not-downloaded) track — cast it via the warmed /live URL below.
    let track_row = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT title, artists, album, album_art_url, local_path
             FROM tracks WHERE id = ?1",
            params![body.track_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
    };
    let (title, artists_json, album, album_art_url, local_path) = match track_row {
        Ok(t) => t,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(e) => {
            tracing::error!(?e, "cast_start: track lookup");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Downloaded → serve the file by id (`/stream/{id}`). Not downloaded →
    // prepare the live stream NOW: this call blocks until the engine has
    // de-fragmented it into the temp cache. Once warm, `/stream/{id}/live`
    // serves a seekable, Content-Length'd audio/mp4 that's indistinguishable
    // from a downloaded file to the receiver — so the Chromecast never
    // cold-starts and times out; the (bounded) wait happens here instead, and
    // the client shows a "Preparing…" state around this request. Belt-and-
    // suspenders: the client usually warms it first, in which case this
    // returns instantly.
    let is_live = local_path.is_none();
    if is_live {
        match crate::acquisition::active_provider()
            .live_path(&state.app, &state.db, body.track_id, false)
            .await
        {
            Ok(Some(_)) => {} // warmed — the /live URL will serve instantly
            Ok(None) | Err(_) => {
                return (StatusCode::CONFLICT, "couldn't prepare this track to cast")
                    .into_response();
            }
        }
    }
    let artists: Vec<String> =
        serde_json::from_str(&artists_json).unwrap_or_default();
    let primary_artist = artists.join(", ");

    // Stream URL = our LAN IP + the streaming port. The Chromecast
    // is on the same LAN; IP allowlist passes LAN peers without
    // requiring a session token.
    let Some(our_ip) = local_ip_address::local_ip().ok() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "unable to determine our LAN IP",
        )
            .into_response();
    };
    let stream_url = if is_live {
        format!(
            "http://{}:{}/stream/{}/live",
            our_ip, state.streaming_port, body.track_id
        )
    } else {
        format!(
            "http://{}:{}/stream/{}",
            our_ip, state.streaming_port, body.track_id
        )
    };

    // Inspect any prior session.
    let prev_handle: Option<crate::cast::CastHandle> = {
        let active = cast.active.lock().await;
        active.clone()
    };

    // Decide where to start playback.
    //
    // Priority order:
    //   1. Explicit start_time in the request body — set by the
    //      frontend when the user clicks Cast in the middle of a
    //      locally-playing track. Carrying the local <audio>
    //      element's currentTime here is what makes the receiver
    //      pick up where the user left off.
    //   2. Transferring the SAME track to a different speaker —
    //      carry over the prior cast session's currentTime
    //      (Spotify-style "transfer playback").
    //   3. Otherwise 0 (fresh track or fresh cast).
    let start_time: f64 = match (body.start_time, &prev_handle) {
        (Some(t), _) if t.is_finite() && t > 0.0 => t,
        (_, Some(old)) if old.device_id != device.id => {
            let snap = old.status_snapshot().await;
            if snap.track_id == Some(body.track_id) {
                snap.current_time.unwrap_or(0.0).max(0.0)
            } else {
                0.0
            }
        }
        _ => 0.0,
    };

    let media = crate::cast::MediaPayload {
        url: stream_url.clone(),
        // The Default Media Receiver picks decoders by content-type.
        // m4a containers carry AAC; "audio/mp4" is the right MIME.
        content_type: "audio/mp4".into(),
        title: title.clone(),
        artist: primary_artist,
        album,
        image_url: album_art_url,
        track_id: body.track_id,
        start_time,
    };

    // If the user is changing tracks on the SAME device, send a
    // LOAD-only on the existing TLS channel — no chime, no
    // re-LAUNCH, no UI gap. Only do the full CONNECT+LAUNCH+LOAD
    // flow if we're casting to a different device (or no session is
    // active).
    if let Some(old) = &prev_handle {
        if old.device_id == device.id {
            tracing::info!(
                device = %device.id,
                start_time,
                "cast_start: reusing session via LoadMedia"
            );
            if let Err(e) = old
                .send(crate::cast::CastCommand::LoadMedia(media.clone()))
                .await
            {
                tracing::warn!(?e, "cast_start: LoadMedia send failed; falling back to fresh session");
            } else {
                return Json(CastStartOut {
                    device_id: old.device_id.clone(),
                    device_name: old.device_name.clone(),
                    stream_url,
                })
                .into_response();
            }
        }
    }

    // Different device (or no prior session) — full launch flow.
    // Send STOP to the prior session first if there was one, but
    // keep the slot populated until the new handle is ready so the
    // frontend's status poller doesn't briefly see active=false and
    // tear down cast mode in the UI.
    if let Some(old) = prev_handle {
        tracing::info!(
            old_device = %old.device_id,
            new_device = %device.id,
            start_time,
            "cast_start: switching devices (slot retained until new handle ready)"
        );
        let _ = old.send(crate::cast::CastCommand::Stop).await;
    }

    let handle = match crate::cast::CastSession::start(
        device.id.clone(),
        device.friendly_name.clone(),
        ip,
        device.port,
        media,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(?e, device = %device.id, "cast_start failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"cast_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let device_name = handle.device_name.clone();
    let device_id_out = handle.device_id.clone();
    {
        let mut active = cast.active.lock().await;
        // Atomic swap: any prior handle (the one we already told to
        // STOP) drops here.
        *active = Some(handle);
    }

    Json(CastStartOut {
        device_id: device_id_out,
        device_name,
        stream_url,
    })
    .into_response()
}

#[derive(Deserialize)]
struct CastControlBody {
    /// "play" | "pause" | "seek"
    action: String,
    /// Required for "seek"; absolute position in seconds.
    #[serde(default)]
    seconds: Option<f64>,
}

/// POST /api/cast/control  body { action, seconds? }
///
/// Sends a play/pause/seek command to whatever device is currently
/// active. 404 if nothing's casting.
async fn cast_control(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<CastControlBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Some(cast) = state.cast.clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let active = cast.active.lock().await;
    let Some(handle) = active.as_ref() else {
        return (StatusCode::NOT_FOUND, "no active cast").into_response();
    };
    let cmd = match body.action.as_str() {
        "play" => crate::cast::CastCommand::Play,
        "pause" => crate::cast::CastCommand::Pause,
        "seek" => {
            let Some(t) = body.seconds else {
                return (StatusCode::BAD_REQUEST, "seek needs seconds").into_response();
            };
            crate::cast::CastCommand::Seek(t)
        }
        _ => {
            return (StatusCode::BAD_REQUEST, "unknown action").into_response();
        }
    };
    if let Err(e) = handle.send(cmd).await {
        tracing::warn!(?e, "cast_control: send failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

/// POST /api/cast/stop
///
/// Sends STOP to the active cast session and drops the handle.
/// Idempotent — returns 204 even when nothing was casting.
async fn cast_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Some(cast) = state.cast.clone() else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let mut active = cast.active.lock().await;
    if let Some(handle) = active.take() {
        let _ = handle.send(crate::cast::CastCommand::Stop).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Serialize)]
struct CastStatusOut {
    /// True when there is an active cast session. When false, the
    /// other fields are placeholders and should be ignored by the
    /// client — it should drop out of cast mode.
    active: bool,
    /// Stable id of the device the active session is talking to.
    /// Empty when `active` is false.
    device_id: String,
    /// Friendly name (e.g. "Living Room speaker"). Empty when not
    /// active.
    device_name: String,
    /// Latest known receiver status (mirrored from MEDIA_STATUS).
    /// Defaults populated when no session is active so the client can
    /// treat the shape as stable.
    status: crate::cast::CastStatus,
}

/// GET /api/cast/status
///
/// Returns a snapshot of the active cast session for the frontend to
/// poll. The frontend uses this to keep the scrubber/play state in
/// sync with the receiver and to detect FINISHED so it can advance
/// the queue. Returns `active: false` with empty fields when nothing
/// is casting — the client treats that as "stop cast mode."
async fn cast_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Some(cast) = state.cast.clone() else {
        return Json(CastStatusOut {
            active: false,
            device_id: String::new(),
            device_name: String::new(),
            status: crate::cast::CastStatus::default(),
        })
        .into_response();
    };
    let active = cast.active.lock().await;
    let Some(handle) = active.as_ref() else {
        return Json(CastStatusOut {
            active: false,
            device_id: String::new(),
            device_name: String::new(),
            status: crate::cast::CastStatus::default(),
        })
        .into_response();
    };
    let snapshot = handle.status_snapshot().await;
    Json(CastStatusOut {
        active: true,
        device_id: handle.device_id.clone(),
        device_name: handle.device_name.clone(),
        status: snapshot,
    })
    .into_response()
}

async fn get_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let conn = state.db.lock().expect("db mutex poisoned");
    let row = conn.query_row(
        "SELECT id, title, artists, album, album_art_url, duration_ms, local_path, status,
                failure_reason
         FROM tracks WHERE id = ?1",
        params![id],
        |r| {
            let artists_json: String = r.get(2)?;
            let artists: Vec<String> =
                serde_json::from_str(&artists_json).unwrap_or_default();
            let local_path: Option<String> = r.get(6)?;
            Ok(StreamTrack {
                id: r.get(0)?,
                title: r.get(1)?,
                artists,
                album: r.get(3)?,
                album_art_url: r.get(4)?,
                duration_ms: r.get(5)?,
                position: 0,
                has_audio: local_path.is_some(),
                status: r.get(7)?,
                failure_reason: r.get(8)?,
            })
        },
    );
    match row {
        Ok(t) => Json(t).into_response(),
        Err(rusqlite::Error::QueryReturnedNoRows) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::error!(?e, "get_track");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn get_track_art(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    // Same LAN bypass as /stream — AirPlay receivers and Chromecasts
    // fetch this URL directly without a session token. They're on the
    // LAN so the IP allowlist already vetted them.
    if !is_private_addr(&effective_client_ip(&addr, &headers)) {
        if let Err(r) = require_token(&state, &headers, &q) {
            return r;
        }
    }
    let url: Option<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT album_art_url FROM tracks WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    proxy_art_response("get_track_art", url, &state).await
}

async fn get_playlist_art(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    // Same-origin endpoint for the playlist cover so the service worker can
    // cache it (cross-origin CDN images can't be intercepted cleanly).
    //
    // This used to skip the token on the LAN, "same as track art" — but nothing
    // casts a PLAYLIST cover. A Chromecast is handed the track's own CDN url
    // (`MediaPayload::image_url`, straight off `tracks.album_art_url`) and never
    // calls this route; the only callers are `playlistArtUrl()`, which always
    // carries a token. So the bypass bought nothing and meant any device on the
    // Wi-Fi could pull any household member's playlist cover while completely
    // unpaired, and probe which playlist ids existed via 404-vs-200. Caching is
    // unaffected: the service worker strips the token from its cache key.
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // And a playlist belongs to a profile — a paired device may only fetch its
    // own covers, the same rule every other playlist endpoint already enforces.
    if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, id) {
        return r;
    }
    let url: Option<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT COALESCE(p.cover_url,
                (SELECT t.album_art_url
                   FROM playlist_tracks pt
                   JOIN tracks t ON pt.track_id = t.id
                  WHERE pt.playlist_id = p.id
                    AND t.album_art_url IS NOT NULL
                  ORDER BY pt.position
                  LIMIT 1))
             FROM playlists p WHERE p.id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    proxy_art_response("get_playlist_art", url, &state).await
}

/// Shared implementation for track / playlist art proxy endpoints.
/// Takes an optional upstream URL (Spotify CDN, typically) and
/// streams the JPEG bytes back inline — no 302 redirect (some
/// downstream clients like AirPlay receivers and the SW's
/// stale-while-revalidate cache flow handle a direct 200 better),
/// with a 7-day immutable cache header so browsers don't re-fetch
/// every page load.
/// Forget art that turned out to be Deezer's "no artwork" placeholder, so the
/// next cover pick falls through to another track instead of serving a grey
/// disc forever. Cheap self-heal: we only learn a cover is a dud by fetching it,
/// and we just did. Best-effort — a failed write only means we retry next time.
fn forget_dud_art(state: &AppState, art_url: &str, label: &'static str) {
    let Ok(conn) = state.db.lock() else { return };
    let tracks = conn
        .execute(
            "UPDATE tracks SET album_art_url = NULL WHERE album_art_url = ?1",
            params![art_url],
        )
        .unwrap_or(0);
    let playlists = conn
        .execute(
            "UPDATE playlists SET cover_url = NULL WHERE cover_url = ?1",
            params![art_url],
        )
        .unwrap_or(0);
    if tracks + playlists > 0 {
        tracing::info!(
            label,
            %art_url,
            tracks,
            playlists,
            "art proxy: dropped Deezer no-cover placeholder"
        );
    }
}

async fn proxy_art_response(
    label: &'static str,
    upstream_url: Option<String>,
    state: &AppState,
) -> Response {
    let Some(art_url) = upstream_url else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(?e, label, "art proxy: client build failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let upstream = match client.get(&art_url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(?e, %art_url, label, "art proxy: upstream fetch failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    if !upstream.status().is_success() {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    // Deezer answers "this album has no artwork" with a 302 to its placeholder
    // rather than a 404, so a dud is only visible in where we LANDED — the
    // stored url keeps a real-looking hash. reqwest followed the redirects, so
    // this costs nothing: forget the dud and 404, and the client shows its own
    // neutral placeholder while the next request picks another track's cover.
    if upstream.url().as_str().contains(crate::deezer::NO_COVER_MD5) {
        forget_dud_art(state, &art_url, label);
        return StatusCode::NOT_FOUND.into_response();
    }
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(?e, label, "art proxy: body read failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let mut resp = bytes.to_vec().into_response();
    let h = resp.headers_mut();
    if let Ok(v) = header::HeaderValue::from_str(&content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // 7-day cache — album art is effectively immutable.
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=604800, immutable"),
    );
    resp
}

/// Extract the 32-char hex md5 from a Deezer **playlist** image URL
/// (`https://<host>.dzcdn.net/images/playlist/<md5>/<W>x<H>-...`). Returns
/// `None` for any other image type — album/artist art carries no wordmark — or
/// a non-Deezer URL, so only editorial playlist covers ever get rewritten.
fn deezer_playlist_md5(url: &str) -> Option<&str> {
    let rest = url.split("/images/playlist/").nth(1)?;
    let md5 = rest.split('/').next()?;
    (md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_hexdigit())).then_some(md5)
}

/// Rewrite a Deezer playlist cover URL to our same-origin scrub proxy, which
/// paints out the baked-in "DEEZER" wordmark before serving. Deezer bakes that
/// wordmark into editorial playlist covers; the client draws its own badge over
/// it, but that badge is just an overlay — deleting it in devtools would reveal
/// the wordmark underneath. Routing the cover through `/api/cover-scrub` means
/// the bytes the browser receives never contain the wordmark at all, and the
/// client only ever holds an opaque md5, never the dzcdn URL. Non-playlist /
/// non-Deezer covers pass through unchanged.
fn scrub_playlist_cover(url: Option<String>) -> Option<String> {
    let u = url?;
    match deezer_playlist_md5(&u) {
        // `?r=` is a cache-buster: cover-scrub responses are cached immutably by
        // md5, so when the scrub itself changes (box size / fill) the same URL
        // would otherwise keep serving the old image. Bump on any scrub change.
        Some(md5) => Some(format!("/api/cover-scrub/{md5}?r=5")),
        None => Some(u),
    }
}

/// Decode a Deezer playlist cover and cover just the baked-in "DEEZER" wordmark,
/// then re-encode as JPEG. Returns `None` if the bytes don't decode (the caller
/// then serves a neutral placeholder — Deezer serves valid JPEGs, so this path
/// is effectively dead).
///
/// The wordmark is a fixed template near the bottom-right — measured across many
/// covers at ~x[0.644, 0.934] y[0.884, 0.932]. We cover a tight box around it
/// (small pad), not the whole corner, so the patch is as unobtrusive as possible.
/// Each covered column is filled with the AVERAGE of the cover's own pixels just
/// above and below the box in that column, so the patch takes on the surrounding
/// colour and blends in (following the background's horizontal variation) rather
/// than reading as a flat block.
fn scrub_wordmark(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut img = image::load_from_memory(bytes).ok()?.to_rgb8();
    let (w, h) = img.dimensions();
    if w < 8 || h < 8 {
        return None;
    }
    // Deezer bakes a "deezer" wordmark into the bottom-right of editorial covers.
    // Cropping it off takes cover text/art with it, so instead paint it out in
    // place: fill the box with the cover's own surrounding pixels, then feather-
    // blur so the corner reads as a soft-focus patch rather than a hard smear —
    // preserving the rest of the artwork.
    let x0 = (w as f32 * 0.625) as u32;
    let x1 = ((w as f32 * 0.95).ceil() as u32).min(w);
    let y0 = (h as f32 * 0.865) as u32;
    let y1 = ((h as f32 * 0.95).ceil() as u32).min(h);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let bh = y1 - y0;
    for x in x0..x1 {
        // Average the cover's own pixels in a band just above and just below the
        // box (both OUTSIDE it, so never a written pixel), per column.
        let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
        for sy in y0.saturating_sub(bh)..y0 {
            let p = img.get_pixel(x, sy).0;
            r += p[0] as u32;
            g += p[1] as u32;
            b += p[2] as u32;
            n += 1;
        }
        for sy in y1..(y1 + bh).min(h) {
            let p = img.get_pixel(x, sy).0;
            r += p[0] as u32;
            g += p[1] as u32;
            b += p[2] as u32;
            n += 1;
        }
        let fill = if n > 0 {
            image::Rgb([(r / n) as u8, (g / n) as u8, (b / n) as u8])
        } else {
            image::Rgb([18u8, 18u8, 20u8])
        };
        for y in y0..y1 {
            img.put_pixel(x, y, fill);
        }
    }
    // Feather the filled box into the cover so it dissolves into the surrounding
    // art (weight 1 inside the box, fading to 0 over the feather margin).
    let feather = bh.max(4);
    let blurred = image::imageops::blur(&img, 9.0);
    let bx0 = x0.saturating_sub(feather);
    let by0 = y0.saturating_sub(feather);
    let bx1 = (x1 + feather).min(w);
    let by1 = (y1 + feather).min(h);
    for y in by0..by1 {
        for x in bx0..bx1 {
            let dx = if x < x0 {
                x0 - x
            } else if x >= x1 {
                x + 1 - x1
            } else {
                0
            };
            let dy = if y < y0 {
                y0 - y
            } else if y >= y1 {
                y + 1 - y1
            } else {
                0
            };
            let d = dx.max(dy);
            let wgt = if d == 0 {
                1.0
            } else {
                (1.0 - d as f32 / feather as f32).max(0.0)
            };
            if wgt <= 0.0 {
                continue;
            }
            let o = img.get_pixel(x, y).0;
            let bl = blurred.get_pixel(x, y).0;
            let mix = |a: u8, c: u8| (a as f32 * (1.0 - wgt) + c as f32 * wgt).round() as u8;
            img.put_pixel(
                x,
                y,
                image::Rgb([mix(o[0], bl[0]), mix(o[1], bl[1]), mix(o[2], bl[2])]),
            );
        }
    }
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .ok()?;
    Some(out.into_inner())
}

/// A solid neutral square, served when a cover somehow can't be decoded so the
/// endpoint NEVER falls back to the wordmarked original. Matches the card's
/// `bg-neutral-800` placeholder, so a (practically impossible — Deezer serves
/// valid JPEGs) decode failure degrades to an empty cover, not a "DEEZER" leak.
fn neutral_cover_placeholder() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(500, 500, image::Rgb([38u8, 38u8, 40u8]));
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = image::DynamicImage::ImageRgb8(img)
        .write_to(&mut out, image::ImageFormat::Jpeg);
    out.into_inner()
}

/// GET /api/cover-scrub/{md5}
///
/// Serves a Deezer editorial **playlist** cover with the baked-in "DEEZER"
/// wordmark painted out (see `scrub_playlist_cover`). The client references
/// covers only by this opaque md5 — never the dzcdn URL — and the wordmark is
/// scrubbed from the bytes, so it's neither in the DOM nor recoverable from the
/// network response. No token required: this serves only public cover art.
async fn cover_scrub(Path(md5): Path<String>) -> Response {
    if md5.len() != 32 || !md5.bytes().all(|b| b.is_ascii_hexdigit()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Deezer serves every size off the same md5; 500x500 is what the cards +
    // hero use. Reconstructed here so the raw dzcdn URL never reaches the client.
    let url = format!(
        "https://e-cdns-images.dzcdn.net/images/playlist/{md5}/500x500-000000-80-0-0.jpg"
    );
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(?e, "cover_scrub: client build failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let bytes = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(?e, "cover_scrub: body read failed");
                return StatusCode::BAD_GATEWAY.into_response();
            }
        },
        Ok(r) => {
            tracing::warn!(status = %r.status(), "cover_scrub: upstream non-200");
            return StatusCode::BAD_GATEWAY.into_response();
        }
        Err(e) => {
            tracing::warn!(?e, "cover_scrub: upstream fetch failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    // Never fall back to the raw bytes — those still carry the wordmark. A
    // decode failure (practically impossible for a Deezer JPEG) yields a neutral
    // placeholder instead, so the wordmark can never reach the client.
    let body = scrub_wordmark(&bytes).unwrap_or_else(neutral_cover_placeholder);
    let mut resp = body.into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("image/jpeg"),
    );
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=604800, immutable"),
    );
    resp
}

// ---- Catalog search + add-to-playlist --------------------------------
//
// These three handlers let the web player discover music in Deezer's
// catalog and append it to one of the user's existing playlists. We
// switched off Spotify catalog search because Spotify's Feb 2026
// dev-mode tightening capped /v1/search at 10 results and gated higher
// quotas behind unreachable enterprise criteria. Deezer's public API
// has comparable coverage, returns ISRC directly, and needs no auth.
//
// The additions are local-only. Migration 005's `locally_added` flag marks
// them so a future re-import of the source archive doesn't wipe them.

/// Track shape returned from /api/search and album-tracks endpoints, and
/// also the shape the client posts back to /api/playlists/:id/tracks.
/// `source` + `source_id` identify where the track came from so the host
/// can mint a stable synthetic `tracks.spotify_id` for it.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct CatalogTrackOut {
    source: String,
    source_id: String,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    /// Catalog id of `album`, when the source told us one. The name on its own
    /// is a poor key — "After Hours" and "After Hours (Deluxe)" are two
    /// strings for one record — so anything matching a track back to an album
    /// (the artist page's Essential Albums) keys on this first.
    ///
    /// `serde(default)`: the client posts this same shape back on
    /// add-to-playlist and has no reason to echo it.
    #[serde(default)]
    album_id: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    /// Carries through when Deezer happens to know it. Used as a dedup key
    /// against pre-existing Spotify-imported rows.
    isrc: Option<String>,
    // -- Library state, populated by `annotate_with_library_state` ----
    //
    // Server-side annotations that let the search UI decide whether to
    // render a ✓ ("already in your library") or + ("add to library")
    // button. Both are filled in by a single batch query before we
    // hand the search response back to the client; clients should not
    // post them back on add/remove calls (defaults are fine if they do).
    /// Local `tracks.id` if this catalog row matches an existing local
    /// track by either synthetic spotify_id (`{source}:{source_id}`) or
    /// ISRC. `None` ⇒ never seen this recording before.
    #[serde(default)]
    local_track_id: Option<i64>,
    /// Playlists the local track is currently linked to. Empty when
    /// `local_track_id` is None or when the track row exists but is
    /// orphaned (rare). Drives the "checked" state in the multi-select
    /// add-to-playlist modal. Deliberately EXCLUDES saved-album (`album:`)
    /// playlists — see `in_saved_album_ids`.
    #[serde(default)]
    in_playlist_ids: Vec<i64>,
    /// Saved-album (`album:` spotify_id) playlists the local track belongs
    /// to, for the active profile. Kept separate from `in_playlist_ids`
    /// because a saved album is not a "playlist" for the per-song ✓, yet the
    /// album page still needs a truthful "this whole album is saved" signal —
    /// which `local_track_id` can't give (mere playback sets that).
    #[serde(default)]
    in_saved_album_ids: Vec<i64>,
    /// True iff `local_track_id` is set AND the local track has a
    /// downloaded audio file on disk. Lets the search UI make the
    /// row tappable to start playback immediately for songs that are
    /// already in the library and ready to play.
    #[serde(default)]
    has_audio: bool,
    /// Deezer's public 30-second preview clip (MP3 URL), when present.
    /// Lets the search UI audition a track before adding/downloading it.
    /// Defaulted on deserialize so clients posting the row back on
    /// add/patch don't have to round-trip it.
    #[serde(default)]
    preview_url: Option<String>,
    /// Explicit-lyrics flag for the small "E" badge. Defaulted so
    /// older clients posting the row back still deserialize.
    #[serde(default)]
    explicit: bool,
}

/// Fill `local_track_id` + `in_playlist_ids` on each catalog row by
/// looking it up against the local DB. Matching is OR'd between:
///   - synthetic spotify_id `{source}:{source_id}` (e.g. `deezer:12345`)
///   - ISRC, when the catalog row has one
///
/// Prepared statements are cached so the N round-trips this does
/// (one per track) collapse into a fraction of a millisecond even
/// for full search pages.
fn annotate_with_library_state(
    conn: &Connection,
    tracks: &mut [CatalogTrackOut],
    // ✓ marks must reflect the ACTIVE profile's playlists only — a song in
    // ANOTHER profile's playlist isn't "in your library". Falls back to the
    // default profile when the client didn't send one.
    profile_id: Option<i64>,
) -> rusqlite::Result<()> {
    if tracks.is_empty() {
        return Ok(());
    }
    let pid = profile_id.unwrap_or_else(|| crate::profiles::default_id(conn).unwrap_or(1));
    // One row per match: track id + whether the audio file is on disk.
    // `local_path` is the source of truth for "downloaded" — it's only
    // set after a local-file import successfully finishes.
    let mut stmt_lookup = conn.prepare_cached(
        "SELECT id, local_path, artists FROM tracks
         WHERE spotify_id = ?1
            OR (?2 IS NOT NULL AND isrc = ?2)
         LIMIT 1",
    )?;
    let mut stmt_playlists = conn.prepare_cached(
        // Exclude `album:` rows — a saved album is NOT a playlist, so a track
        // being in one must not light up the per-song "in a playlist" ✓ (the
        // album-level save indicator already covers that).
        "SELECT pt.playlist_id FROM playlist_tracks pt
         JOIN playlists p ON p.id = pt.playlist_id
         WHERE pt.track_id = ?1 AND p.profile_id = ?2
           AND p.spotify_id NOT LIKE 'album:%'",
    )?;
    // The mirror of the above: ONLY `album:` rows. Drives the album page's
    // "this whole album is saved" ✓ off real save state instead of
    // `local_track_id` (which mere playback sets, so a played-but-unsaved
    // album would otherwise read as saved).
    let mut stmt_saved_albums = conn.prepare_cached(
        "SELECT pt.playlist_id FROM playlist_tracks pt
         JOIN playlists p ON p.id = pt.playlist_id
         WHERE pt.track_id = ?1 AND p.profile_id = ?2
           AND p.spotify_id LIKE 'album:%'",
    )?;
    for track in tracks.iter_mut() {
        let synthetic_id =
            format!("{}:{}", track.source.trim(), track.source_id.trim());
        let isrc = track
            .isrc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let found: Option<(i64, Option<String>, Option<String>)> = stmt_lookup
            .query_row(params![synthetic_id, isrc], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .ok();
        if let Some((tid, local_path, lib_artists)) = found {
            let playlists: Vec<i64> = stmt_playlists
                .query_map(params![tid, pid], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let saved_albums: Vec<i64> = stmt_saved_albums
                .query_map(params![tid, pid], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            track.local_track_id = Some(tid);
            track.in_playlist_ids = playlists;
            track.in_saved_album_ids = saved_albums;
            track.has_audio = local_path.is_some();
            // The library is the source of truth for a track you own. Catalog
            // endpoints (search, album tracklists) carry only the primary
            // artist, while the library row holds full credits (import-time
            // enrichment / credit backfill) — so a catalog surface rendering
            // an owned track would otherwise show "James Blake" where the row
            // knows "James Blake, Travis Scott, Ludwig Göransson". Richer
            // wins, same rule as upsert_track; a thin library row (not yet
            // backfilled) never *removes* names the catalog provided.
            if let Some(names) = lib_artists
                .as_deref()
                .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
            {
                if names.len() > track.artists.len() {
                    track.artists = names;
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct SearchAlbumOut {
    source: String,
    source_id: String,
    name: String,
    artists: Vec<String>,
    cover_url: Option<String>,
    album_type: Option<String>,
    release_date: Option<String>,
    total_tracks: Option<u32>,
}

#[derive(Serialize, Clone)]
struct SearchArtistOut {
    source: String,
    source_id: String,
    name: String,
    picture_url: Option<String>,
    /// Total albums Deezer knows about for the artist. Helps the UI
    /// avoid surfacing "0 albums" placeholders.
    total_albums: Option<u32>,
    /// Deezer "fans" (users who favorited the artist). The closest thing
    /// Deezer gives to Spotify's monthly-listener count; shown on the
    /// artist page hero.
    total_fans: Option<u64>,
}

#[derive(Serialize)]
struct SearchOut {
    tracks: Vec<CatalogTrackOut>,
    albums: Vec<SearchAlbumOut>,
    artists: Vec<SearchArtistOut>,
    #[serde(default)]
    playlists: Vec<PlaylistOut>,
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    t: Option<String>,
    q: Option<String>,
    /// Comma-joined subset of "track,album". Defaults to both.
    #[serde(rename = "type")]
    types: Option<String>,
    limit: Option<u32>,
    /// Active profile — scopes the ✓ ("in your library") marks to playlists this
    /// profile owns. Falls back to the default profile when absent.
    #[serde(default)]
    profile_id: Option<i64>,
}

/// Reusable extractor for endpoints that otherwise only take a token but need
/// the active profile to scope their ✓ marks (album/artist/playlist detail).
#[derive(Deserialize)]
struct ProfileQuery {
    #[serde(default)]
    profile_id: Option<i64>,
}

/// GET /api/search?q=...&type=track,album
///
/// Catalog search against Deezer (free, no auth, no quota cliff).
/// Session-token gated like every other /api/* route so the public
/// LAN/internet posture stays consistent.
async fn spotify_search(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Response {
    // The same token-extraction shape as the other routes -- but we have
    // a richer Query type here, so build a minimal TokenQuery for the
    // require_token helper.
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let Some(query) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "missing q").into_response();
    };
    // The ✓ marks (and `in_playlist_ids` / `in_saved_album_ids` behind them) are
    // per-profile library state, so annotate for the CALLER's profile only —
    // otherwise a paired device could search with someone else's id and learn
    // which of their playlists hold a track.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    // Pick which Deezer endpoints to hit based on the requested types.
    // The wire format mirrors the old Spotify-flavored API for backward
    // compatibility with any callers that still pass `type=`.
    let types = q.types.as_deref().unwrap_or("track,album,artist");
    let want_tracks = types.split(',').any(|t| t.trim() == "track");
    let want_albums = types.split(',').any(|t| t.trim() == "album");
    let want_artists = types.split(',').any(|t| t.trim() == "artist");
    let want_playlists = types.split(',').any(|t| t.trim() == "playlist");
    // Deezer's public API tolerates much larger limits than Spotify; 25
    // of each is a comfortable phone-UI page.
    let limit = q.limit.unwrap_or(25).clamp(1, 50);

    // Fast path: serve a recent identical search from the process cache,
    // re-applying current library ✓ state. Spares Deezer's rate limit when the
    // typeahead dropdown, the committed results page, and re-typed queries all
    // repeat the same lookup within the TTL window.
    let cache_key = format!("{}|{}|{}", query.to_lowercase(), types, limit);
    {
        let cache = search_cache().lock().expect("search cache poisoned");
        if let Some(entry) = cache.get(&cache_key) {
            if entry.fetched_at.elapsed() < SEARCH_TTL {
                return entry.to_response(&state, scoped_pid);
            }
        }
    }

    let client = crate::deezer::DeezerClient::new();

    // Run the three requests concurrently when needed. Each one is an
    // independent Deezer endpoint, so serializing buys us nothing.
    let track_fut = async {
        if want_tracks {
            client.search_tracks(query, limit).await
        } else {
            Ok(Vec::new())
        }
    };
    let album_fut = async {
        if want_albums {
            client.search_albums(query, limit).await
        } else {
            Ok(Vec::new())
        }
    };
    let artist_fut = async {
        if want_artists {
            client.search_artists(query, limit).await
        } else {
            Ok(Vec::new())
        }
    };
    let playlist_fut = async {
        if want_playlists {
            client.search_playlists(query, limit).await
        } else {
            Ok(Vec::new())
        }
    };
    let (track_res, album_res, artist_res, playlist_res) =
        tokio::join!(track_fut, album_fut, artist_fut, playlist_fut);

    let track_hits = match track_res {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(?e, %query, "deezer track search failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"deezer_api_error","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let album_hits = match album_res {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(?e, %query, "deezer album search failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"deezer_api_error","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let artist_hits = match artist_res {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(?e, %query, "deezer artist search failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"deezer_api_error","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    // Playlists are a secondary result — tolerate their failure (don't 502 the
    // whole search just because the playlist endpoint hiccupped).
    let playlist_hits = match playlist_res {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(?e, %query, "deezer playlist search failed");
            Vec::new()
        }
    };

    let mut tracks: Vec<CatalogTrackOut> = track_hits
        .into_iter()
        .map(|t| CatalogTrackOut {
            source: "deezer".into(),
            source_id: t.id.to_string(),
            title: t.title,
            artists: vec![t.artist.name],
            album: Some(t.album.title.clone()),
            album_id: Some(t.album.id.to_string()),
            album_art_url: t.album.best_cover(),
            // Deezer reports track duration in seconds.
            duration_ms: (t.duration as i64) * 1000,
            isrc: t.isrc,
            local_track_id: None,
            in_playlist_ids: Vec::new(),
            in_saved_album_ids: Vec::new(),
            has_audio: false,
            preview_url: t.preview,
            explicit: t.explicit_lyrics,
        })
        .collect();

    let albums: Vec<SearchAlbumOut> = album_hits
        .into_iter()
        .map(|a| {
            // Snap the cover before moving the rest of the struct apart,
            // otherwise the closure can't both move `a.title` and call
            // `a.best_cover()` (partial-move conflict).
            let cover = a.best_cover();
            // /search/album always returns an artist; we fall back to an
            // empty list defensively in case Deezer ever changes that.
            let artists: Vec<String> =
                a.artist.map(|x| vec![x.name]).unwrap_or_default();
            SearchAlbumOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.title,
                artists,
                cover_url: cover,
                album_type: a.record_type,
                release_date: a.release_date,
                total_tracks: a.nb_tracks,
            }
        })
        .collect();

    let artists: Vec<SearchArtistOut> = artist_hits
        .into_iter()
        .map(|a| {
            let pic = a.best_picture();
            SearchArtistOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.name,
                picture_url: pic,
                total_albums: a.nb_album,
                total_fans: a.nb_fan,
            }
        })
        .collect();

    // Drop Deezer-branded "filler" playlists (the generic ones whose only
    // creator is Deezer itself) the same way the genre charts do.
    let playlists: Vec<PlaylistOut> = playlist_hits
        .into_iter()
        .map(playlist_hit_to_out)
        .collect();

    // Cache the un-annotated rows for the TTL window. Library ✓ state is
    // re-applied per response (see `to_response`), so adding a track is still
    // reflected immediately even on a cache hit.
    {
        let mut cache = search_cache().lock().expect("search cache poisoned");
        // A personal install won't accumulate many distinct queries, but clear
        // wholesale if the map somehow balloons rather than tracking LRU.
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(
            cache_key,
            SearchCacheEntry {
                fetched_at: std::time::Instant::now(),
                tracks: tracks.clone(),
                albums: albums.clone(),
                artists: artists.clone(),
                playlists: playlists.clone(),
            },
        );
    }

    // Annotate with library state so the UI can render ✓ vs + per row.
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Err(e) = annotate_with_library_state(&conn, &mut tracks, scoped_pid) {
            tracing::warn!(?e, "search: library annotation failed; rendering without ✓ marks");
        }
    }

    Json(SearchOut {
        tracks,
        albums,
        artists,
        playlists,
    })
    .into_response()
}

#[derive(Serialize)]
struct BrowseOut {
    chart_tracks: Vec<CatalogTrackOut>,
    chart_albums: Vec<SearchAlbumOut>,
    chart_artists: Vec<SearchArtistOut>,
    new_releases: Vec<SearchAlbumOut>,
    /// Genre view only: a second "all-time classics" song row (Last.fm).
    #[serde(default)]
    all_time_tracks: Vec<CatalogTrackOut>,
    /// Genre view only: curated genre playlists (Deezer).
    #[serde(default)]
    playlists: Vec<PlaylistOut>,
}

/// A catalog (Deezer) playlist for the "Popular [genre] playlists" row.
#[derive(Serialize, Clone)]
struct PlaylistOut {
    source: &'static str,
    source_id: String,
    title: String,
    cover_url: Option<String>,
    track_count: Option<i64>,
    creator: Option<String>,
}

fn playlist_hit_to_out(p: crate::deezer::PlaylistHit) -> PlaylistOut {
    PlaylistOut {
        source: "deezer",
        source_id: p.id.to_string(),
        title: p.title,
        cover_url: scrub_playlist_cover(p.picture_big.or(p.picture_medium)),
        track_count: p.nb_tracks,
        creator: clean_playlist_creator(p.user.map(|u| u.name)),
    }
}

/// Drop a playlist's curator credit when it's a Deezer editorial byline
/// (e.g. "Rudy - Deezer Moods Editor") — the UI then just shows "Playlist",
/// so Deezer's brand name doesn't leak into Beetbot's own surfaces.
fn clean_playlist_creator(creator: Option<String>) -> Option<String> {
    creator.filter(|n| !n.to_ascii_lowercase().contains("deezer"))
}

#[derive(Serialize)]
struct GenreOut {
    id: i64,
    name: String,
    picture_url: Option<String>,
}

/// GET /api/genres — Deezer's genre taxonomy with cover art, for the
/// Spotify-style "Browse by genre" tile grid. Each tile opens
/// `/api/browse?genre={id}`. "All" (id 0) is dropped — that's the default feed.
async fn list_genres(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let client = crate::deezer::DeezerClient::new();
    match client.get_genres().await {
        Ok(list) => {
            let out: Vec<GenreOut> = list
                .into_iter()
                .filter(|g| g.id != 0)
                .map(|g| GenreOut {
                    id: g.id,
                    name: g.name,
                    picture_url: g.picture_big.or(g.picture_medium),
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => {
            tracing::warn!(?e, "deezer genres failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"genres_failed"})),
            )
                .into_response()
        }
    }
}

/// Map a Deezer `TrackHit` onto the catalog wire shape.
/// Full credits from a hit's `contributors` (primary first, deduped by name),
/// falling back to the single `artist` when the endpoint didn't provide them
/// (/search and album tracklists don't; /track/{id} and /track/isrc do).
pub(crate) fn credit_names(contributors: &[crate::deezer::ArtistRef], primary: &str) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for a in contributors {
        let name = a.name.trim();
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        out.push(name.to_string());
    }
    if out.is_empty() {
        out.push(primary.to_string());
    }
    out
}

fn track_hit_to_out(t: crate::deezer::TrackHit) -> CatalogTrackOut {
    CatalogTrackOut {
        source: "deezer".into(),
        source_id: t.id.to_string(),
        title: t.title,
        artists: credit_names(&t.contributors, &t.artist.name),
        album: Some(t.album.title.clone()),
        album_id: Some(t.album.id.to_string()),
        album_art_url: t.album.best_cover(),
        duration_ms: (t.duration as i64) * 1000,
        isrc: t.isrc,
        local_track_id: None,
        in_playlist_ids: Vec::new(),
        in_saved_album_ids: Vec::new(),
        has_audio: false,
        preview_url: t.preview,
        explicit: t.explicit_lyrics,
    }
}

/// Cap on simultaneous Deezer search requests across a Browse assembly. Deezer
/// rate-limits per IP and is sensitive to bursts, so we never fire more than
/// this many at once. One semaphore is shared by *all* resolve fan-outs in a
/// single assembly (see `assemble_browse`), so running the pipelines
/// concurrently doesn't multiply the load.
const RESOLVE_CONCURRENCY: usize = 6;

type ResolveLimiter = std::sync::Arc<tokio::sync::Semaphore>;

/// A fresh shared limiter for one assembly's worth of resolves.
fn resolve_limiter() -> ResolveLimiter {
    std::sync::Arc::new(tokio::sync::Semaphore::new(RESOLVE_CONCURRENCY))
}

/// MusicBrainz asks callers for ~1 request/second. Now that fusion gathers its
/// seeds CONCURRENTLY (see `fuse_seed_set`), a cold build can resolve several
/// artists' MBIDs at once — so cap concurrent MB lookups low, PROCESS-WIDE, so
/// no build (or the autoplay radio path) ever bursts it. Unlike `resolve_limiter`
/// this is a single shared instance: the Deezer fan-out is already bounded by the
/// per-assembly `sem`, but the softer MB call takes no such permit otherwise.
const MB_CONCURRENCY: usize = 3;
fn mb_limiter() -> &'static tokio::sync::Semaphore {
    static S: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(MB_CONCURRENCY))
}

/// Resolve external-chart `(title, artist)` pairs to Deezer tracks
/// concurrently (bounded by the shared `sem`), so an Apple/Last.fm list gets
/// cover art, a preview clip, and the add/download flow. Unresolved pairs are
/// dropped; order is preserved.
/// Karaoke / tribute / cover markers that flag a Deezer search hit as an
/// impostor of the charted recording (e.g. "… (Karaoke Version Originally
/// Performed by …)" by a label like "Singer's Best").
const CHART_JUNK_MARKERS: &[&str] = &[
    "karaoke",
    "originally performed",
    "made famous",
    "in the style of",
    "as made famous",
    "a cappella",
    "acappella",
    "backing track",
];

/// Pick the Deezer hit that best matches a chart `(title, artist)`: skip
/// karaoke/tribute/cover impostors (unless the chart entry itself asked for one)
/// and prefer a hit whose artist actually matches the charted artist. Falls back
/// to the first hit so a fuzzy chart still resolves to *something* rather than
/// dropping the row. Fixes the resolver blindly taking Deezer's #1 result, which
/// surfaced karaoke covers for catalog songs.
fn pick_chart_match(
    title: &str,
    artist: &str,
    hits: &[crate::deezer::TrackHit],
) -> Option<crate::deezer::TrackHit> {
    let chart_ctx = format!("{title} {artist}").to_lowercase();
    let chart_artist = artist.to_lowercase();
    let is_junk = |h: &crate::deezer::TrackHit| {
        let hay = format!("{} {}", h.title, h.artist.name).to_lowercase();
        CHART_JUNK_MARKERS
            .iter()
            .any(|m| hay.contains(m) && !chart_ctx.contains(m))
    };
    let artist_ok = |h: &crate::deezer::TrackHit| {
        let a = h.artist.name.to_lowercase();
        !chart_artist.is_empty() && (a.contains(&chart_artist) || chart_artist.contains(&a))
    };
    hits.iter()
        .find(|&h| !is_junk(h) && artist_ok(h))
        .or_else(|| hits.iter().find(|&h| !is_junk(h)))
        .or_else(|| hits.first())
        .cloned()
}

async fn resolve_chart_pairs(
    client: &crate::deezer::DeezerClient,
    sem: &ResolveLimiter,
    pairs: Vec<crate::charts::ChartPair>,
) -> Vec<CatalogTrackOut> {
    let mut set = tokio::task::JoinSet::new();
    for (idx, (title, artist)) in pairs.into_iter().enumerate() {
        let client = client.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let q = format!("{artist} {title}");
            // Pull several candidates (still one search per pair — no extra API
            // calls) and choose the real recording rather than Deezer's #1 hit.
            let hits = client.search_tracks(&q, 8).await.ok().unwrap_or_default();
            let hit = pick_chart_match(&title, &artist, &hits);
            (idx, hit)
        });
    }
    let mut found: Vec<(usize, CatalogTrackOut)> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok((idx, Some(hit))) = res {
            found.push((idx, track_hit_to_out(hit)));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    found.into_iter().map(|(_, t)| t).collect()
}

/// Resolve iTunes genre albums to Deezer albums concurrently (bounded by the
/// shared `sem`), for cover art + the album drill-in, keeping iTunes' release
/// date (Deezer search omits it) so the caller can build both "top albums" and
/// a date-sorted "new releases".
async fn resolve_apple_albums(
    client: &crate::deezer::DeezerClient,
    sem: &ResolveLimiter,
    albums: Vec<crate::charts::AppleAlbum>,
) -> Vec<SearchAlbumOut> {
    let mut set = tokio::task::JoinSet::new();
    for (idx, a) in albums.into_iter().enumerate() {
        let client = client.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let q = format!("{} {}", a.artist, a.name);
            let out = client
                .search_albums(&q, 1)
                .await
                .ok()
                .and_then(|v| v.into_iter().next())
                .map(|h| {
                    let mut out = album_hit_to_out(h);
                    if a.release_date.is_some() {
                        out.release_date = a.release_date;
                    }
                    out
                });
            (idx, out)
        });
    }
    let mut found: Vec<(usize, SearchAlbumOut)> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok((idx, Some(out))) = res {
            found.push((idx, out));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    found.into_iter().map(|(_, a)| a).collect()
}

/// Map a Deezer `AlbumHit` onto the wire shape the album grid consumes.
/// (Mirrors the inline mapping in /api/search and /api/artists/:id/albums.)
fn album_hit_to_out(a: crate::deezer::AlbumHit) -> SearchAlbumOut {
    let cover = a.best_cover();
    let artists = a.artist.map(|x| vec![x.name]).unwrap_or_default();
    SearchAlbumOut {
        source: "deezer".into(),
        source_id: a.id.to_string(),
        name: a.title,
        artists,
        cover_url: cover,
        album_type: a.record_type,
        release_date: a.release_date,
        total_tracks: a.nb_tracks,
    }
}

/// Assembled (but **un-annotated**) Browse rows for one genre, cached so we
/// don't re-run the slow external assembly (Billboard scrape + iTunes/Last.fm
/// + dozens of Deezer resolves) on every navigation. The per-user library ✓
/// marks are *not* baked in here — they're re-applied fresh on each response
/// (a cheap local DB query), so adding a track is reflected immediately even
/// on a cache hit.
struct BrowseCacheEntry {
    fetched_at: std::time::Instant,
    chart_tracks: Vec<CatalogTrackOut>,
    all_time_tracks: Vec<CatalogTrackOut>,
    chart_albums: Vec<SearchAlbumOut>,
    new_releases: Vec<SearchAlbumOut>,
    chart_artists: Vec<SearchArtistOut>,
    playlists: Vec<PlaylistOut>,
}

impl BrowseCacheEntry {
    /// Build the wire response from cached rows, re-applying current library
    /// state to the track rows (so ✓ marks are always live).
    fn to_response(&self, state: &AppState, profile_id: Option<i64>) -> Response {
        let mut chart_tracks = self.chart_tracks.clone();
        let mut all_time_tracks = self.all_time_tracks.clone();
        {
            let conn = state.db.lock().expect("db mutex poisoned");
            let _ = annotate_with_library_state(&conn, &mut chart_tracks, profile_id);
            let _ = annotate_with_library_state(&conn, &mut all_time_tracks, profile_id);
        }
        Json(BrowseOut {
            chart_tracks,
            chart_albums: self.chart_albums.clone(),
            chart_artists: self.chart_artists.clone(),
            new_releases: self.new_releases.clone(),
            all_time_tracks,
            playlists: self.playlists.clone(),
        })
        .into_response()
    }
}

/// How long an assembled Browse feed stays fresh. Charts move slowly (daily at
/// most), so a generous TTL makes navigation instant and spares the upstream
/// APIs (and Deezer's rate limit) from being hammered on every page view.
const BROWSE_TTL: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// Process-wide Browse cache, keyed by genre id (0 = the global feed). A plain
/// global static (rather than an AppState field) keeps the many AppState
/// constructors — including the unit tests — untouched.
fn browse_cache() -> &'static Mutex<std::collections::HashMap<i64, BrowseCacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<i64, BrowseCacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// One cached catalog-search response. Like the Browse cache, we store the
/// un-annotated rows and re-apply current library ✓ state on each hit, so the
/// ✓/+ marks stay live even when the Deezer round-trip is skipped.
struct SearchCacheEntry {
    fetched_at: std::time::Instant,
    tracks: Vec<CatalogTrackOut>,
    albums: Vec<SearchAlbumOut>,
    artists: Vec<SearchArtistOut>,
    playlists: Vec<PlaylistOut>,
}

impl SearchCacheEntry {
    fn to_response(&self, state: &AppState, profile_id: Option<i64>) -> Response {
        let mut tracks = self.tracks.clone();
        {
            let conn = state.db.lock().expect("db mutex poisoned");
            let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
        }
        Json(SearchOut {
            tracks,
            albums: self.albums.clone(),
            artists: self.artists.clone(),
            playlists: self.playlists.clone(),
        })
        .into_response()
    }
}

/// How long a catalog-search response stays fresh. Short enough that newly
/// released tracks show up promptly, long enough that the dropdown + committed
/// results page + a re-typed query all reuse one Deezer round-trip — which is
/// what keeps us under Deezer's ~50-requests/5s rate limit.
const SEARCH_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Process-wide catalog-search cache, keyed by `query|types|limit`. A plain
/// global static (like `browse_cache`) keeps the AppState constructors — and
/// the unit tests — untouched.
fn search_cache() -> &'static Mutex<std::collections::HashMap<String, SearchCacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<String, SearchCacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// How long an artist page's sections (albums / top tracks / related) stay
/// fresh. A discography changes at most on a release day, so a generous TTL
/// makes the artist page instant on revisit — the desktop show-all drill-in
/// (which unmounts + remounts the artist page) and Back-from-album both hit
/// this instead of a fresh Deezer round-trip through the 110ms pacer.
const ARTIST_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// One artist's cached sections, keyed by Deezer artist id. Each section is
/// cached independently (they're fetched by separate endpoints, at separate
/// times) with its own freshness stamp. Top tracks are stored UN-annotated —
/// the per-profile ✓/+ marks are re-applied on each hit, exactly like the
/// search cache, so the marks stay live even when the Deezer call is skipped.
#[derive(Default)]
struct ArtistCacheEntry {
    albums: Option<(std::time::Instant, Vec<SearchAlbumOut>)>,
    top: Option<(std::time::Instant, Vec<CatalogTrackOut>)>,
    related: Option<(std::time::Instant, Vec<SearchArtistOut>)>,
}

/// Process-wide artist-section cache, keyed by artist id. A plain global static
/// (like `search_cache` / `browse_cache`) keeps the AppState constructors — and
/// the unit tests — untouched.
fn artist_cache() -> &'static Mutex<std::collections::HashMap<u64, ArtistCacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<u64, ArtistCacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// ---- Playback handoff ("Beetbot Connect"-lite) -----------------------
//
// A tiny hub-relayed "mailbox" that lets one device hand its now-playing queue
// + position to another (phone <-> desktop), so you can start a song on your
// phone and continue it on the computer. The hub doesn't understand the queue —
// it just relays an opaque JSON snapshot to the target device, which adopts it
// and resumes. Everything is in-memory and session-token gated, like Cast.

/// A device that heartbeated recently — populates the "Play on …" picker and
/// the "playing on <device>" remote banner.
struct PresenceEntry {
    label: String,
    kind: String,
    /// The profile active on the device. Presence is scoped per profile so one
    /// account never sees another account's devices or now-playing.
    profile_id: Option<i64>,
    last_seen: std::time::Instant,
    /// Opaque now-playing snapshot the device published (title/artists/art/
    /// is_playing), relayed verbatim to the other devices.
    now_playing: serde_json::Value,
}

/// Pending remote-control actions (play/pause/next/prev) addressed to a device,
/// drained on its next poll. Keyed by target device id.
fn remote_cmd_map() -> &'static Mutex<std::collections::HashMap<String, RemoteCmdEntry>> {
    static M: std::sync::OnceLock<Mutex<std::collections::HashMap<String, RemoteCmdEntry>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// One pending handoff destined for a specific device. Consumed once.
struct HandoffEntry {
    created_at: std::time::Instant,
    payload: serde_json::Value,
    /// The sender's scoped profile. A device id is client-supplied and
    /// unauthenticated, so it addresses but doesn't authorize — this is what
    /// decides who may claim the snapshot.
    profile_id: Option<i64>,
}

/// Pending transport verbs for one device, filed under the profile that queued
/// them (same reasoning as [`HandoffEntry::profile_id`]).
#[derive(Default)]
struct RemoteCmdEntry {
    profile_id: Option<i64>,
    actions: Vec<String>,
}

const PRESENCE_TTL: std::time::Duration = std::time::Duration::from_secs(15);
const HANDOFF_TTL: std::time::Duration = std::time::Duration::from_secs(60);

fn presence_map() -> &'static Mutex<std::collections::HashMap<String, PresenceEntry>> {
    static M: std::sync::OnceLock<Mutex<std::collections::HashMap<String, PresenceEntry>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn handoff_map() -> &'static Mutex<std::collections::HashMap<String, HandoffEntry>> {
    static M: std::sync::OnceLock<Mutex<std::collections::HashMap<String, HandoffEntry>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[derive(Deserialize)]
struct HeartbeatBody {
    device_id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    profile_id: Option<i64>,
    #[serde(default)]
    now_playing: Option<serde_json::Value>,
}

/// True when the request really came from THIS machine, rather than from a
/// device on the far side of the Meradomo tunnel.
///
/// Loopback alone stopped meaning "local" once a tunnel sat in front: the agent
/// proxies to `127.0.0.1`, so a phone anywhere in the world arrives from
/// loopback. That named every remote device after this Mac — three devices, one
/// name, told apart only by the list's "(1)" / "(2)" suffixes.
///
/// The agent injects `X-Meradomo-*` identity headers on every proxied request,
/// *after* stripping any inbound copies, so their presence is proof the request
/// came through the tunnel. It deliberately sends no `X-Forwarded-For` — the
/// blind pipe genuinely doesn't know the visitor's address — which makes this
/// the signal that is actually available.
fn is_this_machine(headers: &HeaderMap, addr: &SocketAddr) -> bool {
    if headers
        .keys()
        .any(|k| k.as_str().starts_with("x-meradomo-"))
    {
        return false;
    }
    effective_client_ip(addr, headers).is_loopback()
}

/// Name a device for the device list, best source first:
///   1. This machine's hostname, for the desktop app itself (genuinely local) —
///      the only name that tells two Macs apart, and what the owner actually
///      calls the thing. Hyphens become spaces: `Kamrans-MacBook-Pro` reads
///      badly in a list next to "iPhone".
///   2. The session's User-Agent-derived label (iPhone / iPad / Mac / Windows)
///      for anything paired — including anything arriving via the tunnel.
///   3. "Device", if the session vanished mid-heartbeat.
fn server_side_device_label(
    state: &AppState,
    headers: &HeaderMap,
    addr: &SocketAddr,
    q: &TokenQuery,
) -> String {
    if is_this_machine(headers, addr) {
        if let Some(h) = state.hostname_bare.as_ref() {
            let pretty = h.replace('-', " ");
            if !pretty.trim().is_empty() {
                return pretty;
            }
        }
    }
    extract_token(headers, q)
        .and_then(|t| {
            let hash = sha256_hex(&t);
            let conn = state.db.lock().expect("db mutex poisoned");
            conn.query_row(
                "SELECT device_label FROM streaming_sessions
                 WHERE token_sha256 = ?1 AND revoked_at IS NULL",
                params![hash],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Device".into())
}

/// POST /api/devices/heartbeat — announce this device is online + controllable.
async fn devices_heartbeat(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<HeartbeatBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if body.device_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing device_id").into_response();
    }
    // Scope the announced profile to the caller's own. Presence is the other
    // direction of the same trust question: `devices_list` only shows devices on
    // your profile, so an unchecked claim here would let a paired device post
    // itself INTO someone else's device list — and then receive the handoff
    // (their queue and now-playing) they meant for a device of their own.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, body.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    // Name the device HERE rather than trusting a client constant. Both apps
    // used to hardcode "Computer" / "Phone", so two Macs (or two phones) were
    // indistinguishable in the device list. The hub knows better: it has this
    // machine's hostname, and every session already carries a User-Agent-derived
    // label. A client may still pass one to override.
    let label = body
        .label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| server_side_device_label(&state, &headers, &addr, &q));
    let mut map = presence_map().lock().expect("presence poisoned");
    map.insert(
        body.device_id,
        PresenceEntry {
            label,
            kind: body.kind.unwrap_or_else(|| "unknown".into()),
            profile_id: scoped_pid,
            last_seen: std::time::Instant::now(),
            now_playing: body.now_playing.unwrap_or(serde_json::Value::Null),
        },
    );
    map.retain(|_, e| e.last_seen.elapsed() < PRESENCE_TTL);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Serialize)]
struct DeviceOut {
    device_id: String,
    label: String,
    kind: String,
    now_playing: serde_json::Value,
}

#[derive(Deserialize)]
struct DeviceQuery {
    t: Option<String>,
    device_id: Option<String>,
    profile_id: Option<i64>,
}

/// GET /api/devices?device_id=<self> — the other devices online right now.
async fn devices_list(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<DeviceQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let self_id = q.device_id.unwrap_or_default();
    // Only surface devices on the SAME profile as the caller — accounts are
    // isolated, so e.g. the owner's desktop must not see the guest's phone. Scope the
    // id rather than believing the query param: `DeviceOut` carries
    // `now_playing`, so a device list for someone else's profile would hand a
    // paired phone their live listening.
    let pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let map = presence_map().lock().expect("presence poisoned");
    let out: Vec<DeviceOut> = map
        .iter()
        .filter(|(id, e)| {
            **id != self_id && e.profile_id == pid && e.last_seen.elapsed() < PRESENCE_TTL
        })
        .map(|(id, e)| DeviceOut {
            device_id: id.clone(),
            label: e.label.clone(),
            kind: e.kind.clone(),
            now_playing: e.now_playing.clone(),
        })
        .collect();
    Json(out).into_response()
}

#[derive(Deserialize)]
struct RemoteCommandBody {
    target_device_id: String,
    action: String,
}

/// POST /api/remote-command — queue a transport action for another device.
async fn remote_command_post(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Json(body): Json<RemoteCommandBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if body.target_device_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing target_device_id").into_response();
    }
    // Relay known transport verbs, plus a "handoff:<requester-device-id>"
    // request (the receiver pulls its current queue over to that device).
    let action_ok = matches!(body.action.as_str(), "play" | "pause" | "next" | "prev")
        || body.action.starts_with("handoff:");
    if !action_ok {
        return (StatusCode::BAD_REQUEST, "unknown action").into_response();
    }
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let mut map = remote_cmd_map().lock().expect("remote cmd poisoned");
    let entry = map.entry(body.target_device_id).or_insert_with(|| RemoteCmdEntry {
        profile_id: scoped_pid,
        actions: Vec::new(),
    });
    // A device id is client-supplied and unauthenticated, so the profile is what
    // actually addresses this: refuse to queue onto a device filed under someone
    // else's account rather than take over its queue.
    if entry.profile_id != scoped_pid {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Cap the backlog so a device that polls slowly can't accumulate forever.
    if entry.actions.len() < 16 {
        entry.actions.push(body.action);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// GET /api/remote-command?device_id=<self> — drain pending actions for self.
async fn remote_command_get(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<DeviceQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let self_id = q.device_id.unwrap_or_default();
    let mut map = remote_cmd_map().lock().expect("remote cmd poisoned");
    // Check BEFORE removing: draining is destructive, so an unscoped remove
    // would let anyone who names a device id swallow its commands.
    let mine = map
        .get(&self_id)
        .is_some_and(|e| e.profile_id == scoped_pid);
    let actions: Vec<String> = if mine {
        map.remove(&self_id).map(|e| e.actions).unwrap_or_default()
    } else {
        Vec::new()
    };
    Json(actions).into_response()
}

#[derive(Deserialize)]
struct HandoffPostBody {
    target_device_id: String,
    payload: serde_json::Value,
}

/// POST /api/handoff — drop a now-playing snapshot for `target_device_id`.
async fn handoff_post(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Json(body): Json<HandoffPostBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if body.target_device_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing target_device_id").into_response();
    }
    // File it under the sender's profile. The payload is a queue + now-playing
    // snapshot; only a device on the same account may take it.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let mut map = handoff_map().lock().expect("handoff poisoned");
    map.retain(|_, e| e.created_at.elapsed() < HANDOFF_TTL);
    map.insert(
        body.target_device_id,
        HandoffEntry {
            created_at: std::time::Instant::now(),
            payload: body.payload,
            profile_id: scoped_pid,
        },
    );
    StatusCode::NO_CONTENT.into_response()
}

/// GET /api/handoff?device_id=<self> — claim a pending handoff (consume-once).
/// Returns the stored payload JSON, or `null` when nothing is waiting.
async fn handoff_get(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<DeviceQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let self_id = q.device_id.unwrap_or_default();
    let mut map = handoff_map().lock().expect("handoff poisoned");
    // Look before removing. A device id is client-supplied and unauthenticated,
    // and claiming CONSUMES the entry — so an unscoped remove would let anyone
    // naming a device id both read someone's queue and delete it out from under
    // the device it was meant for.
    let claimable = map
        .get(&self_id)
        .is_some_and(|e| e.profile_id == scoped_pid && e.created_at.elapsed() < HANDOFF_TTL);
    let claimed = if claimable {
        map.remove(&self_id).map(|e| e.payload)
    } else {
        None
    };
    Json(claimed).into_response()
}

/// GET /api/browse
///
/// Discovery feed: Deezer's global charts (top tracks / albums / artists)
/// plus the editorial "new releases" album feed. Everything comes back in
/// the same shapes as /api/search, so the Browse UI reuses the search
/// track list and album/artist grids — with previews, add-to-playlist,
/// and ✓ library annotations on the chart tracks.
/// `/api/browse?t=...&genre=N`. `genre` (a Deezer genre id) scopes the charts
/// to one genre; omitted = the global charts + editorial new releases.
#[derive(serde::Deserialize)]
struct BrowseQuery {
    t: Option<String>,
    genre: Option<i64>,
    /// Genre display name (for deriving the Last.fm tag). Sent alongside
    /// `genre` by the client, which already has it.
    genre_name: Option<String>,
    /// Active profile — scopes the ✓ marks to playlists this profile owns.
    #[serde(default)]
    profile_id: Option<i64>,
}

async fn browse(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<BrowseQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    // Same reasoning as search: the ✓ marks are per-profile library state.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let genre = q.genre.filter(|g| *g != 0);
    let cache_key = genre.unwrap_or(0);

    // Fast path: serve a still-fresh cached assembly (re-annotated with live
    // library state). Skips all the external fetches — this is what makes
    // repeat visits + back-navigation instant.
    {
        let cache = browse_cache().lock().expect("browse cache poisoned");
        if let Some(entry) = cache.get(&cache_key) {
            if entry.fetched_at.elapsed() < BROWSE_TTL {
                return entry.to_response(&state, scoped_pid);
            }
        }
    }

    // Read the Last.fm key (Settings override, else the app-wide build key),
    // then assemble the feed. The independent sources run concurrently
    // (see assemble_browse), so a cold assembly takes about as long as its
    // slowest single source rather than the sum of them all.
    let lastfm_key = read_lastfm_key(&state);
    let entry = assemble_browse(genre, q.genre_name.clone(), lastfm_key).await;
    let response = entry.to_response(&state, scoped_pid);
    // Only cache an assembly that actually produced a top-songs row. An empty
    // one usually means every upstream source was rate-limited/unreachable on
    // this pass — caching that would freeze a blank feed for the whole TTL, so
    // we skip it and let the next visit retry.
    if !entry.chart_tracks.is_empty() {
        browse_cache()
            .lock()
            .expect("browse cache poisoned")
            .insert(cache_key, entry);
    }
    response
}

/// The Last.fm API key: a user override from Settings, else the app-wide
/// build-time key.
fn read_lastfm_key(state: &AppState) -> Option<String> {
    let user = {
        let conn = state.db.lock().expect("db mutex poisoned");
        crate::settings::get_setting(&conn, "lastfm_api_key")
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    user.or_else(|| crate::charts::default_lastfm_key().map(|s| s.to_string()))
}

/// Kick off the Last.fm tag-enrichment sweep in the background (Phase 1
/// discovery / Signal 3: rich per-artist tags for "more like this vibe"). No-op
/// when no Last.fm key is configured. Safe to call once at startup — the sweep
/// is incremental (skips already-fetched artists), so a filled library is a
/// quick no-op and the rest fills in over the next minute or two.
pub fn spawn_tag_enrich(state: &AppState) {
    if let Some(key) = read_lastfm_key(state) {
        let db = state.db.clone();
        // `tauri::async_runtime::spawn` (not raw `tokio::spawn`): this is called
        // from Tauri's setup hook, which isn't inside a tokio runtime context.
        tauri::async_runtime::spawn(crate::tags::run_tag_enrich(db, key));
    }
}

/// Phase 4 (Signal 2): kick off the background audio-feature sweep. Same
/// `tauri::async_runtime::spawn` requirement as the tag enrich (setup hook isn't
/// a tokio runtime). The sweep self-disables if no python3-with-numpy is found.
pub fn spawn_audio_enrich(state: &AppState) {
    let db = state.db.clone();
    tauri::async_runtime::spawn(crate::audio::run_audio_enrich(db));
}

/// Assemble a Browse feed (un-annotated) for one genre, or the global feed when
/// `genre` is None. The ~7 independent source pipelines (Deezer playlists, the
/// weekly Top-songs source + resolve, the Deezer chart, All-time classics,
/// iTunes albums, editorial releases, genre artists) all run **concurrently**,
/// sharing one Deezer-search limiter — so a cold assembly takes about as long
/// as its slowest single source instead of the sum of them all.
async fn assemble_browse(
    genre: Option<i64>,
    genre_name: Option<String>,
    lastfm_key: Option<String>,
) -> BrowseCacheEntry {
    use crate::charts;
    let client = crate::deezer::DeezerClient::new();
    let sem = resolve_limiter();
    let cache_key = genre.unwrap_or(0);
    let gname = genre_name.as_deref();
    let lastfm = lastfm_key.as_deref();

    // Popular playlists (Deezer's curated lists).
    let playlists_fut = async {
        match client.get_chart_playlists(cache_key, 12).await {
            Ok(hits) => hits
                .into_iter()
                .map(playlist_hit_to_out)
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(?e, genre = cache_key, "browse: chart playlists failed");
                Vec::new()
            }
        }
    };

    // Top songs this week: Billboard weekly genre chart → iTunes genre feed →
    // Last.fm tag (genre view); Apple most-played (global view). Resolved to
    // Deezer for covers/previews.
    let top_songs_fut = async {
        if genre.is_some() {
            let billboard_pairs = match gname.and_then(charts::deezer_genre_to_billboard_chart) {
                Some(slug) => charts::billboard_genre_songs(slug, 50)
                    .await
                    .map(|p| charts::cap_per_artist(p, 3))
                    .ok()
                    .filter(|v| !v.is_empty()),
                None => None,
            };
            let genre_pairs = match billboard_pairs {
                Some(p) => Some(p),
                None => match gname.and_then(charts::deezer_genre_to_apple_id) {
                    Some(aid) => charts::apple_genre_songs("us", aid, 25)
                        .await
                        .ok()
                        .filter(|v| !v.is_empty()),
                    None => None,
                },
            };
            if let Some(mut pairs) = genre_pairs {
                pairs.truncate(20);
                Some(resolve_chart_pairs(&client, &sem, pairs).await)
            } else if let (Some(key), Some(name)) = (lastfm, gname) {
                let tag = charts::genre_to_tag(name);
                match charts::lastfm_tag_top_tracks(key, &tag, 18).await {
                    Ok(pairs) if !pairs.is_empty() => {
                        Some(resolve_chart_pairs(&client, &sem, pairs).await)
                    }
                    _ => None,
                }
            } else {
                None
            }
        } else {
            // Global "Top songs": Billboard Hot 100 — the canonical weekly US
            // chart — per-artist capped (≤3) so a chart-bombing album drop
            // doesn't fill the row with one name. Falls back to Apple's
            // most-played feed, then to Deezer's chart (None below).
            let hot100 = charts::billboard_genre_songs("hot-100", 100)
                .await
                .map(|p| charts::cap_per_artist(p, 3))
                .ok()
                .filter(|v| !v.is_empty());
            let pairs = match hot100 {
                Some(p) => Some(p),
                None => charts::apple_top_songs("us", 18)
                    .await
                    .ok()
                    .filter(|v| !v.is_empty()),
            };
            match pairs {
                Some(mut p) => {
                    p.truncate(20);
                    Some(resolve_chart_pairs(&client, &sem, p).await)
                }
                None => None,
            }
        }
    };

    // Deezer chart: a track fallback always; the album + artist source for the
    // global view. Non-fatal — a rate-limited chart just yields empty rows.
    let chart_fut = async {
        let res = if let Some(g) = genre {
            client.get_chart_genre(g, 20).await
        } else {
            client.get_chart(20).await
        };
        match res {
            Ok(c) => (c.tracks.data, c.albums.data, c.artists.data),
            Err(e) => {
                tracing::warn!(?e, "deezer chart failed; degrading browse without chart rows");
                (Vec::new(), Vec::new(), Vec::new())
            }
        }
    };

    // All-time classics (Last.fm): genre view only, and only when the week
    // chart came from iTunes/Billboard (so it's a distinct list, not a dupe).
    let all_time_fut = async {
        if genre.is_none() || gname.and_then(charts::deezer_genre_to_apple_id).is_none() {
            return Vec::new();
        }
        if let (Some(key), Some(name)) = (lastfm, gname) {
            let tag = charts::genre_to_tag(name);
            if let Ok(pairs) = charts::lastfm_tag_top_tracks(key, &tag, 18).await {
                if !pairs.is_empty() {
                    let mut resolved = resolve_chart_pairs(&client, &sem, pairs).await;
                    resolved.truncate(12);
                    return resolved;
                }
            }
        }
        Vec::new()
    };

    // Top albums + New releases (iTunes genre album feed): genre view only.
    let genre_albums_fut = async {
        let aid = if genre.is_some() {
            gname.and_then(charts::deezer_genre_to_apple_id)
        } else {
            None
        };
        let Some(aid) = aid else { return None };
        // Fetch/resolve only as many as the rows actually show (20) — resolving
        // more was wasted Deezer calls (slower + more rate-limit pressure).
        match charts::apple_genre_albums("us", aid, 20).await {
            Ok(apple_albums) if !apple_albums.is_empty() => {
                let resolved = resolve_apple_albums(&client, &sem, apple_albums).await;
                let top: Vec<SearchAlbumOut> = resolved.iter().take(20).cloned().collect();
                let mut dated = resolved;
                dated.sort_by(|a, b| b.release_date.cmp(&a.release_date));
                let new: Vec<SearchAlbumOut> = dated.into_iter().take(20).collect();
                Some((top, new))
            }
            _ => None,
        }
    };

    // Editorial New releases: global view only.
    let releases_fut = async {
        if genre.is_some() {
            Vec::new()
        } else {
            client.get_editorial_releases(20).await.unwrap_or_default()
        }
    };

    // Genre artists (genre view); the global view derives artists from the chart.
    let genre_artists_fut = async {
        match genre {
            Some(g) => Some(client.get_genre_artists(g).await),
            None => None,
        }
    };

    let (
        genre_playlists,
        resolved_tracks,
        (chart_tracks_data, chart_albums_data, chart_artists_data),
        all_time_tracks,
        genre_albums,
        releases,
        genre_artists,
    ) = tokio::join!(
        playlists_fut,
        top_songs_fut,
        chart_fut,
        all_time_fut,
        genre_albums_fut,
        releases_fut,
        genre_artists_fut,
    );

    let chart_tracks: Vec<CatalogTrackOut> = match resolved_tracks {
        Some(v) if !v.is_empty() => v,
        _ => chart_tracks_data.into_iter().map(track_hit_to_out).collect(),
    };

    // Genre view: iTunes albums override both the Top-albums and New-releases
    // rows. Global view (and genres iTunes doesn't cover): Deezer chart albums +
    // the editorial releases feed.
    let (chart_albums, new_releases) = match genre_albums {
        Some((top, new)) => (top, new),
        None => (
            chart_albums_data.into_iter().map(album_hit_to_out).collect(),
            releases.into_iter().map(album_hit_to_out).collect(),
        ),
    };

    let artist_hits = match genre_artists {
        Some(Ok(hits)) if !hits.is_empty() => hits,
        // Genre artists empty/failed → fall back to the chart's artists.
        _ => chart_artists_data,
    };
    let chart_artists: Vec<SearchArtistOut> = artist_hits
        .into_iter()
        .map(|a| {
            let pic = a.best_picture();
            SearchArtistOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.name,
                picture_url: pic,
                total_albums: a.nb_album,
                total_fans: a.nb_fan,
            }
        })
        .collect();

    BrowseCacheEntry {
        fetched_at: std::time::Instant::now(),
        chart_tracks,
        all_time_tracks,
        chart_albums,
        new_releases,
        chart_artists,
        playlists: genre_playlists,
    }
}

/// Background pre-warm: a few seconds after startup, assemble the global feed
/// plus the most-browsed genres into the cache, so the first user visit to a
/// popular genre is already instant. Best-effort and gently paced (the genre
/// list comes from Deezer, and assemblies are spaced out) so it never competes
/// hard with live browsing or trips Deezer's rate limit.
pub fn spawn_browse_prewarm(db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;

        let lastfm_key = {
            let user = {
                let conn = db.lock().expect("db mutex poisoned");
                crate::settings::get_setting(&conn, "lastfm_api_key")
                    .ok()
                    .flatten()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            user.or_else(|| crate::charts::default_lastfm_key().map(|s| s.to_string()))
        };

        // The global feed, then the first handful of genres Deezer lists (its
        // own rough popularity order). Each as (genre id or None, display name).
        let mut targets: Vec<(Option<i64>, String)> = vec![(None, String::new())];
        if let Ok(genres) = crate::deezer::DeezerClient::new().get_genres().await {
            for g in genres.into_iter().filter(|g| g.id != 0).take(6) {
                targets.push((Some(g.id), g.name));
            }
        }

        for (genre, name) in targets {
            // Skip if a still-fresh entry already exists (a user beat us to it).
            let key = genre.unwrap_or(0);
            let fresh = browse_cache()
                .lock()
                .ok()
                .and_then(|c| c.get(&key).map(|e| e.fetched_at.elapsed() < BROWSE_TTL))
                .unwrap_or(false);
            if fresh {
                continue;
            }
            let gname = if name.is_empty() { None } else { Some(name) };
            let mut entry = assemble_browse(genre, gname.clone(), lastfm_key.clone()).await;
            // An empty top-songs row during the warm usually means this genre
            // caught a transient Deezer rate-limit in the burst — back off and
            // try once more before giving up.
            if entry.chart_tracks.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                entry = assemble_browse(genre, gname, lastfm_key.clone()).await;
            }
            if !entry.chart_tracks.is_empty() {
                if let Ok(mut c) = browse_cache().lock() {
                    c.insert(key, entry);
                }
            }
            // Space out so we don't burst Deezer or fight live traffic.
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        }
        tracing::info!("browse pre-warm complete");
    });
}

/// GET /api/albums/:id/tracks
///
/// Drill-in for a Deezer album. Returns the album's tracklist in the same
/// CatalogTrackOut shape used by /api/search, with the album name + cover
/// stamped onto every row from a concurrent /album/{id} lookup (Deezer's
/// per-track rows omit them). Stamping at the source means callers that
/// PERSIST these tracks — play-resolve, album import — no longer create
/// cover-less library rows.
async fn get_album_tracks(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Per-profile ✓ marks — scope to the caller (see `spotify_search`).
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(album_id) = id.parse::<u64>() else {
        return (StatusCode::BAD_REQUEST, "album id must be numeric").into_response();
    };
    let client = crate::deezer::DeezerClient::new();
    // Deezer's per-track /album/{id}/tracks rows omit the album's name + cover.
    // Fetch /album/{id} (the one endpoint that carries them) CONCURRENTLY and
    // stamp them onto every row, so EVERY consumer of this endpoint — play,
    // import, album detail — gets art-bearing tracks at the source (imports no
    // longer create cover-less library rows). A failed cover lookup degrades to
    // the old behaviour (None) rather than failing the whole request.
    let (tracks_res, album_res) =
        tokio::join!(client.get_album_tracks(album_id), client.get_album(album_id));
    let tracks = match tracks_res {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(?e, album_id, "deezer album tracks failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"album_tracks_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let (album_name, album_cover) = match album_res {
        Ok(a) => (a.title.clone(), a.best_cover()),
        Err(e) => {
            tracing::debug!(?e, album_id, "album detail (for cover) failed; rows stay cover-less");
            (None, None)
        }
    };
    let mut out: Vec<CatalogTrackOut> = tracks
        .into_iter()
        .map(|t| CatalogTrackOut {
            source: "deezer".into(),
            source_id: t.id.to_string(),
            title: t.title,
            artists: vec![t.artist.name],
            // Stamped from /album/{id} above — Deezer's per-track rows carry
            // neither, so without this every album-tracklist consumer (play,
            // import) would persist a cover-less library row.
            album: album_name.clone(),
            // The album whose tracklist this is, by construction.
            album_id: Some(album_id.to_string()),
            album_art_url: album_cover.clone(),
            duration_ms: (t.duration as i64) * 1000,
            isrc: t.isrc,
            local_track_id: None,
            in_playlist_ids: Vec::new(),
            in_saved_album_ids: Vec::new(),
            has_audio: false,
            preview_url: t.preview,
            explicit: t.explicit_lyrics,
        })
        .collect();
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Err(e) = annotate_with_library_state(&conn, &mut out, scoped_pid) {
            tracing::warn!(?e, "album tracks: library annotation failed");
        }
    }
    Json(out).into_response()
}

/// GET /api/artists/:id/albums
///
/// Drill-in for an artist search result. Returns the same
/// `SearchAlbumOut` shape used by the album search results so the UI
/// can reuse the AlbumGrid component directly — tapping any of these
/// albums then opens the existing AlbumDetailModal flow.
async fn get_artist_albums(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Ok(artist_id) = id.parse::<u64>() else {
        return (StatusCode::BAD_REQUEST, "artist id must be numeric").into_response();
    };
    // Fast path: serve a recent identical response from the artist cache.
    {
        let cache = artist_cache().lock().expect("artist cache poisoned");
        if let Some(entry) = cache.get(&artist_id) {
            if let Some((at, albums)) = &entry.albums {
                if at.elapsed() < ARTIST_TTL {
                    return Json(albums.clone()).into_response();
                }
            }
        }
    }
    let client = crate::deezer::DeezerClient::new();
    let albums = match client.get_artist_albums(artist_id).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(?e, artist_id, "deezer artist albums failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"artist_albums_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let out: Vec<SearchAlbumOut> = albums
        .into_iter()
        .map(|a| {
            let cover = a.best_cover();
            // Artist albums responses elide the per-album artist field;
            // empty-vec is fine since the UI already knows whose
            // discography this is from the artist row that brought
            // them here.
            let artists: Vec<String> =
                a.artist.map(|x| vec![x.name]).unwrap_or_default();
            SearchAlbumOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.title,
                artists,
                cover_url: cover,
                album_type: a.record_type,
                release_date: a.release_date,
                total_tracks: a.nb_tracks,
            }
        })
        .collect();
    {
        let mut cache = artist_cache().lock().expect("artist cache poisoned");
        cache.entry(artist_id).or_default().albums =
            Some((std::time::Instant::now(), out.clone()));
    }
    Json(out).into_response()
}

/// GET /api/artists/:id/top
///
/// An artist's most popular tracks (Deezer's ranking), in the same
/// `CatalogTrackOut` shape as /api/search — with album art, the 30s
/// preview clip, and library annotations — so the UI reuses the search
/// track list (previews + add-to-playlist) verbatim.
async fn get_artist_top_tracks(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Per-profile ✓ marks — scope to the caller (see `spotify_search`).
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(artist_id) = id.parse::<u64>() else {
        return (StatusCode::BAD_REQUEST, "artist id must be numeric").into_response();
    };
    // Fast path: reuse the recent UN-annotated rows and re-apply this profile's
    // ✓/+ marks (they're per-caller, so we never cache the annotated form).
    {
        let cached = {
            let cache = artist_cache().lock().expect("artist cache poisoned");
            cache.get(&artist_id).and_then(|e| {
                e.top.as_ref().and_then(|(at, rows)| {
                    (at.elapsed() < ARTIST_TTL).then(|| rows.clone())
                })
            })
        };
        if let Some(mut out) = cached {
            let conn = state.db.lock().expect("db mutex poisoned");
            if let Err(e) = annotate_with_library_state(&conn, &mut out, scoped_pid) {
                tracing::warn!(?e, "artist top (cached): annotation failed");
            }
            return Json(out).into_response();
        }
    }
    let client = crate::deezer::DeezerClient::new();
    let tracks = match client.get_artist_top(artist_id, 10).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(?e, artist_id, "deezer artist top tracks failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"artist_top_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let out: Vec<CatalogTrackOut> = tracks
        .into_iter()
        .map(|t| CatalogTrackOut {
            source: "deezer".into(),
            source_id: t.id.to_string(),
            title: t.title,
            artists: vec![t.artist.name],
            album: Some(t.album.title.clone()),
            album_id: Some(t.album.id.to_string()),
            album_art_url: t.album.best_cover(),
            duration_ms: (t.duration as i64) * 1000,
            isrc: t.isrc,
            local_track_id: None,
            in_playlist_ids: Vec::new(),
            in_saved_album_ids: Vec::new(),
            has_audio: false,
            preview_url: t.preview,
            explicit: t.explicit_lyrics,
        })
        .collect();
    // Cache the un-annotated rows before we mark them up for this caller.
    {
        let mut cache = artist_cache().lock().expect("artist cache poisoned");
        cache.entry(artist_id).or_default().top =
            Some((std::time::Instant::now(), out.clone()));
    }
    let mut out = out;
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Err(e) = annotate_with_library_state(&conn, &mut out, scoped_pid) {
            tracing::warn!(?e, "artist top: library annotation failed; rendering without ✓ marks");
        }
    }
    Json(out).into_response()
}

/// GET /api/genres/:id/artists
///
/// The genre's top artists (Deezer `/genre/{id}/artists`) — genuinely
/// genre-filtered (unlike the chart) and already carrying portraits, in the
/// same `SearchArtistOut` shape as /api/search. This is the LIGHT path the
/// onboarding taste grid uses: one Deezer call per genre, no chart-track
/// resolution and no per-name re-search — the two things that funneled ~100
/// throttled Deezer calls through one gate and made the artist step take 30-45s.
async fn genre_artists(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Ok(genre_id) = id.parse::<i64>() else {
        return (StatusCode::BAD_REQUEST, "genre id must be numeric").into_response();
    };
    let client = crate::deezer::DeezerClient::new();
    let artists = match client.get_genre_artists(genre_id).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(?e, genre_id, "deezer genre artists failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"genre_artists_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let out: Vec<SearchArtistOut> = artists
        .into_iter()
        .map(|a| {
            let pic = a.best_picture();
            SearchArtistOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.name,
                picture_url: pic,
                total_albums: a.nb_album,
                total_fans: a.nb_fan,
            }
        })
        .collect();
    Json(out).into_response()
}

/// GET /api/artists/:id/related
///
/// "Fans also like" — related artists in the same `SearchArtistOut`
/// shape as /api/search, so the UI reuses the artist grid and tapping
/// one drills into that artist's page.
async fn get_artist_related(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let Ok(artist_id) = id.parse::<u64>() else {
        return (StatusCode::BAD_REQUEST, "artist id must be numeric").into_response();
    };
    // Fast path: serve a recent identical response from the artist cache.
    {
        let cache = artist_cache().lock().expect("artist cache poisoned");
        if let Some(entry) = cache.get(&artist_id) {
            if let Some((at, related)) = &entry.related {
                if at.elapsed() < ARTIST_TTL {
                    return Json(related.clone()).into_response();
                }
            }
        }
    }
    let client = crate::deezer::DeezerClient::new();
    let artists = match client.get_artist_related(artist_id).await {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(?e, artist_id, "deezer related artists failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"artist_related_failed","message":format!("{e}")})),
            )
                .into_response();
        }
    };
    let out: Vec<SearchArtistOut> = artists
        .into_iter()
        .map(|a| {
            let pic = a.best_picture();
            SearchArtistOut {
                source: "deezer".into(),
                source_id: a.id.to_string(),
                name: a.name,
                picture_url: pic,
                total_albums: a.nb_album,
                total_fans: a.nb_fan,
            }
        })
        .collect();
    {
        let mut cache = artist_cache().lock().expect("artist cache poisoned");
        cache.entry(artist_id).or_default().related =
            Some((std::time::Instant::now(), out.clone()));
    }
    Json(out).into_response()
}

// ---- Artist bio (Wikipedia) ------------------------------------------
//
// Deezer carries no artist bio, so we pull a short "About" blurb from
// Wikipedia's REST summary API — free, no key, CC-licensed (we attribute
// it in the UI). Name-matched, with a "<name> musician" search fallback
// for disambiguation and a musical-keyword guard so we never surface a
// wrong-topic article. Results (including misses) are cached in-process.

#[derive(serde::Serialize, Clone)]
struct ArtistBioOut {
    extract: String,
    title: String,
    url: String,
    /// Apple-style About facts, best-effort from Wikidata (via the article's
    /// linked entity). Absent when the entity has no such claim — the client
    /// renders only the rows it gets.
    #[serde(skip_serializing_if = "Option::is_none")]
    born: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    genre: Option<String>,
    /// Wikidata entity id (e.g. "Q1239933") — internal handle for the facts
    /// fetch, never sent to the client.
    #[serde(skip)]
    qid: Option<String>,
}

static BIO_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Option<ArtistBioOut>>>,
> = std::sync::OnceLock::new();

fn bio_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Option<ArtistBioOut>>>
{
    BIO_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Keywords that mark a Wikipedia blurb as being about a music act, so a
/// same-named non-musician (politician, athlete, place) doesn't slip through.
const BIO_MUSIC_HINTS: &[&str] = &[
    "singer", "rapper", "musician", "band ", "song", "music", "producer",
    " dj ", "composer", "duo", "vocalist", "guitarist", "drummer", "bassist",
    "record", "hip hop", "hip-hop", "rock", " pop", "songwriter", "r&b",
    "jazz", "electronic", "dance", "soul", "indie", "metal", "punk", "rapper",
    "discography", "album",
];

fn looks_musical(text: &str) -> bool {
    let lc = text.to_lowercase();
    BIO_MUSIC_HINTS.iter().any(|h| lc.contains(h))
}

async fn wiki_summary(client: &reqwest::Client, title: &str) -> Option<ArtistBioOut> {
    // NB: no trailing slash on the base — a trailing slash leaves an empty
    // path segment, and `push` would then append after it, producing
    // ".../summary//Title" (a 404). `push` percent-encodes the segment, so
    // titles with spaces / slashes (e.g. "AC/DC") are handled correctly.
    let mut u =
        url::Url::parse("https://en.wikipedia.org/api/rest_v1/page/summary").ok()?;
    u.path_segments_mut().ok()?.push(title);
    let resp = client.get(u).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    // Skip disambiguation / missing pages.
    if v.get("type").and_then(|x| x.as_str()) != Some("standard") {
        return None;
    }
    let extract = v
        .get("extract")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if extract.is_empty() {
        return None;
    }
    let desc = v.get("description").and_then(|x| x.as_str()).unwrap_or("");
    // Disambiguation-in-disguise: anthroponymy ("Name list" / given-name /
    // surname) articles are typed "standard", so the type check above doesn't
    // catch them — and their referent list can name-drop enough musical terms
    // to pass the keyword guard (e.g. "Masego", whose list includes the
    // musician alongside grim unrelated entries). Reject list-style pages by
    // their description and the canonical "may refer to" lead-in, so the
    // "<name> musician" search fallback resolves the real artist page instead.
    let desc_lc = desc.to_lowercase();
    if ["disambiguation", "name list", "given name", "surname", "family name"]
        .iter()
        .any(|m| desc_lc.contains(m))
        || extract.to_lowercase().contains("may refer to")
    {
        return None;
    }
    if !looks_musical(&format!("{desc} {extract}")) {
        return None;
    }
    let page_title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or(title)
        .to_string();
    let url = v
        .get("content_urls")
        .and_then(|c| c.get("desktop"))
        .and_then(|d| d.get("page"))
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    Some(ArtistBioOut {
        extract,
        title: page_title,
        url,
        born: None,
        from: None,
        genre: None,
        qid: v
            .get("wikibase_item")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

/// "+1983-09-25T00:00:00Z" (+ precision) → "September 25, 1983". Wikidata's
/// precision says how much of the timestamp is real: 11 = day, 10 = month,
/// 9 = year; below that (decade, century) we skip the fact entirely.
fn format_wikidata_date(time: &str, precision: i64) -> Option<String> {
    let t = time.strip_prefix('+').unwrap_or(time);
    let (date, _) = t.split_once('T')?;
    let mut it = date.splitn(3, '-');
    let year = it.next()?.to_string();
    let month: usize = it.next()?.parse().ok()?;
    let day: usize = it.next()?.trim_start_matches('0').parse().unwrap_or(0);
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July",
        "August", "September", "October", "November", "December",
    ];
    match precision {
        p if p >= 11 && (1..=12).contains(&month) && day > 0 => {
            Some(format!("{} {}, {}", MONTHS[month - 1], day, year))
        }
        10 if (1..=12).contains(&month) => Some(format!("{} {}", MONTHS[month - 1], year)),
        9 | 10 | 11 => Some(year),
        _ => None,
    }
}

/// Tidy a Wikidata genre label for display: "hip hop music" → "Hip Hop".
fn tidy_genre_label(label: &str) -> String {
    let base = label.strip_suffix(" music").unwrap_or(label);
    base.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Wikidata classes that disqualify an entity from being somewhere you are
/// "from". Verified against the case that prompted this: Ludwig Göransson's
/// place of birth is *Linköping Cathedral Congregation*, whose P31 is
/// `parish of the Church of Sweden` **and** `organization` — a congregation,
/// not a town.
const NOT_A_PLACE_YOU_ARE_FROM: [&str; 4] = [
    "Q43229",   // organization
    "Q2977",    // cathedral
    "Q16970",   // church building
    "Q1370598", // place of worship
];

/// Administrative suffixes worth trimming. A municipality in the Nordics and
/// much of Europe takes the name of its seat, so "Linköping Municipality" is
/// the town of Linköping wearing its paperwork.
const ADMIN_SUFFIXES: [&str; 3] = [" Municipality", " Parish", " Township"];

/// Turn a raw birthplace entity into somewhere a person would say they are
/// from, and pair it with its country.
///
/// Wikidata records place of birth at whatever precision the article happened
/// to use, which is regularly below the level anyone names — a parish, a
/// hospital, a neighbourhood. Rendering that under "From" is technically
/// correct and reads like a church, which is exactly what it was.
///
/// So: reject entities that are organizations rather than places, walk up P131
/// (located in the administrative territorial entity) when rejected, trim the
/// administrative suffix off whatever we land on, and append P17 (country).
/// If every candidate is rejected, the **country alone** is the answer —
/// "Sweden" tells the truth and reads fine, where a parish does neither.
///
/// Three hops: beyond that we are naming counties and states, no more sayable
/// than the parish. Country is captured from the first entity that has one,
/// since the parish itself knows it is in Sweden.
async fn resolve_place_name(client: &reqwest::Client, start_qid: &str) -> Option<String> {
    let fetch = |qid: String| {
        let client = client.clone();
        async move {
            client
                .get("https://www.wikidata.org/w/api.php")
                .query(&[
                    ("action", "wbgetentities"),
                    ("ids", qid.as_str()),
                    ("props", "claims|labels"),
                    ("languages", "en"),
                    ("format", "json"),
                    ("formatversion", "2"),
                ])
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success())?
                .json::<serde_json::Value>()
                .await
                .ok()
        }
    };
    let first_id = |v: &serde_json::Value, prop: &str| -> Option<String> {
        v["claims"][prop][0]["mainsnak"]["datavalue"]["value"]["id"]
            .as_str()
            .map(str::to_string)
    };

    let mut qid = start_qid.to_string();
    let mut place: Option<String> = None;
    let mut country_qid: Option<String> = None;
    for _ in 0..3 {
        let Some(resp) = fetch(qid.clone()).await else { break };
        let ent = resp["entities"][qid.as_str()].clone();
        if country_qid.is_none() {
            country_qid = first_id(&ent, "P17");
        }
        let disqualified = ent["claims"]["P31"]
            .as_array()
            .map(|cs| {
                cs.iter().any(|c| {
                    c["mainsnak"]["datavalue"]["value"]["id"]
                        .as_str()
                        .is_some_and(|id| NOT_A_PLACE_YOU_ARE_FROM.contains(&id))
                })
            })
            .unwrap_or(false);
        if !disqualified {
            place = ent["labels"]["en"]["value"].as_str().map(|l| {
                let mut name = l.to_string();
                for suffix in ADMIN_SUFFIXES {
                    if let Some(trimmed) = name.strip_suffix(suffix) {
                        name = trimmed.to_string();
                        break;
                    }
                }
                name
            });
            break;
        }
        match first_id(&ent, "P131") {
            Some(parent) => qid = parent,
            None => break,
        }
    }

    let country = match country_qid {
        Some(c) => fetch(c.clone()).await.and_then(|v| {
            v["entities"][c.as_str()]["labels"]["en"]["value"]
                .as_str()
                .map(str::to_string)
        }),
        None => None,
    };
    match (place, country) {
        (Some(p), Some(c)) if p != c => Some(format!("{p}, {c}")),
        (Some(p), _) => Some(p),
        (None, Some(c)) => Some(c),
        (None, None) => None,
    }
}

/// Fetch Apple-style About facts (born / from / genre) for a Wikidata entity.
/// Two requests: the entity's claims, then one batched label lookup for the
/// place + genre entities those claims point at. Any miss → that fact is None.
async fn fetch_wikidata_facts(
    client: &reqwest::Client,
    qid: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let claims: serde_json::Value = match client
        .get("https://www.wikidata.org/w/api.php")
        .query(&[
            ("action", "wbgetentities"),
            ("ids", qid),
            ("props", "claims"),
            ("format", "json"),
            ("formatversion", "2"),
        ])
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())
    {
        Some(r) => match r.json().await {
            Ok(v) => v,
            Err(_) => return (None, None, None),
        },
        None => return (None, None, None),
    };
    let entity = &claims["entities"][qid]["claims"];
    let snak_value = |prop: &str, idx: usize| -> Option<serde_json::Value> {
        entity
            .get(prop)?
            .get(idx)?
            .get("mainsnak")?
            .get("datavalue")?
            .get("value")
            .cloned()
    };
    // Born: birth date (P569) — PEOPLE ONLY. Band inception (P571) proved
    // unreliable (Wikidata dates Coldplay 1999 while the article says formed
    // 1997 — likely dating the band's rename), and a wrong "BORN" fact reads
    // worse than no row. Bands still get FROM / GENRE / LISTENERS.
    let born = snak_value("P569", 0).and_then(|v| {
        format_wikidata_date(v.get("time")?.as_str()?, v.get("precision")?.as_i64()?)
    });
    // From: birthplace, else formation location, else country of origin.
    let place_qid = ["P19", "P740", "P495"].iter().find_map(|p| {
        snak_value(p, 0)?.get("id")?.as_str().map(str::to_string)
    });
    // Genre: first two P136 entries.
    let genre_qids: Vec<String> = (0..2)
        .filter_map(|i| snak_value("P136", i)?.get("id")?.as_str().map(str::to_string))
        .collect();

    // Batched label lookup for whatever entities we found.
    let mut want: Vec<String> = Vec::new();
    if let Some(p) = &place_qid {
        want.push(p.clone());
    }
    want.extend(genre_qids.iter().cloned());
    let mut labels: std::collections::HashMap<String, String> = Default::default();
    if !want.is_empty() {
        if let Some(resp) = client
            .get("https://www.wikidata.org/w/api.php")
            .query(&[
                ("action", "wbgetentities"),
                ("ids", want.join("|").as_str()),
                ("props", "labels"),
                ("languages", "en"),
                ("format", "json"),
                ("formatversion", "2"),
            ])
            .send()
            .await
            .ok()
            .filter(|r| r.status().is_success())
        {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                for id in &want {
                    if let Some(l) = v["entities"][id.as_str()]["labels"]["en"]["value"].as_str()
                    {
                        labels.insert(id.clone(), l.to_string());
                    }
                }
            }
        }
    }
    // `place_qid` is resolved through `resolve_place_name` rather than looked
    // up in the batch above: the raw entity is frequently a parish, hospital
    // or neighbourhood, and only the walk turns it into a place name.
    let from = match &place_qid {
        Some(p) => match resolve_place_name(client, p).await {
            Some(name) => Some(name),
            None => labels.get(p).cloned(),
        },
        None => None,
    };
    let genres: Vec<String> = genre_qids
        .iter()
        .filter_map(|g| labels.get(g))
        .map(|l| tidy_genre_label(l))
        .collect();
    let genre = if genres.is_empty() {
        None
    } else {
        Some(genres.join(", "))
    };
    (born, from, genre)
}

async fn wiki_search_top(client: &reqwest::Client, query: &str) -> Option<String> {
    let resp = client
        .get("https://en.wikipedia.org/w/api.php")
        .query(&[
            ("action", "query"),
            ("list", "search"),
            ("srsearch", query),
            ("srlimit", "1"),
            ("format", "json"),
        ])
        .send()
        .await
        .ok()?;
    let bytes = resp.bytes().await.ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("query")?
        .get("search")?
        .get(0)?
        .get("title")?
        .as_str()
        .map(str::to_string)
}

/// Does a Wikipedia page title plausibly belong to `name`? Ignores a
/// parenthetical qualifier ("Air (band)" → "air"). Used only to vet
/// SEARCH-FALLBACK results — the direct-name path already followed
/// Wikipedia's own redirects, so stage names (Childish Gambino → Donald
/// Glover) resolve there and never reach this check.
fn title_matches(name: &str, title: &str) -> bool {
    let n = name.trim().to_lowercase();
    let t_full = title.to_lowercase();
    let t = t_full.split('(').next().unwrap_or(&t_full).trim();
    !t.is_empty() && (t.contains(&n) || n.contains(t))
}

async fn fetch_artist_bio(name: &str) -> Option<ArtistBioOut> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Beetbot/0.2 (personal music library)")
        .build()
        .ok()?;
    // 1. Direct page by name (handles the common case + redirects).
    let mut bio = if let Some(b) = wiki_summary(&client, name).await {
        b
    } else {
        // 2. Disambiguate via a "<name> musician" search — but only accept a
        //    result whose title actually resembles the artist, so a bare word
        //    like "Air" doesn't pull in an unrelated musician's page. A wrong
        //    match here becomes "no bio", which is the safer failure.
        let title = wiki_search_top(&client, &format!("{name} musician")).await?;
        let b = wiki_summary(&client, &title).await?;
        if !title_matches(name, &b.title) {
            return None;
        }
        b
    };
    // Enrich with the About facts via the article's Wikidata entity. Purely
    // additive: a facts failure still returns the plain bio.
    if let Some(qid) = bio.qid.clone() {
        let (born, from, genre) = fetch_wikidata_facts(&client, &qid).await;
        bio.born = born;
        bio.from = from;
        bio.genre = genre;
    }
    Some(bio)
}

#[derive(Deserialize)]
struct BioQuery {
    #[serde(default)]
    t: Option<String>,
    name: Option<String>,
}

/// GET /api/artists/bio?name=...
///
/// Returns a Wikipedia "About" blurb for the artist, or `null` when none
/// is confidently found. Cached in-process (hits and misses) so repeated
/// artist-page opens don't re-hit Wikipedia.
async fn artist_bio(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<BioQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let Some(name) = q.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "missing name").into_response();
    };
    let key = name.to_lowercase();
    if let Ok(map) = bio_cache().lock() {
        if let Some(cached) = map.get(&key) {
            return Json(cached.clone()).into_response();
        }
    }
    let bio = fetch_artist_bio(name).await;
    if let Ok(mut map) = bio_cache().lock() {
        map.insert(key, bio.clone());
    }
    Json(bio).into_response()
}

/// GET /api/artists/appears-on?name=...
///
/// Albums by OTHER artists that feature this one (Apple Music's "Appears On").
/// Deezer has no direct endpoint, so this is a search heuristic: search tracks
/// by the artist and keep albums whose main artist is someone else — those are
/// the features/collabs. Grouped by album, capped, best-effort (empty on any
/// failure, the client just hides the rail).
async fn artist_appears_on(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<BioQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let Some(name) = q.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "missing name").into_response();
    };
    let client = crate::deezer::DeezerClient::new();
    let tracks = match client
        .search_tracks(&format!("artist:\"{name}\""), 50)
        .await
    {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(?e, name, "appears-on search failed");
            return Json(Vec::<SearchAlbumOut>::new()).into_response();
        }
    };
    let lc = name.to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let out: Vec<SearchAlbumOut> = tracks
        .into_iter()
        // A track whose MAIN artist differs is a feature on someone else's
        // record — exactly the "Appears On" set.
        .filter(|t| t.artist.name.to_lowercase() != lc)
        // Quality guard: Deezer's artist: search fuzzy-matches, so a stray
        // result set can be pure noise (classical albums for "Masego").
        // A real feature credits the guest in the track title — "… (feat.
        // <name>)" — so require the name there. Legit collabs credited only
        // in the artist list get dropped too; an empty rail beats a wrong one.
        .filter(|t| t.title.to_lowercase().contains(&lc))
        .filter(|t| seen.insert(t.album.id))
        .take(12)
        .map(|t| SearchAlbumOut {
            source: "deezer".into(),
            source_id: t.album.id.to_string(),
            name: t.album.title.clone(),
            artists: vec![t.artist.name.clone()],
            cover_url: t.album.best_cover(),
            album_type: None,
            release_date: None,
            total_tracks: None,
        })
        .collect();
    Json(out).into_response()
}

// ---- Lyrics (LRCLIB) -------------------------------------------------
//
// LRCLIB (https://lrclib.net) is a free, no-key, crowdsourced synced-lyrics
// database built for music players. We match on the signature it expects —
// track title + artist + album + duration, all of which we already have — and
// fall back to its fuzzy /search when the exact /get misses (album/duration
// drift). Results (hits + misses) are cached in-process; lyrics don't change.

#[derive(serde::Serialize, Clone)]
struct LyricsOut {
    /// Plain (unsynced) lyrics, newline-separated. Null when unavailable.
    plain: Option<String>,
    /// Synced lyrics in LRC format ("[mm:ss.xx] line"). Null when unavailable.
    synced: Option<String>,
    /// LRCLIB flags the track as instrumental (no lyrics expected).
    instrumental: bool,
}

#[derive(Deserialize)]
struct LrclibRecord {
    #[serde(rename = "plainLyrics", default)]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics", default)]
    synced_lyrics: Option<String>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    duration: Option<f64>,
}

impl LrclibRecord {
    fn into_out(self) -> Option<LyricsOut> {
        if self.plain_lyrics.is_none() && self.synced_lyrics.is_none() && !self.instrumental {
            return None;
        }
        Some(LyricsOut {
            plain: self.plain_lyrics,
            synced: self.synced_lyrics,
            instrumental: self.instrumental,
        })
    }
}

static LYRICS_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Option<LyricsOut>>>,
> = std::sync::OnceLock::new();

fn lyrics_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, Option<LyricsOut>>> {
    LYRICS_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Outcome of an LRCLIB lookup. Distinguishing a definitive miss from a transient
/// failure is the whole point: only Found/NotFound are persisted, so a network
/// blip can never poison the cache as a permanent "no lyrics".
enum LyricsFetch {
    Found(LyricsOut),
    NotFound,
    Failed,
}

/// Shared HTTP client (built once) so repeated lyrics fetches reuse the pool.
/// 15s per-request timeout — LRCLIB latency swings wildly (measured 6-12s for a
/// successful /get), so a tight cap times out even good lookups (a 5s cap killed
/// lyrics outright). The cost is hidden anyway: the next-track prefetch warms
/// lyrics in the background, and the persistent cache makes every repeat instant.
static LYRICS_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
fn lyrics_client() -> &'static reqwest::Client {
    LYRICS_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Beetbot/0.2 (personal music library; https://github.com/beetbot-app/beetbot)")
            .build()
            .unwrap_or_default()
    })
}

/// A confirmed "no lyrics" goes stale after this long so lyrics LRCLIB adds later
/// eventually surface; a found result is kept forever (lyrics don't change).
const LYRICS_MISS_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// Short-lived negative cache for transient failures, so a re-request in the same
/// session (re-mount, second device) doesn't re-pay the deadline — but it retries
/// once the blip passes.
static LYRICS_FAIL_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
> = std::sync::OnceLock::new();
const LYRICS_FAIL_TTL: std::time::Duration = std::time::Duration::from_secs(60);
fn lyrics_fail_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>> {
    LYRICS_FAIL_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn lyrics_fail_recent(sig: &str) -> bool {
    lyrics_fail_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(sig).map(|t| t.elapsed() < LYRICS_FAIL_TTL))
        .unwrap_or(false)
}
fn lyrics_fail_mark(sig: &str) {
    if let Ok(mut m) = lyrics_fail_cache().lock() {
        m.insert(sig.to_string(), std::time::Instant::now());
    }
}
fn lyrics_fail_clear(sig: &str) {
    if let Ok(mut m) = lyrics_fail_cache().lock() {
        m.remove(sig);
    }
}

/// Persistent cache read. Outer `None` = no row (or a stale miss) → fetch;
/// `Some(None)` = a fresh confirmed miss → return null; `Some(Some(_))` = cached
/// lyrics. Locks/queries/returns synchronously — never held across an `.await`.
fn lyrics_db_get(db: &Arc<Mutex<Connection>>, sig: &str) -> Option<Option<LyricsOut>> {
    let conn = db.lock().ok()?;
    let (plain, synced, instrumental, found, fetched_at): (
        Option<String>,
        Option<String>,
        i64,
        i64,
        i64,
    ) = conn
        .query_row(
            "SELECT plain, synced, instrumental, found, fetched_at FROM lyrics_cache WHERE sig = ?1",
            rusqlite::params![sig],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok()?;
    if found == 0 {
        if chrono::Utc::now().timestamp() - fetched_at > LYRICS_MISS_TTL_SECS {
            return None;
        }
        Some(None)
    } else {
        Some(Some(LyricsOut {
            plain,
            synced,
            instrumental: instrumental != 0,
        }))
    }
}
fn lyrics_db_put(db: &Arc<Mutex<Connection>>, sig: &str, out: Option<&LyricsOut>) {
    let Ok(conn) = db.lock() else {
        return;
    };
    let now = chrono::Utc::now().timestamp();
    let (plain, synced, instrumental, found): (Option<&str>, Option<&str>, i64, i64) = match out {
        Some(o) => (
            o.plain.as_deref(),
            o.synced.as_deref(),
            o.instrumental as i64,
            1,
        ),
        None => (None, None, 0, 0),
    };
    let _ = conn.execute(
        "INSERT OR REPLACE INTO lyrics_cache (sig, plain, synced, instrumental, found, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![sig, plain, synced, instrumental, found, now],
    );
}

/// LRCLIB lookup with an overall ceiling. The per-request timeout (15s) on the
/// shared client does the real bounding; this 20s cap keeps a slow get→search
/// pair from stacking into a longer hang. A timeout is a transient Failed, never
/// a miss — so it isn't persisted and retries later. (The persistent cache +
/// next-track prefetch are what make lyrics feel instant, not a short timeout.)
async fn fetch_lyrics(title: &str, artist: &str, album: &str, duration_s: u32) -> LyricsFetch {
    match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        fetch_lyrics_inner(title, artist, album, duration_s),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => LyricsFetch::Failed,
    }
}

async fn fetch_lyrics_inner(
    title: &str,
    artist: &str,
    album: &str,
    duration_s: u32,
) -> LyricsFetch {
    // NetEase first — far faster (~1.5s vs LRCLIB's 6-12s) and usually synced.
    let netease = fetch_netease(title, artist, duration_s).await;
    if let Some(out) = &netease {
        if out.synced.as_deref().is_some_and(|s| !s.trim().is_empty()) {
            return LyricsFetch::Found(out.clone());
        }
    }
    // Else LRCLIB (broader FOSS catalog; may have synced where NetEase only had
    // plain; and the safety net if NetEase's unofficial endpoint changes). Keep
    // NetEase's plain-only result only when LRCLIB comes up empty.
    match fetch_lrclib(title, artist, album, duration_s).await {
        LyricsFetch::Found(out) => LyricsFetch::Found(out),
        LyricsFetch::NotFound => match netease {
            Some(out) => LyricsFetch::Found(out),
            None => LyricsFetch::NotFound,
        },
        LyricsFetch::Failed => match netease {
            Some(out) => LyricsFetch::Found(out),
            None => LyricsFetch::Failed,
        },
    }
}

// --- NetEase Cloud Music (unofficial public endpoints) as a fast lyrics source.
// Free, no key, but reverse-engineered: needs a browser-y UA + a music.163.com
// Referer to avoid 403, and could change. Catalog is huge and usually synced.

static NETEASE_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
fn netease_client() -> &'static reqwest::Client {
    NETEASE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default()
    })
}

#[derive(Deserialize)]
struct NeteaseSearchResp {
    result: Option<NeteaseResult>,
}
#[derive(Deserialize)]
struct NeteaseResult {
    songs: Option<Vec<NeteaseSong>>,
}
#[derive(Deserialize)]
struct NeteaseArtist {
    #[serde(default)]
    name: String,
}
#[derive(Deserialize)]
struct NeteaseSong {
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    duration: i64,
    #[serde(default)]
    artists: Vec<NeteaseArtist>,
}
#[derive(Deserialize)]
struct NeteaseLyricResp {
    lrc: Option<NeteaseLrcField>,
}
#[derive(Deserialize)]
struct NeteaseLrcField {
    lyric: Option<String>,
}

/// Alphanumeric-lowercase title key for loose matching ("Yeah!" vs "Yeah! (feat.
/// Lil Jon)"), so we accept formatting differences but reject a different song.
fn norm_title(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// True when a NetEase search hit's artist overlaps the artist we asked for.
/// NetEase's fuzzy search returns *other* artists' songs of the same title, and
/// those often share the duration too — so title+duration alone let a different
/// act's lyrics through (the "Foreplay" bug: 汉堡黄's song beat Jalen Santoy's on
/// a one-second duration tiebreak). Confirming the artist keeps a same-title
/// stranger out; a genuine no-match falls through to LRCLIB, which is itself
/// artist-scoped, so we get correct-or-nothing rather than a wrong song.
fn netease_artist_matches(query_artist: &str, song: &NeteaseSong) -> bool {
    let q = norm_title(query_artist); // same alphanumeric-lowercase normaliser
    if q.is_empty() {
        return true; // nothing to check against → don't block
    }
    song.artists.iter().any(|a| {
        let s = norm_title(&a.name);
        if s.is_empty() {
            return false;
        }
        // Substring either way handles "feat." / multi-artist joins ("Anyma &
        // Chris Avantgarde" vs the two listed separately). Exact matches pass at
        // any length; a substring needs the shorter side to be 3+ chars so a
        // 1–2 char fragment can't spuriously match a longer name.
        s == q || (s.len().min(q.len()) >= 3 && (q.contains(&s) || s.contains(&q)))
    })
}

/// Drop NetEase's CJK credit lines ("作词 : …", "作曲 : …") that head Western LRCs
/// so the karaoke view isn't led by metadata.
fn clean_netease_lrc(raw: &str) -> String {
    const CREDITS: [&str; 6] = ["作词", "作曲", "编曲", "制作人", "混音", "录音"];
    raw.lines()
        .filter(|line| {
            let text = line.rsplit(']').next().unwrap_or(line);
            !CREDITS.iter().any(|c| text.contains(c))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Strip [mm:ss.xx] tags from an LRC to derive plain text for the unsynced fallback.
fn lrc_to_plain(lrc: &str) -> String {
    lrc.lines()
        .map(|line| {
            let mut s = line;
            while s.starts_with('[') {
                match s.find(']') {
                    Some(end) => s = &s[end + 1..],
                    None => break,
                }
            }
            s.trim()
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

async fn fetch_netease(title: &str, artist: &str, duration_s: u32) -> Option<LyricsOut> {
    let client = netease_client();
    // 1. Search for the song id.
    let mut url = url::Url::parse("https://music.163.com/api/search/get").ok()?;
    url.query_pairs_mut()
        .append_pair("s", &format!("{title} {artist}"))
        .append_pair("type", "1")
        .append_pair("limit", "10");
    let resp = client
        .get(url)
        .header("Referer", "https://music.163.com")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let songs = resp.json::<NeteaseSearchResp>().await.ok()?.result?.songs?;
    // 2. Pick the best match. NetEase returns the original alongside remixes and
    //    covers — and those often share the title fragment AND the exact duration
    //    of the original, so filtering on duration + loose title-overlap alone let
    //    a different rendition's lyrics through (the real bug: "Mask Off" grabbed a
    //    "(… Remix)" with brand-new verses over the same beat). Fix:
    //    (a) drop alternate renditions (remix/cover/…) unless the queried title is
    //        itself one;
    //    (a2) require the ARTIST to match — NetEase returns a different act's
    //        same-title song (see netease_artist_matches: the "Foreplay" bug,
    //        where a stranger's track was one second closer in length);
    //    (b) prefer an EXACT normalized-title match over a loose overlap;
    //    (c) within a tier, take the duration-closest hit (or the first, if we
    //        don't know the length).
    let want_ms = duration_s as i64 * 1000;
    let t = norm_title(title);
    let dur_ok = |d: i64| duration_s == 0 || (d - want_ms).abs() <= 5000;
    let query_lower = title.to_lowercase();
    let is_alt_version = |name: &str| {
        const MARKERS: [&str; 8] = [
            "remix", "bootleg", "flip", "mashup", "cover", "vip", "rework", "instrumental",
        ];
        let n = name.to_lowercase();
        MARKERS
            .iter()
            .any(|m| n.contains(m) && !query_lower.contains(m))
    };
    let eligible: Vec<NeteaseSong> = songs
        .into_iter()
        .filter(|s| dur_ok(s.duration) && !is_alt_version(&s.name) && netease_artist_matches(artist, s))
        .collect();
    let mut exact: Vec<&NeteaseSong> = eligible
        .iter()
        .filter(|s| !t.is_empty() && norm_title(&s.name) == t)
        .collect();
    let mut loose: Vec<&NeteaseSong> = eligible
        .iter()
        .filter(|s| {
            let n = norm_title(&s.name);
            !n.is_empty() && !t.is_empty() && (n.contains(&t) || t.contains(&n))
        })
        .collect();
    if duration_s != 0 {
        exact.sort_by_key(|s| (s.duration - want_ms).abs());
        loose.sort_by_key(|s| (s.duration - want_ms).abs());
    }
    let song_id = exact.first().or_else(|| loose.first()).map(|s| s.id)?;
    // 3. Fetch the LRC.
    let mut lurl = url::Url::parse("https://music.163.com/api/song/lyric").ok()?;
    lurl.query_pairs_mut()
        .append_pair("id", &song_id.to_string())
        .append_pair("lv", "1")
        .append_pair("kv", "1")
        .append_pair("tv", "-1");
    let lresp = client
        .get(lurl)
        .header("Referer", "https://music.163.com")
        .send()
        .await
        .ok()?;
    if !lresp.status().is_success() {
        return None;
    }
    let raw = lresp.json::<NeteaseLyricResp>().await.ok()?.lrc?.lyric?;
    let synced = clean_netease_lrc(&raw);
    if synced.trim().is_empty() {
        return None;
    }
    let plain = lrc_to_plain(&synced);
    Some(LyricsOut {
        plain: (!plain.trim().is_empty()).then_some(plain),
        synced: Some(synced),
        instrumental: false,
    })
}

async fn fetch_lrclib(
    title: &str,
    artist: &str,
    album: &str,
    duration_s: u32,
) -> LyricsFetch {
    let client = lyrics_client();

    // 1. Exact signature match. A hit is definitive; any failure here (404,
    //    network, parse) is soft — fall through to the fuzzy /search.
    if let Ok(mut url) = url::Url::parse("https://lrclib.net/api/get") {
        url.query_pairs_mut()
            .append_pair("track_name", title)
            .append_pair("artist_name", artist)
            .append_pair("album_name", album)
            .append_pair("duration", &duration_s.to_string());
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                if let Ok(rec) = resp.json::<LrclibRecord>().await {
                    if let Some(out) = rec.into_out() {
                        return LyricsFetch::Found(out);
                    }
                }
            }
        }
    }

    // 2. Fuzzy fallback — and the verdict. A clean 200 with no usable record is a
    //    definitive NotFound; anything that prevents that clean 200 (non-2xx,
    //    network, parse error) is a transient Failed, so a blip is never cached.
    let Ok(mut url) = url::Url::parse("https://lrclib.net/api/search") else {
        return LyricsFetch::Failed;
    };
    url.query_pairs_mut()
        .append_pair("track_name", title)
        .append_pair("artist_name", artist);
    let resp = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return LyricsFetch::Failed,
    };
    let list = match resp.json::<Vec<LrclibRecord>>().await {
        Ok(l) => l,
        Err(_) => return LyricsFetch::Failed,
    };
    let want = duration_s as f64;
    let best = list
        .into_iter()
        .filter(|r| r.plain_lyrics.is_some() || r.synced_lyrics.is_some())
        .min_by(|a, b| {
            // Prefer synced; then closest duration.
            let key = |r: &LrclibRecord| {
                let synced_rank = if r.synced_lyrics.is_some() { 0.0 } else { 1.0 };
                let dd = r.duration.map(|d| (d - want).abs()).unwrap_or(1e6);
                (synced_rank, dd)
            };
            let (sa, da) = key(a);
            let (sb, db) = key(b);
            (sa, da)
                .partial_cmp(&(sb, db))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    match best.and_then(|rec| rec.into_out()) {
        Some(out) => LyricsFetch::Found(out),
        None => LyricsFetch::NotFound,
    }
}

#[derive(Deserialize)]
struct LyricsQuery {
    #[serde(default)]
    t: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    #[serde(default)]
    album: Option<String>,
    /// Track duration in seconds.
    #[serde(default)]
    duration: Option<u32>,
}

/// GET /api/lyrics?title=&artist=&album=&duration=
///
/// Plain + synced (LRC) lyrics from LRCLIB, or `null` when none are found.
/// Cached in-process (hits + misses).
async fn get_lyrics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LyricsQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    let (Some(title), Some(artist)) = (
        q.title.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        q.artist.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    ) else {
        return (StatusCode::BAD_REQUEST, "missing title/artist").into_response();
    };
    let album = q.album.as_deref().unwrap_or("").trim();
    let duration = q.duration.unwrap_or(0);
    let sig = format!(
        "{}|{}|{}|{}",
        title.to_lowercase(),
        artist.to_lowercase(),
        album.to_lowercase(),
        duration
    );
    // 1. In-memory cache (fastest; warm for the session).
    if let Ok(map) = lyrics_cache().lock() {
        if let Some(cached) = map.get(&sig) {
            return Json(cached.clone()).into_response();
        }
    }
    // 2. Persistent DB cache — survives restarts. A hit (lyrics or a fresh
    //    confirmed miss) seeds memory and returns.
    if let Some(hit) = lyrics_db_get(&state.db, &sig) {
        if let Ok(mut map) = lyrics_cache().lock() {
            map.insert(sig.clone(), hit.clone());
        }
        return Json(hit).into_response();
    }
    // 3. A recent transient failure → return null fast; it retries after the blip.
    if lyrics_fail_recent(&sig) {
        return Json(None::<LyricsOut>).into_response();
    }
    // 4. Fetch. Only Found/NotFound are persisted; a Failed never touches the DB,
    //    so a timeout can't poison the cache as a permanent miss.
    match fetch_lyrics(title, artist, album, duration).await {
        LyricsFetch::Found(out) => {
            let val = Some(out);
            lyrics_db_put(&state.db, &sig, val.as_ref());
            if let Ok(mut map) = lyrics_cache().lock() {
                map.insert(sig.clone(), val.clone());
            }
            lyrics_fail_clear(&sig);
            Json(val).into_response()
        }
        LyricsFetch::NotFound => {
            lyrics_db_put(&state.db, &sig, None);
            if let Ok(mut map) = lyrics_cache().lock() {
                map.insert(sig.clone(), None);
            }
            lyrics_fail_clear(&sig);
            Json(None::<LyricsOut>).into_response()
        }
        LyricsFetch::Failed => {
            lyrics_fail_mark(&sig);
            Json(None::<LyricsOut>).into_response()
        }
    }
}

/// Background job: walk the library once and cache LRCLIB lyrics for every owned
/// track, so now-playing lyrics are an instant local hit instead of a 6-12s
/// LRCLIB round-trip. Gentle (sequential, paced) and resumable — results persist,
/// so each launch only works through tracks not yet cached, and it backs off if
/// LRCLIB is unreachable. Default-on; the cache it fills is a few KB per track.
pub fn spawn_lyrics_prewarm(db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        // Let startup settle (browse pre-warm, backfills) before adding load.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        prewarm_lyrics(db).await;
    });
}

async fn prewarm_lyrics(db: Arc<Mutex<Connection>>) {
    // One DB pass: the already-cached sigs + the lyrics keys for the tracks
    // worth warming. We deliberately do NOT warm the whole library — that fired
    // ~1700 automated requests at NetEase's unofficial endpoint, the surest way
    // to get that fast source rate-limited. Instead we warm only what the user
    // actually reaches for: recently-played and downloaded tracks (capped).
    // On-demand fetch + next-track prefetch cover everything else. Build the work
    // list (uncached only) here, then drop the lock before any network I/O —
    // nothing is held across an `.await`.
    let (work, candidates): (Vec<(String, String, String, u32)>, usize) = {
        let Ok(conn) = db.lock() else {
            return;
        };
        let mut cached: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT sig FROM lyrics_cache") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for s in rows.flatten() {
                    cached.insert(s);
                }
            }
        }
        let mut rows: Vec<(String, String, String, i64)> = Vec::new();
        // Recently-played (ever) or downloaded, most-recently-played first,
        // capped — the high-value set, not the whole catalog.
        if let Ok(mut stmt) = conn.prepare(
            "SELECT t.title, t.artists, t.album, t.duration_ms \
             FROM tracks t \
             LEFT JOIN (SELECT track_id, MAX(played_at) AS last_played \
                        FROM play_events GROUP BY track_id) pe ON pe.track_id = t.id \
             WHERE pe.track_id IS NOT NULL OR t.downloaded_at IS NOT NULL \
             ORDER BY COALESCE(pe.last_played, 0) DESC, t.downloaded_at DESC \
             LIMIT 400",
        ) {
            if let Ok(mapped) = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, i64>(3)?,
                ))
            }) {
                for t in mapped.flatten() {
                    rows.push(t);
                }
            }
        }
        let candidates = rows.len();
        let mut work = Vec::new();
        for (title_raw, artists_json, album_raw, duration_ms) in rows {
            let title = title_raw.trim();
            let album = album_raw.trim();
            let artist = serde_json::from_str::<Vec<String>>(&artists_json)
                .ok()
                .and_then(|v| v.into_iter().next())
                .unwrap_or_default();
            let artist = artist.trim();
            // get_lyrics rejects empty title/artist, so they'd never be a hit.
            if title.is_empty() || artist.is_empty() {
                continue;
            }
            // Must match get_lyrics' sig EXACTLY: trim → lowercase → rounded secs
            // (the client sends Math.round(durationMs / 1000)).
            let dur = ((duration_ms as f64) / 1000.0).round().max(0.0) as u32;
            let sig = format!(
                "{}|{}|{}|{}",
                title.to_lowercase(),
                artist.to_lowercase(),
                album.to_lowercase(),
                dur
            );
            if !cached.contains(&sig) {
                work.push((title.to_string(), artist.to_string(), album.to_string(), dur));
            }
        }
        (work, candidates)
    };
    if work.is_empty() {
        return;
    }
    let total = work.len();
    tracing::info!(
        pending = total,
        candidates,
        "lyrics pre-warm: caching lyrics for recently-played + downloaded tracks"
    );
    let mut done = 0usize;
    let mut consecutive_failures = 0u32;
    for (title, artist, album, dur) in work {
        let sig = format!(
            "{}|{}|{}|{}",
            title.to_lowercase(),
            artist.to_lowercase(),
            album.to_lowercase(),
            dur
        );
        match fetch_lyrics(&title, &artist, &album, dur).await {
            LyricsFetch::Found(out) => {
                lyrics_db_put(&db, &sig, Some(&out));
                consecutive_failures = 0;
            }
            LyricsFetch::NotFound => {
                lyrics_db_put(&db, &sig, None);
                consecutive_failures = 0;
            }
            LyricsFetch::Failed => {
                // Not persisted — retried next launch. If LRCLIB is clearly down,
                // stop wasting the whole run on timeouts.
                consecutive_failures += 1;
                if consecutive_failures >= 8 {
                    tracing::warn!(
                        done,
                        total,
                        "lyrics pre-warm: lyrics sources unreachable, pausing until next launch"
                    );
                    return;
                }
            }
        }
        done += 1;
        if done % 50 == 0 {
            tracing::info!(done, total, "lyrics pre-warm progress");
        }
        // Gentle pace — be polite to the (unofficial) lyrics endpoints.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    tracing::info!(done, total, "lyrics pre-warm complete");
}

#[derive(Deserialize)]
struct CreatePlaylistBody {
    name: String,
    #[serde(default)]
    description: Option<String>,
    /// Owning profile. Omitted (older clients) → default profile.
    #[serde(default)]
    profile_id: Option<i64>,
}

#[derive(Serialize)]
struct CreatePlaylistOut {
    id: i64,
    name: String,
    /// The synthetic spotify_id we minted (e.g. `local:abc-...`). Useful
    /// to surface for debugging but the client only really cares about
    /// `id` for follow-up requests.
    spotify_id: String,
}

/// POST /api/playlists  body: { name, description? }
///
/// Create a brand-new playlist that lives only in the local Beetbot
/// database. We mint a synthetic `local:{uuid}` spotify_id so it
/// never collides with a real Spotify mirror row (real Spotify IDs
/// are 22-char base62, no colon). The sync code walks /me/playlists
/// from Spotify and only touches rows whose spotify_id matches a
/// returned playlist, so local: ones are invisible to it — they
/// survive forever.
///
/// Used by the web player's "Add to playlist → + New playlist" flow,
/// but the endpoint is generic enough for any future caller (e.g. a
/// desktop "create empty playlist" button).
async fn create_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<CreatePlaylistBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if name.chars().count() > 200 {
        return (StatusCode::BAD_REQUEST, "name too long").into_response();
    }
    let description = body
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (new_id, spotify_id) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let profile_id = body
            .profile_id
            .unwrap_or_else(|| crate::profiles::default_id(&conn).unwrap_or(1));
        match insert_local_playlist(&conn, name, description, profile_id) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(?e, "create_playlist: insert");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };

    tracing::info!(playlist_id = new_id, %name, "local playlist created");
    Json(CreatePlaylistOut {
        id: new_id,
        name: name.to_string(),
        spotify_id,
    })
    .into_response()
}

/// Body for POST /api/playlists/:id/tracks.
///
/// The client posts the same `CatalogTrackOut` shape it received from
/// /api/search — that way we don't need to re-fetch the track from any
/// external API just to insert it. The `source`/`source_id` pair mints
/// a synthetic `tracks.spotify_id` (e.g. `deezer:12345`) when no
/// existing row matches by ISRC.
type AddTrackBody = CatalogTrackOut;

/// Create a new local-only playlist row inside a held DB lock. Returns
/// the playlist's local id. Pulled out so /api/playlists and
/// /api/albums/import share the exact same insertion logic.
fn insert_local_playlist(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    profile_id: i64,
) -> Result<(i64, String), rusqlite::Error> {
    let spotify_id = format!("local:{}", Uuid::new_v4());
    conn.execute(
        "INSERT INTO playlists
             (spotify_id, name, owner, description, cover_url,
              track_count, last_synced_at, profile_id)
         VALUES (?1, ?2, 'You', ?3, NULL, 0, NULL, ?4)",
        params![spotify_id, name, description, profile_id],
    )?;
    let id = conn.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![spotify_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok((id, spotify_id))
}

/// Create a new album-import playlist row inside a held DB lock. Same as
/// `insert_local_playlist` but mints an `album:{uuid}` spotify_id (so the
/// library classifies it as an "album" rather than a plain playlist) and
/// stores the album artist as the `owner` (rendered "Album · Artist").
fn insert_album_playlist(
    conn: &Connection,
    name: &str,
    artist: Option<&str>,
    profile_id: i64,
) -> Result<(i64, String), rusqlite::Error> {
    let spotify_id = format!("album:{}", Uuid::new_v4());
    conn.execute(
        "INSERT INTO playlists
             (spotify_id, name, owner, description, cover_url,
              track_count, last_synced_at, profile_id)
         VALUES (?1, ?2, ?3, NULL, NULL, 0, NULL, ?4)",
        params![spotify_id, name, artist, profile_id],
    )?;
    let id = conn.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![spotify_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok((id, spotify_id))
}

/// Upsert a track row from a `CatalogTrackOut` payload and append it
/// to `playlist_id` with `locally_added=1`. Returns the local track id
/// and whether the playlist link was newly inserted (false ⇒ already
/// linked).
///
/// Dedup priority for the track row itself:
///   (a) Existing row with matching ISRC — typical when the same
///       recording is already in an imported playlist.
///   (b) Existing row with matching synthetic spotify_id like
///       `deezer:12345` — repeat add of the same Deezer track.
///   (c) Otherwise insert a fresh row.
///
/// This stays pure-DB; any follow-up work that needs an `AppHandle`
/// happens in the caller after this returns.
/// Upsert a catalog track into the `tracks` table WITHOUT linking it to any
/// playlist. Dedups by ISRC, then by synthetic `source:source_id`. Returns
/// `(track_id, inserted_new_row)`. Used by tap-to-play on search/browse results,
/// which only needs a track id to reference the library row.
/// The library row a catalog track would dedup onto: by ISRC first, then by the
/// synthetic `{source}:{source_id}` id. Extracted from `upsert_track` so the
/// import-time credit enrichment can ask "do we already have this?" with the
/// SAME rules the upsert will apply — two copies of this lookup would drift.
fn find_track_id(conn: &Connection, isrc: Option<&str>, synthetic_id: &str) -> Option<i64> {
    let by_isrc: Option<i64> = isrc.and_then(|isrc| {
        let trimmed = isrc.trim();
        if trimmed.is_empty() {
            None
        } else {
            conn.query_row(
                "SELECT id FROM tracks WHERE isrc = ?1",
                params![trimmed],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        }
    });
    by_isrc.or_else(|| {
        conn.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![synthetic_id],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    })
}

/// Deezer's /search and album-tracklist hits carry only the primary artist;
/// the /track/{id} detail carries full credits ("When I'm Home" is James
/// Blake + Travis Scott + Ludwig Göransson, but arrives as James Blake
/// alone). Fetch the detail ONCE, at import time, so the library row is born
/// with full credits — display paths stay un-fetched on purpose (a credits
/// call per rendered search row would multiply catalog traffic for
/// cosmetics).
///
/// No-op unless the track is Deezer-sourced, single-artist, and NOT already
/// in the library — an existing row is the backfill sweep's job, and richer
/// rows are protected from downgrade by `upsert_track` itself. Any fetch
/// failure returns the input unchanged: an import must never fail because a
/// credits lookup did.
async fn with_full_credits(state: &AppState, track: CatalogTrackOut) -> CatalogTrackOut {
    if track.source.trim() != "deezer" || track.artists.len() != 1 {
        return track;
    }
    let Ok(deezer_id) = track.source_id.trim().parse::<u64>() else {
        return track;
    };
    let synthetic_id = format!("{}:{}", track.source.trim(), track.source_id.trim());
    let exists = {
        let conn = state.db.lock().expect("db mutex poisoned");
        find_track_id(&conn, track.isrc.as_deref(), &synthetic_id).is_some()
    };
    if exists {
        return track;
    }
    match crate::deezer::DeezerClient::new().get_track(deezer_id).await {
        Ok(hit) if !hit.contributors.is_empty() => {
            let primary = track.artists[0].clone();
            CatalogTrackOut {
                artists: credit_names(&hit.contributors, &primary),
                ..track
            }
        }
        _ => track,
    }
}

/// Bulk `with_full_credits`, order-preserving, bounded by the shared resolve
/// limiter so a 100-track album import stays polite to the catalog.
async fn with_full_credits_bulk(
    state: &AppState,
    tracks: Vec<CatalogTrackOut>,
) -> Vec<CatalogTrackOut> {
    let sem = resolve_limiter();
    let n = tracks.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, t) in tracks.into_iter().enumerate() {
        let state = state.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            (i, with_full_credits(&state, t).await)
        });
    }
    let mut buf: Vec<Option<CatalogTrackOut>> = (0..n).map(|_| None).collect();
    while let Some(r) = set.join_next().await {
        if let Ok((i, t)) = r {
            buf[i] = Some(t);
        }
    }
    buf.into_iter().flatten().collect()
}

fn upsert_track(conn: &Connection, track: &CatalogTrackOut) -> Result<(i64, bool), rusqlite::Error> {
    let synthetic_id = format!("{}:{}", track.source.trim(), track.source_id.trim());
    let artists_json = serde_json::to_string(&track.artists)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

    if let Some(tid) = find_track_id(conn, track.isrc.as_deref(), &synthetic_id) {
        // The artists CASE below: never DOWNGRADE credits. A /search hit
        // carries one artist where the stored row may hold full contributors
        // (import-time enrichment, the Spotify sync, or the backfill).
        // Re-touching a track via search used to silently shrink a full
        // credits array back to one name; keep whichever array knows more.
        conn.execute(
            "UPDATE tracks SET
                 title = ?2,
                 artists = CASE
                     WHEN json_array_length(?3) > json_array_length(artists)
                     THEN ?3 ELSE artists END,
                 album = COALESCE(?4, album),
                 album_art_url = COALESCE(?5, album_art_url),
                 duration_ms = ?6,
                 isrc = COALESCE(?7, isrc),
                 updated_at = strftime('%s','now')
             WHERE id = ?1",
            params![
                tid,
                track.title,
                artists_json,
                track.album,
                track.album_art_url,
                track.duration_ms,
                track.isrc,
            ],
        )?;
        Ok((tid, false))
    } else {
        conn.execute(
            "INSERT INTO tracks
                 (spotify_id, title, artists, album, album_art_url, duration_ms, isrc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                synthetic_id,
                track.title,
                artists_json,
                track.album,
                track.album_art_url,
                track.duration_ms,
                track.isrc,
            ],
        )?;
        let tid = conn.query_row(
            "SELECT id FROM tracks WHERE spotify_id = ?1",
            params![synthetic_id],
            |r| r.get::<_, i64>(0),
        )?;
        Ok((tid, true))
    }
}

#[derive(Serialize)]
struct ResolveTrackResult {
    track_id: i64,
    status: String,
}

/// A `source == "local"` catalog row is ALREADY a library track — its
/// `source_id` is the track id. Look it up and return id + real status instead
/// of upserting (which would insert a bogus "local:<id>" duplicate row and hand
/// the player a non-playable id). `None` if the id is unparseable or the row is
/// gone.
fn lookup_local_track(conn: &Connection, source_id: &str) -> Option<ResolveTrackResult> {
    let tid = source_id.trim().parse::<i64>().ok()?;
    let status = conn
        .query_row(
            "SELECT status FROM tracks WHERE id = ?1",
            params![tid],
            |r| r.get::<_, String>(0),
        )
        .ok()?;
    Some(ResolveTrackResult {
        track_id: tid,
        status,
    })
}

/// POST /api/tracks/resolve — turn a catalog search/browse result into a real
/// library track row (no playlist link) and return its id + status, so the
/// client can play it via /stream/{id} once the track has a local audio file.
async fn resolve_catalog_track(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<AddTrackBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if body.source.trim().is_empty() || body.source_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing source/source_id").into_response();
    }
    // Before the DB lock: enrichment awaits the network, and the row should be
    // born with full credits (no-op for 'local' and already-known tracks).
    let body = with_full_credits(&state, body).await;
    let conn = state.db.lock().expect("db mutex poisoned");
    // 'local' rows are already library tracks — return the id directly instead
    // of upserting a bogus "local:<id>" duplicate.
    if body.source.trim() == "local" {
        return match lookup_local_track(&conn, &body.source_id) {
            Some(r) => Json(r).into_response(),
            None => (StatusCode::NOT_FOUND, "unknown local track").into_response(),
        };
    }
    let track_id = match upsert_track(&conn, &body) {
        Ok((id, _new)) => id,
        Err(e) => {
            tracing::error!(?e, "resolve_catalog_track: upsert");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let status: String = conn
        .query_row(
            "SELECT status FROM tracks WHERE id = ?1",
            params![track_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "pending".into());
    Json(ResolveTrackResult { track_id, status }).into_response()
}

#[derive(Deserialize)]
struct ResolveTracksBody {
    tracks: Vec<AddTrackBody>,
}

#[derive(Serialize)]
struct ResolveTracksResult {
    /// One entry per input track, SAME ORDER, so the client can zip each
    /// resolved id/status back onto its catalog metadata. Unresolvable rows
    /// (blank source, or an upsert error) come back as `track_id: 0` so the
    /// client can drop them from the queue while keeping positions aligned.
    resolved: Vec<ResolveTrackResult>,
}

/// POST /api/tracks/resolve-batch — upsert a whole list of catalog results into
/// library track rows in one round-trip, so "play from this list" can seed the
/// full queue (and auto-advance down it) instead of resolving one tap at a time.
/// One DB lock for the batch; reuses `upsert_track` (ISRC-deduped, no playlist
/// Re-derive a playlist's cached `track_count` from the rows it actually holds.
///
/// The counter used to be nudged by `+1` / `-1` beside each insert and delete,
/// which is only correct while every one of those writes succeeds — and they
/// were all issued as `let _ = conn.execute(...)`, so a failure was invisible
/// and the nudge went ahead regardless. `playlist_tracks` is keyed on
/// `(playlist_id, position)`, so an insert CAN fail: two writers computing
/// `MAX(position) + 1` from the same starting point collide, one row is
/// rejected, and the count walks one ahead of reality for good. Measured on a
/// real library 18 Aug: 3 playlists of 78 reading exactly one too high.
///
/// Counting is O(rows) rather than O(1), but these are playlists — hundreds of
/// rows, behind a lock already held — and a number that cannot drift is worth
/// more than the microseconds. It also repairs itself: any row already wrong
/// becomes right the next time its playlist is written to.
fn resync_track_count(conn: &rusqlite::Connection, playlist_id: i64) {
    if let Err(e) = conn.execute(
        "UPDATE playlists SET track_count =
            (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?1)
         WHERE id = ?1",
        params![playlist_id],
    ) {
        tracing::warn!(?e, playlist_id, "resync_track_count");
    }
}

/// link) exactly like the single-track resolve.
async fn resolve_catalog_tracks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<ResolveTracksBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Bulk credit enrichment before the lock (order-preserving; no-ops for
    // 'local' entries and tracks the library already knows).
    let tracks = with_full_credits_bulk(&state, body.tracks).await;
    let conn = state.db.lock().expect("db mutex poisoned");
    let mut resolved = Vec::with_capacity(tracks.len());
    for t in &tracks {
        if t.source.trim().is_empty() || t.source_id.trim().is_empty() {
            resolved.push(ResolveTrackResult {
                track_id: 0,
                status: "skipped".into(),
            });
            continue;
        }
        // 'local' rows are already library tracks — never upsert (avoids bogus
        // "local:<id>" duplicates); just echo the existing id + status.
        if t.source.trim() == "local" {
            resolved.push(lookup_local_track(&conn, &t.source_id).unwrap_or(
                ResolveTrackResult {
                    track_id: 0,
                    status: "skipped".into(),
                },
            ));
            continue;
        }
        match upsert_track(&conn, t) {
            Ok((track_id, _new)) => {
                let status: String = conn
                    .query_row(
                        "SELECT status FROM tracks WHERE id = ?1",
                        params![track_id],
                        |r| r.get(0),
                    )
                    .unwrap_or_else(|_| "pending".into());
                resolved.push(ResolveTrackResult { track_id, status });
            }
            Err(e) => {
                tracing::error!(?e, "resolve_catalog_tracks: upsert");
                resolved.push(ResolveTrackResult {
                    track_id: 0,
                    status: "failed".into(),
                });
            }
        }
    }
    Json(ResolveTracksResult { resolved }).into_response()
}

fn upsert_track_and_link(
    conn: &Connection,
    playlist_id: i64,
    track: &CatalogTrackOut,
) -> Result<(i64, bool), rusqlite::Error> {
    // Find-or-refresh-or-insert the track row (ISRC-first dedup, metadata
    // refresh on hit); the bool is "new track row", which we don't need here —
    // this fn's own bool means "new playlist LINK".
    let (track_id, _) = upsert_track(conn, track)?;

    // Append to playlist_tracks unless already linked.
    let already = conn
        .query_row(
            "SELECT 1 FROM playlist_tracks
             WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
            |_| Ok(()),
        )
        .is_ok();
    if already {
        return Ok((track_id, false));
    }
    let next_pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1
             FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO playlist_tracks
             (playlist_id, track_id, position, added_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))",
        params![playlist_id, track_id, next_pos],
    )?;
    resync_track_count(conn, playlist_id);
    Ok((track_id, true))
}

/// Resolve (find-or-create) the "Favorites" playlist for a profile (the home
/// for the star/Favorite toggle). Identified by its stable `spotify_id`
/// (`csv:liked-songs` or a `liked:` prefix), NOT its display name — the name is
/// just what the UI shows ("Favorites"; older installs may still read "Liked
/// Songs" until the rename migration runs). The name fallbacks below only help
/// adopt a pre-existing playlist that predates the stable id.
fn liked_playlist_id(conn: &Connection, profile_id: Option<i64>) -> rusqlite::Result<i64> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM playlists
             WHERE (profile_id IS ?1)
               AND (spotify_id = 'csv:liked-songs'
                    OR spotify_id LIKE 'liked:%'
                    OR lower(name) IN ('favorites', 'liked songs', 'liked_songs'))
             ORDER BY id LIMIT 1",
            params![profile_id],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    let sid = match profile_id {
        Some(p) => format!("liked:{p}"),
        None => "liked:default".to_string(),
    };
    conn.execute(
        "INSERT INTO playlists (spotify_id, name, track_count, profile_id)
         VALUES (?1, 'Favorites', 0, ?2)",
        params![sid, profile_id],
    )?;
    conn.query_row(
        "SELECT id FROM playlists WHERE spotify_id = ?1",
        params![sid],
        |r| r.get(0),
    )
}

#[derive(Deserialize)]
struct LikeBody {
    liked: bool,
    profile_id: Option<i64>,
}

/// POST /api/tracks/:id/acquire — ask the hub to make this track playable.
///
/// The phone could already copy a file the hub HAS; it had no way to ask for
/// one it hasn't. That left the "on neither" tracks with no action anywhere in
/// the phone UI — the row showed a blank badge and the menu offered nothing,
/// so the only way to get them was to walk to the Mac.
///
/// Fire-and-forget by design: acquiring can take a minute (match, fetch,
/// convert), which is far too long to hold a phone's HTTP request open through
/// a tunnel. Returns 202 immediately; the caller watches `has_audio` on
/// `/api/tracks/:id` to know when it lands.
///
/// The open build's provider returns `Unavailable` for `Auto`, so this answers
/// 501 there rather than pretending — the core names no acquisition source.
async fn acquire_track_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Must exist, and must not already have audio — re-acquiring a track we
    // already hold would be a silent no-op the caller can't distinguish.
    let already: Option<bool> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT (local_path IS NOT NULL AND local_path != '') FROM tracks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok()
    };
    match already {
        None => return (StatusCode::NOT_FOUND, "no such track").into_response(),
        Some(true) => {
            return Json(serde_json::json!({ "status": "already" })).into_response();
        }
        Some(false) => {}
    }
    if !crate::acquisition::active_provider().auto_acquires() {
        return (
            StatusCode::NOT_IMPLEMENTED,
            "this build can't fetch audio on its own",
        )
            .into_response();
    }
    let app = state.app.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn(async move {
        match crate::acquisition::active_provider()
            .acquire(&app, &db, id, crate::acquisition::AcquireSource::Auto)
            .await
        {
            Ok(_) => tracing::info!(track_id = id, "acquire: requested from a phone — done"),
            Err(e) => tracing::warn!(track_id = id, error = %e, "acquire: requested from a phone — failed"),
        }
    });
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "status": "started" })),
    )
        .into_response()
}

/// POST /api/tracks/:id/like — add/remove a (library) track to the profile's
/// Liked Songs playlist. Idempotent.
async fn like_track(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
    Json(body): Json<LikeBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // A paired device can only like into its OWN profile's Favorites, never
    // another's by passing `profile_id`; loopback (desktop) is unchanged.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, body.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let exists = conn
        .query_row("SELECT 1 FROM tracks WHERE id = ?1", params![id], |_| Ok(()))
        .is_ok();
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }
    let pid = match liked_playlist_id(&conn, scoped_pid) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(?e, "liked_playlist_id");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let already = conn
        .query_row(
            "SELECT 1 FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![pid, id],
            |_| Ok(()),
        )
        .is_ok();
    if body.liked && !already {
        let next_pos: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
                params![pid],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let _ = conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))",
            params![pid, id, next_pos],
        );
        resync_track_count(&conn, pid);
    } else if !body.liked && already {
        let _ = conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![pid, id],
        );
        resync_track_count(&conn, pid);
    }
    Json(serde_json::json!({ "liked": body.liked })).into_response()
}

#[derive(Deserialize)]
struct LikedQuery {
    t: Option<String>,
    profile_id: Option<i64>,
}

/// GET /api/tracks/liked — the set of track ids in the profile's Liked Songs
/// playlist, so the client can render filled hearts.
async fn liked_tracks(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<LikedQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    // Paired devices see only their own Favorites, not another profile's.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let pid = match liked_playlist_id(&conn, scoped_pid) {
        Ok(p) => p,
        Err(_) => {
            return Json(serde_json::json!({ "ids": Vec::<i64>::new() })).into_response();
        }
    };
    let ids: Vec<i64> = conn
        .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1")
        .and_then(|mut stmt| {
            stmt.query_map(params![pid], |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    Json(serde_json::json!({ "ids": ids })).into_response()
}

/// GET /api/tracks/{id}/playlists — the playlist ids a LOCAL track currently
/// belongs to (scoped to the active profile), so the now-playing "Add to
/// playlist" picker can pre-check the right rows (including Liked Songs).
async fn get_track_playlists(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<LikedQuery>,
    Path(track_id): Path<i64>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    // Membership is scoped to the caller's own profile (paired) / the requested
    // one (loopback), never widened by a crafted `profile_id`.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let ids: Vec<i64> = conn
        .prepare(
            // Album rows are excluded — a saved album isn't a playlist, so the
            // "add to playlist" picker must not pre-check it (it isn't listed
            // there either) nor count it toward the per-song ✓.
            "SELECT DISTINCT pt.playlist_id FROM playlist_tracks pt
             JOIN playlists p ON p.id = pt.playlist_id
             WHERE pt.track_id = ?1 AND (p.profile_id IS ?2)
               AND p.spotify_id NOT LIKE 'album:%'",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![track_id, scoped_pid], |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    Json(serde_json::json!({ "in_playlist_ids": ids })).into_response()
}

#[derive(Deserialize)]
struct PlayBody {
    track_id: i64,
    profile_id: Option<i64>,
}

/// POST /api/plays — record one listen (fired by the player once a track has
/// been played past a small threshold). Feeds the stats screen.
async fn log_play(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<PlayBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // A play is logged to the caller's OWN profile history, so a paired device
    // can't inflate/poison another profile's stats via `profile_id`.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, body.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let _ = conn.execute(
        "INSERT INTO play_events (track_id, profile_id) VALUES (?1, ?2)",
        params![body.track_id, scoped_pid],
    );
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct FinishBody {
    track_id: i64,
    profile_id: Option<i64>,
    ms_played: i64,
    completed: bool,
}

/// POST /api/plays/finish — record HOW MUCH of the most-recent logged play of
/// this track was heard (and whether it finished), by updating that row. A no-op
/// when the play never crossed the ~20s log threshold (no row exists). Powers
/// completion-weighted recommendations later (Phase 0 / Signal 4). `profile_id IS
/// ?4` is SQLite's null-safe match, so it works for the no-profile case too.
async fn finish_play(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(body): Json<FinishBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Same-profile scoping as log_play — a paired device can only update its
    // own history rows.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, body.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let _ = conn.execute(
        "UPDATE play_events SET ms_played = ?1, completed = ?2
         WHERE id = (
             SELECT id FROM play_events
             WHERE track_id = ?3 AND profile_id IS ?4
             ORDER BY played_at DESC, id DESC LIMIT 1
         )",
        params![
            body.ms_played,
            body.completed as i64,
            body.track_id,
            scoped_pid
        ],
    );
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct StatsQuery {
    t: Option<String>,
    profile_id: Option<i64>,
    /// Only count plays at/after this epoch-seconds. 0 = all time.
    since: Option<i64>,
}

#[derive(Serialize, Clone)]
struct StatTrack {
    track_id: i64,
    title: String,
    artists: Vec<String>,
    album: Option<String>,
    album_art_url: Option<String>,
    duration_ms: i64,
    /// Whether a local audio file exists for this track. Drives the player:
    /// a track with a file plays via /stream/{id}; one without is shown but
    /// not playable. Without this the client would assume every history track
    /// has a file and fail with "no supported sources".
    has_audio: bool,
    count: i64,
}

#[derive(Serialize)]
struct StatArtist {
    name: String,
    count: i64,
}

/// The Stats screen's "Top songs": your most-played tracks within the `since`
/// window, **skips excluded** (ranked and counted by [`REAL_PLAY`], so a song
/// you kept skipping past can't outrank one you actually finished). Extracted
/// from `get_stats` so it's unit-testable against a seeded DB.
fn stat_top_tracks(conn: &Connection, pid: Option<i64>, since: i64, limit: i64) -> Vec<StatTrack> {
    conn.prepare(&format!(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms,
                (t.local_path IS NOT NULL AND t.local_path <> '') AS has_audio, SUM({REAL_PLAY}) c
         FROM play_events pe JOIN tracks t ON t.id = pe.track_id
         WHERE (pe.profile_id IS ?1) AND pe.played_at >= ?2
         GROUP BY t.id HAVING c > 0 ORDER BY c DESC, MAX(pe.played_at) DESC LIMIT ?3"
    ))
    .and_then(|mut stmt| {
        stmt.query_map(params![pid, since, limit], |r| {
            let artists_json: String = r.get(2)?;
            Ok(StatTrack {
                track_id: r.get(0)?,
                title: r.get(1)?,
                artists: serde_json::from_str(&artists_json).unwrap_or_default(),
                album: r.get(3)?,
                album_art_url: r.get(4)?,
                duration_ms: r.get(5)?,
                has_audio: r.get(6)?,
                count: r.get(7)?,
            })
        })
        .map(|rows| rows.filter_map(|x| x.ok()).collect())
    })
    .unwrap_or_default()
}

/// GET /api/stats — listening totals + top tracks/artists for a profile over
/// an optional time window. All computed locally from play_events.
async fn get_stats(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<StatsQuery>,
) -> Response {
    let tq = TokenQuery { t: q.t.clone() };
    if let Err(r) = require_token(&state, &headers, &tq) {
        return r;
    }
    // Stats read only the caller's OWN profile — a paired device can't read
    // another profile's listening history by passing `profile_id`.
    let pid = match scoped_profile_id(&state, &headers, &addr, &tq, q.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let since = q.since.unwrap_or(0);
    let conn = state.db.lock().expect("db mutex poisoned");

    // Skips don't count anywhere on this screen: a play (and the minutes it
    // adds) only lands if it wasn't skipped — the same discount Home applies.
    let (total_plays, total_ms): (i64, i64) = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM({REAL_PLAY}), 0),
                        COALESCE(SUM({REAL_PLAY} * t.duration_ms), 0)
                 FROM play_events pe JOIN tracks t ON t.id = pe.track_id
                 WHERE (pe.profile_id IS ?1) AND pe.played_at >= ?2"
            ),
            params![pid, since],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    let unique_artists: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(DISTINCT je.value)
                 FROM play_events pe JOIN tracks t ON t.id = pe.track_id, json_each(t.artists) je
                 WHERE (pe.profile_id IS ?1) AND pe.played_at >= ?2 AND {REAL_PLAY} = 1"
            ),
            params![pid, since],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let top_tracks = stat_top_tracks(&conn, pid, since, 25);

    let top_artists: Vec<StatArtist> = conn
        .prepare(
            &format!(
            "SELECT je.value AS artist, SUM({REAL_PLAY}) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id, json_each(t.artists) je
             WHERE (pe.profile_id IS ?1) AND pe.played_at >= ?2
             GROUP BY je.value HAVING c > 0 ORDER BY c DESC, artist ASC LIMIT 25"
            ),
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![pid, since], |r| {
                Ok(StatArtist {
                    name: r.get(0)?,
                    count: r.get(1)?,
                })
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();

    // Home shelves: Recents (recently played), Top Songs (all-time top), and
    // "From your past" (rediscover — played a lot before, not lately). All
    // profile-scoped play_events windows, independent of the `since` filter.
    let track_query = |sql: &str| -> Vec<StatTrack> {
        conn.prepare(sql)
            .and_then(|mut stmt| {
                stmt.query_map(params![pid], |r| {
                    let aj: String = r.get(2)?;
                    Ok(StatTrack {
                        track_id: r.get(0)?,
                        title: r.get(1)?,
                        artists: serde_json::from_str(&aj).unwrap_or_default(),
                        album: r.get(3)?,
                        album_art_url: r.get(4)?,
                        duration_ms: r.get(5)?,
                        has_audio: r.get(6)?,
                        count: r.get(7)?,
                    })
                })
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
            })
            .unwrap_or_default()
    };
    let ha = "(t.local_path IS NOT NULL AND t.local_path <> '') AS has_audio";
    let recent_tracks = track_query(&format!(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms, {ha}, COUNT(*) c
         FROM play_events pe JOIN tracks t ON t.id = pe.track_id
         WHERE (pe.profile_id IS ?1)
         GROUP BY t.id ORDER BY MAX(pe.played_at) DESC LIMIT 16"
    ));
    let top_all_time = track_query(&format!(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms, {ha}, COUNT(*) c
         FROM play_events pe JOIN tracks t ON t.id = pe.track_id
         WHERE (pe.profile_id IS ?1)
         GROUP BY t.id ORDER BY c DESC, MAX(pe.played_at) DESC LIMIT 16"
    ));
    // "From your past": >= 2 plays older than 45 days, 0 plays in the last 45.
    let rediscover = track_query(&format!(
        "SELECT t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms, {ha},
                SUM(CASE WHEN pe.played_at <  strftime('%s','now') - 45*86400 THEN 1 ELSE 0 END) c
         FROM play_events pe JOIN tracks t ON t.id = pe.track_id
         WHERE (pe.profile_id IS ?1)
         GROUP BY t.id
         HAVING c >= 2
            AND SUM(CASE WHEN pe.played_at >= strftime('%s','now') - 45*86400 THEN 1 ELSE 0 END) = 0
         ORDER BY c DESC LIMIT 16"
    ));

    Json(serde_json::json!({
        "total_plays": total_plays,
        "total_minutes": (total_ms as f64 / 60000.0).round() as i64,
        "unique_artists": unique_artists,
        "top_tracks": top_tracks,
        "top_artists": top_artists,
        "recent_tracks": recent_tracks,
        "top_all_time": top_all_time,
        "rediscover": rediscover,
    }))
    .into_response()
}

// ---- Home feed (/api/home) -------------------------------------------------
//
// Spotify-style personalized Home. v1 ships ONE computed shelf, "More like your
// favorites": your most-played artists -> ListenBrainz community-similarity graph
// -> Deezer deeper-cut tracks -> playable. All keyless (MusicBrainz +
// ListenBrainz labs + Deezer). The response is a list of TYPED shelves so future
// shelves are a data-only addition the client renders with existing components.

/// How the per-visit selection pass (N1) treats a cached shelf's item list.
/// `Ranked` shelves pass through exactly as built — their order IS information
/// (newest-first radar, your ranked top artists). `Rotate` shelves are built as
/// an OVERSIZED pool; each visit keeps the top `anchors` (quality floor) and
/// fills to `display` with a visit-seeded shuffle of the remainder, so two
/// visits on the same day show different-but-on-theme slices of one pool
/// without any extra catalog calls.
#[derive(Clone, Copy, PartialEq)]
enum SelectPolicy {
    Ranked,
    Rotate { anchors: usize, display: usize },
}

/// The "why you're seeing this" class of a discovery shelf (N5). The builders
/// produce more shelves than a page should show; `arrange_shelves` selects a
/// bounded, intent-balanced, per-visit-rotated subset so the shelf LINEUP itself
/// varies — not just each shelf's contents. Default `Familiar` for any shelf a
/// builder doesn't explicitly tag (lead/trail shelves never reach arrange).
#[derive(Clone, Copy, PartialEq, Debug)]
enum ShelfIntent {
    /// Close to your established taste (your Mix, more-like-favorites/-artist).
    Familiar,
    /// Newly released / just-dropped (Release Radar, new releases).
    Fresh,
    /// Deliberately off your core (under-the-radar, tag/mood, new-for-you).
    Discover,
    /// Human-curated (editorial playlists).
    Editorial,
}

/// One card in a heterogeneous `mixed_row` shelf. Wrapper-tagged so serde emits
/// e.g. `{"type":"artist","artist":{…}}` — a shape the client maps straight onto
/// its existing artist / album / playlist cards. Reuses the homogeneous output
/// structs verbatim (all already `Serialize + Clone`).
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum MixedItem {
    Artist { artist: SearchArtistOut },
    Album { album: SearchAlbumOut },
    Playlist { playlist: PlaylistOut },
}

#[derive(Serialize, Clone)]
struct HomeShelf {
    /// Render hint for the client. One of:
    /// - "track_row"    -> `tracks` (external catalog tracks, play via catalog)
    /// - "album_row"    -> `albums` (catalog albums, tap opens the album)
    /// - "stat_row"     -> `stat_tracks` (LOCAL library tracks, play locally)
    /// - "artist_row"   -> `artists` (resolved catalog artists, tap opens artist)
    /// - "playlist_row" -> `playlists` (catalog editorial playlists, tap opens)
    /// - "mixed_row"    -> `items` (ordered heterogeneous artist/album/playlist)
    kind: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    eyebrow: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tracks: Vec<CatalogTrackOut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    albums: Vec<SearchAlbumOut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    stat_tracks: Vec<StatTrack>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    artists: Vec<SearchArtistOut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    playlists: Vec<PlaylistOut>,
    /// "mixed_row" payload — an ordered, heterogeneous list of artist/album/
    /// playlist cards (Spotify's "More like {X}" blend). Empty (omitted) for every
    /// other kind, so an older bundled client never sees an unexpected field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    items: Vec<MixedItem>,
    /// Optional round thumbnail for the shelf HEADER (the seed artist's photo on a
    /// "More like {X}" mixed row, matching Spotify). Omitted for normal shelves.
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_art: Option<String>,
    /// Client display hint. `Some("rail")` → render as a "Made for you" portrait
    /// tile in the rail instead of a shelf row (the mixes); `Some("spotlight")` →
    /// render as the mid-feed full-width band. Omitted for normal rows — so an
    /// older bundled client just ignores it and renders every shelf as a row.
    #[serde(skip_serializing_if = "Option::is_none")]
    display: Option<&'static str>,
    /// Refresh-cadence caption for a rail (mix/tile) shelf, e.g. "New every
    /// Monday". Omitted → the client's default ("New every day"). Serialized.
    #[serde(skip_serializing_if = "Option::is_none")]
    cadence: Option<&'static str>,
    /// Per-visit selection policy (N1). Server-side only — never serialized.
    #[serde(skip)]
    select: SelectPolicy,
    /// Marks a recommendation surface: its served items are logged to
    /// `home_impressions` (N0) so selection can later fade ignored picks (N3).
    /// False for identity/history shelves (their job IS to echo). Server-side
    /// only — never serialized.
    #[serde(skip)]
    discovery: bool,
    /// Intent lane for per-visit lineup selection (N5). Set by the builders (via
    /// `build_external_shelves`); defaults to `Familiar`. Server-side only.
    #[serde(skip)]
    intent: ShelfIntent,
    /// Release-day priority: 0 = not a release shelf; higher = preferred lead.
    /// On Fridays `arrange_shelves` promotes the highest-ranked one to the top.
    /// Server-side only.
    #[serde(skip)]
    release_rank: u8,
}

impl HomeShelf {
    fn track_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        tracks: Vec<CatalogTrackOut>,
    ) -> Self {
        Self {
            kind: "track_row".into(),
            title: title.into(),
            eyebrow,
            tracks,
            albums: vec![],
            stat_tracks: vec![],
            artists: vec![],
            playlists: vec![],
            items: vec![],
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    fn album_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        albums: Vec<SearchAlbumOut>,
    ) -> Self {
        Self {
            kind: "album_row".into(),
            title: title.into(),
            eyebrow,
            tracks: vec![],
            albums,
            stat_tracks: vec![],
            artists: vec![],
            playlists: vec![],
            items: vec![],
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    fn stat_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        stat_tracks: Vec<StatTrack>,
    ) -> Self {
        Self {
            kind: "stat_row".into(),
            title: title.into(),
            eyebrow,
            tracks: vec![],
            albums: vec![],
            stat_tracks,
            artists: vec![],
            playlists: vec![],
            items: vec![],
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    fn artist_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        artists: Vec<SearchArtistOut>,
    ) -> Self {
        Self {
            kind: "artist_row".into(),
            title: title.into(),
            eyebrow,
            tracks: vec![],
            albums: vec![],
            stat_tracks: vec![],
            artists,
            playlists: vec![],
            items: vec![],
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    fn playlist_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        playlists: Vec<PlaylistOut>,
    ) -> Self {
        Self {
            kind: "playlist_row".into(),
            title: title.into(),
            eyebrow,
            tracks: vec![],
            albums: vec![],
            stat_tracks: vec![],
            artists: vec![],
            playlists,
            items: vec![],
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    /// A heterogeneous row (Spotify's "More like {X}"): an ordered blend of
    /// artist / album / playlist cards carried in `items` rather than one of the
    /// homogeneous vecs. `Ranked` (no per-visit rotation) — the builder already
    /// picks the interleave; the daily seed rotates the whole row's seed artist.
    fn mixed_row(
        title: impl Into<String>,
        eyebrow: Option<String>,
        items: Vec<MixedItem>,
    ) -> Self {
        Self {
            kind: "mixed_row".into(),
            title: title.into(),
            eyebrow,
            tracks: vec![],
            albums: vec![],
            stat_tracks: vec![],
            artists: vec![],
            playlists: vec![],
            items,
            seed_art: None,
            display: None,
            cadence: None,
            select: SelectPolicy::Ranked,
            discovery: false,
            intent: ShelfIntent::Familiar,
            release_rank: 0,
        }
    }

    /// Opt this shelf into per-visit rotation (N1): the builder supplies an
    /// oversized pool; each visit shows the top `anchors` plus a visit-seeded
    /// draw from the rest, `display` items total.
    fn rotating(mut self, anchors: usize, display: usize) -> Self {
        self.select = SelectPolicy::Rotate { anchors, display };
        self
    }

    /// Mark this shelf as a recommendation surface whose served items are
    /// logged to `home_impressions` (N0).
    fn discovery(mut self) -> Self {
        self.discovery = true;
        self
    }

    /// Mark this shelf as a "Made for you" rail tile (the mixes). `arrange_shelves`
    /// pulls rail shelves out of the lane/budget rotation so the tile is stable,
    /// and the client renders it as a portrait tile instead of a row.
    fn rail(mut self) -> Self {
        self.display = Some("rail");
        self
    }

    /// Set the rail tile's refresh-cadence caption (e.g. "New every Monday").
    fn cadence(mut self, c: &'static str) -> Self {
        self.cadence = Some(c);
        self
    }

    /// Attach a round header thumbnail (the seed artist's photo on a mixed
    /// "More like {X}" row).
    fn seed_art(mut self, url: Option<String>) -> Self {
        self.seed_art = url;
        self
    }
}

/// Serve-history fatigue (N3). Maps a discovery item's kind-scoped key → how
/// many PRIOR calendar days the feed already showed it, so selection can demote
/// things you've seen a lot. Loaded once per serve from `home_impressions`;
/// empty on a fresh library (or before N0 logged anything), in which case
/// selection degrades exactly to N1's pure per-visit rotation.
#[derive(Default)]
struct FatigueMap(std::collections::HashMap<String, i64>);

impl FatigueMap {
    /// Coarse demotion tier for a `fatigue_key`: 0 = fresh enough to anchor,
    /// 1 = getting stale, 2 = shown a week-plus of days (last-resort backfill).
    /// Coarse on purpose — within a tier the visit-seeded shuffle still rotates,
    /// so ranking isn't flattened into a brittle strict most-unseen-first order.
    fn tier(&self, key: &str) -> u8 {
        match self.0.get(key).copied().unwrap_or(0) {
            0..=2 => 0,
            3..=6 => 1,
            _ => 2,
        }
    }
}

/// Kind-scoped impression key (the item id spaces overlap across kinds — a
/// track and a playlist can share `deezer:123` — so scope by kind).
fn fatigue_key(kind: &str, key: &str) -> String {
    let mut s = String::with_capacity(kind.len() + 1 + key.len());
    s.push_str(kind);
    s.push('\u{1f}');
    s.push_str(key);
    s
}

/// Load per-item PRIOR-day serve counts for fatigue demotion (N3). Counts only
/// rows last shown BEFORE `today`, so today's own logging can't shift the
/// discount between two serves in the same session — a visit stays stable even
/// as impressions accrue. Best-effort: a read hiccup yields an empty map (→ N1).
fn load_fatigue(conn: &Connection, pid: Option<i64>, today: &str) -> FatigueMap {
    let mut map = std::collections::HashMap::new();
    let res: rusqlite::Result<()> = (|| {
        let mut stmt = conn.prepare_cached(
            "SELECT item_kind, item_key, shown_days FROM home_impressions
             WHERE profile_id = ?1 AND last_shown < ?2",
        )?;
        let rows = stmt.query_map(params![pid.unwrap_or(0), today], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows.flatten() {
            map.insert(fatigue_key(&row.0, &row.1), row.2);
        }
        Ok(())
    })();
    if let Err(e) = res {
        tracing::warn!(?e, "home fatigue: load failed");
    }
    FatigueMap(map)
}

/// Per-visit selection (N1 rotation + N3 fatigue + N4 exploration). Reorders a
/// `Rotate`-policied shelf's oversized pool so the visible slice for THIS visit
/// leads: fatigue-sort so the freshest, least-shown items anchor, seed-shuffle
/// the fill, and reserve a controlled fraction of the fill for exploration picks
/// from the pool's novel tail (see `pick`). The FULL reordered pool is kept (NOT
/// trimmed to `display`) so cross-shelf de-dup in `curate_home_shelves` can
/// backfill from the prioritized tail before it trims each shelf to `display`.
/// Seeded per (visit, shelf title) so siblings permute independently and a visit
/// is stable across re-renders. `Ranked` shelves pass through untouched.
fn select_shelf_items(shelf: &mut HomeShelf, visit_seed: u64, fatigue: &FatigueMap) {
    let SelectPolicy::Rotate { anchors, display } = shelf.select else {
        return;
    };
    let seed = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        visit_seed.hash(&mut h);
        shelf.title.hash(&mut h);
        h.finish()
    };
    pick(&mut shelf.tracks, anchors, display, seed, fatigue, |t| {
        fatigue_key("track", &format!("{}:{}", t.source, t.source_id))
    });
    pick(&mut shelf.albums, anchors, display, seed, fatigue, |a| {
        fatigue_key("album", &format!("{}:{}", a.source, a.source_id))
    });
    pick(&mut shelf.artists, anchors, display, seed, fatigue, |a| {
        fatigue_key("artist", &norm_artist(&a.name))
    });
    pick(&mut shelf.playlists, anchors, display, seed, fatigue, |p| {
        fatigue_key("playlist", &format!("{}:{}", p.source, p.source_id))
    });
    // stat_tracks are never Rotate-policied: stat shelves are rebuilt fresh per
    // request and already size themselves with the visit seed internally.
}

/// Fraction of a shelf's FILL slots (the visible slots after the anchors)
/// reserved for exploration (N4). ~1 in 5 — a modest, "safe" epsilon: enough
/// that every discovery shelf carries some genuine novelty, small enough that
/// the shelf still leads with strong matches.
const EXPLORE_FRACTION: f64 = 0.2;

/// SplitMix64 finalizer — a cheap deterministic scramble of one u64, used to
/// order exploration candidates by the visit seed.
fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// Reorder one item list for `select_shelf_items` (see its doc), then reserve a
/// controlled fraction of the fill for exploration (N4). No-op for a pool
/// at/under `display` (everything shows anyway — matches N1's small-pool skip).
///
/// N4 safe exploration: pure per-visit rotation (N1) + fatigue demotion (N3)
/// still only ever draw from the top of each candidate pool — the safest, most
/// on-taste matches. Genuine discovery lives in the pool's NOVEL TAIL (items the
/// builder ranked beyond `display`: less-corroborated, less-popular, more
/// surprising), which a straight top-`display` cut would never surface. This
/// guarantees `EXPLORE_FRACTION` of the fill slots come from that tail — an
/// epsilon-greedy floor of exploration in every shelf — while keeping it "safe":
/// exploration picks are fatigue-aware (fresh tail preferred) and ride at the
/// END of the visible slice, so anchors + strong fill still lead. Deterministic
/// per (visit, shelf) like the rest of selection. The full pool is preserved
/// (curate trims to `display`), so exploitation items pushed past the visible
/// slice remain as backfill.
fn pick<T>(
    items: &mut Vec<T>,
    anchors: usize,
    display: usize,
    seed: u64,
    fatigue: &FatigueMap,
    key_of: impl Fn(&T) -> String,
) {
    let n = items.len();
    if items.is_empty() || n <= display {
        return;
    }
    // Tag each item with (original rank, fatigue tier). Original rank identifies
    // the novel tail (rank >= display) that exploitation alone would bury.
    let rows: Vec<(usize, u8, T)> = std::mem::take(items)
        .into_iter()
        .enumerate()
        .map(|(rank, it)| {
            let tier = fatigue.tier(&key_of(&it));
            (rank, tier, it)
        })
        .collect();

    let fill = display.saturating_sub(anchors);
    let want_explore = ((fill as f64) * EXPLORE_FRACTION).round() as usize;

    // Choose exploration picks from the novel tail: freshest first, then
    // visit-seed rotated, capped at `want_explore` (and at what the tail holds).
    let mut explore_idx: Vec<usize> = (0..n).filter(|&i| rows[i].0 >= display).collect();
    explore_idx.sort_by_key(|&i| (rows[i].1, mix64(seed ^ rows[i].0 as u64)));
    explore_idx.truncate(want_explore);
    let is_explore: std::collections::HashSet<usize> =
        explore_idx.iter().copied().collect();

    // Split into exploration rows (in chosen priority order) and the rest, which
    // gets the N3 exploitation ordering (tier stable-sort → anchors → tiered
    // shuffle). `rows` is still rank-ordered here, so draining preserves it.
    let mut explore_rows: Vec<(usize, u8, T)> = Vec::with_capacity(explore_idx.len());
    let mut exploit_rows: Vec<(usize, u8, T)> = Vec::with_capacity(n - explore_idx.len());
    for (i, row) in rows.into_iter().enumerate() {
        if is_explore.contains(&i) {
            explore_rows.push(row);
        } else {
            exploit_rows.push(row);
        }
    }
    // Order the exploration picks by the same key used to choose them.
    explore_rows.sort_by_key(|(rank, tier, _)| (*tier, mix64(seed ^ *rank as u64)));

    // Exploitation: stable tier-sort (rank order preserved within a tier), take
    // anchors, tiered-shuffle the remainder.
    exploit_rows.sort_by_key(|(_, tier, _)| *tier);
    let rest = exploit_rows.split_off(anchors.min(exploit_rows.len()));
    let anchors_vec: Vec<T> = exploit_rows.into_iter().map(|(_, _, it)| it).collect();
    let fill_vec: Vec<T> = tiered_shuffle(rest.into_iter().map(|(_, t, it)| (t, it)).collect(), seed);
    let explore_vec: Vec<T> = explore_rows.into_iter().map(|(_, _, it)| it).collect();

    // Compose: anchors, then exploitation fill up to the reserved exploration
    // count, then the exploration picks (tail of the visible slice), then the
    // leftover exploitation items as backfill for curate.
    let e_actual = explore_vec.len();
    let exploit_visible = fill.saturating_sub(e_actual);
    let mut ordered: Vec<T> = Vec::with_capacity(n);
    ordered.extend(anchors_vec);
    let mut fill_iter = fill_vec.into_iter();
    for _ in 0..exploit_visible {
        if let Some(x) = fill_iter.next() {
            ordered.push(x);
        }
    }
    ordered.extend(explore_vec);
    ordered.extend(fill_iter);
    *items = ordered;
}

/// Shuffle a tier-sorted `rest` within each tier and concatenate the shuffled
/// tiers in order, so a fresher tier's items always precede a staler tier's in
/// the backfill. Each tier gets a salted seed so tiers don't permute in
/// lock-step. Keeps the full list — the caller/curate trims to `display`.
fn tiered_shuffle<T>(rest: Vec<(u8, T)>, seed: u64) -> Vec<T> {
    let mut out: Vec<T> = Vec::with_capacity(rest.len());
    let mut iter = rest.into_iter().peekable();
    while let Some(&(tier, _)) = iter.peek() {
        let mut group: Vec<T> = Vec::new();
        while iter.peek().map(|(t, _)| *t) == Some(tier) {
            group.push(iter.next().unwrap().1);
        }
        let salt = seed ^ (tier as u64 + 1).wrapping_mul(0x9E3779B97F4A7C15);
        let k = group.len();
        out.extend(seeded_shuffle_take(group, salt, k));
    }
    out
}

/// The visible-item cap a shelf's policy imposes: `Rotate` trims to `display`;
/// `Ranked` keeps its full (already-sized) list.
fn rotate_cap(select: &SelectPolicy) -> usize {
    match select {
        SelectPolicy::Rotate { display, .. } => *display,
        SelectPolicy::Ranked => usize::MAX,
    }
}

/// N5 shelf-lineup selection: the builders assemble MORE discovery shelves than
/// a page should show (up to ~12: four Familiar + two Fresh + three Discover +
/// several Editorial). Showing all of them, in a fixed order, every visit is the
/// static-skeleton problem. This picks a bounded, intent-balanced subset and
/// interleaves it, rotating BOTH which shelves appear and their order by the
/// visit seed — so the lineup itself changes visit to visit. Free: the
/// candidates are already built and cached; this is pure reordering/trimming.
///
/// Guarantees intent variety (no lane can monopolize the page), a rotating lead
/// lane, and a page budget. Degrades to a plain interleave when there are few
/// candidates (nothing is hidden until there's genuine excess).
fn arrange_shelves(external: Vec<HomeShelf>, seed: u64, weekday: chrono::Weekday) -> Vec<HomeShelf> {
    const LANES: [ShelfIntent; 4] = [
        ShelfIntent::Familiar,
        ShelfIntent::Fresh,
        ShelfIntent::Discover,
        ShelfIntent::Editorial,
    ];
    /// At most this many shelves per intent lane (so one lane can't dominate).
    const PER_INTENT_MAX: usize = 2;
    /// Page budget: at most this many discovery shelves in the lineup.
    const TOTAL_MAX: usize = 7;

    // Rail shelves (the mixes) are a SEPARATE visual surface, so pull them out of
    // the lane rotation + page budget — otherwise the artist-mix tile would blink
    // in and out of the rail visit-to-visit and eat a row slot. They re-join at
    // the end (the client renders them as tiles, not rows).
    let (rail, mut external): (Vec<HomeShelf>, Vec<HomeShelf>) =
        external.into_iter().partition(|s| s.display == Some("rail"));

    // Friday release-day lead: on Fridays, promote the best release shelf to the
    // very top and retitle it, so the page opens on new music (like Spotify's
    // "New Music Friday"). Pulled out of its lane so it isn't double-served;
    // still counts toward the page budget. It's an album_row → renders as a
    // normal first row (the client hero arm is stat/track-row only).
    let friday_lead: Option<HomeShelf> = if weekday == chrono::Weekday::Fri {
        external
            .iter()
            .enumerate()
            .filter(|(_, s)| s.release_rank > 0)
            .max_by_key(|(_, s)| s.release_rank)
            .map(|(i, _)| i)
            .map(|i| {
                let mut s = external.remove(i);
                s.title = "New this Friday".into();
                s.eyebrow = Some("It's release day".into());
                s
            })
    } else {
        None
    };
    // Guarantee Release Radar a slot on non-Fridays too (Fridays already promote
    // it as the lead). Pull it out of the lane rotation so a busy per-visit
    // rotation can never push it off the page when it has content; it keeps its
    // "Release Radar" title and is dropped a couple of rows in below.
    let radar_lead: Option<HomeShelf> = if friday_lead.is_some() {
        None
    } else {
        external
            .iter()
            // release_rank 3 is Release Radar's rank (see build_external_shelves;
            // new-for-you is 2, global new-releases is 1).
            .position(|s| s.release_rank == 3)
            .map(|i| external.remove(i))
    };
    let budget = TOTAL_MAX
        - usize::from(friday_lead.is_some())
        - usize::from(radar_lead.is_some());

    // Bucket by intent (preserving builder order — already quality/fatigue
    // ranked). Anything outside the known lanes passes through untouched.
    let mut lanes: Vec<Vec<HomeShelf>> = LANES.iter().map(|_| Vec::new()).collect();
    let mut misc: Vec<HomeShelf> = Vec::new();
    for s in external {
        match LANES.iter().position(|l| *l == s.intent) {
            Some(i) => lanes[i].push(s),
            None => misc.push(s),
        }
    }

    // Rotate WITHIN each lane (which candidates lead rotates by the seed), then
    // cap the lane. A salted seed per lane keeps lanes from permuting together.
    let mut queues: Vec<std::collections::VecDeque<HomeShelf>> = lanes
        .into_iter()
        .enumerate()
        .map(|(i, lane)| {
            let salt = seed ^ (i as u64 + 1).wrapping_mul(0x9E3779B97F4A7C15);
            let n = lane.len();
            let mut rot = seeded_shuffle_take(lane, salt, n);
            rot.truncate(PER_INTENT_MAX);
            rot.into_iter().collect()
        })
        .collect();

    // Round-robin across lanes, rotating the START lane by the seed, until the
    // page budget is hit or every lane is drained.
    let start = (seed % LANES.len() as u64) as usize;
    let mut out: Vec<HomeShelf> = Vec::new();
    loop {
        let before = out.len();
        for k in 0..LANES.len() {
            if out.len() >= budget {
                break;
            }
            let idx = (start + k) % LANES.len();
            if let Some(s) = queues[idx].pop_front() {
                out.push(s);
            }
        }
        if out.len() == before || out.len() >= budget {
            break;
        }
    }
    out.extend(misc);
    out.extend(rail);
    // Prepend the Friday lead (after rail so tiles stay last; insert at 0 puts it
    // above the rows). Done before the spotlight pass so indices are final.
    if let Some(lead) = friday_lead {
        out.insert(0, lead);
    }
    // Non-Friday: drop the guaranteed Release Radar a couple of rows in — below
    // the lead personalized shelves, still well above the fold. Also before the
    // spotlight pass so indices stay final.
    if let Some(radar) = radar_lead {
        let pos = out.len().min(2);
        out.insert(pos, radar);
    }

    // Spotlight (mid-feed band): promote exactly ONE eligible discovery track_row
    // per visit, chosen by the visit seed (salted so it doesn't lock-step with the
    // lane rotation). Rail tiles and stat/album/artist rows are ineligible. Curate
    // runs AFTER this and can still drop the marked shelf (min-5 after dedup) → that
    // visit simply has no band. Opportunistic by design.
    let eligible: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, s)| s.discovery && s.kind == "track_row" && s.display.is_none())
        .map(|(i, _)| i)
        .collect();
    if !eligible.is_empty() {
        let pick = eligible[((seed ^ 0x5307_11FE) % eligible.len() as u64) as usize];
        out[pick].display = Some("spotlight");
    }
    out
}

#[derive(Serialize)]
struct HomeOut {
    shelves: Vec<HomeShelf>,
    /// Server-computed 4-bucket greeting ("Good morning" / "Good afternoon" /
    /// "Good evening" / "Late night") on the SERVER's clock. The client renders
    /// this verbatim so the header agrees with the daypart shelf and phone↔Mac
    /// agree on remote access. Omitted (empty) only on older bundled servers, in
    /// which case the client falls back to its own local greeting.
    #[serde(skip_serializing_if = "String::is_empty")]
    greeting: String,
    /// True when a "Welcome back" win-back shelf survived curation for a dormant
    /// profile — the client lights a dot on the Home tab (imp 8). Not a push.
    welcome_back: bool,
    /// Age in seconds of the cached discovery POOL backing this feed — 0 on a
    /// cold (just-built) response, up to HOME_TTL on a warm hit (N6). The client
    /// turns it into an HONEST "Updated …" caption instead of a static label:
    /// the discovery content really is this old, even though the per-visit
    /// arrangement is always fresh. Omitted on older servers (client falls back).
    #[serde(skip_serializing_if = "Option::is_none")]
    discovery_age_secs: Option<u64>,
    /// False when this profile has no play history yet, so the endless stations
    /// have nothing to seed from (`station_seeds` would come back empty and the
    /// station would build zero tracks). The client HIDES the station tiles
    /// rather than offering a button that can only disappoint. Older clients
    /// ignore the field and keep showing the tiles — their pre-existing
    /// behaviour, not a regression.
    station_ready: bool,
    /// False only on a `fast=1` response: this feed is the cheap subset, painted
    /// while the expensive shelves are still resolving. The client shows it
    /// immediately and APPENDS the rest when the full response lands. Absent on
    /// older servers → clients treat the feed as complete, which it is for them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    partial: bool,
}

struct HomeCacheEntry {
    fetched_at: std::time::Instant,
    shelves: Vec<HomeShelf>,
}

/// Recommendations move slowly + the build fans out to ~15-25 keyless API calls,
/// so cache the assembled shelves per profile for a long time.
const HOME_TTL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

// Keyed by (profile, local-date) so the cached discovery ROTATES daily: a new
// day is a fresh key (cache miss → rebuild), while the 6h TTL still throttles
// rebuilds within a day. home_handler prunes other-day entries on insert.
fn home_cache()
-> &'static Mutex<std::collections::HashMap<(Option<i64>, String), HomeCacheEntry>> {
    static C: std::sync::OnceLock<
        Mutex<std::collections::HashMap<(Option<i64>, String), HomeCacheEntry>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// MusicBrainz + ListenBrainz both require a descriptive User-Agent.
const MB_LB_UA: &str = "Beetbot/0.2 ( personal-use music app )";
/// The ListenBrainz Labs similar-artists algorithm enum (session-based,
/// 5-year window). Validated against the live endpoint.
const LB_SIMILAR_ALGO: &str =
    "session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30";

/// Lowercase + fold common Latin diacritics so "André"/"Beyoncé"/"JAŸ-Z" match
/// the library's plain-name storage; collapse whitespace. Truncates at the
/// first ';' (primary artist) — mirrors `tags::artist_key` so legacy
/// "Aminé;Leon Thomas" rows match bans/tags/seeds for "Aminé".
fn norm_artist(s: &str) -> String {
    let s = s.split(';').next().unwrap_or(s);
    let mut out = String::with_capacity(s.len());
    for ch in s.trim().chars() {
        let m = match ch {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ý' | 'ÿ' | 'Ý' | 'Ÿ' => 'y',
            'ñ' | 'Ñ' => 'n',
            'ç' | 'Ç' => 'c',
            other => other.to_ascii_lowercase(),
        };
        out.push(m);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Resolve an artist NAME to a MusicBrainz artist MBID, cached FOREVER in the
/// settings table (`mbid:<norm name>`; an artist's MBID never changes). Returns
/// None and caches the miss too. MusicBrainz is ~1 req/s — the caller sleeps
/// between cache MISSES only, so steady-state (everything cached) is instant.
async fn resolve_artist_mbid(state: &AppState, name: &str) -> (Option<String>, bool) {
    let key = format!("mbid:{}", norm_artist(name));
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Ok(Some(v)) = crate::settings::get_setting(&conn, &key) {
            return (if v.is_empty() { None } else { Some(v) }, true); // (mbid, was_cached)
        }
    }
    let query = format!("artist:\"{}\"", name);
    // Cap concurrent MB lookups (a cache hit above already returned without a
    // permit). Held across the round-trip + JSON parse; released before we return.
    let _mb_permit = mb_limiter().acquire().await.ok();
    // CRITICAL: only cache a DEFINITIVE result (a 200 that we parsed). A
    // transient failure (timeout, 503, rate-limit, network) must NOT be cached
    // as a miss — that would silently blacklist the artist forever. Bail without
    // caching (and without sleeping) so the next build retries.
    let resp = match state
        .proxy_http
        .get("https://musicbrainz.org/ws/2/artist/")
        .header(reqwest::header::USER_AGENT, MB_LB_UA)
        .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "1")])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (None, false),
    };
    let mbid = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|j| j["artists"].get(0).and_then(|a| a["id"].as_str()).map(String::from));
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = crate::settings::set_setting(&conn, &key, mbid.as_deref().unwrap_or(""));
    }
    (mbid, false)
}

/// ListenBrainz Labs similar-artists for an artist MBID (keyless, public).
/// Returns (display_name, mbid, score), unranked.
async fn listenbrainz_similar(state: &AppState, mbid: &str) -> Vec<(String, Option<String>, i64)> {
    let resp = match state
        .proxy_http
        .get("https://labs.api.listenbrainz.org/similar-artists/json")
        .header(reqwest::header::USER_AGENT, MB_LB_UA)
        .query(&[("artist_mbids", mbid), ("algorithm", LB_SIMILAR_ALGO)])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };
    json.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let name = v["name"].as_str()?.to_string();
                    let amb = v["artist_mbid"].as_str().map(String::from);
                    let score = v["score"].as_i64().unwrap_or(0);
                    Some((name, amb, score))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a list of artist NAMES to one Deezer "deeper cut" track each
/// (2nd-most-popular, skipping the #1 hit), IN PARALLEL bounded by
/// RESOLVE_CONCURRENCY. Results come back in the SAME order as the input so the
/// caller's ranking/dedupe stays deterministic; `None` for artists that didn't
/// resolve. This is the slow fan-out that used to run sequentially.
async fn deezer_deep_cuts_parallel(
    names: Vec<String>,
    sem: ResolveLimiter,
) -> Vec<Option<crate::deezer::TrackHit>> {
    let n = names.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, name) in names.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let client = crate::deezer::DeezerClient::new();
            let a = resolve_best_artist(&client, &name).await?;
            let top = client.get_artist_top(a.id, 5).await.ok()?;
            let pick = if top.len() >= 2 {
                top.into_iter().nth(1)
            } else {
                top.into_iter().next()
            };
            pick.map(|t| (i, t))
        });
    }
    let mut buf: Vec<Option<crate::deezer::TrackHit>> = (0..n).map(|_| None).collect();
    while let Some(r) = set.join_next().await {
        if let Ok(Some((i, t))) = r {
            buf[i] = Some(t);
        }
    }
    buf
}

/// Resolve (track_title, artist_name) pairs — e.g. from Last.fm track.getSimilar —
/// to playable Deezer tracks via an exact `artist:"…" track:"…"` search, in
/// PARALLEL (bounded by the shared limiter), preserving input order. Unlike
/// deezer_deep_cuts_parallel this returns the ACTUAL similar song (1 Deezer call
/// each, not a per-artist deep-cut guess), which is the point of song→song radio.
async fn deezer_resolve_tracks_parallel(
    pairs: Vec<(String, String)>,
    sem: ResolveLimiter,
) -> Vec<crate::deezer::TrackHit> {
    let n = pairs.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, (track, artist)) in pairs.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let client = crate::deezer::DeezerClient::new();
            // Strip quotes so they can't break Deezer's advanced-query syntax.
            let q = format!(
                "artist:\"{}\" track:\"{}\"",
                artist.replace('"', " "),
                track.replace('"', " ")
            );
            let hit = client.search_tracks(&q, 1).await.ok()?.into_iter().next()?;
            Some((i, hit))
        });
    }
    let mut buf: Vec<Option<crate::deezer::TrackHit>> = (0..n).map(|_| None).collect();
    while let Some(r) = set.join_next().await {
        if let Ok(Some((i, t))) = r {
            buf[i] = Some(t);
        }
    }
    buf.into_iter().flatten().collect()
}

/// Top library artists (by track footprint) for a profile.
fn top_library_artists(state: &AppState, profile_id: Option<i64>, limit: i64) -> Vec<String> {
    let conn = state.db.lock().expect("db mutex poisoned");
    conn.prepare(
        "SELECT je.value FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         JOIN playlists p ON p.id = pt.playlist_id, json_each(t.artists) je
         WHERE p.profile_id IS ?1 GROUP BY je.value ORDER BY COUNT(DISTINCT t.id) DESC LIMIT ?2",
    )
    .and_then(|mut s| {
        s.query_map(params![profile_id, limit], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
    })
    .unwrap_or_default()
}

/// Top artists by completion-weighted PLAY history (Signal 4), most-played
/// first. The shared seed source for discovery shelves — replaces per-builder
/// copies of the same `SUM(PLAY_WEIGHT)` query. Takes `&Connection` so the
/// caller controls locking (and it's unit-testable).
fn top_played_artists(conn: &Connection, profile_id: Option<i64>, limit: i64) -> Vec<String> {
    conn.prepare(&format!(
        "SELECT je.value FROM play_events pe JOIN tracks t ON t.id = pe.track_id, json_each(t.artists) je
         WHERE (pe.profile_id IS ?1) GROUP BY je.value
         ORDER BY SUM({PLAY_WEIGHT} * {RECENCY_BOOST}) DESC, je.value ASC LIMIT ?2"
    ))
    .and_then(|mut s| {
        s.query_map(params![profile_id, limit], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
    })
    .unwrap_or_default()
}

/// Artist NAMES the user saved/followed (incl. onboarding picks), newest-first,
/// from the `saved_artists` profile-KV the client writes (see src/lib/saved.ts).
/// Best-effort: empty on missing / legacy / malformed JSON.
fn saved_artist_names(conn: &Connection, profile_id: Option<i64>) -> Vec<String> {
    let pid = profile_id.unwrap_or(0);
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM profile_kv WHERE profile_id = ?1 AND key = 'saved_artists'",
            params![pid],
            |r| r.get(0),
        )
        .ok();
    let Some(raw) = raw else {
        return Vec::new();
    };
    #[derive(Deserialize)]
    struct Pick {
        name: String,
    }
    serde_json::from_str::<Vec<Pick>>(&raw)
        .map(|v| {
            v.into_iter()
                .map(|p| p.name)
                .filter(|n| !n.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Coarse genre BUCKETS the user picked at onboarding (e.g. "Electronic"), from
/// the `saved_genres` profile-KV the client writes (see src/lib/saved.ts). A flat
/// JSON string array — no wrapper object, unlike `saved_artists`. Best-effort:
/// empty on missing / legacy / malformed JSON. Labels are the same `GENRE_BUCKETS`
/// vocabulary `top_genre_profile` and `bucket_to_deezer_genre` speak.
fn saved_genre_buckets(conn: &Connection, profile_id: Option<i64>) -> Vec<String> {
    let pid = profile_id.unwrap_or(0);
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM profile_kv WHERE profile_id = ?1 AND key = 'saved_genres'",
            params![pid],
            |r| r.get(0),
        )
        .ok();
    let Some(raw) = raw else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw)
        .map(|v| v.into_iter().filter(|g| !g.trim().is_empty()).collect())
        .unwrap_or_default()
}

/// Onboarding-aware seed pool: the profile's top-played artists, topped up with
/// their saved/onboarding picks while play history is too thin to fill a shelf.
/// Same shape as `top_played_artists`, so discovery builders swap 1:1. The picks
/// fade on their own once ≥ `MIN_SEEDS` real plays exist — established profiles
/// take the early return and are seeded purely by what they play (no change).
fn seed_artists(conn: &Connection, profile_id: Option<i64>, limit: i64) -> Vec<String> {
    const MIN_SEEDS: usize = 3;
    let mut pool = top_played_artists(conn, profile_id, limit);
    if pool.len() >= MIN_SEEDS || pool.len() as i64 >= limit {
        return pool;
    }
    let mut seen: std::collections::HashSet<String> =
        pool.iter().map(|s| s.to_lowercase()).collect();
    for name in saved_artist_names(conn, profile_id) {
        if pool.len() as i64 >= limit {
            break;
        }
        if seen.insert(name.to_lowercase()) {
            pool.push(name);
        }
    }
    pool
}

/// "Release Radar" — recent releases (last ~120 days) from the artists you
/// actually PLAY (falling back to library footprint for thin-history users),
/// as an album shelf. Parallel per-artist Deezer fan-out.
async fn build_release_radar(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
) -> Option<HomeShelf> {
    // Seed from play history + onboarding picks (seed_artists), falling back to
    // the library footprint only when even those are empty — so a fresh profile
    // gets new releases from the artists it picked, not a generic global radar.
    let artists = {
        let seeds = {
            let conn = state.db.lock().expect("db mutex poisoned");
            seed_artists(&conn, profile_id, 12)
        };
        if seeds.is_empty() {
            top_library_artists(state, profile_id, 12)
        } else {
            seeds
        }
    };
    if artists.is_empty() {
        return None;
    }
    // Recency window for "new" releases. Widened from 120 → 180 days so a radar
    // still fills for artists who release less often than weekly — the 120-day
    // cut left profiles whose picks had nothing out in the last four months with
    // an empty (hidden) radar.
    let cutoff: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.query_row("SELECT date('now','-180 days')", [], |r| r.get(0))
            .unwrap_or_default()
    };
    let mut set = tokio::task::JoinSet::new();
    for name in artists {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let client = crate::deezer::DeezerClient::new();
            let a = resolve_best_artist(&client, &name).await?;
            let albums = client.get_artist_albums(a.id).await.ok()?;
            Some((name, albums))
        });
    }
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut albums: Vec<SearchAlbumOut> = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(Some((artist_name, hits))) = r {
            for a in hits {
                let recent = a
                    .release_date
                    .as_deref()
                    .map(|d| d >= cutoff.as_str())
                    .unwrap_or(false);
                if recent && seen.insert(a.id) {
                    let mut out = album_hit_to_out(a);
                    if out.artists.is_empty() {
                        out.artists = vec![artist_name.clone()];
                    }
                    albums.push(out);
                }
            }
        }
    }
    if albums.is_empty() {
        return None;
    }
    albums.sort_by(|x, y| y.release_date.cmp(&x.release_date));
    // Cap per artist BEFORE truncating to 15, or a prolific act crowds everyone
    // out: an artist who releases a radio-show episode every week (A State of
    // Trance ASOT 1286, 1285, 1284, …) has ~17 albums inside the 120-day window,
    // and newest-first they fill all 15 slots. Keep the 2 newest per artist so the
    // radar stays spread across the seed artists.
    const PER_ARTIST: usize = 2;
    let mut per_artist: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    albums.retain(|a| {
        let akey = norm_artist(a.artists.first().map(String::as_str).unwrap_or(""));
        let c = per_artist.entry(akey).or_insert(0);
        if *c >= PER_ARTIST {
            return false;
        }
        *c += 1;
        true
    });
    albums.truncate(15);
    // Ranked (newest-first is the point) but still a recommendation surface —
    // log impressions so fatigue (N3) can apply later.
    Some(
        HomeShelf::album_row(
            "Release Radar",
            Some("New from artists you play".into()),
            albums,
        )
        .discovery(),
    )
}

/// "[Artist] Mix" — your most-played artist's tracks woven with tracks from
/// similar artists (ListenBrainz). Track shelf.
async fn build_artist_mix(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    // Daily-rotate the seed artist: pick from your top-16 most-played artists
    // (N2: widened from 8, recency-weighted) by the day's seed instead of always
    // your all-time #1, so "X Mix" changes day to day (and is stable within a day).
    let seed: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let pool = seed_artists(&conn, profile_id, 16);
        if pool.is_empty() {
            return None;
        }
        pool[(day_seed % pool.len() as u64) as usize].clone()
    };
    // Route the mix through the fusion engine (single seed = exactly the proven
    // radio ranking): the seed's own tracks woven with similar-artist cuts, RRF-
    // ranked and MMR-de-clumped, instead of the old fixed interleave. Ask for 20
    // (not 12): the extra depth is the per-visit rotation pool (N1).
    let tracks = fuse_seed_set(
        state,
        std::slice::from_ref(&seed),
        None,
        20,
        profile_id,
        sem,
        PopMode::Favor,
    )
    .await;
    if tracks.len() < 4 {
        return None;
    }
    Some(
        HomeShelf::track_row(
            format!("{} Mix", seed),
            Some("Built around an artist you love".into()),
            tracks,
        )
        .rotating(4, 12)
        .discovery()
        .rail(),
    )
}

/// "Because you played {Artist}" — reacts to your RECENT listening (not all-time
/// taste): seeds from an artist you actually finished a song by in the last week.
/// Names the shelf after that artist (Spotify's strongest "it's reacting to me"
/// signal). Skips the artist `build_artist_mix` chose for the day so one page
/// never doubles up on the same artist.
async fn build_because_you_played(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    let (recent, mix_seed): (Vec<String>, Option<String>) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        // Artists you COMPLETED a track by in the last 7 days, most recent first.
        let recent: Vec<String> = conn
            .prepare(
                "SELECT je.value FROM play_events pe JOIN tracks t ON t.id = pe.track_id, json_each(t.artists) je
                 WHERE (pe.profile_id IS ?1) AND pe.completed = 1
                   AND pe.played_at >= CAST(strftime('%s','now','-7 days') AS INTEGER)
                 GROUP BY je.value ORDER BY MAX(pe.played_at) DESC LIMIT 6",
            )
            .and_then(|mut s| {
                s.query_map(params![profile_id], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|x| x.ok()).collect())
            })
            .unwrap_or_default();
        // Recompute build_artist_mix's day seed so we don't collide with it.
        let pool = seed_artists(&conn, profile_id, 16);
        let mix_seed = (!pool.is_empty()).then(|| pool[(day_seed % pool.len() as u64) as usize].clone());
        (recent, mix_seed)
    };
    // Don't theme the whole feed around a single song: require at least two
    // distinct recently-finished artists before this shelf appears. (A brand-new
    // profile whose only play is the one track onboarding auto-starts would
    // otherwise get a "Because you played {that artist}" row that crowds out the
    // picks.)
    if recent.len() < 2 {
        return None;
    }
    let candidates: Vec<String> = recent
        .into_iter()
        .filter(|a| Some(a) != mix_seed.as_ref())
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let seed = candidates[(day_seed % candidates.len() as u64) as usize].clone();
    let tracks = fuse_seed_set(
        state,
        std::slice::from_ref(&seed),
        None,
        30,
        profile_id,
        sem,
        PopMode::Favor,
    )
    .await;
    if tracks.len() < 4 {
        return None;
    }
    Some(
        HomeShelf::track_row(
            format!("Because you played {}", seed),
            Some("From your recent listening".into()),
            tracks,
        )
        .rotating(3, 12)
        .discovery(),
    )
}

/// Drop the seed song itself and the seed artist's own catalog from a
/// song-similar candidate list, dedup by catalog id, cap. Pure, so the
/// filtering rules are unit-testable. Unlike `tag_shelf_pick` this does NOT
/// drop every library artist: songs that travel with a song you loved
/// naturally include artists you know, and pruning them would gut the shelf's
/// point. The seed's own artist IS dropped — their catalog is what the
/// artist-level shelves already cover.
fn song_similar_pick(
    hits: Vec<crate::deezer::TrackHit>,
    seed_title: &str,
    seed_artist: &str,
    cap: usize,
) -> Vec<CatalogTrackOut> {
    let seed_t = seed_title.trim().to_lowercase();
    let seed_a = norm_artist(seed_artist);
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut out: Vec<CatalogTrackOut> = Vec::new();
    for h in hits {
        if norm_artist(&h.artist.name) == seed_a {
            continue;
        }
        if h.title.trim().to_lowercase() == seed_t {
            continue;
        }
        if !seen.insert(h.id) {
            continue;
        }
        out.push(track_hit_to_out(h));
        if out.len() >= cap {
            break;
        }
    }
    out
}

/// `More like "{song}"` — the only shelf seeded by an exact TRACK rather than
/// an artist, tag or chart (docs/home-feed.md, build order phase 2 / open
/// question 6). Last.fm's `track.getsimilar` is co-listening over the exact
/// song — the most granular signal in the app, previously confined to radio
/// autoplay.
///
/// The seed is a track the user FINISHED in the last 7 days (a completed play
/// is the strongest implicit positive we have), rotated across the three most
/// recent by the day seed so the shelf's mood moves day to day. The whole
/// result is cached with the daily discovery pool like every other builder —
/// the day seed pins the song for the day, so the per-track fan-out that keeps
/// this signal out of cacheable paths elsewhere costs one lookup per profile
/// per day here.
///
/// Quoted title on purpose: `More like {artist}` already exists, and the
/// quotes are what tell a scanning eye this row is about a song.
async fn build_more_like_song(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    let key = read_lastfm_key(state)?;
    // The three most recently finished distinct tracks, newest first.
    let recent: Vec<(String, String)> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.prepare(
            "SELECT t.title, json_extract(t.artists, '$[0]')
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1) AND pe.completed = 1
               AND pe.played_at >= CAST(strftime('%s','now','-7 days') AS INTEGER)
             GROUP BY t.id ORDER BY MAX(pe.played_at) DESC LIMIT 3",
        )
        .and_then(|mut s| {
            s.query_map(params![profile_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default()
    };
    let candidates: Vec<&(String, String)> =
        recent.iter().filter(|(t, a)| !t.trim().is_empty() && !a.trim().is_empty()).collect();
    if candidates.is_empty() {
        return None;
    }
    let (seed_title, seed_artist) =
        candidates[(day_seed % candidates.len() as u64) as usize].clone();
    let pairs = crate::charts::lastfm_track_similar(&key, &seed_artist, &seed_title, 30).await;
    if pairs.is_empty() {
        return None;
    }
    let hits = deezer_resolve_tracks_parallel(pairs, sem).await;
    let mut tracks = song_similar_pick(hits, &seed_title, &seed_artist, 24);
    if tracks.len() < 5 {
        return None;
    }
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
    }
    Some(
        HomeShelf::track_row(
            format!("More like \"{seed_title}\""),
            // Honest provenance: track.getsimilar IS co-listening data.
            Some("You played it to the end — people who love it play these".into()),
            tracks,
        )
        .rotating(4, 12)
        .discovery(),
    )
}

#[derive(Deserialize)]
struct RadioParams {
    /// Seed artist name (the currently-playing track's primary artist).
    artist: String,
    /// Currently-playing title — excluded from the result so radio doesn't
    /// immediately replay the song you're on.
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// Radio engine for autoplay: ~`limit` catalog tracks "similar to" a seed
/// artist — the seed's own top tracks woven with tracks from ListenBrainz-similar
/// artists. Keyless (MusicBrainz + ListenBrainz + Deezer; no Spotify). Same
/// engine as `build_artist_mix`, but seeded on a specific artist, larger, and
/// excluding the currently-playing title.
/// The profile's owned artists (normalized) — lets ranking tell DISCOVERY
/// (fresh) from ECHO (familiar). Shared by the fusion helpers below.
fn library_artist_names(
    state: &AppState,
    profile_id: Option<i64>,
) -> std::collections::HashSet<String> {
    let conn = state.db.lock().expect("db mutex poisoned");
    conn.prepare(
        "SELECT DISTINCT je.value FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         JOIN playlists p ON p.id = pt.playlist_id, json_each(t.artists) je
         WHERE p.profile_id IS ?1",
    )
    .and_then(|mut s| {
        s.query_map(params![profile_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|x| x.ok().map(|n: String| norm_artist(&n))).collect())
    })
    .unwrap_or_default()
}

/// The profile's permanently-banned artists (P15). Stored + returned as
/// `norm_artist` keys, so they match the keys curate_home_shelves + the station
/// compare against. An empty set is a no-op everywhere.
fn load_ban_set(conn: &Connection, pid: Option<i64>) -> std::collections::HashSet<String> {
    conn.prepare("SELECT artist_key FROM artist_bans WHERE (profile_id IS ?1)")
        .and_then(|mut s| {
            s.query_map(params![pid], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct BanQuery {
    artist: String,
}

#[derive(Deserialize)]
struct KvQuery {
    key: String,
}

/// GET /api/profile-kv?key=<k>&profile_id=<id> — fetch one per-profile KV
/// value. The value is an opaque JSON string owned by the client (first user:
/// the desktop sidebar pins), returned verbatim; `null` when unset.
async fn profile_kv_get_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(kq): Query<KvQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // KV is per-profile personalization — a paired device reads only its own.
    let pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p.unwrap_or(0),
        Err(r) => return r,
    };
    let conn = state.db.lock().expect("db mutex poisoned");
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM profile_kv WHERE profile_id = ?1 AND key = ?2",
            params![pid, kq.key],
            |r| r.get(0),
        )
        .ok();
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        value.unwrap_or_else(|| "null".to_string()),
    )
        .into_response()
}

/// PUT /api/profile-kv?key=<k>&profile_id=<id> — upsert one per-profile KV
/// value. The body must be a JSON document (validated, size-capped) so a GET
/// can always be served back verbatim as application/json.
async fn profile_kv_put_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(kq): Query<KvQuery>,
    body: String,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if kq.key.trim().is_empty() || kq.key.len() > 64 {
        return (StatusCode::BAD_REQUEST, "bad key").into_response();
    }
    if body.len() > 64 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "value too large").into_response();
    }
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "value must be JSON").into_response();
    }
    // A paired device writes only its own profile's KV, never another's.
    let scoped = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let pid = scoped.unwrap_or(0);
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = conn.execute(
            "INSERT INTO profile_kv (profile_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value",
            params![pid, kq.key, body],
        );
    }
    // Onboarding picks change the Home seed pool, so drop this profile's cached
    // feed — otherwise the (often empty/thin) build cached at first launch would
    // keep serving for up to HOME_TTL and the picks wouldn't show until the next
    // calendar day. The cache key's `.0` is the same scoped profile Option the
    // home_handler keys on, so this targets exactly this profile's entries.
    if kq.key == "saved_artists" || kq.key == "saved_genres" {
        if let Ok(mut cache) = home_cache().lock() {
            cache.retain(|(cache_pid, _), _| *cache_pid != scoped);
        }
    }
    (StatusCode::OK, "saved").into_response()
}

/// POST /api/feedback/ban?artist=<name> — permanently stop recommending an
/// artist for this profile (P15). Stored as a normalized key; enforced across
/// every Home shelf kind (curate_home_shelves) and the station.
async fn ban_artist_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(bq): Query<BanQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // A ban applies to the caller's OWN profile's recommendations only.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let key = norm_artist(bq.artist.trim());
    if key.is_empty() {
        return (StatusCode::BAD_REQUEST, "artist is required").into_response();
    }
    let conn = state.db.lock().expect("db mutex poisoned");
    let _ = conn.execute(
        "INSERT OR IGNORE INTO artist_bans (profile_id, artist_key) VALUES (?1, ?2)",
        params![scoped_pid, key],
    );
    (StatusCode::OK, "banned").into_response()
}

/// The station's seed artists: your top-played artists, daily-shuffled + capped
/// to 5, so the station rotates day to day but is stable within a day. Pure so
/// it's unit-testable.
fn station_seeds(conn: &Connection, pid: Option<i64>, seed: u64) -> Vec<String> {
    let top = seed_artists(conn, pid, 8);
    seeded_shuffle_take(top, seed, 5)
}

#[derive(Deserialize)]
struct StationQuery {
    mode: Option<String>,
}

/// Map a station steering mode to (popularity bias, discovery-only). "For you"
/// (default) is familiar-leaning; "deep" surfaces obscure cuts; "fresh" is
/// new-artists-only. Pure/testable. UI labels never name the catalog source.
fn station_mode(mode: Option<&str>) -> (PopMode, bool) {
    match mode {
        Some("deep") => (PopMode::Invert, false),
        Some("fresh") => (PopMode::Favor, true),
        _ => (PopMode::Favor, false),
    }
}

struct StationCacheEntry {
    fetched_at: std::time::Instant,
    tracks: Vec<CatalogTrackOut>,
}

/// Same 6h/day model as the Home cache: the station's fusion is the SAME
/// ~15-call fan-out, so a cold press otherwise blocks ~14s. Cache it so the
/// one-tap CTA is instant (the pre-warm gets ahead of the day's first press).
const STATION_TTL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Keyed by (profile, local-date, mode) so the mix ROTATES daily and each
/// steering mode caches independently. The cached list is PRE-ban — bans change
/// at runtime and are re-applied cheaply on read, so a "don't recommend" takes
/// effect immediately without waiting for the entry to expire.
fn station_cache() -> &'static Mutex<
    std::collections::HashMap<(Option<i64>, String, &'static str), StationCacheEntry>,
> {
    static C: std::sync::OnceLock<
        Mutex<std::collections::HashMap<(Option<i64>, String, &'static str), StationCacheEntry>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Canonical cache key for a station mode. Derived from the RESOLVED
/// (popularity, discovery-only) pair so any guests — including an unknown mode,
/// which `station_mode` folds into the default — shares the correct cached list.
fn station_cache_key(pop: PopMode, discovery_only: bool) -> &'static str {
    match (pop, discovery_only) {
        (PopMode::Invert, _) => "deep",
        (PopMode::Favor, true) => "fresh",
        _ => "for-you",
    }
}

/// Assemble a station's track batch (PRE-ban): the fusion engine over a rotating
/// set of the profile's top artists, then the mode's discovery filter. Shared by
/// the live handler and the pre-warm so both build the SAME batch for a given
/// (profile, day, mode). Empty when the profile has no seed artists yet.
/// A distinct seed salt per station mode, so the co-offered modes (for-you /
/// deep cuts / fresh finds) each draw a DIFFERENT slice of your top artists.
/// Without this they share seeds and can surface the identical #1 track: the
/// popularity bias (Favor vs Invert) is the only thing separating the modes, and
/// it can't separate a top candidate whose Deezer rank is unknown (neutral 1.0
/// in both). for-you stays canonical (unsalted); deep + fresh diverge.
fn mode_salt(pop: PopMode, discovery_only: bool) -> u64 {
    match (pop, discovery_only) {
        (PopMode::Invert, false) => 0x1234_5678_9abc_def0, // deep cuts
        (PopMode::Favor, true) => 0x0fed_cba9_8765_4321,   // fresh finds
        _ => 0,                                            // for-you (canonical)
    }
}

async fn build_station(
    state: &AppState,
    pid: Option<i64>,
    pop: PopMode,
    discovery_only: bool,
    date: &str,
) -> Vec<CatalogTrackOut> {
    let seeds = {
        let conn = state.db.lock().expect("db mutex poisoned");
        // Salt the daily seed per mode (see `mode_salt`) so deep/fresh don't
        // collide on the same first track.
        let seed = daily_seed(pid, date) ^ mode_salt(pop, discovery_only);
        station_seeds(&conn, pid, seed)
    };
    if seeds.is_empty() {
        return Vec::new();
    }
    let sem = resolve_limiter();
    let mut tracks = fuse_seed_set(state, &seeds, None, 40, pid, sem, pop).await;
    if discovery_only {
        let seed_norm: std::collections::HashSet<String> =
            seeds.iter().map(|s| norm_artist(s)).collect();
        let lib = library_artist_names(state, pid);
        tracks.retain(|t| {
            let a = norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
            !seed_norm.contains(&a) && !lib.contains(&a)
        });
    }
    tracks
}

/// GET /api/station — "My station": a one-tap personal mix, the fusion
/// engine over a rotating set of your top artists, ban-filtered. `mode` steers
/// it (for you / deep cuts / fresh finds). Returns ~40 tracks; the player's
/// EXISTING autoplay keeps it going past this seed batch, so we don't fork the
/// refill path.
async fn station_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(sq): Query<StationQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // A station is built from play history and artist bans — the most personal
    // signal there is. Scope it to the caller's OWN profile: a paired device
    // asking for someone else's id would otherwise get a station derived from
    // that person's listening.
    let pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let (pop, discovery_only) = station_mode(sq.mode.as_deref());
    let mkey = station_cache_key(pop, discovery_only);
    let date = local_date_string();

    // Serve a fresh cached batch if the pre-warm (or an earlier press) built one;
    // otherwise pay the fusion once and cache it for the next press.
    let cached = {
        let cache = station_cache().lock().expect("station cache poisoned");
        cache
            .get(&(pid, date.clone(), mkey))
            .filter(|e| e.fetched_at.elapsed() < STATION_TTL)
            .map(|e| e.tracks.clone())
    };
    let tracks_preban = match cached {
        Some(t) => t,
        None => {
            let built = build_station(&state, pid, pop, discovery_only, &date).await;
            if !built.is_empty() {
                let mut cache = station_cache().lock().expect("station cache poisoned");
                cache.retain(|k, _| k.1 == date); // prune other days
                cache.insert(
                    (pid, date.clone(), mkey),
                    StationCacheEntry {
                        fetched_at: std::time::Instant::now(),
                        tracks: built.clone(),
                    },
                );
            }
            built
        }
    };
    if tracks_preban.is_empty() {
        return Json(Vec::<CatalogTrackOut>::new()).into_response();
    }
    // Re-apply bans on read (cheap) so a "don't recommend" takes effect without
    // waiting for the cached entry to expire.
    let banned = {
        let conn = state.db.lock().expect("db mutex poisoned");
        load_ban_set(&conn, pid)
    };
    let mut tracks = tracks_preban;
    tracks.retain(|t| {
        !banned.contains(&norm_artist(t.artists.first().map(String::as_str).unwrap_or("")))
    });
    Json(tracks).into_response()
}

/// Fuse candidate SOURCES (each a rank-ordered list) into a final track list via
/// Reciprocal Rank Fusion × novelty × popularity-diversity, then MMR-sequence so
/// no single artist clumps. Pure (no DB/network) so the ranking math is unit-
/// testable. Mirrors the proven `build_radio_similar` ranking layer (which stays
/// as-is for autoplay), now reused by the Home discovery shelves:
///   • RRF — a track corroborated by MULTIPLE sources (across seeds) sums each
///     source's 1/(K+rank) contribution, so multi-seed agreement wins;
///   • novelty — nudges toward artists NOT in `lib_names` (0.9 owned, 1.25 new);
///   • popularity — mildly favours mid/long-tail over blockbusters;
///   • MMR — greedily de-clumps repeated artists (λ relevance vs diversity).
/// `excl` drops a title outright (the currently-playing track, for autoplay).
/// How the popularity term biases ranking. `Favor` is the mild long-tail
/// preference used by radio/discovery; `Invert` is a strong obscure-boost for
/// the "under the radar" shelf. `rank == 0` (unknown popularity) stays neutral
/// in BOTH — it is not treated as maximally obscure.
#[derive(Clone, Copy, PartialEq, Debug)]
enum PopMode {
    Favor,
    Invert,
}

fn fuse_rank(
    sources: &[&[crate::deezer::TrackHit]],
    lib_names: &std::collections::HashSet<String>,
    want: usize,
    excl: Option<&str>,
    pop_mode: PopMode,
) -> Vec<CatalogTrackOut> {
    const RRF_K: f64 = 60.0;
    let mut by_id: std::collections::HashMap<u64, (crate::deezer::TrackHit, f64)> =
        std::collections::HashMap::new();
    let mut order: Vec<u64> = Vec::new();
    for src in sources {
        for (rank, hit) in src.iter().enumerate() {
            if excl.is_some_and(|e| hit.title.trim().to_lowercase() == e) {
                continue;
            }
            let contrib = 1.0 / (RRF_K + rank as f64 + 1.0);
            match by_id.get_mut(&hit.id) {
                Some((_, s)) => *s += contrib,
                None => {
                    order.push(hit.id);
                    by_id.insert(hit.id, (hit.clone(), contrib));
                }
            }
        }
    }
    let mut scored: Vec<(u64, f64)> = order
        .iter()
        .filter_map(|id| {
            by_id.get(id).map(|(hit, rrf)| {
                let novelty = if lib_names.contains(&norm_artist(&hit.artist.name)) {
                    0.9
                } else {
                    1.25
                };
                let pop = match pop_mode {
                    PopMode::Favor => match hit.rank {
                        0 => 1.0,
                        r if r >= 600_000 => 0.9,
                        r if r >= 200_000 => 1.0,
                        _ => 1.08,
                    },
                    // Under-the-radar: strongly reward obscure, penalize popular.
                    PopMode::Invert => match hit.rank {
                        0 => 1.0,
                        r if r >= 600_000 => 0.5,
                        r if r >= 200_000 => 0.8,
                        r if r >= 50_000 => 1.1,
                        _ => 1.4,
                    },
                };
                (*id, rrf * novelty * pop)
            })
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let max_score = scored.first().map(|x| x.1).unwrap_or(1.0).max(1e-9);

    const LAMBDA: f64 = 0.7;
    let mut artist_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut tracks: Vec<CatalogTrackOut> = Vec::new();
    while tracks.len() < want && !scored.is_empty() {
        let mut best_i = 0usize;
        let mut best_mmr = f64::NEG_INFINITY;
        for (i, (id, score)) in scored.iter().enumerate() {
            let akey = norm_artist(&by_id[id].0.artist.name);
            let already = *artist_count.get(&akey).unwrap_or(&0) as f64;
            let mmr = LAMBDA * (score / max_score) - (1.0 - LAMBDA) * already;
            if mmr > best_mmr {
                best_mmr = mmr;
                best_i = i;
            }
        }
        let (id, _) = scored.remove(best_i);
        if let Some((hit, _)) = by_id.remove(&id) {
            *artist_count
                .entry(norm_artist(&hit.artist.name))
                .or_insert(0) += 1;
            tracks.push(track_hit_to_out(hit));
        }
    }
    tracks
}

/// Weekly per-artist candidate cache (migration 023). Memoises the expensive
/// `gather_candidates` fan-out per (normalised artist, ISO-week) so repeat builds
/// within a week skip it; the ISO-week key turns the cache over every Monday.
/// Returns the 4 source lists on a hit, or None on a miss / corrupt row.
fn candidate_cache_get(
    conn: &Connection,
    artist_norm: &str,
    iso_week: &str,
) -> Option<[Vec<crate::deezer::TrackHit>; 4]> {
    let json: String = conn
        .query_row(
            "SELECT candidates FROM artist_candidate_cache WHERE artist_norm = ?1 AND iso_week = ?2",
            params![artist_norm, iso_week],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Store a candidate set for (artist, ISO-week) and prune prior weeks so the
/// table stays bounded to the current week. Best-effort: a serialise or write
/// failure just means the next build refetches.
fn candidate_cache_put(
    conn: &Connection,
    artist_norm: &str,
    iso_week: &str,
    candidates: &[Vec<crate::deezer::TrackHit>; 4],
) {
    let json = match serde_json::to_string(candidates) {
        Ok(j) => j,
        Err(_) => return,
    };
    let _ = conn.execute(
        "INSERT OR REPLACE INTO artist_candidate_cache \
         (artist_norm, iso_week, candidates, fetched_at) \
         VALUES (?1, ?2, ?3, strftime('%s','now'))",
        params![artist_norm, iso_week, json],
    );
    // Prior ISO-weeks are dead weight. Lexical compare is valid: "%G-W%V" is
    // year-first and zero-padded, so "2026-W07" < "2026-W28" < "2027-W01".
    let _ = conn.execute(
        "DELETE FROM artist_candidate_cache WHERE iso_week < ?1",
        params![iso_week],
    );
}

/// Generate the four candidate SOURCE lists for ONE seed artist (song→song
/// similars, Deezer smart-radio, artist-graph deep cuts, the seed's own top
/// tracks). Mirrors `build_radio_similar`'s candidate generation, factored out so
/// several seeds can be fused together. `exclude_title` seeds the song→song
/// source (empty without a title, e.g. on Home).
async fn gather_candidates(
    state: &AppState,
    artist: &str,
    exclude_title: Option<&str>,
    sem: ResolveLimiter,
) -> (
    Vec<crate::deezer::TrackHit>,
    Vec<crate::deezer::TrackHit>,
    Vec<crate::deezer::TrackHit>,
    Vec<crate::deezer::TrackHit>,
) {
    // Weekly candidate cache (migration 023): only the exclude_title-less path
    // (station + Home discovery) is memoisable — the radio-from-current-track
    // path is per-track and skips the cache. Serve a fresh weekly hit; otherwise
    // fall through to the fan-out and store the result for the rest of the week.
    let cache_key: Option<(String, String)> = if exclude_title.is_none() {
        Some((norm_artist(artist), local_iso_week()))
    } else {
        None
    };
    if let Some((an, wk)) = &cache_key {
        let hit = {
            let conn = state.db.lock().expect("db mutex poisoned");
            candidate_cache_get(&conn, an, wk)
        };
        if let Some([a, b, c, d]) = hit {
            return (a, b, c, d);
        }
    }
    let lastfm_key = read_lastfm_key(state);
    let lastfm_artist_key = lastfm_key.clone();
    let lastfm_fut = async move {
        match lastfm_artist_key {
            Some(key) => crate::charts::lastfm_similar_artists(&key, artist, 24).await,
            None => Vec::new(),
        }
    };
    let seed_title = exclude_title.map(|s| s.to_string());
    let lastfm_track_fut = async move {
        match (lastfm_key, seed_title) {
            (Some(key), Some(title)) if !title.trim().is_empty() => {
                crate::charts::lastfm_track_similar(&key, artist, &title, 20).await
            }
            _ => Vec::new(),
        }
    };
    let lb_fut = async {
        let (mbid, _) = resolve_artist_mbid(state, artist).await;
        match mbid {
            Some(m) => {
                let mut sims = listenbrainz_similar(state, &m).await;
                sims.sort_by(|a, b| b.2.cmp(&a.2));
                sims.into_iter().map(|(n, _, _)| n).take(24).collect::<Vec<String>>()
            }
            None => Vec::new(),
        }
    };
    let seed_for_top = artist.to_string();
    let seed_sem = sem.clone();
    let seed_fut = async move {
        let _permit = seed_sem.acquire_owned().await.ok()?;
        let client = crate::deezer::DeezerClient::new();
        let a = resolve_best_artist(&client, &seed_for_top).await?;
        let (own_top, radio, related) = tokio::join!(
            client.get_artist_top(a.id, 6),
            client.get_artist_radio(a.id),
            client.get_artist_related(a.id),
        );
        Some((
            own_top.unwrap_or_default(),
            radio.unwrap_or_default(),
            related.unwrap_or_default(),
        ))
    };
    let (listenbrainz_names, lastfm_names, lastfm_track_pairs, seed_res) =
        tokio::join!(lb_fut, lastfm_fut, lastfm_track_fut, seed_fut);
    let (own_top, radio_tracks, related): (
        Vec<crate::deezer::TrackHit>,
        Vec<crate::deezer::TrackHit>,
        Vec<crate::deezer::ArtistHit>,
    ) = seed_res.unwrap_or_default();
    let related_names: Vec<String> = related.into_iter().map(|a| a.name).collect();

    let mut sim_names: Vec<String> = Vec::new();
    for name in crate::cooccur::playlist_cooccur_artists(&state.db, artist, 6)
        .into_iter()
        .chain(crate::tags::tag_similar_artists(&state.db, artist, 6))
        .chain(listenbrainz_names)
        .chain(lastfm_names)
        .chain(related_names)
    {
        if !sim_names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            sim_names.push(name);
        }
    }
    sim_names.truncate(8);
    let (track_hits, sim_picks) = tokio::join!(
        deezer_resolve_tracks_parallel(lastfm_track_pairs, sem.clone()),
        deezer_deep_cuts_parallel(sim_names, sem),
    );
    let deep: Vec<crate::deezer::TrackHit> = sim_picks.into_iter().flatten().collect();
    // Store for the rest of the ISO-week — but only a NON-EMPTY result, so a
    // transient all-miss (rate-limit / network blip) isn't frozen as this
    // artist's answer for the week (mirrors the MBID cache's "only cache a
    // definitive result" rule). Prior weeks are pruned inside the put.
    let out = [track_hits, radio_tracks, deep, own_top];
    if let Some((an, wk)) = &cache_key {
        if out.iter().any(|v| !v.is_empty()) {
            let conn = state.db.lock().expect("db mutex poisoned");
            candidate_cache_put(&conn, an, wk, &out);
        }
    }
    let [track_hits, radio_tracks, deep, own_top] = out;
    (track_hits, radio_tracks, deep, own_top)
}

/// Fuse candidates from MULTIPLE seed artists into one ranked, annotated track
/// list (imp 3): gather each seed's four sources, then RRF/novelty/MMR across ALL
/// of them at once — so a track two seeds both surface sums both contributions,
/// and MMR de-clumps repeated artists. The Home discovery shelves use this to get
/// the same ranking quality as autoplay (plus Signals 1 co-occurrence + 3 tags,
/// which only reached the user via radio before).
async fn fuse_seed_set(
    state: &AppState,
    seeds: &[String],
    exclude_title: Option<&str>,
    limit: usize,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    pop_mode: PopMode,
) -> Vec<CatalogTrackOut> {
    if seeds.is_empty() {
        return Vec::new();
    }
    let lib_names = library_artist_names(state, profile_id);
    // Gather every seed's sources CONCURRENTLY. This loop used to be sequential
    // ("keeps a small seed set from bursting the APIs"), which made it the ~5x
    // multiplier behind a slow cold "My station" / discovery build. It's
    // safe to parallelize: the Deezer fan-out stays bounded by the SHARED `sem`
    // (each seed's Deezer work still acquires from the same semaphore), and the
    // softer Last.fm/MusicBrainz calls degrade gracefully (a rate-limited miss
    // just yields fewer candidates) with MBIDs cached after first use. Results
    // are placed back at their seed INDEX so the fused source order — and thus
    // the daily-deterministic output — is identical to the old sequential loop.
    let mut slots: Vec<Option<[Vec<crate::deezer::TrackHit>; 4]>> =
        (0..seeds.len()).map(|_| None).collect();
    let mut set = tokio::task::JoinSet::new();
    for (i, s) in seeds.iter().enumerate() {
        let st = state.clone();
        let seed = s.clone();
        let excl = exclude_title.map(str::to_string);
        let sm = sem.clone();
        set.spawn(async move {
            let (a, b, c, d) = gather_candidates(&st, &seed, excl.as_deref(), sm).await;
            (i, [a, b, c, d])
        });
    }
    while let Some(res) = set.join_next().await {
        if let Ok((i, arr)) = res {
            slots[i] = Some(arr);
        }
    }
    let gathered: Vec<[Vec<crate::deezer::TrackHit>; 4]> =
        slots.into_iter().flatten().collect();
    let sources: Vec<&[crate::deezer::TrackHit]> = gathered
        .iter()
        .flat_map(|g| g.iter().map(|v| v.as_slice()))
        .collect();
    let want = limit.clamp(1, 50);
    let excl = exclude_title.map(|s| s.trim().to_lowercase());
    let mut tracks = fuse_rank(&sources, &lib_names, want, excl.as_deref(), pop_mode);
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
    }
    tracks
}

async fn build_radio_similar(
    state: &AppState,
    artist: &str,
    exclude_title: Option<&str>,
    limit: usize,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
) -> Vec<CatalogTrackOut> {
    // The library artist set, so we can tell DISCOVERY (fresh) from ECHO (familiar).
    let lib_names: std::collections::HashSet<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        conn.prepare(
            "SELECT DISTINCT je.value FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
             JOIN playlists p ON p.id = pt.playlist_id, json_each(t.artists) je
             WHERE p.profile_id IS ?1",
        )
        .and_then(|mut s| {
            s.query_map(params![profile_id], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|x| x.ok().map(|n: String| norm_artist(&n))).collect())
        })
        .unwrap_or_default()
    };

    // Multi-source candidate generation (the echo-chamber fix): blend several
    // INDEPENDENT keyless graphs instead of leaning on ListenBrainz alone.
    //   • Last.fm artist.getSimilar — independent artist graph (no MBID, breaks
    //     ListenBrainz's popularity skew).
    //   • Deezer artist smart-radio — genuine TRACK-level adjacency (cross-artist),
    //     no MBID needed.
    //   • Deezer related-artists — editorial "fans also like" graph.
    //   • co-occurrence + tag overlap — your own adjacency (kept, now a minority).
    let lastfm_key = read_lastfm_key(state);
    let lastfm_artist_key = lastfm_key.clone();
    let lastfm_fut = async move {
        match lastfm_artist_key {
            Some(key) => crate::charts::lastfm_similar_artists(&key, artist, 24).await,
            None => Vec::new(),
        }
    };
    // SONG-to-SONG (the primary track-level source): Last.fm track.getSimilar on the
    // currently-playing track returns the ACTUAL similar songs. Empty without a
    // title, so radio still works artist-seeded when no track context is supplied.
    let seed_title = exclude_title.map(|s| s.to_string());
    let lastfm_track_fut = async move {
        match (lastfm_key, seed_title) {
            (Some(key), Some(title)) if !title.trim().is_empty() => {
                crate::charts::lastfm_track_similar(&key, artist, &title, 20).await
            }
            _ => Vec::new(),
        }
    };
    // ListenBrainz similar-artists (MusicBrainz resolve → LB graph). Run as a future
    // so its slow, rate-limited upstream calls OVERLAP the others instead of adding
    // ~2s serially in front of everything.
    let lb_fut = async {
        let (mbid, _) = resolve_artist_mbid(state, artist).await;
        match mbid {
            Some(m) => {
                let mut sims = listenbrainz_similar(state, &m).await;
                sims.sort_by(|a, b| b.2.cmp(&a.2));
                sims.into_iter().map(|(n, _, _)| n).take(24).collect::<Vec<String>>()
            }
            None => Vec::new(),
        }
    };
    let seed_for_top = artist.to_string();
    let seed_sem = sem.clone();
    // One artist search, then its own top tracks + smart-radio + related, together.
    let seed_fut = async move {
        let _permit = seed_sem.acquire_owned().await.ok()?;
        let client = crate::deezer::DeezerClient::new();
        let a = resolve_best_artist(&client, &seed_for_top).await?;
        let (own_top, radio, related) = tokio::join!(
            client.get_artist_top(a.id, 6),
            client.get_artist_radio(a.id),
            client.get_artist_related(a.id),
        );
        Some((
            own_top.unwrap_or_default(),
            radio.unwrap_or_default(),
            related.unwrap_or_default(),
        ))
    };
    let (listenbrainz_names, lastfm_names, lastfm_track_pairs, seed_res) =
        tokio::join!(lb_fut, lastfm_fut, lastfm_track_fut, seed_fut);
    let (own_top, radio_tracks, related): (
        Vec<crate::deezer::TrackHit>,
        Vec<crate::deezer::TrackHit>,
        Vec<crate::deezer::ArtistHit>,
    ) = seed_res.unwrap_or_default();
    let related_names: Vec<String> = related.into_iter().map(|a| a.name).collect();

    // Similar-artist NAMES to resolve to Deezer deep cuts, deduped case-insensitively
    // and rank-preserving (adjacency first, then the wider reach sources).
    let mut sim_names: Vec<String> = Vec::new();
    for name in crate::cooccur::playlist_cooccur_artists(&state.db, artist, 6)
        .into_iter()
        .chain(crate::tags::tag_similar_artists(&state.db, artist, 6))
        .chain(listenbrainz_names)
        .chain(lastfm_names)
        .chain(related_names)
    {
        if !sim_names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            sim_names.push(name);
        }
    }
    // Per-name deep cuts now play a supporting role (song→song track-similars +
    // smart-radio carry the bulk), so keep this fan-out small — 8 names, each 2
    // Deezer calls — to stay well under the ~50-req/5s quota that caused 20s+ radio.
    sim_names.truncate(8);
    // Resolve the song→song track similars AND the supporting deep cuts together.
    let (track_hits, sim_picks) = tokio::join!(
        deezer_resolve_tracks_parallel(lastfm_track_pairs, sem.clone()),
        deezer_deep_cuts_parallel(sim_names, sem),
    );

    // ---- RANKING LAYER ------------------------------------------------------
    // Candidate SOURCES as ranked lists, fused with Reciprocal Rank Fusion: each
    // source contributes 1/(K + rank) to a track's score, so a song corroborated by
    // MULTIPLE independent sources (e.g. both the Last.fm song-graph AND Deezer
    // smart-radio) outranks one only a single source surfaced — scale-free, no
    // per-source tuning. Order of sources doesn't matter to RRF; only within-source
    // rank does. Sources, best signal first: song→song similars, Deezer smart-radio,
    // artist-graph deep cuts, the seed's own top tracks (station identity).
    let want = limit.clamp(1, 50);
    let excl = exclude_title.map(|s| s.trim().to_lowercase());
    let excl = excl.as_deref();
    let deep: Vec<crate::deezer::TrackHit> = sim_picks.into_iter().flatten().collect();
    let sources: [&[crate::deezer::TrackHit]; 4] = [&track_hits, &radio_tracks, &deep, &own_top];
    const RRF_K: f64 = 60.0;
    let mut by_id: std::collections::HashMap<u64, (crate::deezer::TrackHit, f64)> =
        std::collections::HashMap::new();
    let mut order: Vec<u64> = Vec::new();
    for src in sources {
        for (rank, hit) in src.iter().enumerate() {
            // Drop the currently-playing track outright.
            if excl.is_some_and(|e| hit.title.trim().to_lowercase() == e) {
                continue;
            }
            let contrib = 1.0 / (RRF_K + rank as f64 + 1.0);
            match by_id.get_mut(&hit.id) {
                Some((_, s)) => *s += contrib,
                None => {
                    order.push(hit.id);
                    by_id.insert(hit.id, (hit.clone(), contrib));
                }
            }
        }
    }

    // Final score = RRF × novelty × popularity-diversity:
    //   • novelty — nudge toward artists NOT already in your library (discovery)
    //     without punishing a genuinely-similar song by an artist you own;
    //   • popularity — when Deezer exposes `rank`, mildly favour mid/long-tail over
    //     blockbusters so radio isn't all the obvious hits (rank 0 = unknown → neutral).
    let mut scored: Vec<(u64, f64)> = order
        .iter()
        .filter_map(|id| {
            by_id.get(id).map(|(hit, rrf)| {
                let novelty = if lib_names.contains(&norm_artist(&hit.artist.name)) {
                    0.9
                } else {
                    1.25
                };
                let pop = match hit.rank {
                    0 => 1.0,
                    r if r >= 600_000 => 0.9,
                    r if r >= 200_000 => 1.0,
                    _ => 1.08,
                };
                (*id, rrf * novelty * pop)
            })
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let max_score = scored.first().map(|x| x.1).unwrap_or(1.0).max(1e-9);

    // MMR sequencing: greedily emit the best candidate, but penalise one whose
    // primary artist is already in the queue (penalty grows per prior pick), so no
    // single neighbour clumps. λ favours relevance; (1-λ) the diversity penalty.
    const LAMBDA: f64 = 0.7;
    let mut artist_count: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut tracks: Vec<CatalogTrackOut> = Vec::new();
    while tracks.len() < want && !scored.is_empty() {
        let mut best_i = 0usize;
        let mut best_mmr = f64::NEG_INFINITY;
        for (i, (id, score)) in scored.iter().enumerate() {
            let akey = norm_artist(&by_id[id].0.artist.name);
            let already = *artist_count.get(&akey).unwrap_or(&0) as f64;
            let mmr = LAMBDA * (score / max_score) - (1.0 - LAMBDA) * already;
            if mmr > best_mmr {
                best_mmr = mmr;
                best_i = i;
            }
        }
        let (id, _) = scored.remove(best_i);
        if let Some((hit, _)) = by_id.remove(&id) {
            *artist_count
                .entry(norm_artist(&hit.artist.name))
                .or_insert(0) += 1;
            tracks.push(track_hit_to_out(hit));
        }
    }
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
        // Autoplay shouldn't queue a track a prior match already found no source
        // for — it would only 404-skip when it comes up. annotate_with_library_state
        // just linked each candidate to its local row (if any); drop the ones
        // recorded as `failed`.
        drop_unavailable(&conn, &mut tracks);
    }
    tracks
}

/// Remove radio/autoplay candidates whose already-known local row is `failed`:
/// a match previously found no streamable source, so queueing it again only
/// produces a silent skip. Best-effort — relies on `annotate_with_library_state`
/// having populated `local_track_id`; an un-linked candidate is left in.
fn drop_unavailable(conn: &Connection, tracks: &mut Vec<CatalogTrackOut>) {
    let ids: Vec<i64> = tracks.iter().filter_map(|t| t.local_track_id).collect();
    if ids.is_empty() {
        return;
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id FROM tracks WHERE status = 'failed' AND id IN ({placeholders})");
    let failed: std::collections::HashSet<i64> = conn
        .prepare(&sql)
        .and_then(|mut s| {
            s.query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();
    if failed.is_empty() {
        return;
    }
    tracks.retain(|t| t.local_track_id.map_or(true, |id| !failed.contains(&id)));
}

/// GET /api/radio/similar?artist=<name>&title=<current>&limit=30
///
/// Autoplay/radio: returns ~`limit` catalog tracks similar to the seed artist so
/// the player can keep the queue flowing when it runs dry (and repeat is off).
async fn get_radio_similar(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(rp): Query<RadioParams>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // The radio filters against the caller's own library/bans — scope it, or a
    // paired device could shape a radio around someone else's profile.
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let artist = rp.artist.trim();
    if artist.is_empty() {
        return (StatusCode::BAD_REQUEST, "artist is required").into_response();
    }
    let limit = rp.limit.unwrap_or(30).clamp(1, 50);
    let sem = resolve_limiter();
    let tracks =
        build_radio_similar(&state, artist, rp.title.as_deref(), limit, scoped_pid, sem).await;
    Json(tracks).into_response()
}

/// Build the "More like your favorites" shelf. Returns None if there's not
/// enough listening history to seed it.
async fn build_more_like_favorites(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    seed: u64,
) -> Option<HomeShelf> {
    // Seeds = your most-played artists. Route the shelf through the fusion engine
    // (RRF + novelty + popularity + MMR, plus playlist co-occurrence + Last.fm
    // tags) instead of the old summed-score sort. Rotate WHICH seeds drive the
    // fusion by the day's seed, so it both diversifies its seeds and drifts daily.
    // N2: widened the seed pool 8→16 (recency-weighted) so the 3-of-N draw spans
    // a broader, more current slice of your taste instead of the frozen top-8.
    let seeds = {
        let conn = state.db.lock().expect("db mutex poisoned");
        seed_artists(&conn, profile_id, 16)
    };
    if seeds.is_empty() {
        return None;
    }
    let seed_norm: std::collections::HashSet<String> =
        seeds.iter().map(|s| norm_artist(s)).collect();
    let lib_names = library_artist_names(state, profile_id);
    let fusion_seeds = seeded_shuffle_take(seeds.clone(), seed, 3);
    let mut tracks =
        fuse_seed_set(state, &fusion_seeds, None, 24, profile_id, sem, PopMode::Favor).await;
    // Discovery filter: this shelf is about NEW artists, so exclude the seeds'
    // own tracks and anything already in the library OUTRIGHT (the fusion engine
    // only novelty-down-weights those, which is right for radio, not for this).
    tracks.retain(|t| {
        let a = norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
        !seed_norm.contains(&a) && !lib_names.contains(&a)
    });
    // Keep the whole surviving fusion ranking as the POOL (N1): each visit
    // shows the top 4 plus a visit-seeded draw, 12 total (see select_shelf_items).
    tracks.truncate(24);
    if tracks.is_empty() {
        return None;
    }

    // 6. Annotate ✓ marks for the active profile (same as Browse/Search).
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
    }
    // Name the seeds that actually DROVE today's fusion, not the static
    // all-time top-3 — the copy should match the content.
    let eyebrow = {
        let names: Vec<&str> = fusion_seeds.iter().map(|s| s.as_str()).collect();
        Some(format!("Based on {}", names.join(", ")))
    };
    Some(
        HomeShelf::track_row("More like your favorites", eyebrow, tracks)
            .rotating(4, 12)
            .discovery(),
    )
}

/// Per-week cache for "Weekly finds", keyed by (profile, ISO week). Built once
/// and reused all week — the daily home cache rebuilds every calendar day off a
/// recency-drifting seed pool + live APIs, so without this the shelf would change
/// mid-week despite its "New every Monday" caption. Only the last-built week is
/// kept (prior weeks pruned on insert). Lost on restart → rebuilt once, still
/// pinned for the rest of that week.
fn weekly_finds_cache(
) -> &'static Mutex<std::collections::HashMap<(Option<i64>, String), HomeShelf>> {
    static C: std::sync::OnceLock<
        Mutex<std::collections::HashMap<(Option<i64>, String), HomeShelf>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// "Weekly finds" — a fixed-for-the-week discovery mix of mostly-unheard tracks
/// from a wide draw of your taste. Materialized once per ISO week (see
/// `weekly_finds_cache`) so it genuinely holds still Mon→Sun and turns over on
/// Monday — the daily-mix rail's weekly sibling / return hook.
async fn build_weekly_finds(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    iso_week: &str,
) -> Option<HomeShelf> {
    let key = (profile_id, iso_week.to_string());
    if let Some(hit) = weekly_finds_cache().lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Some(hit);
    }
    let mut seeds = {
        let conn = state.db.lock().expect("db mutex poisoned");
        seed_artists(&conn, profile_id, 16)
    };
    if seeds.len() < 3 {
        return None;
    }
    // Sort before shuffling so the week seed selects the SAME 5 seeds regardless
    // of how the recency-weighted pool happens to be ordered on the build day
    // (a rebuild after a restart lands on the same picks for the week).
    seeds.sort();
    let seed_norm: std::collections::HashSet<String> =
        seeds.iter().map(|s| norm_artist(s)).collect();
    let lib_names = library_artist_names(state, profile_id);
    let week_seed = weekly_seed(profile_id, iso_week);
    let fusion_seeds = seeded_shuffle_take(seeds.clone(), week_seed, 5);
    let mut tracks =
        fuse_seed_set(state, &fusion_seeds, None, 40, profile_id, sem, PopMode::Favor).await;
    tracks.retain(|t| {
        let a = norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
        !seed_norm.contains(&a) && !lib_names.contains(&a)
    });
    tracks.truncate(30);
    if tracks.len() < 8 {
        return None;
    }
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
    }
    // Ranked (NOT rotating) so it reads as one fixed weekly object; .rail() lands
    // it as a portrait tile; the cadence caption sets it apart from daily mixes.
    let shelf = HomeShelf::track_row(
        "Weekly finds",
        Some("Fresh picks, refreshed every Monday".into()),
        tracks,
    )
    .discovery()
    .rail()
    .cadence("New every Monday");
    if let Ok(mut m) = weekly_finds_cache().lock() {
        m.retain(|k, _| k.1 == *iso_week); // drop prior weeks
        m.insert(key, shelf.clone());
    }
    Some(shelf)
}

// ---- Cheap (local-SQL) Home shelves ----------------------------------------
// These read only the local DB (no external calls), so home_handler recomputes
// them FRESH on every request — "Recently played" / "On repeat" must reflect
// the latest listening, unlike the long-cached external/discovery shelves.

/// Run a StatTrack query. The SQL must SELECT
/// (track_id, title, artists_json, album, album_art_url, duration_ms, count).
fn stat_tracks_query(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Vec<StatTrack> {
    conn.prepare(sql)
        .and_then(|mut stmt| {
            stmt.query_map(params, |r| {
                let aj: String = r.get(2)?;
                Ok(StatTrack {
                    track_id: r.get(0)?,
                    title: r.get(1)?,
                    artists: serde_json::from_str(&aj).unwrap_or_default(),
                    album: r.get(3)?,
                    album_art_url: r.get(4)?,
                    duration_ms: r.get(5)?,
                    has_audio: r.get(6)?,
                    count: r.get(7)?,
                })
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default()
}

/// Columns every stat shelf selects (kept identical so they share row-mapping).
/// `has_audio` is column 6; the per-shelf `COUNT(*)`/`SUM(...)` is column 7.
const STAT_COLS: &str = "t.id, t.title, t.artists, t.album, t.album_art_url, t.duration_ms, \
     (t.local_path IS NOT NULL AND t.local_path <> '') AS has_audio";

/// Per-play affinity weight (Phase 3 — Signal 4: decision/completion-weighted).
/// A finished listen counts more than a skip, so "top"/"favorites" rankings
/// reflect what you actually sit through, not just whatever autoplay started:
///   • completed = 1 (heard ≥85%)          → 1.5  (strong positive)
///   • ms_played > 0 but not completed      → 0.25 (a real skip — you bailed early)
///   • ms_played = 0 (legacy / pre-Phase-0) → 1.0  (neutral; historical counts intact)
/// Requires the play_events table guestsed as `pe`. Used as `SUM(<PLAY_WEIGHT>)` in
/// the ORDER BY of taste rankings; the displayed `COUNT(*)` is left untouched.
const PLAY_WEIGHT: &str =
    "(CASE WHEN pe.completed = 1 THEN 1.5 WHEN pe.ms_played > 0 THEN 0.25 ELSE 1.0 END)";

/// A "real" play for stats leaderboards (the Spotify model — a stream only
/// counts once you're past the skip): a completed listen (`completed = 1`), OR
/// a legacy untracked play (`ms_played = 0`, recorded before completion
/// tracking existed). A SKIP — started but abandoned (`ms_played > 0` and NOT
/// completed) — counts 0, matching how `PLAY_WEIGHT` discounts it. `SUM`ming
/// this gives a play count you can trust: "songs you actually listened to".
/// Usable in any query that joins play_events as `pe`.
const REAL_PLAY: &str = "(CASE WHEN pe.completed = 1 OR pe.ms_played = 0 THEN 1 ELSE 0 END)";

/// Recency multiplier on a play's weight (N2). All-time SUM(weight) ranking
/// freezes the seed pool for established listeners — the same handful of
/// artists drive every discovery surface forever. Boosting recent plays lets a
/// current obsession climb into the (widened) seed pool so discovery follows
/// your taste as it moves, while long-tail history still contributes (older
/// plays keep weight 1.0, so a long-time favorite doesn't fall out). Reads
/// `pe.played_at` (epoch secs) against the SQLite clock, matching PLAY_WEIGHT's
/// `pe` guests — usable in any query that joins play_events as `pe`.
const RECENCY_BOOST: &str = "(CASE
    WHEN pe.played_at >= strftime('%s','now','-30 days') THEN 3.0
    WHEN pe.played_at >= strftime('%s','now','-90 days') THEN 1.5
    ELSE 1.0 END)";

/// Deterministic per-(profile, local-date) seed for daily feed rotation.
/// Computed server-side so phone and Mac agree automatically, and derived only
/// from the profile id + calendar date so it is stable WITHIN a day — the same
/// date yields the same seed yields the same shuffle, so a refresh never
/// reshuffles. No `rand`/thread entropy anywhere on the path.
fn daily_seed(profile_id: Option<i64>, local_date: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    profile_id.hash(&mut h);
    local_date.hash(&mut h);
    h.finish()
}

/// Server-local calendar date as `YYYY-MM-DD`. Matches SQLite
/// `date('now','localtime')` (both read the OS zone), so the rotation seed and
/// the local-hour timestamps stored on `play_events` share one clock.
fn local_date_string() -> String {
    chrono::Local::now().date_naive().to_string()
}

/// Weekly rotation seed — same shape as `daily_seed` but keyed by ISO week, so a
/// "Weekly finds" shelf holds still all week and turns over on Monday.
fn weekly_seed(profile_id: Option<i64>, iso_week: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    profile_id.hash(&mut h);
    iso_week.hash(&mut h);
    "weekly".hash(&mut h); // domain-separate from daily_seed for the same string
    h.finish()
}

/// Server-local ISO week as `YYYY-Www` (e.g. `2026-W28`). ISO weeks start
/// Monday, so this rolls over Monday 00:00 local.
fn local_iso_week() -> String {
    chrono::Local::now().format("%G-W%V").to_string()
}

/// Deterministic seeded shuffle: permutes `items` by a SplitMix64 stream seeded
/// from `seed`, then keeps the first `take`. A plain Fisher-Yates so the result
/// is stable within a day and identical across devices/builds — SplitMix64 is a
/// tiny, fully-specified algorithm, unlike `rand`'s RNG stream which is not a
/// stability contract. The permutation before truncation drops/duplicates
/// nothing; `take` beyond the length is a no-op.
fn seeded_shuffle_take<T>(mut items: Vec<T>, seed: u64, take: usize) -> Vec<T> {
    let mut state = seed;
    let mut next = move || {
        state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    };
    let n = items.len();
    if n > 1 {
        for i in (1..n).rev() {
            let j = (next() % (i as u64 + 1)) as usize;
            items.swap(i, j);
        }
    }
    items.truncate(take);
    items
}

fn build_recently_played(conn: &Connection, pid: Option<i64>) -> Option<HomeShelf> {
    let tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS}, COUNT(*) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1)
             GROUP BY t.id ORDER BY MAX(pe.played_at) DESC LIMIT 40"
        ),
        &[&pid],
    );
    (!tracks.is_empty()).then(|| HomeShelf::stat_row("Recently played", None, tracks))
}

// NB: "On repeat" and "From your past" are the RANKED re-engagement shelves —
// kept weight-ordered (not rotated) so they read as a genuine ranking. The
// greatest-hits / taste-slice shelves (Top songs, daypart, decade, genre) carry
// the daily rotation instead, since their internal order is far less meaningful.
fn build_on_repeat(conn: &Connection, pid: Option<i64>) -> Option<HomeShelf> {
    let tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS}, COUNT(*) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1) AND pe.played_at >= strftime('%s','now') - 28*86400
             GROUP BY t.id HAVING c >= 2
             ORDER BY SUM({PLAY_WEIGHT}) DESC, MAX(pe.played_at) DESC LIMIT 16"
        ),
        &[&pid],
    );
    (!tracks.is_empty())
        .then(|| HomeShelf::stat_row("On repeat", Some("On heavy rotation lately".into()), tracks))
}

fn build_top_songs(conn: &Connection, pid: Option<i64>, seed: u64) -> Option<HomeShelf> {
    let tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS}, COUNT(*) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1)
             GROUP BY t.id ORDER BY SUM({PLAY_WEIGHT}) DESC, MAX(pe.played_at) DESC LIMIT 40"
        ),
        &[&pid],
    );
    let tracks = seeded_shuffle_take(tracks, seed, 16);
    // "Your top songs", not "Top songs": on a page that mixes personal shelves
    // with global charts, an unqualified "Top" reads as everyone's. The title
    // should answer "mine or the world's?" on its own.
    (!tracks.is_empty()).then(|| HomeShelf::stat_row("Your top songs", None, tracks))
}

fn build_from_your_past(conn: &Connection, pid: Option<i64>) -> Option<HomeShelf> {
    let tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS},
                    SUM(CASE WHEN pe.played_at < strftime('%s','now') - 45*86400 THEN 1 ELSE 0 END) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1)
             GROUP BY t.id
             HAVING c >= 2
                AND SUM(CASE WHEN pe.played_at >= strftime('%s','now') - 45*86400 THEN 1 ELSE 0 END) = 0
             ORDER BY SUM({PLAY_WEIGHT}) DESC LIMIT 16"
        ),
        &[&pid],
    );
    (!tracks.is_empty()).then(|| {
        HomeShelf::stat_row(
            "From your past",
            Some("You loved these a while back".into()),
            tracks,
        )
    })
}

/// A profile is "dormant" (a lapsed listener worth winning back) if it has plays
/// but none in the last `n_days`. No plays at all → NOT dormant (there's nothing
/// to win back yet). Used to hoist the "From your past" shelf to the top.
const DORMANT_DAYS: i64 = 14;
fn is_dormant(conn: &Connection, pid: Option<i64>, n_days: i64) -> bool {
    // Do the time math in SQL: strftime('%s','now') is TEXT, and pulling it into
    // Rust as an i64 fails the type check — but SQLite coerces it in arithmetic.
    let has_any: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM play_events WHERE (profile_id IS ?1))",
            params![pid],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !has_any {
        return false; // no plays at all → nothing to win back
    }
    let recent: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM play_events
             WHERE (profile_id IS ?1) AND played_at >= strftime('%s','now') - ?2*86400)",
            params![pid, n_days],
            |r| r.get(0),
        )
        .unwrap_or(true);
    !recent
}

/// Current local-time daypart (Phase 3 — Signal 4, time-of-day context):
/// returns the greeting/subtitle to show and the [lo, hi) local-hour window
/// (`wraps` = the window crosses midnight). Hour comes from the server's local
/// clock, matching the timestamps stored on play_events.
fn daypart_now(conn: &Connection) -> (&'static str, &'static str, i64, i64, bool) {
    let hour: i64 = conn
        .query_row(
            "SELECT CAST(strftime('%H','now','localtime') AS INTEGER)",
            [],
            |r| r.get(0),
        )
        .unwrap_or(12);
    daypart_for_hour(hour)
}

/// Pure hour → (greeting, shelf-subtitle, window-lo, window-hi, wraps-midnight)
/// mapping. Extracted from `daypart_now` so the bucket boundaries are unit-
/// testable without the wall clock. The greeting is the server's single source
/// of truth for the Home header (the client renders it verbatim), so header and
/// daypart shelf can never disagree.
fn daypart_for_hour(hour: i64) -> (&'static str, &'static str, i64, i64, bool) {
    match hour {
        5..=11 => ("Good morning", "Songs to start your day", 5, 12, false),
        12..=16 => ("Good afternoon", "Your afternoon rotation", 12, 17, false),
        17..=21 => ("Good evening", "Easing into the evening", 17, 22, false),
        _ => ("Late night", "After hours", 22, 5, true),
    }
}

/// "Good morning / afternoon / evening / Late night" — songs with genuine
/// time-of-day CHARACTER, not just your all-day favorites that happen to also
/// play now. Ranked by daypart CONCENTRATION: score = in_w² / total_w, where
/// in_w is the completion-weighted plays inside this daypart and total_w is the
/// weighted plays across all hours. Squaring in_w keeps volume mattering while
/// the /total_w divisor demotes tracks you play evenly all day (a global favorite
/// at evening-share ≈ daypart-fraction scores low; a track you only play at night
/// scores high). The HAVING ≥2 in-daypart plays filters one-off noise, and the
/// shelf is skipped below 5 tracks so a thin/cold daypart shows nothing rather
/// than a misleading list (Recently played / Top songs already cover cold start).
fn build_daypart_shelf(conn: &Connection, pid: Option<i64>, seed: u64) -> Option<HomeShelf> {
    // The `greeting` ("Good afternoon") is already the Home page header, so the
    // shelf takes the descriptive `subtitle` ("Your afternoon rotation") as its
    // title instead — otherwise the same phrase shows twice on one screen.
    let (_greeting, subtitle, lo, hi, wraps) = daypart_now(conn);
    let hour_expr = "CAST(strftime('%H', pe.played_at, 'unixepoch', 'localtime') AS INTEGER)";
    let hour_pred = if wraps {
        format!("({hour_expr} >= {lo} OR {hour_expr} < {hi})")
    } else {
        format!("({hour_expr} >= {lo} AND {hour_expr} < {hi})")
    };
    let tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS}, SUM(CASE WHEN {hour_pred} THEN 1 ELSE 0 END) c
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1)
             GROUP BY t.id
             HAVING SUM(CASE WHEN {hour_pred} THEN 1 ELSE 0 END) >= 2
             ORDER BY (SUM(CASE WHEN {hour_pred} THEN {PLAY_WEIGHT} ELSE 0 END)
                       * SUM(CASE WHEN {hour_pred} THEN {PLAY_WEIGHT} ELSE 0 END)
                       / SUM({PLAY_WEIGHT})) DESC,
                      MAX(CASE WHEN {hour_pred} THEN pe.played_at ELSE 0 END) DESC
             LIMIT 40"
        ),
        &[&pid],
    );
    let tracks = seeded_shuffle_take(tracks, seed, 16);
    (tracks.len() >= 5).then(|| HomeShelf::stat_row(subtitle, None, tracks))
}

/// Decade Mixes ("Your 2010s") — taste-based: most-played tracks grouped by the
/// release decade of `tracks.release_year` (NULL until the enrich pass runs).
/// Top ~2 decades that have enough played songs to fill a shelf.
fn build_decade_mixes(conn: &Connection, pid: Option<i64>, seed: u64) -> Vec<HomeShelf> {
    let decades: Vec<i64> = conn
        .prepare(&format!(
            "SELECT (t.release_year/10)*10 AS decade
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1) AND t.release_year IS NOT NULL AND t.release_year >= 1950
             GROUP BY decade HAVING COUNT(DISTINCT t.id) >= 8
             ORDER BY SUM({PLAY_WEIGHT}) DESC LIMIT 2"
        ))
        .and_then(|mut s| {
            s.query_map(params![pid], |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for decade in decades {
        let tracks = stat_tracks_query(
            conn,
            &format!(
                "SELECT {STAT_COLS}, COUNT(*) c
                 FROM play_events pe JOIN tracks t ON t.id = pe.track_id
                 WHERE (pe.profile_id IS ?1) AND (t.release_year/10)*10 = ?2
                 GROUP BY t.id ORDER BY SUM({PLAY_WEIGHT}) DESC, MAX(pe.played_at) DESC LIMIT 40"
            ),
            &[&pid, &decade],
        );
        // Independent daily rotation per decade bucket (salt the seed by decade).
        let tracks = seeded_shuffle_take(tracks, seed ^ decade as u64, 16);
        if tracks.len() >= 5 {
            out.push(
                HomeShelf::stat_row(
                    format!("Your {decade}s"),
                    Some("From across the years you play".into()),
                    tracks,
                )
                .rail(),
            );
        }
    }
    out
}

/// Genre Mixes ("Your Hip-Hop mix") — taste-based: most-played tracks grouped by
/// the coarse `tracks.genre` bucket. Excludes the "Unknown" sentinel. Top ~2.
fn build_genre_mixes(conn: &Connection, pid: Option<i64>, seed: u64) -> Vec<HomeShelf> {
    let genres: Vec<String> = conn
        .prepare(&format!(
            "SELECT t.genre
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1) AND t.genre IS NOT NULL AND t.genre <> 'Unknown'
             GROUP BY t.genre HAVING COUNT(DISTINCT t.id) >= 8
             ORDER BY SUM({PLAY_WEIGHT}) DESC LIMIT 2"
        ))
        .and_then(|mut s| {
            s.query_map(params![pid], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    let mut out = Vec::new();
    for genre in genres {
        let tracks = stat_tracks_query(
            conn,
            &format!(
                "SELECT {STAT_COLS}, COUNT(*) c
                 FROM play_events pe JOIN tracks t ON t.id = pe.track_id
                 WHERE (pe.profile_id IS ?1) AND t.genre = ?2
                 GROUP BY t.id ORDER BY SUM({PLAY_WEIGHT}) DESC, MAX(pe.played_at) DESC LIMIT 40"
            ),
            &[&pid, &genre],
        );
        // Independent daily rotation per genre bucket (salt the seed by genre).
        let gsalt = genre
            .bytes()
            .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
        let tracks = seeded_shuffle_take(tracks, seed ^ gsalt, 16);
        if tracks.len() >= 5 {
            out.push(
                HomeShelf::stat_row(
                    format!("Your {genre} mix"),
                    Some("Genres you lean into".into()),
                    tracks,
                )
                .rail(),
            );
        }
    }
    out
}

/// "More of this sound" (Phase 4 — Signal 2): downloaded tracks that are
/// sonically closest to your most-played downloaded track, by audio-feature
/// distance. Absent until the background extractor has analysed enough of the
/// library (needs the seed + ≥5 neighbours with features), so it simply appears
/// once Signal 2 has warmed up — no thin/misleading shelf in the meantime.
fn build_sounds_like(conn: &Connection, pid: Option<i64>, seed: u64) -> Option<HomeShelf> {
    // Seed = one of your most-played DOWNLOADED tracks that already has audio
    // features, rotated daily (index by the day's seed) so the shelf isn't
    // pinned to a single song. The `, t.id ASC` tie-break keeps the candidate
    // order deterministic when weight + last-played tie.
    let candidates: Vec<(i64, String)> = conn
        .prepare(&format!(
            "SELECT t.id, t.title
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             JOIN track_features tf ON tf.track_id = t.id
             WHERE (pe.profile_id IS ?1)
             GROUP BY t.id
             ORDER BY SUM({PLAY_WEIGHT}) DESC, MAX(pe.played_at) DESC, t.id ASC LIMIT 8"
        ))
        .and_then(|mut s| {
            s.query_map(params![pid], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    if candidates.is_empty() {
        return None;
    }
    let (seed_id, seed_title) = candidates[(seed % candidates.len() as u64) as usize].clone();
    let ids = crate::audio::audio_similar_ids(conn, seed_id, 16);
    if ids.len() < 5 {
        return None;
    }
    // Fetch StatTrack rows for the neighbours; inlining our own i64 ids is
    // injection-safe. Badge = the track's own play count for this profile.
    let id_list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let mut tracks = stat_tracks_query(
        conn,
        &format!(
            "SELECT {STAT_COLS},
                    (SELECT COUNT(*) FROM play_events pe WHERE pe.track_id = t.id AND (pe.profile_id IS ?1)) c
             FROM tracks t WHERE t.id IN ({id_list})"
        ),
        &[&pid],
    );
    // Reorder to the nearest-first ranking returned by audio_similar_ids.
    let rank: std::collections::HashMap<i64, usize> =
        ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    tracks.sort_by_key(|t| rank.get(&t.track_id).copied().unwrap_or(usize::MAX));
    (tracks.len() >= 5).then(|| {
        HomeShelf::stat_row(
            "More of this sound",
            Some(format!("Because you played {seed_title}")),
            tracks,
        )
    })
}

// ---- External (cached) Home shelves ----------------------------------------

fn artist_hit_to_out(a: crate::deezer::ArtistHit) -> SearchArtistOut {
    let pic = a.best_picture();
    SearchArtistOut {
        source: "deezer".into(),
        source_id: a.id.to_string(),
        name: a.name,
        picture_url: pic,
        total_albums: a.nb_album,
        total_fans: a.nb_fan,
    }
}

/// Pick the artist a name most likely refers to, from a Deezer search list.
/// Deezer ranks `/search/artist` by RELEVANCE, not popularity, and its index is
/// full of same-name impostors, tributes, and portrait-less phantom credits — so
/// a search for "Drake" can return a 50-fan "Drake" (or "Marshmello & Omar LinX"
/// for "Marshmello") ahead of the real act. Taking result [0] caches the wrong,
/// often photo-less, entity. Prefer, in one pass: exact-name match WITH a photo
/// and the most fans; then any exact-name match by fans; then any result with a
/// photo by fans; finally the first. Mirrors `pickArtistForName` on the client.
///
/// Every name→artist resolution goes through this so the picked artist (and thus
/// the portrait, id, radio, and related seeds) is consistent everywhere.
fn pick_artist_for_name(
    hits: Vec<crate::deezer::ArtistHit>,
    name: &str,
) -> Option<crate::deezer::ArtistHit> {
    let want = name.trim().to_lowercase();
    hits.into_iter().max_by_key(|a| {
        let exact = a.name.trim().to_lowercase() == want;
        let has_photo = a.best_picture().is_some();
        // Tiers compare before fans (tuple order): exact+photo > exact > photo > none.
        let tier: u8 = match (exact, has_photo) {
            (true, true) => 3,
            (true, false) => 2,
            (false, true) => 1,
            (false, false) => 0,
        };
        (tier, a.nb_fan.unwrap_or(0))
    })
}

/// Resolve one artist name to its best-matching catalog artist (see
/// `pick_artist_for_name`). Searches a WIDE window, not just the top hit.
async fn resolve_best_artist(
    client: &crate::deezer::DeezerClient,
    name: &str,
) -> Option<crate::deezer::ArtistHit> {
    let hits = client.search_artists(name, 8).await.ok()?;
    pick_artist_for_name(hits, name)
}

/// Resolve artist NAMES to catalog artists (photo + id) via Deezer, in PARALLEL
/// (bounded by the shared limiter), preserving input order; drops unresolved.
async fn deezer_resolve_artists_parallel(
    names: Vec<String>,
    sem: ResolveLimiter,
) -> Vec<SearchArtistOut> {
    let n = names.len();
    let mut set = tokio::task::JoinSet::new();
    for (i, name) in names.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let client = crate::deezer::DeezerClient::new();
            let a = resolve_best_artist(&client, &name).await?;
            Some((i, artist_hit_to_out(a)))
        });
    }
    let mut buf: Vec<Option<SearchArtistOut>> = (0..n).map(|_| None).collect();
    while let Some(r) = set.join_next().await {
        if let Ok(Some((i, a))) = r {
            buf[i] = Some(a);
        }
    }
    buf.into_iter().flatten().collect()
}

/// "Your top artists" — most-played artists resolved to catalog artist cards.
async fn build_top_artists(
    state: &AppState,
    pid: Option<i64>,
    sem: ResolveLimiter,
) -> Option<HomeShelf> {
    // seed_artists = most-played artists, topped up with onboarding picks while
    // history is thin — so a fresh profile shows the artists it just picked here
    // instead of an empty (or lone auto-played) row.
    let names: Vec<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        seed_artists(&conn, pid, 12)
    };
    if names.is_empty() {
        return None;
    }
    let artists = deezer_resolve_artists_parallel(names, sem).await;
    (!artists.is_empty()).then(|| HomeShelf::artist_row("Your top artists", None, artists))
}

/// "More like [artist]" — Deezer related-artists for one of your most-played
/// artists, rotated daily (N2) instead of pinned to your #2 forever.
async fn build_more_like_artist(
    state: &AppState,
    pid: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    // Rotate the seed artist across your top-6 by the day's seed (salted so it
    // doesn't lock-step with the {Artist} Mix pick), so the shelf's title AND
    // content change day to day instead of showing the same #2 artist's static
    // related list forever.
    let seed: String = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let pool = seed_artists(&conn, pid, 6);
        if pool.is_empty() {
            return None;
        }
        let idx = (day_seed ^ 0x5DEECE66D) % pool.len() as u64;
        pool[idx as usize].clone()
    };
    let _permit = sem.acquire_owned().await.ok()?;
    let client = crate::deezer::DeezerClient::new();
    let a = resolve_best_artist(&client, &seed).await?;
    let related = client.get_artist_related(a.id).await.ok()?;
    // Filter out the seed itself AND artists already in the library — this is a
    // DISCOVERY shelf, so recommending names you already own defeats the point.
    let lib_names = library_artist_names(state, pid);
    let seed_norm = norm_artist(&a.name);
    let artists: Vec<SearchArtistOut> = related
        .into_iter()
        .filter(|h| {
            let nk = norm_artist(&h.name);
            nk != seed_norm && !lib_names.contains(&nk)
        })
        // 24 = the per-visit rotation pool (N1); the shelf displays 12.
        .take(24)
        .map(artist_hit_to_out)
        .collect();
    (!artists.is_empty()).then(|| {
        HomeShelf::artist_row(format!("More like {}", a.name), None, artists)
            .rotating(3, 12)
            .discovery()
    })
}

/// "More like [artist]" as a MIXED row (Spotify-style): related artists blended
/// with albums BY those neighbors and one on-seed playlist — genuine discovery,
/// NOT the seed's own catalog (which the user, having played the seed, likely
/// already owns). Seeded on a most-played artist DISTINCT from
/// `build_more_like_artist`'s pick — they share the "More like {X}" title, so the
/// same seed would render two near-identical rows. Keyless (Deezer).
async fn build_more_like_mixed(
    state: &AppState,
    pid: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    // Salt distinct from build_more_like_artist (0x5DEECE66D) and build_artist_mix
    // (unsalted). Recompute those two sibling picks and skip them, so we never
    // emit a second "More like {same artist}" or clash with the "{Artist} Mix".
    const MIXED_SALT: u64 = 0x9E3779B97F4A7C15;
    let candidates: Vec<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let pool = seed_artists(&conn, pid, 8);
        if pool.is_empty() {
            return None;
        }
        let p6 = seed_artists(&conn, pid, 6);
        let p16 = seed_artists(&conn, pid, 16);
        let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
        if !p6.is_empty() {
            taken.insert(norm_artist(&p6[((day_seed ^ 0x5DEECE66D) % p6.len() as u64) as usize]));
        }
        if !p16.is_empty() {
            taken.insert(norm_artist(&p16[(day_seed % p16.len() as u64) as usize]));
        }
        let start = ((day_seed ^ MIXED_SALT) % pool.len() as u64) as usize;
        (0..pool.len())
            .map(|k| pool[(start + k) % pool.len()].clone())
            .filter(|n| !taken.contains(&norm_artist(n)))
            .collect()
    };
    if candidates.is_empty() {
        return None;
    }

    let _permit = sem.acquire_owned().await.ok()?;
    let client = crate::deezer::DeezerClient::new();
    let lib = library_artist_names(state, pid);

    // Walk the day's candidate seeds until one yields a genuinely mixed row. Its
    // gates (≥3 related AND ≥1 non-artist card) are stricter than
    // build_more_like_artist's, so a single seed no-shows more often; retrying
    // avoids a day-locked empty slot. Bounded so a barren pool doesn't fan out.
    for seed in candidates.into_iter().take(4) {
        if let Some(shelf) = more_like_mixed_for_seed(&client, &seed, &lib).await {
            return Some(shelf);
        }
    }
    None
}

/// One seed attempt for `build_more_like_mixed`: related artists + the newest
/// album from each of the top two neighbors + one title-matched on-seed playlist,
/// interleaved. `None` unless it can be a genuine mixed row (≥3 related AND ≥1
/// non-artist card).
async fn more_like_mixed_for_seed(
    client: &crate::deezer::DeezerClient,
    seed: &str,
    lib: &std::collections::HashSet<String>,
) -> Option<HomeShelf> {
    let a = resolve_best_artist(client, seed).await?;
    let seed_norm = norm_artist(&a.name);
    // Related artists, minus the seed + anything already owned — the backbone.
    let related: Vec<crate::deezer::ArtistHit> = client
        .get_artist_related(a.id)
        .await
        .ok()?
        .into_iter()
        .filter(|h| {
            let n = norm_artist(&h.name);
            n != seed_norm && !lib.contains(&n)
        })
        .collect();
    if related.len() < 3 {
        return None;
    }
    // Neighbor ids + names for the album slots (captured before `related` is
    // consumed). Deezer's /artist/{id}/albums omits the per-album artist, so we
    // stamp the neighbor's name back on for the album card's subtitle.
    let n0 = related[0].id;
    let name0 = related[0].name.clone();
    let n1 = related.get(1).map(|h| h.id);
    let name1 = related.get(1).map(|h| h.name.clone());
    let artists: Vec<SearchArtistOut> =
        related.into_iter().take(6).map(artist_hit_to_out).collect();

    // Albums BY the top neighbors (real discovery, not the seed's own catalog)
    // plus one on-seed playlist. Concurrent under the held permit.
    let (a0, a1, pls) = tokio::join!(
        client.get_artist_albums(n0),
        async {
            match n1 {
                Some(id) => client.get_artist_albums(id).await.ok().unwrap_or_default(),
                None => Vec::new(),
            }
        },
        client.search_playlists(&a.name, 3),
    );
    // Each neighbor's newest full-length album, with the neighbor stamped as the
    // artist when the artist-scoped album list left it blank.
    let newest = |hits: Vec<crate::deezer::AlbumHit>, who: &str| -> Option<SearchAlbumOut> {
        let mut v: Vec<crate::deezer::AlbumHit> = hits
            .into_iter()
            .filter(|al| al.record_type.as_deref() == Some("album"))
            .collect();
        v.sort_by(|x, y| y.release_date.cmp(&x.release_date));
        v.into_iter().next().map(|al| {
            let mut out = album_hit_to_out(al);
            if out.artists.is_empty() {
                out.artists = vec![who.to_string()];
            }
            out
        })
    };
    let alb0 = newest(a0.ok().unwrap_or_default(), &name0);
    let alb1 = match name1 {
        Some(n) => newest(a1, &n),
        None => None,
    };
    let mut albums: Vec<SearchAlbumOut> = Vec::new();
    let mut seen_alb: std::collections::HashSet<String> = std::collections::HashSet::new();
    for al in [alb0, alb1].into_iter().flatten() {
        if seen_alb.insert(al.source_id.clone()) {
            albums.push(al);
        }
    }

    // One playlist whose title actually references the seed (drops junk name
    // hits, e.g. "Air" → "Fresh Air").
    let seed_lc = a.name.to_lowercase();
    let playlist: Option<PlaylistOut> = pls
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.title.to_lowercase().contains(&seed_lc))
        .map(playlist_hit_to_out);

    // Must have ≥1 non-artist card, else it's just an artist row (which
    // build_more_like_artist already covers).
    if albums.is_empty() && playlist.is_none() {
        return None;
    }

    // Front-loaded on the strongest signal (related artists), matching Spotify's
    // "More like" ratio: [artist, artist, album, artist, playlist, artist, album,
    // artist], skipping any slot whose source ran dry.
    let mut ai = artists.into_iter();
    let mut li = albums.into_iter();
    let mut pi = playlist.into_iter();
    let mut items: Vec<MixedItem> = Vec::new();
    for slot in [b'A', b'A', b'L', b'A', b'P', b'A', b'L', b'A'] {
        match slot {
            b'A' => {
                if let Some(x) = ai.next() {
                    items.push(MixedItem::Artist { artist: x });
                }
            }
            b'L' => {
                if let Some(x) = li.next() {
                    items.push(MixedItem::Album { album: x });
                }
            }
            _ => {
                if let Some(x) = pi.next() {
                    items.push(MixedItem::Playlist { playlist: x });
                }
            }
        }
    }
    items.extend(ai.map(|x| MixedItem::Artist { artist: x })); // any leftover artists

    // Title = just the artist; "More like" rides the eyebrow so the header reads
    // as Spotify's does (small "More like" over the big name, beside the photo).
    Some(
        HomeShelf::mixed_row(a.name.clone(), Some("More like".into()), items)
            .seed_art(a.best_picture())
            .discovery(),
    )
}

/// "New releases" — Deezer's editorial album feed (global, not personalized).
async fn build_new_releases(sem: ResolveLimiter) -> Option<HomeShelf> {
    let _permit = sem.acquire_owned().await.ok()?;
    let client = crate::deezer::DeezerClient::new();
    let hits = client.get_editorial_releases(20).await.ok()?;
    let albums: Vec<SearchAlbumOut> = hits.into_iter().map(album_hit_to_out).collect();
    // Ranked (newest-first is the point) but still a recommendation surface —
    // log impressions so fatigue (N3) can apply later.
    (!albums.is_empty())
        .then(|| HomeShelf::album_row("New releases", None, albums).discovery())
}

/// Build the EXPENSIVE shelves (each fans out to dozens of keyless calls). All
/// six run CONCURRENTLY behind ONE shared limiter so total Deezer concurrency
/// stays at RESOLVE_CONCURRENCY and the cold build never bursts the API. This
/// is the unit that home_handler caches per profile for `HOME_TTL`.
/// Over-generic / non-descriptive Last.fm tags that make a poor shelf label.
const GENERIC_TAGS: &[&str] = &[
    "seen live",
    "favorites",
    "favourites",
    "favorite",
    "favourite",
    "awesome",
    "spotify",
    "beautiful",
    "love",
    "male vocalists",
    "female vocalists",
    "amazing",
    "cool",
];

/// The profile's dominant Last.fm tags: sum per-tag weight across your top-N
/// most-played artists (via `artist_tags`, keyed by the normalized artist name),
/// most-dominant first, skipping over-generic tags. Pure (`&Connection`) so it's
/// unit-testable.
fn dominant_tags(conn: &Connection, profile_id: Option<i64>, n_artists: i64) -> Vec<String> {
    let artists = seed_artists(conn, profile_id, n_artists);
    let mut weights: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for name in &artists {
        let key = crate::tags::artist_key(name);
        let rows: Vec<(String, i64)> = conn
            .prepare("SELECT tag, weight FROM artist_tags WHERE artist_key = ?1")
            .and_then(|mut s| {
                s.query_map(params![key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                    .map(|rows| rows.filter_map(|x| x.ok()).collect())
            })
            .unwrap_or_default();
        for (tag, w) in rows {
            if GENERIC_TAGS.contains(&tag.as_str()) {
                continue;
            }
            *weights.entry(tag).or_insert(0) += w;
        }
    }
    let mut ranked: Vec<(String, i64)> = weights.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().map(|(t, _)| t).collect()
}

/// Turn resolved tag-shelf candidates into a DISCOVERY list: drop owned artists
/// and duplicate track ids, cap at 24 — the oversized per-visit rotation pool
/// (N1); the shelf displays 12. Pure so it's testable without the network.
fn tag_shelf_pick(
    hits: Vec<crate::deezer::TrackHit>,
    lib_names: &std::collections::HashSet<String>,
) -> Vec<CatalogTrackOut> {
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut out: Vec<CatalogTrackOut> = Vec::new();
    for h in hits {
        let a = norm_artist(&h.artist.name);
        if lib_names.contains(&a) || !seen.insert(h.id) {
            continue;
        }
        out.push(track_hit_to_out(h));
        if out.len() >= 24 {
            break;
        }
    }
    out
}

/// "More {tag} for you" (imp 9) — a Last.fm-tag-seeded discovery shelf. Tags
/// (Signal 3) reached the user only via Radio autoplay before; this surfaces the
/// user's dominant tag on Home. No-op without a Last.fm key or enough tag data.
async fn build_tag_shelf(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    day_seed: u64,
) -> Option<HomeShelf> {
    let key = read_lastfm_key(state)?;
    // N2: rotate the seed tag across your top-3 dominant tags by the day's seed
    // instead of always taking tag #1, so this shelf's mood changes day to day.
    let tag = {
        let conn = state.db.lock().expect("db mutex poisoned");
        let top: Vec<String> = dominant_tags(&conn, profile_id, 12).into_iter().take(3).collect();
        if top.is_empty() {
            return None;
        }
        let idx = (day_seed ^ 0x2545F4914F6CDD1D) % top.len() as u64;
        top[idx as usize].clone()
    };
    let pairs = crate::charts::lastfm_tag_top_tracks(&key, &tag, 40)
        .await
        .unwrap_or_default();
    if pairs.is_empty() {
        return None;
    }
    let hits = deezer_resolve_tracks_parallel(pairs, sem).await;
    let lib_names = library_artist_names(state, profile_id);
    let mut tracks = tag_shelf_pick(hits, &lib_names);
    if tracks.len() < 5 {
        return None;
    }
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        let _ = annotate_with_library_state(&conn, &mut tracks, profile_id);
    }
    // Capitalize the first letter for the title ("shoegaze" -> "Shoegaze").
    let disp = {
        let mut c = tag.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => tag.clone(),
        }
    };
    Some(
        HomeShelf::track_row(
            format!("More {disp} for you"),
            Some("A sound you lean into".into()),
            tracks,
        )
        .rotating(4, 12)
        .discovery(),
    )
}

/// The profile's top genre buckets by completion-weighted play history (the same
/// coarse buckets the genre mixes use), topped up with the profile's onboarding
/// GENRE picks while history is too thin to fill the editorial shelves. Mirrors
/// `seed_artists`: the picks fade on their own once ≥ `MIN_GENRE_SEEDS` real
/// history buckets exist, so an established profile is unaffected. Deterministic —
/// the `genre` tie-break gives a total order when weighted sums tie.
fn top_genre_profile(conn: &Connection, pid: Option<i64>, limit: i64) -> Vec<String> {
    const MIN_GENRE_SEEDS: usize = 2;
    let mut played: Vec<String> = conn
        .prepare(&format!(
            "SELECT t.genre
             FROM play_events pe JOIN tracks t ON t.id = pe.track_id
             WHERE (pe.profile_id IS ?1) AND t.genre IS NOT NULL AND t.genre <> 'Unknown'
             GROUP BY t.genre HAVING COUNT(DISTINCT t.id) >= 8
             ORDER BY SUM({PLAY_WEIGHT}) DESC, t.genre ASC LIMIT ?2"
        ))
        .and_then(|mut s| {
            s.query_map(params![pid, limit], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|x| x.ok()).collect())
        })
        .unwrap_or_default();
    if played.len() >= MIN_GENRE_SEEDS || played.len() as i64 >= limit {
        return played;
    }
    let mut seen: std::collections::HashSet<String> =
        played.iter().map(|g| g.to_lowercase()).collect();
    for bucket in saved_genre_buckets(conn, pid) {
        if played.len() as i64 >= limit {
            break;
        }
        if seen.insert(bucket.to_lowercase()) {
            played.push(bucket);
        }
    }
    played
}

/// Map one of our coarse genre buckets to a stable catalog editorial-genre id.
/// `None` for buckets the catalog doesn't cleanly chart (e.g. Folk) — those are
/// simply skipped. Internal ids only; no source name reaches the UI.
fn bucket_to_deezer_genre(bucket: &str) -> Option<i64> {
    Some(match bucket {
        "Hip-Hop" => 116,
        "R&B" => 165,
        "Country" => 84,
        "Metal" => 464,
        "Reggae" => 144,
        "Latin" => 197,
        "Jazz" => 129,
        "Classical" => 98,
        "Rock" => 152,
        "Pop" => 132,
        "Electronic" => 113,
        _ => return None, // Folk + anything unmapped → skip
    })
}

/// Cold-start Home (a profile that skipped onboarding): shelves built from the
/// cached global Browse feed — what's trending generally — so a no-taste
/// profile gets a full page instead of a single shelf. Every personalized
/// builder no-ops without seed artists, and the empty-shelf guard hides the
/// rest; without this, a skipper's Home is one "Popular playlists" row deep.
/// Served straight from `browse_cache()` (pre-warmed at startup) so it costs
/// zero catalog calls and adds no latency; in the first seconds of a cold
/// launch, before the pre-warm lands, it simply contributes nothing and the
/// next visit fills in. Gated on `station_ready` at the call site: the moment
/// the profile has any seed artist, the personalized feed takes over and these
/// shelves never appear again.
fn build_cold_start_shelves() -> Vec<HomeShelf> {
    // Match curate_home_shelves' floor so these survive curation intact.
    const MIN_SHELF: usize = 5;
    let cached = {
        let cache = browse_cache().lock().expect("browse cache poisoned");
        cache.get(&0).map(|e| {
            (
                e.chart_tracks.clone(),
                e.chart_artists.clone(),
                e.new_releases.clone(),
                e.chart_albums.clone(),
            )
        })
    };
    let Some((chart_tracks, chart_artists, new_releases, chart_albums)) = cached else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if chart_tracks.len() >= MIN_SHELF {
        out.push(HomeShelf::track_row(
            "Trending now",
            // The why, not the what. A brand-new user's first question is "why
            // is my page generic?", and this is the moment they decide whether
            // the app understands them. Naming the reason also frames the page
            // as *going* somewhere, which softens the otherwise-cliff switch to
            // a personalised feed when station_ready flips (docs/home-feed.md).
            Some("Until we know your taste".into()),
            chart_tracks,
        ));
    }
    if chart_artists.len() >= MIN_SHELF {
        out.push(HomeShelf::artist_row("Popular artists", None, chart_artists));
    }
    // Prefer the honest "New releases" shelf; fall back to the album chart when
    // the releases row is thin — with a title that matches what it shows.
    if new_releases.len() >= MIN_SHELF {
        out.push(HomeShelf::album_row(
            "New releases",
            Some("Fresh this week".into()),
            new_releases,
        ));
    } else if chart_albums.len() >= MIN_SHELF {
        out.push(HomeShelf::album_row("Top albums", None, chart_albums));
    }
    out
}

/// Editorial playlists on Home (Discover→Home): for the profile's top ~3 genre
/// buckets, surface that genre's curated playlists as a `playlist_row`. Filtered
/// TO your taste but NOT generated from your history — the cheapest way to break
/// the echo chamber. Falls back to the global editorial feed for a thin /
/// all-Unknown library. Titles/eyebrows never name the catalog source.
async fn build_editorial_shelves(state: &AppState, pid: Option<i64>) -> Vec<HomeShelf> {
    let buckets = {
        let conn = state.db.lock().expect("db mutex poisoned");
        top_genre_profile(&conn, pid, 3)
    };
    let client = crate::deezer::DeezerClient::new();
    let mut out: Vec<HomeShelf> = Vec::new();
    for bucket in &buckets {
        let Some(gid) = bucket_to_deezer_genre(bucket) else {
            continue;
        };
        // 24 = the per-visit rotation pool (N1); each shelf displays 12.
        let playlists: Vec<PlaylistOut> = client
            .get_chart_playlists(gid, 24)
            .await
            .map(|hits| hits.into_iter().map(playlist_hit_to_out).collect())
            .unwrap_or_default();
        if playlists.len() >= 3 {
            out.push(
                HomeShelf::playlist_row(
                    format!("Popular in {bucket}"),
                    Some(format!("Because you love {bucket}")),
                    playlists,
                )
                .rotating(3, 12)
                .discovery(),
            );
        }
    }
    if out.is_empty() {
        let playlists: Vec<PlaylistOut> = client
            .get_chart_playlists(0, 24)
            .await
            .map(|hits| hits.into_iter().map(playlist_hit_to_out).collect())
            .unwrap_or_default();
        if playlists.len() >= 3 {
            out.push(
                HomeShelf::playlist_row("Popular playlists", None, playlists)
                    .rotating(3, 12)
                    .discovery(),
            );
        }
    }
    out
}

/// "Under the radar" (long-tail discovery) — the fusion engine seeded from your
/// top artists but with popularity INVERTED, so it surfaces barely-known artists
/// in your taste graph. Track-level deep-cutting already ships in
/// build_more_like_favorites; this is the ARTIST-level long-tail counterpart, and
/// our zero-payola freedom makes championing the un-popular honest.
async fn build_under_the_radar(
    state: &AppState,
    profile_id: Option<i64>,
    sem: ResolveLimiter,
    seed: u64,
) -> Option<HomeShelf> {
    // N2: widened seed pool 8→16 (recency-weighted), matching more-like-favorites.
    let seeds = {
        let conn = state.db.lock().expect("db mutex poisoned");
        seed_artists(&conn, profile_id, 16)
    };
    if seeds.is_empty() {
        return None;
    }
    let seed_norm: std::collections::HashSet<String> =
        seeds.iter().map(|s| norm_artist(s)).collect();
    let lib_names = library_artist_names(state, profile_id);
    let fusion_seeds = seeded_shuffle_take(seeds.clone(), seed, 3);
    let mut tracks =
        fuse_seed_set(state, &fusion_seeds, None, 24, profile_id, sem, PopMode::Invert).await;
    // Discovery filter: new artists only (drop the seeds + anything owned).
    tracks.retain(|t| {
        let a = norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
        !seed_norm.contains(&a) && !lib_names.contains(&a)
    });
    // Whole surviving ranking = the per-visit pool (N1); top 4 anchored, 12 shown.
    tracks.truncate(24);
    if tracks.len() < 5 {
        return None;
    }
    Some(
        HomeShelf::track_row(
            "Under the radar",
            Some("Barely-known picks from your taste".into()),
            tracks,
        )
        .rotating(4, 12)
        .discovery(),
    )
}

/// Filter fresh releases to NEW-TO-YOU: drop albums by artists you already play
/// or own, plus duplicate album ids; cap at 24 — the per-visit rotation pool
/// (N1); the shelf displays 12. Pure so it's unit-testable.
fn filter_fresh_albums(
    releases: Vec<crate::deezer::AlbumHit>,
    known: &std::collections::HashSet<String>,
) -> Vec<SearchAlbumOut> {
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut out: Vec<SearchAlbumOut> = Vec::new();
    for a in releases {
        let an = a
            .artist
            .as_ref()
            .map(|ar| norm_artist(&ar.name))
            .unwrap_or_default();
        if !an.is_empty() && known.contains(&an) {
            continue;
        }
        if !seen.insert(a.id) {
            continue;
        }
        out.push(album_hit_to_out(a));
        if out.len() >= 24 {
            break;
        }
    }
    out
}

/// "New for you" — fresh releases from artists you HAVEN'T played (the inverse of
/// Release Radar, which is new music from artists you DO play). Excludes your
/// played + owned artists so the two shelves never collide.
///
/// Unlike the other taste-flavoured shelves, this one still builds for a profile
/// with no history: they all need play seeds and return None without them, while
/// this one's exclusion simply has nothing to exclude. So it's the only shelf
/// that can end up describing a filter that never ran — see the subtitle below.
async fn build_new_for_you(state: &AppState, pid: Option<i64>) -> Option<HomeShelf> {
    let known: std::collections::HashSet<String> = {
        let played: Vec<String> = {
            let conn = state.db.lock().expect("db mutex poisoned");
            top_played_artists(&conn, pid, 100)
        };
        let mut k: std::collections::HashSet<String> =
            played.iter().map(|a| norm_artist(a)).collect();
        k.extend(library_artist_names(state, pid));
        k
    };
    let client = crate::deezer::DeezerClient::new();
    let releases = client.get_editorial_releases(40).await.unwrap_or_default();
    let albums = filter_fresh_albums(releases, &known);
    if albums.len() < 5 {
        return None;
    }
    // An empty `known` means the filter above excluded nobody — there was no
    // history to exclude. Claiming "artists you haven't played" would then be
    // describing work that never happened, to someone who hasn't played anyone.
    // These really are just fresh releases; say so.
    let subtitle = if known.is_empty() {
        "Fresh releases"
    } else {
        "Fresh releases from artists you haven't played"
    };
    Some(
        HomeShelf::album_row("New for you", Some(subtitle.into()), albums)
            .rotating(3, 12)
            .discovery(),
    )
}

/// The four shelves that own a cold build's wall clock. Measured on a real
/// profile: the whole feed is 13 builders but they don't finish together —
/// `new_for_you` lands at 1.1s, `top_artists` 1.8s, `editorial` 2.8s, then a gap,
/// then `release_radar` 5.3s, `new_releases` 5.4s, `more_like_artist` 5.7s and
/// `more_like_mixed` 6.3s. On a cold profile that tail stretches to ~40s. Skipping
/// exactly these four yields a real, personalized page in the first few seconds;
/// `fast` builds are a strict subset and are never cached, so the full feed still
/// arrives (and caches) exactly as before.
async fn build_external_shelves(
    state: &AppState,
    pid: Option<i64>,
    seed: u64,
    fast: bool,
) -> Vec<HomeShelf> {
    let sem = resolve_limiter();
    // ISO week for the "Weekly finds" tile — it materializes per week (cached),
    // so it holds all week even as this daily pool rebuilds.
    let iso_week = local_iso_week();
    let (
        more_like,
        top_artists,
        radar,
        mix,
        more_like_artist,
        new_rel,
        tag_shelf,
        editorial,
        under_radar,
        new_for_you,
        because,
        weekly,
        more_like_mixed,
        more_like_song,
    ) = tokio::join!(
        build_more_like_favorites(state, pid, sem.clone(), seed),
        build_top_artists(state, pid, sem.clone()),
        async { if fast { None } else { build_release_radar(state, pid, sem.clone()).await } },
        build_artist_mix(state, pid, sem.clone(), seed),
        async {
            if fast {
                None
            } else {
                build_more_like_artist(state, pid, sem.clone(), seed).await
            }
        },
        async { if fast { None } else { build_new_releases(sem.clone()).await } },
        build_tag_shelf(state, pid, sem.clone(), seed),
        build_editorial_shelves(state, pid),
        build_under_the_radar(state, pid, sem.clone(), seed),
        build_new_for_you(state, pid),
        build_because_you_played(state, pid, sem.clone(), seed),
        build_weekly_finds(state, pid, sem.clone(), &iso_week),
        async {
            if fast {
                None
            } else {
                build_more_like_mixed(state, pid, sem.clone(), seed).await
            }
        },
        async {
            // A per-track fan-out (track.getsimilar + resolution) — too slow
            // for the fast partial, cached with the daily pool like the rest.
            if fast { None } else { build_more_like_song(state, pid, sem.clone(), seed).await }
        },
    );
    // Tag each shelf with its intent lane (N5) so arrange_shelves can pick a
    // balanced, rotating per-visit subset. `top_artists` is your ranked roster
    // (Familiar); the mixes/more-like shelves are Familiar; radar + new releases
    // are Fresh; tag/under-radar/new-for-you are Discover; editorial is curated.
    let tag = |s: Option<HomeShelf>, intent: ShelfIntent| -> Option<HomeShelf> {
        s.map(|mut s| {
            s.intent = intent;
            s
        })
    };
    // Rank the release shelves so the Friday lead prefers the most personalized:
    // Release Radar (from artists you play) > New for you (fresh artists) > New
    // releases (global editorial).
    let release = |s: Option<HomeShelf>, rank: u8| -> Option<HomeShelf> {
        s.map(|mut s| {
            s.release_rank = rank;
            s
        })
    };
    let mut out: Vec<HomeShelf> = [
        tag(more_like, ShelfIntent::Familiar),
        tag(top_artists, ShelfIntent::Familiar),
        release(tag(radar, ShelfIntent::Fresh), 3),
        tag(mix, ShelfIntent::Familiar),
        tag(more_like_artist, ShelfIntent::Familiar),
        release(tag(new_rel, ShelfIntent::Fresh), 1),
        tag(tag_shelf, ShelfIntent::Discover),
        tag(under_radar, ShelfIntent::Discover),
        release(tag(new_for_you, ShelfIntent::Discover), 2),
        tag(because, ShelfIntent::Discover),
        tag(weekly, ShelfIntent::Discover), // rail shelf; intent unused (bypasses lanes)
        tag(more_like_mixed, ShelfIntent::Discover),
        tag(more_like_song, ShelfIntent::Discover),
    ]
    .into_iter()
    .flatten()
    .collect();
    out.extend(editorial.into_iter().map(|mut s| {
        s.intent = ShelfIntent::Editorial;
        s
    }));
    out
}

/// Whether the Home discovery cache for a key needs a (re)build: missing, or
/// older than HOME_TTL. Pure so the pre-warm decision is unit-testable.
fn should_prewarm(entry: Option<&HomeCacheEntry>) -> bool {
    match entry {
        Some(e) => e.fetched_at.elapsed() >= HOME_TTL,
        None => true,
    }
}

/// The profiles to pre-warm: the no-profile default (`None`) plus every real
/// profile id. Pure (takes `&Connection`) so it's unit-testable.
fn prewarm_target_pids(conn: &Connection) -> Vec<Option<i64>> {
    let mut pids: Vec<Option<i64>> = vec![None];
    if let Ok(mut stmt) = conn.prepare("SELECT id FROM profiles ORDER BY id") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, i64>(0)) {
            pids.extend(rows.filter_map(|x| x.ok()).map(Some));
        }
    }
    pids
}

/// Duration from `now` until ~30s past the next LOCAL midnight — the moment the
/// date component of the Home cache key rolls over (a fresh key = a cache miss
/// the pre-warm should get ahead of). Pure (takes the instant) so the day-
/// boundary math is testable without the wall clock. Falls back to one hour on
/// any calendar edge (DST gaps etc.) rather than busy-looping.
fn next_wake_after(now: chrono::DateTime<chrono::Local>) -> std::time::Duration {
    use chrono::TimeZone;
    let fallback = std::time::Duration::from_secs(3600);
    let Some(tomorrow) = now.date_naive().succ_opt() else {
        return fallback;
    };
    let Some(target_naive) = tomorrow.and_hms_opt(0, 0, 30) else {
        return fallback;
    };
    let Some(target) = chrono::Local.from_local_datetime(&target_naive).earliest() else {
        return fallback;
    };
    (target - now).to_std().unwrap_or(fallback)
}

/// One pre-warm pass: for the no-profile default and every profile, rebuild
/// today's discovery cache entry unless a live request already warmed it. Runs in
/// TWO ordered passes — HOME feeds first (what every profile sees the instant it
/// opens the app), THEN the stations (the one-tap CTA + chips). Ordering matters:
/// a live cold /api/home at startup competes for the shared Deezer throttle gate,
/// so warming the heavier station fan-out AFTER the homes keeps it from starving
/// that first user-facing feed. Paces between profiles so the warm never bursts
/// the keyless APIs.
async fn prewarm_home_once(state: &AppState) {
    let date = local_date_string();
    let pids = {
        let conn = state.db.lock().expect("db mutex poisoned");
        prewarm_target_pids(&conn)
    };

    // Pass 1 — HOME feeds first (prioritized: this is the page users land on).
    for pid in &pids {
        let cache_key = (*pid, date.clone());
        let stale = {
            let cache = home_cache().lock().expect("home cache poisoned");
            should_prewarm(cache.get(&cache_key))
        };
        if !stale {
            continue; // a live request already warmed today's key
        }
        let seed = daily_seed(*pid, &date);
        // Always the FULL build: the pre-warm exists to populate the cache, and a
        // partial feed must never land there.
        let built = build_external_shelves(state, *pid, seed, false).await;
        if !built.is_empty() {
            let mut cache = home_cache().lock().expect("home cache poisoned");
            cache.retain(|k, _| k.1 == date);
            cache.insert(
                cache_key,
                HomeCacheEntry {
                    fetched_at: std::time::Instant::now(),
                    shelves: built,
                },
            );
        }
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    }

    // Pass 2 — station modes: the one-tap CTA (for-you) AND both steering chips
    // (deep / fresh), so all three are instant on the day's first press. Each mode
    // caches independently under the same daily rotation, with its own staleness
    // check. Extra Deezer volume is spread by the global ~9/s throttle gate, so
    // this lengthens the pass but never bursts the API. (pop, discovery_only)
    // mirrors `station_mode`.
    for pid in &pids {
        let mut did_work = false;
        for (pop, discovery_only) in [
            (PopMode::Favor, false),  // for-you (the CTA)
            (PopMode::Invert, false), // deep cuts
            (PopMode::Favor, true),   // fresh finds
        ] {
            let skey = (*pid, date.clone(), station_cache_key(pop, discovery_only));
            let station_stale = {
                let cache = station_cache().lock().expect("station cache poisoned");
                cache
                    .get(&skey)
                    .map_or(true, |e| e.fetched_at.elapsed() >= STATION_TTL)
            };
            if !station_stale {
                continue;
            }
            let s = build_station(state, *pid, pop, discovery_only, &date).await;
            did_work = true;
            if !s.is_empty() {
                let mut cache = station_cache().lock().expect("station cache poisoned");
                cache.retain(|k, _| k.1 == date);
                cache.insert(
                    skey,
                    StationCacheEntry {
                        fetched_at: std::time::Instant::now(),
                        tracks: s,
                    },
                );
            }
        }
        // Pace between profiles only when this one actually fanned out.
        if did_work {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        }
    }
    tracing::info!("home pre-warm pass complete");
}

/// Background pre-warm of the per-(profile, day) discovery cache (imp 4),
/// mirroring `spawn_browse_prewarm`. `build_external_shelves` fans out to ~15-25
/// keyless calls; warming it on launch — and again just after local midnight,
/// when the date in the cache key rolls over — means the day's first Home load
/// is served from cache instead of paying that fan-out live. Uses
/// `tauri::async_runtime::spawn` (the setup hook isn't a tokio runtime) and
/// clones `AppState` into the 'static future.
pub fn spawn_home_prewarm(state: &AppState) {
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        // Let startup settle before the burst (same 8s as the browse pre-warm).
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        loop {
            prewarm_home_once(&state).await;
            let wait = next_wake_after(chrono::Local::now());
            tokio::time::sleep(wait).await;
        }
    });
}

/// Make the Home feed read as curated rather than repetitive. For the LOCAL
/// "stat_row" shelves (which all draw from the same play history and otherwise
/// echo each other):
///   • de-clump — cap any one artist to 2 tracks per shelf (no 3-in-a-row);
///   • cross-shelf de-dup — in display order, show each track in AT MOST ONE
///     shelf (the highest), so the same songs don't repeat as you scroll;
///   • a shelf left with fewer than MIN_SHELF unique tracks is dropped, which
///     also collapses near-duplicate shelves (e.g. "Your 2020s" ≈ "Your top songs").
/// Discovery shelves (track/album/artist rows) are left untouched.
fn curate_home_shelves(
    shelves: Vec<HomeShelf>,
    banned: &std::collections::HashSet<String>,
) -> Vec<HomeShelf> {
    const PER_ARTIST: usize = 2;
    const MIN_SHELF: usize = 5;
    // Two independent identity spaces: LOCAL stat tracks (by track_id) and
    // DISCOVERY items (track by (source, source_id), album by source_id, artist
    // by normalized name). A stat track and a discovery track are NOT de-duped
    // across spaces (one's a local file, one's a catalog rec) — acceptable.
    let mut seen_stat: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut seen_track: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    let mut seen_album: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_artist: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_playlist: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<HomeShelf> = Vec::with_capacity(shelves.len());
    for mut shelf in shelves {
        match shelf.kind.as_str() {
            "stat_row" => {
                let mut per_artist: std::collections::HashMap<String, usize> =
                    std::collections::HashMap::new();
                let kept: Vec<StatTrack> = std::mem::take(&mut shelf.stat_tracks)
                    .into_iter()
                    .filter(|t| {
                        let akey =
                            norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
                        if banned.contains(&akey) {
                            return false;
                        }
                        if seen_stat.contains(&t.track_id) {
                            return false;
                        }
                        let c = per_artist.entry(akey).or_insert(0);
                        if *c >= PER_ARTIST {
                            return false;
                        }
                        *c += 1;
                        true
                    })
                    .collect();
                if kept.len() < MIN_SHELF {
                    continue; // drop a now-thin / redundant shelf
                }
                for t in &kept {
                    seen_stat.insert(t.track_id);
                }
                shelf.stat_tracks = kept;
                out.push(shelf);
            }
            "track_row" => {
                // Discovery tracks: cross-shelf de-dup + per-artist cap. Claim
                // tracks only if the shelf SURVIVES min-5 (like stat_row), so a
                // dropped shelf doesn't steal tracks from later shelves.
                let mut per_artist: std::collections::HashMap<String, usize> =
                    std::collections::HashMap::new();
                let mut kept: Vec<CatalogTrackOut> = std::mem::take(&mut shelf.tracks)
                    .into_iter()
                    .filter(|t| {
                        let akey =
                            norm_artist(t.artists.first().map(String::as_str).unwrap_or(""));
                        if banned.contains(&akey) {
                            return false;
                        }
                        let key = (t.source.clone(), t.source_id.clone());
                        if seen_track.contains(&key) {
                            return false;
                        }
                        let c = per_artist.entry(akey).or_insert(0);
                        if *c >= PER_ARTIST {
                            return false;
                        }
                        *c += 1;
                        true
                    })
                    .collect();
                // N3: trim to the shelf's display size AFTER de-dup/cap, so a
                // Rotate shelf backfills from its prioritized pool tail (select
                // kept the whole pool) instead of under-filling, and only the
                // VISIBLE items claim cross-shelf identity below.
                kept.truncate(rotate_cap(&shelf.select));
                if kept.len() < MIN_SHELF {
                    continue;
                }
                for t in &kept {
                    seen_track.insert((t.source.clone(), t.source_id.clone()));
                }
                shelf.tracks = kept;
                out.push(shelf);
            }
            "album_row" => {
                // Navigational: de-dup by album id, CAP PER ARTIST (so a prolific
                // act's serial releases can't crowd an album shelf — same
                // 2-per-artist rule the track rows use), drop only when empty.
                // De-dup via `contains` + a within-shelf set, then trim to
                // `display` (N3), so only the VISIBLE albums claim cross-shelf
                // identity — a backfill album trimmed away doesn't suppress a
                // later shelf.
                let mut local: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                let mut per_artist: std::collections::HashMap<String, usize> =
                    std::collections::HashMap::new();
                let mut kept: Vec<SearchAlbumOut> = std::mem::take(&mut shelf.albums)
                    .into_iter()
                    .filter(|a| {
                        let ak = norm_artist(a.artists.first().map(String::as_str).unwrap_or(""));
                        if banned.contains(&ak)
                            || seen_album.contains(&a.source_id)
                            || !local.insert(a.source_id.clone())
                        {
                            return false;
                        }
                        let c = per_artist.entry(ak).or_insert(0);
                        if *c >= PER_ARTIST {
                            return false;
                        }
                        *c += 1;
                        true
                    })
                    .collect();
                kept.truncate(rotate_cap(&shelf.select));
                if kept.is_empty() {
                    continue;
                }
                for a in &kept {
                    seen_album.insert(a.source_id.clone());
                }
                shelf.albums = kept;
                out.push(shelf);
            }
            "artist_row" => {
                let mut local: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                let mut kept: Vec<SearchArtistOut> = std::mem::take(&mut shelf.artists)
                    .into_iter()
                    .filter(|a| {
                        let ak = norm_artist(&a.name);
                        !banned.contains(&ak) && !seen_artist.contains(&ak) && local.insert(ak)
                    })
                    .collect();
                kept.truncate(rotate_cap(&shelf.select));
                if kept.is_empty() {
                    continue;
                }
                for a in &kept {
                    seen_artist.insert(norm_artist(&a.name));
                }
                shelf.artists = kept;
                out.push(shelf);
            }
            "playlist_row" => {
                // Editorial playlists: de-dup by id (a global playlist can chart
                // in two genres), drop only when empty.
                let mut local: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                let mut kept: Vec<PlaylistOut> = std::mem::take(&mut shelf.playlists)
                    .into_iter()
                    .filter(|p| !seen_playlist.contains(&p.source_id) && local.insert(p.source_id.clone()))
                    .collect();
                kept.truncate(rotate_cap(&shelf.select));
                if kept.is_empty() {
                    continue;
                }
                for p in &kept {
                    seen_playlist.insert(p.source_id.clone());
                }
                shelf.playlists = kept;
                out.push(shelf);
            }
            "mixed_row" => {
                // Heterogeneous cards: ban-strip + de-dup each item against the
                // shared identity sets (so an album/artist shown here isn't
                // repeated in a homogeneous shelf), preserving interleave order.
                // Drop the shelf only if nothing survives.
                let kept: Vec<MixedItem> = std::mem::take(&mut shelf.items)
                    .into_iter()
                    .filter(|it| match it {
                        MixedItem::Artist { artist } => {
                            let k = norm_artist(&artist.name);
                            !banned.contains(&k) && seen_artist.insert(k)
                        }
                        MixedItem::Album { album } => {
                            let ak =
                                norm_artist(album.artists.first().map(String::as_str).unwrap_or(""));
                            !banned.contains(&ak) && seen_album.insert(album.source_id.clone())
                        }
                        MixedItem::Playlist { playlist } => {
                            seen_playlist.insert(playlist.source_id.clone())
                        }
                    })
                    .collect();
                // Drop the row unless a non-artist card survived — an artists-only
                // mixed row is just build_more_like_artist's job (and defeats the
                // build-time "≥1 non-artist" guarantee once cross-shelf de-dup runs).
                let has_non_artist = kept
                    .iter()
                    .any(|it| !matches!(it, MixedItem::Artist { .. }));
                if kept.is_empty() || !has_non_artist {
                    continue;
                }
                shelf.items = kept;
                out.push(shelf);
            }
            _ => out.push(shelf),
        }
    }
    out
}

/// Per-visit selection nonce for /api/home (N1). The client mints a fresh
/// nonce per app-open and per pull-to-refresh; the server folds it into the
/// selection seed so each visit draws a different slice of the day's cached
/// pools. Absent (older client) → the hour bucket stands in, so the feed still
/// varies through the day without churning on every request.
#[derive(Deserialize)]
struct HomeQuery {
    #[serde(default)]
    v: Option<String>,
    /// `fast=1` asks for only the shelves that can be built cheaply, so the page
    /// can paint while the expensive half is still resolving. Every Deezer call
    /// is spaced 110ms apart PROCESS-WIDE, so a build's wall clock is almost
    /// exactly (calls × 110ms) — a cold profile needs ~360 calls and takes ~40s.
    /// The cheap shelves land in ~3s; making the client wait for the other 37s
    /// before it may show anything is the whole problem. A fast build is a
    /// STRICT SUBSET of the full one and is never cached, so it can't shadow the
    /// real feed.
    #[serde(default)]
    fast: Option<String>,
}

/// GET /api/home — the whole personalized Home feed for a profile, as one
/// ordered list of typed shelves the client renders generically by `kind`.
async fn home_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Query(hq): Query<HomeQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Scope every shelf to the acting profile. Loopback (desktop) trusts the
    // client's `profile_id`; a paired device is pinned to its session-bound
    // profile so a stale/crafted client can't pull another profile's feed. An
    // unbound paired session resolves to None — the builders then filter on
    // `profile_id IS NULL`, yielding an empty personal feed rather than a leak.
    let pid = read_scope_profile(&state, &headers, &addr, &q, pq.profile_id);
    // Two seeds (N1). The DAY seed drives the expensive cached pool build (which
    // artist gets the Mix, which 3 artists seed the fusion) — stable per (profile,
    // date) so the cache key stays honest. The VISIT seed drives the cheap
    // per-request work: which slice of each cached pool is shown, and the rotating
    // stat shelves — so every visit (new nonce) sees a fresh arrangement without
    // a single extra catalog call.
    let date = local_date_string();
    let seed = daily_seed(pid, &date);
    let visit_seed = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        pid.hash(&mut h);
        date.hash(&mut h);
        match hq.v.as_deref().filter(|v| !v.is_empty()) {
            Some(v) => v.hash(&mut h),
            // Older client (no nonce): vary by hour bucket instead — fresher
            // than the old one-feed-per-day without churning every request.
            None => chrono::Local::now().format("%H").to_string().hash(&mut h),
        }
        h.finish()
    };
    let cache_key = (pid, date.clone());

    // 1. Cheap LOCAL shelves (pure SQL) — recomputed FRESH every request so
    //    recent listening is always current. Split into a leading cluster
    //    (recent activity, shown up top) and a trailing cluster (deeper history
    //    + decade/genre mixes); the cached discovery shelves splice between them.
    let (greeting, lead_top, lead_more, trail) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        // Server-computed greeting (4-bucket, server clock) so the client header
        // matches the daypart shelf below and agrees phone↔Mac on remote access.
        let greeting = daypart_now(&conn).0.to_string();
        // Win-back (imp 8): if the whole profile has gone quiet for a while,
        // hoist "From your past" to the very TOP with a "Welcome back" framing.
        // Pushed FIRST so curate_home_shelves (first-claimant-wins, in display
        // order) lets it keep its tracks instead of the recency shelves gutting it.
        let dormant = is_dormant(&conn, pid, DORMANT_DAYS);
        let mut lead_top = Vec::new();
        if dormant {
            if let Some(mut s) = build_from_your_past(&conn, pid) {
                s.title = "Welcome back".to_string();
                s.eyebrow = Some("Pick up where you left off".into());
                lead_top.push(s);
            }
        }
        // Rotating stat shelves take the VISIT seed (N1): they're cheap SQL
        // rebuilt per request, so their 16-of-40 draws now vary per visit, not
        // per day. Ranked shelves (recently played / on repeat / from your
        // past) stay untouched — their order is information.
        if let Some(s) = build_daypart_shelf(&conn, pid, visit_seed) {
            lead_top.push(s);
        }
        if let Some(s) = build_recently_played(&conn, pid) {
            lead_top.push(s);
        }
        // Deeper library shelves — placed BELOW the discovery cluster so Home
        // leads with new music instead of burying it under your own catalogue.
        let mut lead_more = Vec::new();
        if let Some(s) = build_on_repeat(&conn, pid) {
            lead_more.push(s);
        }
        if let Some(s) = build_sounds_like(&conn, pid, visit_seed) {
            lead_more.push(s);
        }
        let mut trail = Vec::new();
        if let Some(s) = build_top_songs(&conn, pid, visit_seed) {
            trail.push(s);
        }
        // Genre mixes before decade mixes so the rail's tile order matches the
        // artist-mix → genre → decade order the client renders (mixes carry the
        // `rail` display hint; the client reads them in payload order).
        trail.extend(build_genre_mixes(&conn, pid, visit_seed));
        trail.extend(build_decade_mixes(&conn, pid, visit_seed));
        // Only in the trail when NOT dormant (otherwise it's hoisted to the top).
        if !dormant {
            if let Some(s) = build_from_your_past(&conn, pid) {
                trail.push(s);
            }
        }
        (greeting, lead_top, lead_more, trail)
    };

    // 2. Expensive discovery shelves — per-(profile, day) cached for HOME_TTL.
    //    Returns the pool AND its age (secs since built) for the honest "Updated
    //    …" caption (N6); a cold build reports age 0.
    let fresh = |key: &(Option<i64>, String)| -> Option<(Vec<HomeShelf>, u64)> {
        let cache = home_cache().lock().expect("home cache poisoned");
        cache
            .get(key)
            .filter(|e| e.fetched_at.elapsed() < HOME_TTL)
            .map(|e| (e.shelves.clone(), e.fetched_at.elapsed().as_secs()))
    };
    let want_fast = hq.fast.as_deref().is_some_and(|v| v == "1" || v == "true");
    // Tracks whether the discovery shelves in THIS response are a partial (subset)
    // feed, so the client knows to refetch for the full one. True for an explicit
    // fast request and for the cold-cache path below (which serves a partial while
    // the full build runs in the background).
    let mut served_partial = want_fast;
    let (external, discovery_age_secs) = if let Some(c) = fresh(&cache_key) {
        c
    } else if want_fast {
        // A fast request deliberately takes NEITHER the cache nor the in-flight
        // lock: it exists to paint while the full build runs, so queueing behind
        // that build would defeat its whole purpose. Its result is a strict subset
        // and is never written to the cache — a partial feed cached here would
        // shadow the real one for the full 6h TTL.
        (build_external_shelves(&state, pid, seed, true).await, 0)
    } else {
        // COLD cache (typically the first load after a date rollover). The full
        // build fans out to dozens of external catalog calls and can take tens of
        // seconds; blocking the request on it freezes the app on first open and
        // stalls a remote visitor's first load, and running several handlers'
        // worth of these at once saturates the async runtime. So do NOT block the
        // request on the full build. Instead: kick it off in the BACKGROUND, held
        // by the inflight lock so only one runs and it still fills the cache for
        // the next load; and serve a fast PARTIAL now, bounded by a hard timeout so
        // a slow or unreachable provider can never wedge the feed.
        let lock = inflight_lock(&format!("home:{cache_key:?}"));
        if let Ok(guard) = lock.try_lock_owned() {
            let state_bg = state.clone();
            let key_bg = cache_key.clone();
            let date_bg = date.clone();
            tokio::spawn(async move {
                let _guard = guard; // held for the build's duration; released on drop
                let built = build_external_shelves(&state_bg, pid, seed, false).await;
                // Cache only a non-empty build, so a transient hiccup retries next load.
                if !built.is_empty() {
                    let mut cache = home_cache().lock().expect("home cache poisoned");
                    // Drop other days' entries so the map stays ~one row per profile.
                    cache.retain(|k, _| k.1 == date_bg);
                    cache.insert(
                        key_bg,
                        HomeCacheEntry {
                            fetched_at: std::time::Instant::now(),
                            shelves: built,
                        },
                    );
                }
            });
        }
        served_partial = true;
        // A hard ceiling on the cold response: past this, serve local shelves only
        // (empty discovery) rather than making the user wait on a slow provider.
        let partial = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            build_external_shelves(&state, pid, seed, true),
        )
        .await
        .unwrap_or_default();
        (partial, 0) // just built → age 0
    };

    // 2b. Per-visit selection (N1) + fatigue demotion (N3): reorder each cached
    //     oversized pool so this visit's freshest, least-shown slice leads. Cheap
    //     (one small DB read + pure shuffles) and local — per-visit freshness
    //     still costs zero catalog calls. Fatigue counts only PRIOR days, so it's
    //     stable across repeat serves within the same day/session.
    let fatigue = {
        let conn = state.db.lock().expect("db mutex poisoned");
        load_fatigue(&conn, pid, &date)
    };
    let mut external = external;
    for s in &mut external {
        select_shelf_items(s, visit_seed, &fatigue);
    }
    // 2c. Per-visit shelf lineup (N5): the builders produce more discovery
    //     shelves than a page should show; pick a bounded, intent-balanced,
    //     seed-rotated subset so the LINEUP (which shelves, in what order) also
    //     varies visit to visit. Free — the candidates are already cached.
    let weekday = chrono::Datelike::weekday(&chrono::Local::now());
    let external = arrange_shelves(external, visit_seed, weekday);

    // 3. Final ordered feed: greeting + recent activity, then DISCOVERY, then the
    //    deeper-library shelves and history — so new music leads instead of being
    //    buried under your own catalogue.
    let mut shelves = lead_top;
    shelves.extend(external);
    shelves.extend(lead_more);
    shelves.extend(trail);
    // Strip permanently-banned artists from every shelf kind (P15), then curate.
    // Same lock also answers "can the stations build?" — they seed off
    // `top_played_artists` (see `station_seeds`), so an empty pool means an empty
    // station. Limit 1: we only need existence, and asking for 1 keeps this
    // independent of whatever width `station_seeds` samples at.
    let (banned, station_ready) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        (
            load_ban_set(&conn, pid),
            !seed_artists(&conn, pid, 1).is_empty(),
        )
    };
    // Cold start (skipped onboarding): no seed artists means the discovery
    // builders had nothing to work with and Home would be one shelf deep. Fill
    // the page from the cached global charts until listening begins —
    // `station_ready` flips with the first seed artist and these disappear.
    let mut shelves = shelves;
    if !station_ready {
        shelves.extend(build_cold_start_shelves());
    }
    let shelves = curate_home_shelves(shelves, &banned);
    // N0: remember what the discovery shelves actually SHOWED (post-curation, so
    // items dropped by dedup/bans don't count as impressions). Best-effort — a
    // logging hiccup must never fail the feed.
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        log_home_impressions(&conn, pid, &date, &shelves);
    }
    // Confirm the win-back shelf actually SURVIVED curation before flagging the
    // client dot — otherwise we'd light "something new" with no shelf behind it.
    let welcome_back = shelves.iter().any(|s| s.title == "Welcome back");
    let out = HomeOut {
        shelves,
        greeting,
        welcome_back,
        discovery_age_secs: Some(discovery_age_secs),
        station_ready,
        partial: served_partial,
    };
    // T1 perf: Home cards render at ~128–160 CSS px, but Deezer art URLs carry
    // the 1000×1000 "xl" variant — ~4× the pixels (and bytes) of the 500
    // variant for zero visible gain at card size, across ~140 images per feed.
    // Downsize display URLs in the RESPONSE only; the stored URLs (DB, other
    // surfaces like the now-playing hero) keep full resolution.
    match serde_json::to_value(&out) {
        Ok(mut v) => {
            downsize_dzcdn_art(&mut v);
            Json(v).into_response()
        }
        Err(_) => Json(out).into_response(), // can't happen; serve full-res
    }
}

/// Rewrite every Deezer image URL in a JSON tree from the 1000×1000 "xl"
/// variant down to 500×500. Deezer serves all sizes off the same md5 path, so
/// this is a pure string substitution; non-Deezer URLs are untouched.
fn downsize_dzcdn_art(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains("dzcdn.net/images/") && s.contains("/1000x1000-") {
                *s = s.replace("/1000x1000-", "/500x500-");
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(downsize_dzcdn_art),
        serde_json::Value::Object(o) => {
            o.values_mut().for_each(downsize_dzcdn_art);
        }
        _ => {}
    }
}

/// N0: upsert one `home_impressions` row per discovery item served, bumping
/// `shown_days` at most once per calendar day (refreshes and multiple visits on
/// the same day don't inflate the count). Keys are kind-scoped and stable:
/// tracks/albums/playlists by `{source}:{source_id}`, artists by normalized
/// name. `profile_id` stores 0 for the no-profile default — NOT NULL so the
/// upsert's ON CONFLICT actually fires (SQLite treats NULLs as distinct).
/// Fatigue (N3) reads this table; nothing else depends on it.
fn log_home_impressions(
    conn: &Connection,
    pid: Option<i64>,
    date: &str,
    shelves: &[HomeShelf],
) {
    let Ok(tx) = conn.unchecked_transaction() else {
        return;
    };
    {
        let Ok(mut stmt) = tx.prepare_cached(
            "INSERT INTO home_impressions
                 (profile_id, item_kind, item_key, first_shown, last_shown, shown_days, shelf)
             VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5)
             ON CONFLICT(profile_id, item_kind, item_key) DO UPDATE SET
                 shown_days = shown_days + (last_shown < excluded.last_shown),
                 last_shown = max(last_shown, excluded.last_shown),
                 shelf = excluded.shelf",
        ) else {
            return;
        };
        let pid0 = pid.unwrap_or(0);
        for s in shelves.iter().filter(|s| s.discovery) {
            for t in &s.tracks {
                let _ = stmt.execute(params![
                    pid0,
                    "track",
                    format!("{}:{}", t.source, t.source_id),
                    date,
                    s.title
                ]);
            }
            for a in &s.albums {
                let _ = stmt.execute(params![
                    pid0,
                    "album",
                    format!("{}:{}", a.source, a.source_id),
                    date,
                    s.title
                ]);
            }
            for a in &s.artists {
                let _ = stmt.execute(params![pid0, "artist", norm_artist(&a.name), date, s.title]);
            }
            for p in &s.playlists {
                let _ = stmt.execute(params![
                    pid0,
                    "playlist",
                    format!("{}:{}", p.source, p.source_id),
                    date,
                    s.title
                ]);
            }
            // mixed_row items carry their own kind; log each under the same key
            // space as the homogeneous rows so fatigue reads back uniformly.
            for it in &s.items {
                match it {
                    MixedItem::Artist { artist } => {
                        let _ =
                            stmt.execute(params![pid0, "artist", norm_artist(&artist.name), date, s.title]);
                    }
                    MixedItem::Album { album } => {
                        let _ = stmt.execute(params![
                            pid0,
                            "album",
                            format!("{}:{}", album.source, album.source_id),
                            date,
                    s.title
                        ]);
                    }
                    MixedItem::Playlist { playlist } => {
                        let _ = stmt.execute(params![
                            pid0,
                            "playlist",
                            format!("{}:{}", playlist.source, playlist.source_id),
                            date,
                    s.title
                        ]);
                    }
                }
            }
        }
    }
    // N3: prune impressions we haven't served in ~6 months so the table stays
    // bounded (and a long-dormant item becomes eligible for discovery again).
    // Cheap best-effort scan in the same tx as the upserts.
    let _ = tx.execute(
        "DELETE FROM home_impressions WHERE last_shown < date('now','-180 days')",
        [],
    );
    if let Err(e) = tx.commit() {
        tracing::warn!(?e, "home impressions: commit failed");
    }
}

// --- The discovery funnel (docs/home-feed.md, build order phase 1) ----------
//
// Impressions record what Home SHOWED; play history records what got played.
// Crossing them answers the question nothing else can: which shelves earn
// their slot, and which are exposure with no adoption. The join key is exact —
// a catalog track imported to the library gets `spotify_id = "{source}:{id}"`,
// the same string the impression logged as `item_key`.
//
// Track impressions only: plays are track-level, so albums/artists/playlists
// have no adoption edge to measure yet. Their impressions still accrue for
// fatigue; they are simply absent here.

/// One impressed discovery track's funnel state.
#[derive(Serialize)]
struct DiscoveryFunnelItem {
    item_key: String,
    shelf: Option<String>,
    shown_days: i64,
    first_shown: String,
    last_shown: String,
    /// The track was imported to the library at some point (adoption step 1).
    in_library: bool,
    /// Plays since the day it was first shown (adoption step 2).
    plays_since_shown: i64,
    completed_since_shown: i64,
}

/// Per-shelf rollup of the above.
#[derive(Serialize)]
struct DiscoveryShelfReport {
    shelf: String,
    items: i64,
    total_shown_days: i64,
    in_library: i64,
    played: i64,
}

#[derive(Serialize)]
struct DiscoveryReport {
    shelves: Vec<DiscoveryShelfReport>,
    items: Vec<DiscoveryFunnelItem>,
}

/// Pure query, separated from the handler so the join is unit-testable.
/// `played_at >= strftime('%s', first_shown)` compares against UTC midnight of
/// the shown date — day-granularity, which is all a funnel report needs.
fn home_discovery_report(conn: &Connection, pid: Option<i64>) -> DiscoveryReport {
    let mut items: Vec<DiscoveryFunnelItem> = Vec::new();
    let res: rusqlite::Result<()> = (|| {
        let mut stmt = conn.prepare_cached(
            "SELECT hi.item_key, hi.shelf, hi.shown_days, hi.first_shown, hi.last_shown,
                    t.id IS NOT NULL,
                    COUNT(pe.id),
                    COALESCE(SUM(pe.completed), 0)
             FROM home_impressions hi
             LEFT JOIN tracks t ON t.spotify_id = hi.item_key
             LEFT JOIN play_events pe ON pe.track_id = t.id
                  AND (pe.profile_id IS ?2)
                  AND pe.played_at >= strftime('%s', hi.first_shown)
             WHERE hi.profile_id = ?1 AND hi.item_kind = 'track'
             GROUP BY hi.item_key
             ORDER BY hi.shown_days DESC, hi.item_key",
        )?;
        let rows = stmt.query_map(params![pid.unwrap_or(0), pid], |r| {
            Ok(DiscoveryFunnelItem {
                item_key: r.get(0)?,
                shelf: r.get(1)?,
                shown_days: r.get(2)?,
                first_shown: r.get(3)?,
                last_shown: r.get(4)?,
                in_library: r.get::<_, i64>(5)? != 0,
                plays_since_shown: r.get(6)?,
                completed_since_shown: r.get(7)?,
            })
        })?;
        items.extend(rows.flatten());
        Ok(())
    })();
    if let Err(e) = res {
        tracing::warn!(?e, "home discovery report: query failed");
    }
    // Rollup in Rust rather than a second SQL pass: the item list is already in
    // hand and bounded (impressions are pruned at 180 days).
    let mut by_shelf: std::collections::BTreeMap<String, DiscoveryShelfReport> =
        std::collections::BTreeMap::new();
    for it in &items {
        let key = it.shelf.clone().unwrap_or_else(|| "(before v027)".into());
        let e = by_shelf.entry(key.clone()).or_insert(DiscoveryShelfReport {
            shelf: key,
            items: 0,
            total_shown_days: 0,
            in_library: 0,
            played: 0,
        });
        e.items += 1;
        e.total_shown_days += it.shown_days;
        e.in_library += i64::from(it.in_library);
        e.played += i64::from(it.plays_since_shown > 0);
    }
    DiscoveryReport {
        shelves: by_shelf.into_values().collect(),
        items,
    }
}

/// GET /api/home/report — the discovery funnel for the acting profile.
///
/// Owner-only (`is_this_machine`): this is listening history, a desktop
/// analysis surface, not something a paired device should be able to pull.
async fn home_report_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if !is_this_machine(&headers, &addr) {
        return (StatusCode::FORBIDDEN, "owner surface").into_response();
    }
    let pid = read_scope_profile(&state, &headers, &addr, &q, pq.profile_id);
    let report = {
        let conn = state.db.lock().expect("db mutex poisoned");
        home_discovery_report(&conn, pid)
    };
    Json(report).into_response()
}

#[derive(Serialize)]
struct AddTrackOut {
    /// Local track id after insert/upsert. Lets the caller poll the
    /// playlist detail and find the row immediately after adding.
    track_id: i64,
    /// Whether we actually inserted (true) or the track was already on
    /// the playlist (false). Used by the UI to flash "already there".
    inserted: bool,
}

/// POST /api/playlists/:id/tracks
///
/// Add a Deezer-sourced (or any catalog-sourced) track to one of the
/// user's local playlists. Three things happen in sequence:
///   1. The track row gets upserted. ISRC is the dedup key when set:
///      if we already have a track with the same ISRC (typically from
///      an earlier import), we reuse that row instead of inserting a
///      duplicate.
///   2. A playlist_tracks row is appended at the tail with
///      locally_added=1 so a re-import of the source archive doesn't wipe it.
///   3. The HTTP response returns immediately. The track is stored
///      metadata-only until the user attaches an audio file.
async fn add_track_to_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TokenQuery>,
    Path(playlist_id): Path<i64>,
    Json(body): Json<AddTrackBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, playlist_id) {
        return r;
    }
    if body.source.trim().is_empty() || body.source_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing source/source_id").into_response();
    }
    // Enrich before the lock — the library row should be born with full credits.
    let body = with_full_credits(&state, body).await;

    let (track_id, inserted) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        // Playlist must exist before we touch the join table.
        let exists = conn
            .query_row(
                "SELECT 1 FROM playlists WHERE id = ?1",
                params![playlist_id],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            return StatusCode::NOT_FOUND.into_response();
        }
        match upsert_track_and_link(&conn, playlist_id, &body) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(?e, "add_track: upsert+link");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };

    // The track row is linked to the playlist. Audio is sourced via local-file
    // import ("Use my own file…").

    Json(AddTrackOut { track_id, inserted }).into_response()
}

#[derive(Deserialize)]
struct ImportAlbumBody {
    /// Display name for the new playlist. Typically the album name.
    name: String,
    /// Album artist, stored as the playlist `owner` so the library can
    /// render "Album · Artist" (Spotify style). Optional for backward
    /// compatibility with older clients.
    #[serde(default)]
    artist: Option<String>,
    /// Owning profile. Omitted (older clients) → default profile.
    #[serde(default)]
    profile_id: Option<i64>,
    /// Full track list as returned by /api/albums/:id/tracks. The
    /// client passes them through verbatim so we don't re-fetch.
    tracks: Vec<CatalogTrackOut>,
}

#[derive(Serialize)]
struct ImportAlbumOut {
    playlist_id: i64,
    /// Number of tracks newly linked into the playlist. Less than
    /// `total` when some tracks were already in another playlist by
    /// ISRC and we deduped — the track rows still get linked, but the
    /// "inserted" flag refers to the playlist link being new.
    inserted: i64,
    total: i64,
}

/// POST /api/albums/import
///
/// One-shot "save this whole album to my library" action. Creates a
/// new local playlist named after the album and links every track in
/// `tracks[]` into it via `upsert_track_and_link` (ISRC dedup against
/// existing tracks rows still applies). The rows are stored metadata-only;
/// the HTTP response returns as soon as they're in the DB, so the phone's
/// Library view picks up the new playlist immediately.
async fn import_album(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(mut body): Json<ImportAlbumBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if name.chars().count() > 200 {
        return (StatusCode::BAD_REQUEST, "name too long").into_response();
    }
    if body.tracks.is_empty() {
        return (StatusCode::BAD_REQUEST, "tracks[] cannot be empty").into_response();
    }
    // Reject anything bigger than a reasonable album; protects against
    // someone POSTing an absurdly large payload.
    if body.tracks.len() > 100 {
        return (
            StatusCode::BAD_REQUEST,
            "tracks[] too large (max 100 per album import)",
        )
            .into_response();
    }

    // Enrich the whole album's credits before the transaction (bounded by the
    // shared resolve limiter; no-ops for tracks the library already knows).
    body.tracks = with_full_credits_bulk(&state, std::mem::take(&mut body.tracks)).await;
    let total = body.tracks.len() as i64;
    let (playlist_id, freshly_linked): (i64, Vec<i64>) = {
        let mut conn = state.db.lock().expect("db mutex poisoned");
        let tx = match conn.transaction() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(?e, "import_album: begin tx");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        let artist = body.artist.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let profile_id = body
            .profile_id
            .unwrap_or_else(|| crate::profiles::default_id(&tx).unwrap_or(1));
        let playlist_id = match insert_album_playlist(&tx, name, artist, profile_id) {
            Ok((id, _)) => id,
            Err(e) => {
                tracing::error!(?e, "import_album: create playlist");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        let mut freshly_linked = Vec::new();
        for track in &body.tracks {
            match upsert_track_and_link(&tx, playlist_id, track) {
                Ok((track_id, true)) => freshly_linked.push(track_id),
                Ok((_, false)) => { /* dup within the same album; ignore */ }
                Err(e) => {
                    tracing::warn!(?e, title = %track.title, "import_album: skipping track");
                }
            }
        }
        if let Err(e) = tx.commit() {
            tracing::error!(?e, "import_album: commit");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        (playlist_id, freshly_linked)
    };

    let inserted = freshly_linked.len() as i64;
    tracing::info!(
        playlist_id,
        %name,
        inserted,
        total,
        "imported album"
    );

    // Tracks are linked; audio is sourced later via local-file import.

    Json(ImportAlbumOut {
        playlist_id,
        inserted,
        total,
    })
    .into_response()
}

/// A catalog (Deezer) playlist's metadata + full track list, for the
/// "Popular [genre] playlists" drill-in. Tracks come back in the same
/// `CatalogTrackOut` shape as /api/search, annotated with library state,
/// so the drill-in reuses the search track list (preview + add-to-playlist).
#[derive(Serialize)]
struct CatalogPlaylistOut {
    source: &'static str,
    source_id: String,
    title: String,
    cover_url: Option<String>,
    creator: Option<String>,
    track_count: Option<i64>,
    tracks: Vec<CatalogTrackOut>,
}

/// GET /api/catalog/playlists/:id
///
/// Drill-in for a Deezer playlist surfaced in the genre Browse page.
/// Returns its metadata plus the full tracklist (resolved to the catalog
/// track shape with previews + ✓ library marks), so the user can preview
/// and cherry-pick — or "Add all" via /api/playlists/import.
async fn get_catalog_playlist(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Query(pq): Query<ProfileQuery>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Per-profile ✓ marks — scope to the caller (see `spotify_search`).
    let scoped_pid = match scoped_profile_id(&state, &headers, &addr, &q, pq.profile_id) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(pid) = id.parse::<i64>() else {
        return (StatusCode::BAD_REQUEST, "playlist id must be numeric").into_response();
    };
    let client = crate::deezer::DeezerClient::new();
    let detail = match client.get_playlist(pid).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(?e, pid, "catalog playlist failed");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"playlist_failed"})),
            )
                .into_response();
        }
    };

    // The /playlist/{id} response embeds up to ~the first page of tracks.
    // Pull the full list explicitly so long playlists aren't truncated.
    let track_hits = match client.get_playlist_tracks(pid, 100).await {
        Ok(t) if !t.is_empty() => t,
        _ => detail
            .tracks
            .as_ref()
            .map(|t| t.data.clone())
            .unwrap_or_default(),
    };
    let mut tracks: Vec<CatalogTrackOut> =
        track_hits.into_iter().map(track_hit_to_out).collect();
    {
        let conn = state.db.lock().expect("db mutex poisoned");
        if let Err(e) = annotate_with_library_state(&conn, &mut tracks, scoped_pid) {
            tracing::warn!(?e, "catalog playlist: library annotation failed");
        }
    }

    Json(CatalogPlaylistOut {
        source: "deezer",
        source_id: detail.id.to_string(),
        title: detail.title,
        cover_url: scrub_playlist_cover(detail.picture_big.or(detail.picture_medium)),
        creator: clean_playlist_creator(detail.creator.map(|u| u.name)),
        track_count: detail.nb_tracks,
        tracks,
    })
    .into_response()
}

#[derive(Deserialize)]
struct ImportPlaylistBody {
    /// Display name for the new local playlist (the catalog playlist title).
    name: String,
    /// Owning profile. Omitted (older clients) → default profile.
    #[serde(default)]
    profile_id: Option<i64>,
    /// Full track list as returned by /api/catalog/playlists/:id, passed
    /// through verbatim so we don't re-fetch.
    tracks: Vec<CatalogTrackOut>,
}

/// POST /api/playlists/import
///
/// "Save this whole catalog playlist to my library." Mirrors
/// /api/albums/import but mints a plain `local:` playlist (so the library
/// classifies it as a playlist, not an album) named after the source
/// playlist. Links every track via `upsert_track_and_link` (ISRC dedup
/// applies); tracks are stored metadata-only, audio attached later.
async fn import_playlist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(mut body): Json<ImportPlaylistBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let name = body.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name is required").into_response();
    }
    if name.chars().count() > 200 {
        return (StatusCode::BAD_REQUEST, "name too long").into_response();
    }
    if body.tracks.is_empty() {
        return (StatusCode::BAD_REQUEST, "tracks[] cannot be empty").into_response();
    }
    if body.tracks.len() > 200 {
        return (
            StatusCode::BAD_REQUEST,
            "tracks[] too large (max 200 per playlist import)",
        )
            .into_response();
    }

    // Same pre-transaction credit enrichment as import_album.
    body.tracks = with_full_credits_bulk(&state, std::mem::take(&mut body.tracks)).await;
    let total = body.tracks.len() as i64;
    let (playlist_id, freshly_linked): (i64, Vec<i64>) = {
        let mut conn = state.db.lock().expect("db mutex poisoned");
        let tx = match conn.transaction() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(?e, "import_playlist: begin tx");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        let profile_id = body
            .profile_id
            .unwrap_or_else(|| crate::profiles::default_id(&tx).unwrap_or(1));
        let playlist_id = match insert_local_playlist(&tx, name, None, profile_id) {
            Ok((id, _)) => id,
            Err(e) => {
                tracing::error!(?e, "import_playlist: create playlist");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        let mut freshly_linked = Vec::new();
        for track in &body.tracks {
            match upsert_track_and_link(&tx, playlist_id, track) {
                Ok((track_id, true)) => freshly_linked.push(track_id),
                Ok((_, false)) => { /* dup within the same playlist; ignore */ }
                Err(e) => {
                    tracing::warn!(?e, title = %track.title, "import_playlist: skipping track");
                }
            }
        }
        if let Err(e) = tx.commit() {
            tracing::error!(?e, "import_playlist: commit");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        (playlist_id, freshly_linked)
    };

    let inserted = freshly_linked.len() as i64;
    tracing::info!(playlist_id, %name, inserted, total, "imported catalog playlist");

    // Tracks are linked; audio is sourced later via local-file import.

    Json(ImportAlbumOut {
        playlist_id,
        inserted,
        total,
    })
    .into_response()
}

#[derive(Deserialize)]
struct PatchTrackPlaylistsBody {
    /// The catalog row we're managing. Used to upsert the local
    /// tracks entry if the track isn't already in the library. A
    /// `source == "local"` row is treated as an existing library
    /// track and linked by its id (never re-inserted).
    track: CatalogTrackOut,
    /// Playlist ids to ensure the track is linked to.
    #[serde(default)]
    add: Vec<i64>,
    /// Playlist ids to ensure the track is NOT linked to.
    #[serde(default)]
    remove: Vec<i64>,
}

#[derive(Serialize)]
struct PatchTrackPlaylistsOut {
    /// Local tracks.id after the upsert. The client should mirror
    /// this back into its in-memory model so subsequent calls hit
    /// the same row.
    track_id: i64,
    /// Playlist ids the track is currently in after applying the
    /// diff. Authoritative source of truth for the UI to re-render.
    in_playlist_ids: Vec<i64>,
}

/// PATCH /api/tracks/playlists
///
/// Idempotent multi-playlist editor for a catalog row. Used by the
/// Search screen's checkmark modal: the UI shows every playlist with
/// checkboxes pre-filled from `in_playlist_ids`, the user toggles
/// freely, then sends one PATCH with the diff.
///
/// Semantics:
///   - If the catalog row is new to the library, upsert it (ISRC
///     dedup against existing tracks rows still applies).
///   - Apply `add` then `remove` against playlist_tracks, with
///     locally_added=1 on newly-linked rows.
///   - The track row is created once on first add; re-adds of an
///     existing track just adjust playlist links.
async fn patch_track_playlists(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TokenQuery>,
    Json(mut body): Json<PatchTrackPlaylistsBody>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    // Every target playlist (add + remove) must be owned by the caller, so a
    // paired device can't slip another profile's playlist into the diff.
    for &pid in body.add.iter().chain(body.remove.iter()) {
        if let Err(r) = enforce_playlist_owner(&state, &headers, &addr, &q, pid) {
            return r;
        }
    }
    // Owned copies: the enrichment below replaces `body.track`, so borrows of
    // its fields must not outlive that assignment.
    let source = body.track.source.trim().to_string();
    let source_id = body.track.source_id.trim().to_string();
    if source.is_empty() || source_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing track.source/source_id").into_response();
    }
    // Enrich before the lock — the library row should be born with full credits.
    body.track = with_full_credits(&state, body.track).await;

    // Whether the track row existed before this call.
    let (track_id, was_new) = {
        let conn = state.db.lock().expect("db mutex poisoned");
        // A `source == "local"` row is ALREADY a library track — its source_id
        // is the track id. Link that existing row instead of upserting a bogus
        // "local:<id>" duplicate (the same guard resolve_catalog_track uses).
        if source == "local" {
            match lookup_local_track(&conn, &source_id) {
                Some(r) => (r.track_id, false),
                None => {
                    return (StatusCode::NOT_FOUND, "unknown local track").into_response();
                }
            }
        } else {
            // Find-or-refresh-or-insert via the canonical upsert (deterministic
            // ISRC-first dedup + metadata refresh on hit) instead of the drifted
            // inline copy this used to carry (a non-deterministic `OR ... LIMIT 1`
            // lookup that never refreshed stale rows).
            match upsert_track(&conn, &body.track) {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::error!(?e, "patch_track: upsert");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    };

    // Apply the diff inside a single transaction so a crash in the
    // middle leaves the link table consistent.
    let in_playlist_ids: Vec<i64> = {
        let mut conn = state.db.lock().expect("db mutex poisoned");
        let tx = match conn.transaction() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(?e, "patch_track: begin tx");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        for pid in &body.add {
            // Ensure playlist exists; skip gracefully otherwise.
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM playlists WHERE id = ?1",
                    params![pid],
                    |_| Ok(()),
                )
                .is_ok();
            if !exists {
                tracing::warn!(playlist_id = pid, "patch_track: add target missing");
                continue;
            }
            let already: bool = tx
                .query_row(
                    "SELECT 1 FROM playlist_tracks
                     WHERE playlist_id = ?1 AND track_id = ?2",
                    params![pid, track_id],
                    |_| Ok(()),
                )
                .is_ok();
            if already {
                continue;
            }
            let next_pos: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1
                     FROM playlist_tracks WHERE playlist_id = ?1",
                    params![pid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if let Err(e) = tx.execute(
                "INSERT INTO playlist_tracks
                     (playlist_id, track_id, position, added_at)
                 VALUES (?1, ?2, ?3, strftime('%s','now'))",
                params![pid, track_id, next_pos],
            ) {
                tracing::error!(?e, "patch_track: link insert");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            resync_track_count(&tx, *pid);
        }
        for pid in &body.remove {
            let removed = match tx.execute(
                "DELETE FROM playlist_tracks
                 WHERE playlist_id = ?1 AND track_id = ?2",
                params![pid, track_id],
            ) {
                Ok(n) => n,
                Err(e) => {
                    tracing::error!(?e, "patch_track: link delete");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            if removed > 0 {
                resync_track_count(&tx, *pid);
            }
        }
        // Snapshot the new state inside the same tx so the response
        // is authoritative.
        let now_in: Vec<i64> = match tx.prepare(
            "SELECT playlist_id FROM playlist_tracks
             WHERE track_id = ?1 ORDER BY playlist_id",
        ) {
            Ok(mut stmt) => stmt
                .query_map([track_id], |r| r.get(0))
                .ok()
                .and_then(|i| i.collect::<Result<Vec<_>, _>>().ok())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if let Err(e) = tx.commit() {
            tracing::error!(?e, "patch_track: commit");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        now_in
    };

    // Audio is sourced via local-file import.
    let _ = was_new;

    Json(PatchTrackPlaylistsOut {
        track_id,
        in_playlist_ids,
    })
    .into_response()
}

async fn stream_track(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<i64>,
    req: Request,
) -> Response {
    // LAN peers (including the Chromecast we just handed a URL to) don't
    // carry a session token — they just GET the URL. The IP allowlist
    // middleware already verified they're on a private network; trust
    // that here and skip the token check. Remote peers still need a
    // valid token (the middleware would have rejected them long before
    // reaching the handler if they didn't).
    if !is_private_addr(&effective_client_ip(&addr, &headers)) {
        if let Err(r) = require_token(&state, &headers, &q) {
            return r;
        }
    }
    // The "where is the playable file for this id" lookup is the read side of
    // the acquisition boundary. The open build's LocalFileProvider runs the
    // identical SELECT; mapping its Err -> None preserves the old
    // `.ok().flatten()` (missing row / DB error -> 404).
    let provider = crate::acquisition::active_provider();
    let local_path: Option<String> = {
        let conn = state.db.lock().expect("db mutex poisoned");
        provider.resolve_local_path(&conn, id).ok().flatten()
    };
    // If there's no local file yet and the active provider auto-acquires (the
    // full build), fetch this track on demand, then serve the result. The open
    // build's provider never auto-acquires, so this is a no-op there and the
    // request 404s exactly as before (the player then falls back to a preview).
    let local_path = match local_path {
        Some(p) => Some(p),
        None if provider.auto_acquires() => {
            // Collapse a burst of concurrent plays of the same id into a single
            // acquisition; other requests await it here, then re-resolve.
            let gate = inflight_lock(&format!("stream-acquire:{id}"));
            let _g = gate.lock().await;
            let resolved = {
                let conn = state.db.lock().expect("db mutex poisoned");
                provider.resolve_local_path(&conn, id).ok().flatten()
            };
            match resolved {
                Some(p) => Some(p),
                None => match provider
                    .acquire(
                        &state.app,
                        &state.db,
                        id,
                        crate::acquisition::AcquireSource::Auto,
                    )
                    .await
                {
                    Ok(outcome) => Some(outcome.local_path),
                    Err(e) => {
                        tracing::warn!(error = %e, id, "auto-acquire on play failed");
                        None
                    }
                },
            }
        }
        None => None,
    };
    let Some(local_path) = local_path else {
        return (StatusCode::NOT_FOUND, "no audio file for this track").into_response();
    };
    let path: PathBuf = local_path.into();
    if !path.exists() {
        return (StatusCode::GONE, "audio file missing from disk").into_response();
    }
    // ServeFile handles Range + Content-Type + Accept-Ranges + 206 for us,
    // but its Content-Type comes from `mime_guess` which maps .m4a -> the
    // non-standard "audio/m4a". iOS Safari rejects that and silently refuses
    // to decode. Force the IANA-standard MIME for the extensions we know
    // we produce (ffmpeg writes .m4a; future formats can extend).
    let override_mime = mime_for_extension(&path);
    match ServeFile::new(&path).oneshot(req).await {
        Ok(mut r) => {
            if let Some(mime) = override_mime {
                r.headers_mut().insert(
                    header::CONTENT_TYPE,
                    header::HeaderValue::from_static(mime),
                );
            }
            r.into_response()
        }
        Err(e) => {
            tracing::error!(?e, "stream serve");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Instant playback for a non-downloaded track: ask the active provider for a
/// seekable local file (the full build resolves + remuxes the source to a temp
/// file; the open build returns `None`), then range-serve it exactly like
/// `stream_track`. `None`/error -> 404, and the player falls back to a preview.
/// GET /api/streaming/health — whether instant streaming is degraded.
///
/// `degraded_since` is unix seconds when the provider's fast route tripped its
/// alarm, or null while healthy. Lets the Settings page say "using the slower
/// route since <date>" instead of users discovering it as unexplained
/// slowness. The built-in provider always reports healthy.
async fn streaming_health(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if let Err(r) = require_token(&state, &headers, &q) {
        return r;
    }
    let since = crate::acquisition::active_provider()
        .live_health(&state.db)
        .await;
    Json(serde_json::json!({ "degraded_since": since })).into_response()
}

/// Query for `/stream/{id}/live`: the session token plus an optional `warm`
/// marker. Players send `warm=1` on the prefetch that readies the NEXT queue
/// entries — nobody is listening for that response, so the provider may let a
/// real tap overtake it. Absent on actual playback loads, including the
/// element's own fallback when a prefetched copy is missing.
#[derive(Deserialize, Default)]
struct LiveStreamQuery {
    t: Option<String>,
    warm: Option<String>,
}

async fn stream_track_live(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<LiveStreamQuery>,
    Path(id): Path<i64>,
    req: Request,
) -> Response {
    if !is_private_addr(&effective_client_ip(&addr, &headers)) {
        let tq = TokenQuery { t: q.t.clone() };
        if let Err(r) = require_token(&state, &headers, &tq) {
            return r;
        }
    }
    // Any value but an explicit off counts as warm — the marker either
    // travelled or it didn't.
    let warm = q
        .warm
        .as_deref()
        .is_some_and(|w| w != "0" && !w.eq_ignore_ascii_case("false"));
    let path = match crate::acquisition::active_provider()
        .live_path(&state.app, &state.db, id, warm)
        .await
    {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "no live stream for this track").into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, id, "live stream resolve failed");
            return (StatusCode::NOT_FOUND, "live stream unavailable").into_response();
        }
    };
    let path: PathBuf = path.into();
    if !path.exists() {
        return (StatusCode::GONE, "live audio missing from disk").into_response();
    }
    let override_mime = mime_for_extension(&path);
    match ServeFile::new(&path).oneshot(req).await {
        Ok(mut r) => {
            if let Some(mime) = override_mime {
                r.headers_mut()
                    .insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
            }
            r.into_response()
        }
        Err(e) => {
            tracing::error!(?e, "live serve");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Per-key async lock that collapses a burst of identical concurrent requests
/// into one: only the first caller does the work, the rest await and share its
/// cached result. Used to dedup overlapping fetches (e.g. the home feed).
fn inflight_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static INFLIGHT: std::sync::OnceLock<
        Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();
    let map = INFLIGHT.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut m = map.lock().expect("inflight map poisoned");
    m.entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ---- Helpers ----------------------------------------------------------

/// Pick the IANA-standard audio MIME for file extensions we know we emit.
/// Returns `None` for unknown extensions; callers fall back to whatever
/// `tower_http::ServeFile` inferred. The .m4a case is the important one --
/// iOS Safari refuses `audio/m4a` (the default mime_guess output) and only
/// progressively decodes when it sees `audio/mp4`.
fn mime_for_extension(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "m4a" | "mp4" | "m4b" => Some("audio/mp4"),
        "mp3" => Some("audio/mpeg"),
        "opus" => Some("audio/ogg; codecs=opus"),
        "ogg" | "oga" => Some("audio/ogg"),
        "webm" => Some("audio/webm"),
        "flac" => Some("audio/flac"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn read_bool_setting(conn: &Connection, key: &str) -> Option<bool> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .ok();
    v.and_then(|s| match s.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    })
}

// ---- /cert handlers --------------------------------------------------
//
// Three endpoints together drive the iOS trust flow:
//
//   GET /cert                         -- HTML landing with install
//                                        instructions and download links.
//   GET /cert/beetbot.crt             -- Raw PEM cert.
//   GET /cert/beetbot.mobileconfig    -- Apple Configuration Profile that
//                                        installs the cert into the iPhone's
//                                        keychain in a single tap.
//
// After installing the profile, iOS still requires the user to flip
// Settings > General > About > Certificate Trust Settings to "Enable
// Full Trust" for our cert. The landing page calls this out.

async fn cert_landing(State(state): State<AppState>) -> Response {
    // No auth, no IP gating beyond the global middleware. This is the
    // first page a phone hits before it can even establish HTTPS.
    let host_label = state
        .hostname_bare
        .as_deref()
        .map(|s| s.as_str())
        .unwrap_or("Beetbot");
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trust {host} on this device</title>
  <style>
    body {{ font: -apple-system-body, system-ui, sans-serif;
            background: #0a0a0a; color: #f5f5f5;
            margin: 0; padding: 24px; line-height: 1.5; }}
    h1 {{ font-size: 20px; margin-top: 0; }}
    a.button {{ display: inline-block;
                background: #10b981; color: #0a0a0a;
                padding: 12px 18px; border-radius: 8px;
                text-decoration: none; font-weight: 600;
                margin: 4px 0; }}
    a.alt {{ color: #d4d4d4; text-decoration: underline; font-size: 14px; }}
    ol {{ padding-left: 20px; }}
    ol li {{ margin: 6px 0; }}
    code {{ background: #1a1a1a; padding: 2px 6px;
            border-radius: 4px; font-family: ui-monospace, monospace; }}
    .note {{ color: #a3a3a3; font-size: 13px;
             border-left: 3px solid #404040; padding-left: 10px;
             margin: 16px 0; }}
  </style>
</head>
<body>
  <h1>Trust {host} on this device</h1>
  <p>To play music offline on iPhone, this device needs to trust
  {host}'s LAN certificate. It takes about 30 seconds.</p>

  <p><a class="button" href="/cert/beetbot.mobileconfig"
        download="beetbot.mobileconfig">Install Profile (iPhone)</a></p>

  <ol>
    <li>Tap <strong>Install Profile</strong> above.</li>
    <li>Open the iPhone <strong>Settings</strong> app -- you'll see
        <em>Profile Downloaded</em> at the top.</li>
    <li>Tap <strong>Install</strong> (top-right), enter your passcode,
        and tap <strong>Install</strong> twice more to confirm.</li>
    <li>Open <strong>Settings &gt; General &gt; About &gt; Certificate Trust
        Settings</strong> and turn on the toggle for <code>Beetbot LAN</code>.</li>
    <li>Come back and open the HTTPS link from your computer's Beetbot
        Devices page. Music will play offline.</li>
  </ol>

  <p class="note">This certificate is generated on your computer and never
  leaves your local network. It only signs requests for your computer's
  <code>.local</code> hostname.</p>

  <p><a class="alt" href="/cert/beetbot.crt">Download raw .crt instead</a></p>
</body>
</html>"#,
        host = html_escape(host_label),
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

async fn cert_pem_download(State(state): State<AppState>) -> Response {
    let Some(pem) = state.cert_pem.as_ref() else {
        return (StatusCode::NOT_FOUND, "no certificate configured").into_response();
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-pem-file"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"beetbot.crt\"",
            ),
        ],
        pem.as_str().to_owned(),
    )
        .into_response()
}

async fn mobileconfig_download(State(state): State<AppState>) -> Response {
    let Some(pem) = state.cert_pem.as_ref() else {
        return (StatusCode::NOT_FOUND, "no certificate configured").into_response();
    };
    let host_bare = state
        .hostname_bare
        .as_deref()
        .map(|s| s.as_str())
        .unwrap_or("beetbot");
    let xml = build_mobileconfig_xml(host_bare, pem);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-apple-aspen-config"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"beetbot.mobileconfig\"",
            ),
        ],
        xml,
    )
        .into_response()
}

/// Assemble an Apple Configuration Profile (unsigned) that installs our
/// self-signed cert. Unsigned profiles trigger a yellow "Unsigned" warning
/// on iOS but install fine after the user confirms.
fn build_mobileconfig_xml(host_bare: &str, cert_pem: &str) -> String {
    // Strip the PEM headers and newlines: the .mobileconfig payload wants
    // pure base64 inside a <data> tag.
    let base64_body: String = cert_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.chars())
        .collect();
    let payload_uuid = uuid::Uuid::new_v4();
    let profile_uuid = uuid::Uuid::new_v4();
    let display_name = format!("Beetbot LAN ({host_bare})");
    let identifier_base = host_bare.to_ascii_lowercase().replace('.', "-");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.beetbot.lan.{identifier_base}.cert</string>
      <key>PayloadUUID</key>
      <string>{payload_uuid}</string>
      <key>PayloadDisplayName</key>
      <string>Beetbot LAN Certificate</string>
      <key>PayloadDescription</key>
      <string>Self-signed certificate for the Beetbot HTTPS server on your local network.</string>
      <key>PayloadCertificateFileName</key>
      <string>beetbot.crt</string>
      <key>PayloadContent</key>
      <data>
{base64_body}
      </data>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.beetbot.lan.{identifier_base}</string>
  <key>PayloadUUID</key>
  <string>{profile_uuid}</string>
  <key>PayloadDisplayName</key>
  <string>{display_name}</string>
  <key>PayloadDescription</key>
  <string>Trusts the Beetbot LAN server so this device can use offline playback and Add to Home Screen.</string>
  <key>PayloadOrganization</key>
  <string>Beetbot</string>
</dict>
</plist>
"#
    )
}

fn html_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&#39;".into(),
            c => c.to_string(),
        })
        .collect()
}

fn label_from_user_agent(ua: &str) -> String {
    if ua.is_empty() {
        return "Unknown device".into();
    }
    let lc = ua.to_lowercase();
    if lc.contains("iphone") {
        "iPhone".into()
    } else if lc.contains("ipad") {
        "iPad".into()
    } else if lc.contains("android") {
        "Android".into()
    } else if lc.contains("macintosh") || lc.contains("mac os") {
        "Mac".into()
    } else if lc.contains("windows") {
        "Windows".into()
    } else if lc.contains("linux") {
        "Linux".into()
    } else {
        ua.chars().take(40).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This file's own source. Some invariants live in the SHAPE of the code
    /// rather than in any value it computes, and this is the only way to assert
    /// them.
    const OWN_SOURCE: &str = include_str!("mod.rs");

    /// A profile id arriving in a query string is a CLAIM, not an identity: a
    /// paired device can put any number there. It only becomes an identity after
    /// `scoped_profile_id` / `read_scope_profile` checks it against the profile
    /// bound to that device's session.
    ///
    /// Five handlers once used the claim directly — `/api/station` served a
    /// station built from another profile's play history and bans, `/api/devices`
    /// listed their devices and what they were playing right now, and
    /// search/browse/album/artist leaked which of their playlists held a track.
    /// Each was a one-line read, and each looked completely ordinary.
    ///
    /// So: every client-supplied profile id must be handed to a gate, and to
    /// nothing else. A handler that forgets is not subtly wrong — it doesn't
    /// compile past this test.
    ///
    /// One line legitimately can't use a gate — `bind_session_profile`, where
    /// the id IS the request ("let me become this profile") and the PIN is the
    /// check. It says so with a `scope-exempt:` marker, which forces the next
    /// person who needs one to write down why.
    #[test]
    fn a_client_supplied_profile_id_is_only_ever_passed_to_a_gate() {
        // Bindings that hold a deserialized query/body — i.e. attacker-chosen.
        // `e.profile_id`, `entry.profile_id` etc. are internal state, not claims.
        const CLIENT_BINDINGS: [&str; 3] = ["q.profile_id", "pq.profile_id", "body.profile_id"];
        // Only scan the real code: this test names the bindings in its own body.
        let code_only = OWN_SOURCE.split("#[cfg(test)]").next().unwrap_or(OWN_SOURCE);
        let mut ungated: Vec<(usize, String)> = Vec::new();
        for (i, line) in code_only.lines().enumerate() {
            let code = line.split("//").next().unwrap_or(line); // ignore comments
            if !CLIENT_BINDINGS.iter().any(|b| code.contains(b)) {
                continue;
            }
            let gated = code.contains("scoped_profile_id(")
                || code.contains("read_scope_profile(")
                || line.contains("scope-exempt:");
            if !gated {
                ungated.push((i + 1, line.trim().to_string()));
            }
        }
        assert!(
            ungated.is_empty(),
            "a client-supplied profile_id is used without passing it through \
             scoped_profile_id/read_scope_profile — that hands one profile's data to \
             whoever asks for it:\n{}",
            ungated
                .iter()
                .map(|(n, l)| format!("  mod.rs:{n}: {l}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    /// The two `*_decision` functions take a `bool` for "is this the trusted
    /// owner", and every test above hands them that bool directly — so the policy
    /// can be flawless while the SHELL computes the bool wrongly, and not one
    /// unit test moves. That is exactly what happened. Four authorization sites
    /// asked `.is_loopback()`, which the Meradomo agent turns into `true` for
    /// every phone on earth: it proxies to `127.0.0.1` and deliberately sends no
    /// `X-Forwarded-For`, so "loopback" stopped being evidence of anything.
    ///
    /// What each one handed a paired phone, in one line of code each: any
    /// profile's device list and `now_playing` (`scoped_profile_id`); any
    /// profile's playlists, library and Home feed (`read_scope_profile`); the
    /// right to rename or delete any profile's playlist
    /// (`enforce_playlist_owner`); and the right to delete any profile outright
    /// (`delete_profile_handler`).
    ///
    /// The predicate that means "the owner" is [`is_this_machine`] — loopback AND
    /// no `X-Meradomo-*` headers. `.is_loopback()` still has honest uses in this
    /// file (LAN gating, pairing bypass, rate-limit exemption, audit logging), so
    /// don't ban it globally — pin the rule exactly where it broke: an
    /// authorization site classifies the owner with `is_this_machine`, never with
    /// loopback alone.
    #[test]
    fn every_authorization_site_asks_is_this_machine_not_merely_is_it_loopback() {
        const AUTHORIZATION_SITES: [&str; 4] = [
            "fn scoped_profile_id(",
            "fn read_scope_profile(",
            "fn enforce_playlist_owner(",
            "async fn delete_profile_handler(",
        ];
        let code_only = OWN_SOURCE.split("#[cfg(test)]").next().unwrap_or(OWN_SOURCE);
        for site in AUTHORIZATION_SITES {
            let (_, rest) = code_only
                .split_once(site)
                .unwrap_or_else(|| panic!("{site} vanished — this test needs rewriting"));
            // Function bodies here all end at the first column-zero `}`.
            let body = rest.split_once("\n}\n").map_or(rest, |(b, _)| b);
            let code: String = body
                .lines()
                .filter_map(|l| l.split("//").next())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code.contains(".is_loopback()"),
                "{site} decides authorization from bare loopback. Behind the Meradomo \
                 tunnel that makes every paired device the owner. Use \
                 is_this_machine(headers, addr).",
            );
            assert!(
                code.contains("is_this_machine("),
                "{site} no longer asks is_this_machine — whatever gate follows is only \
                 as good as the bool it is handed.",
            );
        }
    }

    /// The gates need the peer address to tell the trusted owner from
    /// a paired device. A handler that doesn't take `ConnectInfo<SocketAddr>`
    /// *cannot* call one — the omission is what made the leaks possible, and it
    /// is invisible at the call site. Catch it at the signature instead.
    #[test]
    fn every_handler_taking_a_profile_id_can_actually_check_it() {
        // Query types whose fields include a profile_id (i.e. carry a claim).
        let profile_bearing: Vec<&str> = ["ProfileQuery", "PlaylistsQuery", "SearchQuery",
            "BrowseQuery", "DeviceQuery", "LikedQuery", "StatsQuery"]
            .into_iter()
            .filter(|t| {
                OWN_SOURCE
                    .split(&format!("struct {t}"))
                    .nth(1)
                    .and_then(|rest| rest.split('}').next())
                    .is_some_and(|body| body.contains("profile_id"))
            })
            .collect();
        assert!(!profile_bearing.is_empty(), "test is broken, not the code");

        let mut gaps: Vec<String> = Vec::new();
        for chunk in OWN_SOURCE.split("async fn ").skip(1) {
            let name = chunk.split('(').next().unwrap_or("?").trim().to_string();
            let Some(sig) = chunk.split(") -> Response").next() else {
                continue; // not a handler
            };
            if sig.len() > 2_000 {
                continue; // ran past the signature into a body
            }
            let takes_claim = profile_bearing
                .iter()
                .any(|t| sig.contains(&format!("Query<{t}>")));
            // handoff/remote-command take DeviceQuery but key on device_id and
            // never read the profile claim; the previous test proves that.
            let reads_claim = chunk
                .split("\n}")
                .next()
                .is_some_and(|body| body.contains(".profile_id"));
            if takes_claim && reads_claim && !sig.contains("ConnectInfo") {
                gaps.push(name);
            }
        }
        assert!(
            gaps.is_empty(),
            "these handlers read a client-supplied profile_id but don't take \
             ConnectInfo<SocketAddr>, so they CANNOT scope it to the caller: {gaps:?}\n\
             Add `ConnectInfo(addr): ConnectInfo<SocketAddr>,` and route the id through \
             scoped_profile_id (see `home_handler`).",
        );
    }

    /// The rule that decides who reads whose data. Every leak this file has had
    /// was a handler failing to ASK this question — but the answer itself had
    /// never been tested either, because it was welded to `AppState` (which owns
    /// a `tauri::AppHandle` and so can't be built in a test). It's `scope_decision`
    /// now, and these are the cases that matter.
    #[test]
    fn a_paired_device_is_who_its_session_says_it_is_whatever_it_asks_for() {
        const GUEST: i64 = 2;
        const OWNER: i64 = 1;

        // No provider in front, so no guest, in every case below.
        let nobody = || None;

        // THE attack: the guest's phone, bound to the guest, asks for the owner's id.
        assert_eq!(
            scope_decision(false, Some(OWNER), nobody, || Some(GUEST)),
            Some(Some(GUEST)),
            "a paired device widened its scope by asking — this is the leak",
        );
        // Asking for nothing doesn't widen it either.
        assert_eq!(scope_decision(false, None, nobody, || Some(GUEST)), Some(Some(GUEST)));
        // Asking for its own id is the ordinary case.
        assert_eq!(scope_decision(false, Some(GUEST), nobody, || Some(GUEST)), Some(Some(GUEST)));

        // Paired but no profile chosen yet: reads nothing. NOT the owner's
        // default — falling back to a real profile here would hand a fresh
        // device someone's library.
        assert_eq!(scope_decision(false, Some(OWNER), nobody, || None), None, "unbound session got data");
        assert_eq!(scope_decision(false, None, nobody, || None), None);

        // Loopback is the owner (the desktop webview switching profiles in-app):
        // its claim stands verbatim, including the no-profile scope.
        assert_eq!(scope_decision(true, Some(OWNER), nobody, || Some(GUEST)), Some(Some(OWNER)));
        assert_eq!(scope_decision(true, None, nobody, || Some(GUEST)), Some(None));
        assert_eq!(scope_decision(true, Some(GUEST), nobody, || None), Some(Some(GUEST)));
    }

    /// A guest signed in by a sharing provider is their own account, and asking
    /// for somebody else's id does not change that.
    ///
    /// The ordering matters as much as the rule: a guest's account wins over the
    /// session binding, because a shared link opened on a phone that ALSO happens
    /// to be paired to this server over the local network would otherwise read as
    /// whoever that pairing chose.
    #[test]
    fn a_guest_reads_their_own_account_and_nobody_elses() {
        const GUEST: i64 = 2;
        const OWNER: i64 = 1;
        const SAM: i64 = 7;

        assert_eq!(
            scope_decision(false, Some(OWNER), || Some(SAM), || Some(GUEST)),
            Some(Some(SAM)),
            "a guest reached another account by asking",
        );
        assert_eq!(scope_decision(false, None, || Some(SAM), || None), Some(Some(SAM)));

        // A guest whose account could not be resolved falls through to the
        // session rule — and with no session, reads nothing at all. Never the
        // owner's library.
        assert_eq!(scope_decision(false, Some(OWNER), || None, || None), None);

        // The desktop is still the desktop. A provider cannot reach it anyway,
        // but the ordering is stated rather than assumed.
        assert_eq!(scope_decision(true, Some(OWNER), || Some(SAM), || None), Some(Some(OWNER)));
    }

    /// The same rule for reads, where the owner falls back to a default profile
    /// and a guest deliberately does not.
    #[test]
    fn a_guest_reading_never_falls_back_to_the_default_profile() {
        const DEFAULT: i64 = 1;
        const SAM: i64 = 7;

        assert_eq!(
            read_scope_decision(false, None, || DEFAULT, || Some(SAM), || None),
            Some(SAM),
        );
        // Unresolvable guest, no session: empty, not the default. Falling back
        // here would serve a stranger the owner's whole library.
        assert_eq!(
            read_scope_decision(false, None, || DEFAULT, || None, || None),
            None,
            "a guest was handed the default profile's library",
        );
        // The owner on the desktop still gets the default when they claim nothing.
        assert_eq!(
            read_scope_decision(true, None, || DEFAULT, || None, || None),
            Some(DEFAULT),
        );
    }

    /// The rule above is only ever as good as the `bool` handed to it, and for
    /// most of this file's life the shell computed that from loopback alone.
    /// Behind the Meradomo tunnel that is the owner's entire authority given
    /// away: the agent proxies to `127.0.0.1` and deliberately sends no
    /// `X-Forwarded-For`, so a phone anywhere in the world is loopback, the first
    /// branch returns its claim verbatim, and the two branches this file keeps
    /// calling the point are never reached.
    ///
    /// Confirmed against a running 0.3.6 build before the fix: a session that had
    /// never chosen a profile POSTed `/api/devices/heartbeat` with
    /// `profile_id: 1`, got `204`, and read its own device back out of
    /// `GET /api/devices?profile_id=1` — both halves of the leak
    /// `devices_heartbeat` documents itself as preventing.
    ///
    /// So assert the predicate and the policy TOGETHER. Neither is wrong alone.
    #[test]
    fn a_tunnelled_device_is_not_the_owner_however_loopback_it_looks() {
        const GUEST: i64 = 2;
        const OWNER: i64 = 1;

        let mut via_tunnel = HeaderMap::new();
        via_tunnel.insert("x-meradomo-email", "owner@example.com".parse().unwrap());
        let tunnelled = is_this_machine(&via_tunnel, &peer("127.0.0.1"));

        // the guest's phone, through the tunnel, names the owner's profile. Loopback by
        // peer address, and it must still be told it is the guest.
        assert_eq!(
            scope_decision(tunnelled, Some(OWNER), || None, || Some(GUEST)),
            Some(Some(GUEST)),
            "a tunnelled device claimed another profile and was believed",
        );

        // Paired but never bound: reads nothing. This is the case the loopback
        // branch used to answer first, so the rule never applied at all.
        assert_eq!(
            scope_decision(tunnelled, Some(OWNER), || None, || None),
            None,
            "an unbound tunnelled session was handed a profile",
        );
        assert_eq!(scope_decision(tunnelled, None, || None, || None), None);

        // The desktop webview is untouched: real loopback, no tunnel headers, so
        // its in-app profile switching still speaks for itself.
        let owner = is_this_machine(&HeaderMap::new(), &peer("127.0.0.1"));
        assert_eq!(
            scope_decision(owner, Some(OWNER), || None, || Some(GUEST)),
            Some(Some(OWNER)),
            "the owner lost its own profile switching",
        );
    }

    /// The loopback branch must not pay for the session lookup — it takes the db
    /// lock, and `scoped_profile_id` is documented as callable before the caller
    /// takes it. A lookup here would be a deadlock waiting for a caller to hold
    /// the lock first.
    #[test]
    fn the_owner_path_never_touches_the_session_store() {
        let mut looked_up = false;
        let mut guest_looked_up = false;
        let _ = scope_decision(
            true,
            Some(1),
            || {
                guest_looked_up = true;
                Some(3)
            },
            || {
                looked_up = true;
                Some(2)
            },
        );
        assert!(!looked_up, "loopback consulted the session store — that risks the db-lock deadlock");
        assert!(!guest_looked_up, "loopback resolved a guest account — same db lock, same deadlock");
    }

    /// The same rule for the READ endpoints — the library list, the Home feed,
    /// the playlist list. Same threat, same answer; it only parts company with
    /// `scope_decision` on what an absent claim means to the owner.
    #[test]
    fn a_paired_device_cannot_read_another_profiles_library_by_asking() {
        const GUEST: i64 = 2;
        const OWNER: i64 = 1;
        const DEFAULT: i64 = 7;

        // No provider in front, so no guest, in every case below.
        let nobody = || None;

        // The attack: the guest's phone asks for the owner's library. It gets the guest's.
        assert_eq!(
            read_scope_decision(false, Some(OWNER), || DEFAULT, nobody, || Some(GUEST)),
            Some(GUEST),
            "a paired device read another profile by naming it — this is the leak",
        );
        assert_eq!(read_scope_decision(false, None, || DEFAULT, nobody, || Some(GUEST)), Some(GUEST));

        // Unbound reads NOTHING. Not the default, not the owner's — callers turn
        // this None into an empty list. Falling back here is the whole bug class.
        assert_eq!(
            read_scope_decision(false, Some(OWNER), || DEFAULT, nobody, || None),
            None,
            "an unbound session was handed a profile's library",
        );

        // Loopback (the owner): claim honoured; no claim → the default profile,
        // because "no profile" isn't a sensible library to show.
        assert_eq!(read_scope_decision(true, Some(OWNER), || DEFAULT, nobody, || Some(GUEST)), Some(OWNER));
        assert_eq!(read_scope_decision(true, None, || DEFAULT, nobody, || Some(GUEST)), Some(DEFAULT));
    }

    /// The read gate's half of the tunnel bug — worse than the write gate's,
    /// because its owner branch resolves an absent claim to a REAL profile.
    /// Trusting loopback here didn't merely let a phone name someone else's
    /// library (`/api/playlists`, `/api/library/songs`, `/api/home`); a phone
    /// that had never chosen a profile got the DEFAULT one's library by asking
    /// for nothing at all.
    #[test]
    fn a_tunnelled_device_cannot_read_a_library_by_looking_local() {
        const GUEST: i64 = 2;
        const OWNER: i64 = 1;
        const DEFAULT: i64 = 7;

        let mut via_tunnel = HeaderMap::new();
        via_tunnel.insert("x-meradomo-email", "owner@example.com".parse().unwrap());
        let tunnelled = is_this_machine(&via_tunnel, &peer("127.0.0.1"));

        assert_eq!(
            read_scope_decision(tunnelled, Some(OWNER), || DEFAULT, || None, || Some(GUEST)),
            Some(GUEST),
            "a tunnelled device read the library it named",
        );
        assert_eq!(
            read_scope_decision(tunnelled, None, || DEFAULT, || None, || None),
            None,
            "an unbound tunnelled session was handed the default profile's library",
        );

        // The desktop webview keeps both of its behaviours.
        let owner = is_this_machine(&HeaderMap::new(), &peer("127.0.0.1"));
        assert_eq!(
            read_scope_decision(owner, Some(OWNER), || DEFAULT, || None, || Some(GUEST)),
            Some(OWNER),
        );
        assert_eq!(
            read_scope_decision(owner, None, || DEFAULT, || None, || Some(GUEST)),
            Some(DEFAULT),
        );
    }

    /// Each branch needs exactly one of the two db-locking lookups; taking the
    /// other is wasted work at best and, for the session store on the loopback
    /// path, the same lock hazard as above.
    #[test]
    fn read_scope_only_pays_for_the_lookup_its_branch_needs() {
        let (mut default_hit, mut guest_hit, mut session_hit) = (false, false, false);
        let _ = read_scope_decision(
            true,
            None,
            || {
                default_hit = true;
                7
            },
            || {
                guest_hit = true;
                Some(3)
            },
            || {
                session_hit = true;
                Some(2)
            },
        );
        assert!(default_hit, "owner with no claim must resolve the default profile");
        assert!(!session_hit, "loopback consulted the session store");
        assert!(!guest_hit, "loopback resolved a guest account — same db lock, same hazard");

        let (mut default_hit, mut guest_hit, mut session_hit) = (false, false, false);
        let _ = read_scope_decision(
            false,
            Some(1),
            || {
                default_hit = true;
                7
            },
            || {
                guest_hit = true;
                Some(3)
            },
            || {
                session_hit = true;
                Some(2)
            },
        );
        assert!(!default_hit, "a paired device resolved the owner's default profile");
        assert!(guest_hit, "the guest branch must be consulted before the session");
        assert!(!session_hit, "a guest account was found and the session was consulted anyway");
    }

    fn peer(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 50000)
    }

    /// Who is shown the list of accounts on this machine.
    ///
    /// This is load-bearing. Auto-creating an account for everybody the owner
    /// shares with means the profile list stops being "my family" and becomes "a
    /// list of people", and a picker over that list is a way into somebody else's
    /// library. The desktop is the owner's own machine and sees everything; every
    /// other caller sees strictly less.
    #[test]
    fn a_guest_is_shown_their_own_account_and_no_sign_of_anybody_elses() {
        assert_eq!(profile_view(false, Some(7)), ProfileView::JustTheirs(7));
    }

    #[test]
    fn a_device_paired_over_the_local_network_never_sees_remote_accounts() {
        // Pairing proves somebody typed a code that was on the screen. That is
        // enough to reach the music in the house; it is not enough to be offered
        // the account of somebody the owner shared with over the internet.
        assert_eq!(profile_view(false, None), ProfileView::LocalOnly);
    }

    #[test]
    fn the_desktop_sees_every_account_on_its_own_machine() {
        assert_eq!(profile_view(true, None), ProfileView::All);
        // Even if identity headers somehow reached it, this machine is this
        // machine — the first branch decides.
        assert_eq!(profile_view(true, Some(7)), ProfileView::All);
    }

    /// A device reached through the Meradomo tunnel arrives from loopback (the
    /// agent proxies to 127.0.0.1), so loopback alone can't mean "this Mac" —
    /// it named every remote device after the host, and a phone showed up in
    /// its owner's own device list as "a MacBook Pro (2)".
    #[test]
    fn tunnel_identity_headers_mean_the_client_is_not_this_machine() {
        // The desktop webview: real loopback, no tunnel headers → this machine.
        assert!(is_this_machine(&HeaderMap::new(), &peer("127.0.0.1")));

        // A phone through the agent: also loopback, but carrying the identity
        // headers the agent injects → NOT this machine.
        let mut via_tunnel = HeaderMap::new();
        via_tunnel.insert("x-meradomo-email", "owner@example.com".parse().unwrap());
        assert!(!is_this_machine(&via_tunnel, &peer("127.0.0.1")));

        // Any other X-Meradomo-* header is equally proof of the tunnel.
        let mut only_role = HeaderMap::new();
        only_role.insert("x-meradomo-role", "owner".parse().unwrap());
        assert!(!is_this_machine(&only_role, &peer("127.0.0.1")));

        // A LAN client is not this machine either, headers or no headers.
        assert!(!is_this_machine(&HeaderMap::new(), &peer("192.168.1.40")));
    }

    fn xff(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    /// Every trust decision in this file — pairing bypass, LAN allow, and which
    /// profile a request may read — hangs off this one function. It had no test.
    ///
    /// The rule: consult `X-Forwarded-For` ONLY when the TCP peer is already
    /// loopback, so the header can lower trust (our tunnel naming its real
    /// caller) but never raise it.
    #[test]
    fn effective_client_ip_never_lets_a_header_grant_owner_trust() {
        // The desktop webview: real loopback, no header → owner.
        assert!(effective_client_ip(&peer("127.0.0.1"), &HeaderMap::new()).is_loopback());

        // The attack that matters: a remote caller forging the header. Its TCP
        // peer isn't loopback, so the header is ignored outright — no amount of
        // XFF makes you the owner.
        let forged = effective_client_ip(&peer("203.0.113.9"), &xff("127.0.0.1"));
        assert_eq!(forged, peer("203.0.113.9").ip(), "a forged XFF took owner trust");
        assert!(!forged.is_loopback());
        // Same for a LAN peer trying it.
        assert!(!effective_client_ip(&peer("192.168.1.50"), &xff("127.0.0.1")).is_loopback());

        // Our tunnel connects FROM loopback and names the real caller: trust is
        // downgraded to that caller, who then faces the remote gate + pairing.
        let tunnelled = effective_client_ip(&peer("127.0.0.1"), &xff("198.51.100.7"));
        assert_eq!(tunnelled, "198.51.100.7".parse::<IpAddr>().unwrap());
        assert!(!tunnelled.is_loopback(), "a tunnelled phone must not inherit owner trust");

        // A tunnelled caller who prepends their own entry: the proxy appends its
        // observation on the RIGHT, so the rightmost wins and the forgery on the
        // left is ignored.
        let spoofed = effective_client_ip(&peer("127.0.0.1"), &xff("127.0.0.1, 198.51.100.7"));
        assert_eq!(
            spoofed,
            "198.51.100.7".parse::<IpAddr>().unwrap(),
            "took a client-supplied leftmost XFF entry over the proxy's own",
        );

        // Junk in the header must not be read as loopback — fall back to the peer.
        assert!(effective_client_ip(&peer("127.0.0.1"), &xff("not-an-ip")).is_loopback());
    }

    #[test]
    fn rfc1918_ipv4_passes() {
        for ip in [
            "10.0.0.1",
            "192.168.1.5",
            "172.16.10.10",
            "127.0.0.1",
            "169.254.1.1",
        ] {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(is_private_addr(&addr), "{ip} should be allowed");
        }
    }

    #[test]
    fn public_ipv4_rejected() {
        for ip in ["8.8.8.8", "1.2.3.4", "172.32.0.1"] {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(!is_private_addr(&addr), "{ip} should be rejected");
        }
    }

    #[test]
    fn ipv6_link_local_and_loopback_pass() {
        for ip in ["::1", "fe80::1", "fc00::1", "fd12:3456::1"] {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(is_private_addr(&addr), "{ip} should be allowed");
        }
    }

    #[test]
    fn ipv6_public_rejected() {
        for ip in ["2001:db8::1", "2606:4700::1111"] {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(!is_private_addr(&addr), "{ip} should be rejected");
        }
    }

    #[test]
    fn ipv4_mapped_ipv6_checks_embedded_v4() {
        let v4_mapped_private: IpAddr = "::ffff:192.168.1.1".parse().unwrap();
        assert!(is_private_addr(&v4_mapped_private));
        let v4_mapped_public: IpAddr = "::ffff:8.8.8.8".parse().unwrap();
        assert!(!is_private_addr(&v4_mapped_public));
    }

    #[test]
    fn effective_ip_preserves_genuine_loopback() {
        // The desktop webview: loopback peer, no forwarding header -> stays
        // loopback so the owner keeps the pairing bypass.
        let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        assert!(effective_client_ip(&addr, &HeaderMap::new()).is_loopback());
    }

    #[test]
    fn effective_ip_downgrades_tunnelled_loopback() {
        // ngrok connects from loopback but stamps the real remote client. That
        // must be reclassified to a public peer (no LAN trust, pairing applies).
        let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        let ip = effective_client_ip(&addr, &headers);
        assert_eq!(ip, "203.0.113.7".parse::<IpAddr>().unwrap());
        assert!(!is_private_addr(&ip), "tunnelled public client must not be LAN-trusted");
    }

    #[test]
    fn effective_ip_uses_rightmost_xff_entry() {
        // A client forging a loopback entry on the LEFT must not win — the proxy
        // appends the address it actually observed on the right.
        let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "127.0.0.1, 203.0.113.7".parse().unwrap());
        let ip = effective_client_ip(&addr, &headers);
        assert_eq!(ip, "203.0.113.7".parse::<IpAddr>().unwrap());
        assert!(!ip.is_loopback(), "client-forged loopback entry must be ignored");
    }

    #[test]
    fn effective_ip_ignores_xff_from_nonloopback_peer() {
        // A LAN/remote peer cannot forge X-Forwarded-For to claim loopback: the
        // header is consulted only when the TCP peer is itself loopback.
        let addr: SocketAddr = "192.168.1.50:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        let ip = effective_client_ip(&addr, &headers);
        assert_eq!(ip, "192.168.1.50".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn mime_override_for_m4a_is_ios_safari_friendly() {
        // The critical case: iOS Safari refuses `audio/m4a` (mime_guess's
        // default for .m4a) and only progressively decodes when it sees
        // `audio/mp4`. This test pins the override.
        assert_eq!(
            mime_for_extension(std::path::Path::new("foo.m4a")),
            Some("audio/mp4")
        );
        assert_eq!(
            mime_for_extension(std::path::Path::new("foo.M4A")),
            Some("audio/mp4")
        );
        assert_eq!(
            mime_for_extension(std::path::Path::new("/tmp/Tame Impala - XO.m4a")),
            Some("audio/mp4")
        );
        assert_eq!(
            mime_for_extension(std::path::Path::new("foo.mp3")),
            Some("audio/mpeg")
        );
        assert_eq!(
            mime_for_extension(std::path::Path::new("foo.opus")),
            Some("audio/ogg; codecs=opus")
        );
        assert_eq!(mime_for_extension(std::path::Path::new("foo")), None);
        assert_eq!(mime_for_extension(std::path::Path::new("foo.xyz")), None);
    }

    #[test]
    fn user_agent_label_examples() {
        assert_eq!(label_from_user_agent(""), "Unknown device");
        assert_eq!(
            label_from_user_agent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
            "iPhone"
        );
        assert_eq!(
            label_from_user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
            "Mac"
        );
    }

    // ------------------------------------------------------------------
    // Home-feed test fixtures (P0). The db::tests `fresh_db` helper is private
    // to that module, so we inline the same 3-line opener here — `db::open`
    // applies every real migration, giving builders a true schema.
    // ------------------------------------------------------------------

    fn open_test_db() -> Connection {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        crate::db::open(tmp.path()).unwrap()
    }

    /// Favorites is the star button's single destination — Spotify's Liked
    /// Songs, Apple's Favorites — and neither app lets you delete it. Ours did:
    /// a Delete control sat in the phone's playlist hero for every playlist
    /// alike, and the handler behind it checked the token and the owner but
    /// never what it was deleting. One tap and a confirm would have dropped
    /// every favourite, and the next star would mint a fresh empty anchor, so
    /// the damage would read as "my favourites disappeared" with no error.
    ///
    /// The guard lives in `delete_playlist_row` because BOTH entry points (the
    /// phone's HTTP DELETE and the desktop's IPC command) funnel through it —
    /// hiding the button only fixes the client that was asked nicely.
    /// The phone polls `GET /api/tracks/{id}` while a download runs, and it is
    /// the only place it can learn WHY the hub stopped trying. The hub writes a
    /// sentence meant for a person -- age-gated, nothing matched, needs a key --
    /// but the query behind this endpoint selected `status` and not
    /// `failure_reason`, so the phone knew only that something failed and fell
    /// back to "isn't on your Mac" for all three. That reads the same for a case
    /// you can fix (point it at another upload) and one you can't (unmatchable).
    ///
    /// Asserted on the serialized JSON, not the struct: the field is
    /// `skip_serializing_if = "Option::is_none"`, so a wrong attribute would
    /// leave the struct correct and the wire silent.
    /// Favorites is a log of what you liked, not a hand-ordered playlist —
    /// nothing in either UI can reorder it — so the song you just starred
    /// belongs at the top. It was landing at the bottom, and the list
    /// disagreed with itself: the Spotify import wrote its rows newest-first
    /// (position 2 = most recent), while every like since was appended at
    /// `MAX(position) + 1`. The newest songs sat at BOTH ends.
    ///
    /// Ordering by `added_at` rather than renumbering positions on every like
    /// also repairs the imported history in place, instead of only fixing
    /// likes made from here on.
    /// `track_count` was nudged `+1` / `-1` beside each insert and delete, and
    /// every one of those writes was issued as `let _ = ...`. An insert CAN
    /// fail — `playlist_tracks` is keyed on `(playlist_id, position)`, so two
    /// writers computing `MAX(position) + 1` from the same point collide — and
    /// the nudge went ahead regardless, walking the count permanently out of
    /// step. Found on a real library: 3 playlists of 78, each exactly one high.
    ///
    /// Deriving the count means a drifted row REPAIRS itself on the next write,
    /// which is what this asserts — not merely that fresh counts are right.
    #[test]
    fn a_drifted_track_count_repairs_itself_on_the_next_write() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO playlists (id, spotify_id, name, track_count)
             VALUES (1, 'local:abc', 'Road Trip', 999)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, spotify_id, title, artists, duration_ms, status)
             VALUES (1, 's1', 'Song', '[\"A\"]', 1000, 'downloaded')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES (1, 1, 0, 1700000000)",
            [],
        )
        .unwrap();

        let count = || -> i64 {
            conn.query_row("SELECT track_count FROM playlists WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(count(), 999, "starts wildly wrong, as a drifted row would");
        resync_track_count(&conn, 1);
        assert_eq!(count(), 1, "one write is enough to put it right");

        // And it tracks a delete without a decrement anywhere.
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = 1", [])
            .unwrap();
        resync_track_count(&conn, 1);
        assert_eq!(count(), 0);
    }

    #[test]
    fn favorites_reads_newest_first_and_other_playlists_keep_their_order() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO playlists (id, spotify_id, name, track_count) VALUES
             (1, 'liked:1', 'Favorites', 0),
             (2, 'local:abc', 'Road Trip', 0)",
            [],
        )
        .unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO tracks (id, spotify_id, title, artists, duration_ms, status)
                 VALUES (?1, 's' || ?1, 'Song ' || ?1, '[\"A\"]', 1000, 'downloaded')",
                rusqlite::params![id],
            )
            .unwrap();
        }
        // The shape the bug produced: the import's newest row sits at a LOW
        // position, and the like made afterwards is appended at a high one.
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES
             (1, 1, 2, 1700000000),
             (1, 2, 3, 1600000000),
             (1, 3, 99, 1800000000),
             (2, 1, 2, 1700000000),
             (2, 2, 3, 1600000000),
             (2, 3, 99, 1800000000)",
            [],
        )
        .unwrap();

        let titles = |pid: i64| -> Vec<String> {
            let order = crate::playlist_track_order(&conn, pid);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT t.title FROM tracks t
                     JOIN playlist_tracks pt ON pt.track_id = t.id
                     WHERE pt.playlist_id = ?1 {order}"
                ))
                .unwrap();
            let rows = stmt
                .query_map(rusqlite::params![pid], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
            rows
        };

        assert_eq!(
            titles(1),
            vec!["Song 3", "Song 1", "Song 2"],
            "Favorites reads newest first — the freshly liked Song 3 leads despite its high position"
        );
        assert_eq!(
            titles(2),
            vec!["Song 1", "Song 2", "Song 3"],
            "an ordinary playlist still reads in hand position order"
        );
    }

    #[test]
    fn a_failed_track_reports_why_on_the_wire() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO tracks (id, spotify_id, title, artists, duration_ms, status, failure_reason)
             VALUES (1, 's1', 'Age Gated', '[\"A\"]', 1000, 'failed', 'YouTube age-restricts this one.'),
                    (2, 's2', 'Fine', '[\"A\"]', 1000, 'downloaded', NULL)",
            [],
        )
        .unwrap();

        let read = |id: i64| -> serde_json::Value {
            let t = conn
                .query_row(
                    "SELECT id, title, artists, album, album_art_url, duration_ms, local_path,
                            status, failure_reason
                     FROM tracks WHERE id = ?1",
                    rusqlite::params![id],
                    |r| {
                        let artists_json: String = r.get(2)?;
                        let local_path: Option<String> = r.get(6)?;
                        Ok(StreamTrack {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            artists: serde_json::from_str(&artists_json).unwrap_or_default(),
                            album: r.get(3)?,
                            album_art_url: r.get(4)?,
                            duration_ms: r.get(5)?,
                            position: 0,
                            has_audio: local_path.is_some(),
                            status: r.get(7)?,
                            failure_reason: r.get(8)?,
                        })
                    },
                )
                .unwrap();
            serde_json::to_value(t).unwrap()
        };

        assert_eq!(
            read(1)["failure_reason"],
            serde_json::json!("YouTube age-restricts this one."),
            "a failed track carries the hub's own words to the phone"
        );
        assert!(
            read(2).get("failure_reason").is_none(),
            "a healthy track adds no key -- the field is skipped when None"
        );
    }

    #[test]
    fn the_favorites_anchor_cannot_be_deleted() {
        let conn = open_test_db();
        // Both spellings of the anchor: the CSV-import id and the per-profile
        // one. Identified by stable id, never by display name.
        conn.execute(
            "INSERT INTO playlists (id, spotify_id, name, track_count) VALUES
             (1, 'liked:1', 'Favorites', 0),
             (2, 'csv:liked-songs', 'Liked Songs', 0),
             (3, 'local:abc', 'Road Trip', 0)",
            [],
        )
        .unwrap();

        assert!(crate::is_anchor_playlist(&conn, 1));
        assert!(crate::is_anchor_playlist(&conn, 2));
        assert!(!crate::is_anchor_playlist(&conn, 3), "an ordinary playlist is not the anchor");

        assert!(!crate::delete_playlist_row(&conn, 1).unwrap(), "refused");
        assert!(!crate::delete_playlist_row(&conn, 2).unwrap(), "refused");
        assert!(crate::delete_playlist_row(&conn, 3).unwrap(), "ordinary playlists still delete");

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 2, "both anchors survive; only the ordinary one is gone");
    }

    /// The desktop mint must collapse only its OWN stale prior sessions, never a
    /// paired phone's — even though a phone reached through a loopback tunnel is
    /// stored under 127.0.0.1 just like the desktop. The discriminator is the UA.
    #[test]
    fn loopback_prune_sweeps_only_same_ua_desktop_sessions() {
        let conn = open_test_db();
        let mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

        let insert = |id: &str, ua: &str, ip: &str, idle_secs: i64| {
            conn.execute(
                "INSERT INTO streaming_sessions
                     (id, token_sha256, device_label, ip_address, user_agent, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now') - ?6)",
                params![id, format!("sha-{id}"), "label", ip, ua, idle_secs],
            )
            .unwrap();
        };
        // The desktop's own stale prior launch — should be swept.
        insert("old-mac", mac, "127.0.0.1", 3600);
        // A phone paired via a loopback reverse-proxy tunnel: same 127.0.0.1,
        // stale — must SURVIVE because its UA differs from the minter's.
        insert("phone", iphone, "127.0.0.1", 3600);
        // Another still-active desktop instance (fresh) — spared by staleness.
        insert("fresh-mac", mac, "::1", 5);
        // The just-minted desktop row is keep_id; it must never prune itself.
        insert("new-mac", mac, "127.0.0.1", 0);

        prune_own_stale_loopback_sessions(&conn, "new-mac", mac);

        let alive = |id: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM streaming_sessions WHERE id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        };
        assert!(!alive("old-mac"), "the desktop's own stale prior session should be pruned");
        assert!(alive("phone"), "a tunnelled phone session (different UA) must NOT be pruned");
        assert!(alive("fresh-mac"), "a still-active desktop session (fresh last_seen) must be spared");
        assert!(alive("new-mac"), "the just-minted session must never prune itself");
    }

    /// A minimal TrackHit for the candidate-cache tests (only id/title carry
    /// identity here; the rest exercises the full serde round-trip).
    fn thit(id: u64, title: &str) -> crate::deezer::TrackHit {
        crate::deezer::TrackHit {
            id,
            title: title.to_string(),
            duration: 200,
            artist: crate::deezer::ArtistRef {
                name: "Artist".to_string(),
            },
            album: crate::deezer::AlbumRef {
                id: 1,
                title: "Album".to_string(),
                cover_xl: None,
                cover_big: None,
                cover_medium: None,
            },
            isrc: None,
            release_date: None,
            preview: None,
            explicit_lyrics: false,
            rank: 0,
            contributors: Vec::new(),
        }
    }

    #[test]
    fn candidate_cache_roundtrips_and_prunes_prior_weeks() {
        let conn = open_test_db();
        let set = [
            vec![thit(1, "a"), thit(2, "b")],
            vec![thit(3, "c")],
            vec![], // an empty source list must round-trip too
            vec![thit(4, "d")],
        ];
        // Cold: a never-written key misses.
        assert!(candidate_cache_get(&conn, "drake", "2026-W07").is_none());
        // Put, then a same-week read returns the exact 4 lists.
        candidate_cache_put(&conn, "drake", "2026-W07", &set);
        let got = candidate_cache_get(&conn, "drake", "2026-W07").expect("same-week hit");
        assert_eq!(got[0].len(), 2);
        assert_eq!(got[0][0].id, 1);
        assert_eq!(got[0][1].title, "b");
        assert!(got[2].is_empty(), "empty list preserved");
        assert_eq!(got[3][0].id, 4);
        // A later ISO-week is a MISS (the cache turns over) ...
        assert!(candidate_cache_get(&conn, "drake", "2026-W08").is_none());
        // ... and writing the new week PRUNES the prior week's row.
        candidate_cache_put(&conn, "drake", "2026-W08", &set);
        assert!(
            candidate_cache_get(&conn, "drake", "2026-W07").is_none(),
            "prior ISO-week pruned on write"
        );
        assert!(candidate_cache_get(&conn, "drake", "2026-W08").is_some());
    }

    #[test]
    fn candidate_cache_is_keyed_per_artist() {
        let conn = open_test_db();
        candidate_cache_put(
            &conn,
            "drake",
            "2026-W07",
            &[vec![thit(1, "x")], vec![], vec![], vec![]],
        );
        // A different artist in the same week is an independent miss.
        assert!(candidate_cache_get(&conn, "future", "2026-W07").is_none());
        assert!(candidate_cache_get(&conn, "drake", "2026-W07").is_some());
    }

    /// Insert one `tracks` row, returning its autoincrement id. Supplies the
    /// NOT NULL columns (`spotify_id` unique, `title`, `artists` JSON,
    /// `duration_ms`) so the INSERT can't silently fail.
    fn seed_track(
        conn: &Connection,
        spotify_id: &str,
        title: &str,
        artists: &[&str],
        album: Option<&str>,
        duration_ms: i64,
    ) -> i64 {
        let artists_json = serde_json::to_string(artists).unwrap();
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, album, duration_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![spotify_id, title, artists_json, album, duration_ms],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// Build a `CatalogTrackOut` from just the real payload fields; the
    /// library-state annotation fields fall to their serde defaults.
    fn catalog_track(
        source: &str,
        source_id: &str,
        title: &str,
        artists: &[&str],
        album: Option<&str>,
        album_art_url: Option<&str>,
        isrc: Option<&str>,
    ) -> CatalogTrackOut {
        serde_json::from_value(serde_json::json!({
            "source": source,
            "source_id": source_id,
            "title": title,
            "artists": artists,
            "album": album,
            "album_art_url": album_art_url,
            "duration_ms": 200_000,
            "isrc": isrc,
        }))
        .unwrap()
    }

    // The three upsert paths (upsert_track / upsert_track_and_link /
    // patch_track_playlists) share one core, so this covers all three: a repeat
    // upsert must REFRESH metadata on the existing row (the drifted patch copy
    // used to leave it stale) and dedup deterministically by ISRC.
    #[test]
    fn upsert_track_refreshes_metadata_and_dedups_by_isrc() {
        let conn = open_test_db();
        let count = |c: &Connection| -> i64 {
            c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)).unwrap()
        };

        // First upsert inserts a fresh row.
        let (id1, new1) = upsert_track(
            &conn,
            &catalog_track(
                "deezer", "12345", "Old Title", &["Artist A"],
                Some("Old Album"), None, Some("USABC1234567"),
            ),
        )
        .unwrap();
        assert!(new1, "first upsert inserts a new row");
        assert_eq!(count(&conn), 1);

        // Same source:source_id, CHANGED metadata → refresh the row in place.
        let (id2, new2) = upsert_track(
            &conn,
            &catalog_track(
                "deezer", "12345", "New Title", &["Artist A", "Artist B"],
                Some("New Album"), Some("http://art/new.jpg"), Some("USABC1234567"),
            ),
        )
        .unwrap();
        assert_eq!(id2, id1, "same synthetic id reuses the row");
        assert!(!new2, "repeat upsert does not insert a duplicate");
        assert_eq!(count(&conn), 1, "no duplicate row");
        let (title, art): (String, Option<String>) = conn
            .query_row(
                "SELECT title, album_art_url FROM tracks WHERE id = ?1",
                params![id1],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "New Title", "metadata refreshed on repeat upsert");
        assert_eq!(art.as_deref(), Some("http://art/new.jpg"), "cover filled in");

        // Different source:source_id but SAME isrc → ISRC-first dedup resolves to
        // the existing row (guards the old non-deterministic OR ... LIMIT 1 path).
        let (id3, new3) = upsert_track(
            &conn,
            &catalog_track(
                "spotify", "999", "Spotify Title", &["Artist A"],
                None, None, Some("USABC1234567"),
            ),
        )
        .unwrap();
        assert_eq!(id3, id1, "ISRC match reuses the row across sources");
        assert!(!new3, "ISRC dedup does not insert a new row");
        assert_eq!(count(&conn), 1, "ISRC dedup kept a single row");
    }

    /// Insert one `play_events` row (mig 009 + 013 columns).
    fn seed_play(
        conn: &Connection,
        track_id: i64,
        profile_id: Option<i64>,
        played_at: i64,
        ms_played: i64,
        completed: bool,
    ) {
        conn.execute(
            "INSERT INTO play_events (track_id, profile_id, played_at, ms_played, completed) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![track_id, profile_id, played_at, ms_played, completed as i64],
        )
        .unwrap();
    }

    #[allow(dead_code)]
    fn seed_setting(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .unwrap();
    }

    /// Epoch-seconds `days` days before now — same basis as SQLite
    /// `strftime('%s','now')`, so window filters in the builders line up.
    fn plays_ago(days: i64) -> i64 {
        chrono::Utc::now().timestamp() - days * 86_400
    }

    /// Write the `saved_artists` profile-KV in the shape the client stores.
    fn seed_saved_artists(conn: &Connection, pid: i64, names: &[&str]) {
        let json = serde_json::to_string(
            &names
                .iter()
                .map(|n| serde_json::json!({ "name": n }))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO profile_kv (profile_id, key, value) VALUES (?1, 'saved_artists', ?2)",
            params![pid, json],
        )
        .unwrap();
    }

    #[test]
    fn saved_artist_names_parses_and_tolerates_bad_json() {
        let conn = open_test_db();
        // Missing key → empty.
        assert!(saved_artist_names(&conn, Some(1)).is_empty());
        // Good JSON → names in stored order, blank names filtered.
        seed_saved_artists(&conn, 1, &["Drake", "  ", "Taylor Swift"]);
        assert_eq!(
            saved_artist_names(&conn, Some(1)),
            vec!["Drake".to_string(), "Taylor Swift".to_string()]
        );
        // Malformed JSON → empty, never panics. (Overwrite profile 1's value;
        // profile_kv has an FK to profiles, and only the seeded id 1 exists.)
        conn.execute(
            "INSERT OR REPLACE INTO profile_kv (profile_id, key, value) VALUES (1, 'saved_artists', 'not json')",
            [],
        )
        .unwrap();
        assert!(saved_artist_names(&conn, Some(1)).is_empty());
    }

    #[test]
    fn seed_artists_uses_picks_when_no_history() {
        let conn = open_test_db();
        seed_saved_artists(&conn, 1, &["Picked A", "Picked B"]);
        // Zero play history → the pool is purely the onboarding picks.
        assert_eq!(
            seed_artists(&conn, Some(1), 16),
            vec!["Picked A".to_string(), "Picked B".to_string()]
        );
    }

    #[test]
    fn seed_artists_blends_thin_history() {
        let conn = open_test_db();
        let t = seed_track(&conn, "s1", "T", &["Played One"], None, 200_000);
        seed_play(&conn, t, Some(1), plays_ago(1), 200_000, true);
        // 1 played + 2 picks, one of which duplicates the played artist (case-insensitive).
        seed_saved_artists(&conn, 1, &["played one", "Picked B"]);
        let seeds = seed_artists(&conn, Some(1), 16);
        assert_eq!(seeds[0], "Played One", "real history seeds first");
        assert!(seeds.contains(&"Picked B".to_string()), "the fresh pick tops it up");
        assert_eq!(seeds.len(), 2, "the duplicate pick is deduped, not doubled");
    }

    #[test]
    fn seed_artists_ignores_picks_when_warm() {
        let conn = open_test_db();
        for (i, name) in ["A", "B", "C"].iter().enumerate() {
            let t = seed_track(&conn, &format!("s{i}"), "T", &[*name], None, 200_000);
            seed_play(&conn, t, Some(1), plays_ago(1), 200_000, true);
        }
        seed_saved_artists(&conn, 1, &["Picked X"]);
        // ≥ MIN_SEEDS real plays → picks are never consulted (established profile,
        // identical behaviour to the old top_played_artists-only path).
        let seeds = seed_artists(&conn, Some(1), 16);
        assert!(!seeds.contains(&"Picked X".to_string()));
        assert_eq!(seeds.len(), 3);
    }

    #[test]
    fn daily_seed_is_stable_and_sensitive() {
        let a = daily_seed(Some(1), "2026-07-01");
        assert_eq!(a, daily_seed(Some(1), "2026-07-01")); // same in → same out
        assert_ne!(a, daily_seed(Some(1), "2026-07-02")); // date-sensitive
        assert_ne!(a, daily_seed(Some(2), "2026-07-01")); // profile-sensitive
        assert_eq!(daily_seed(None, "2026-07-01"), daily_seed(None, "2026-07-01"));
        assert_ne!(
            daily_seed(None, "2026-07-01"),
            daily_seed(Some(0), "2026-07-01")
        );
    }

    #[test]
    fn weekly_seed_is_stable_and_week_sensitive() {
        // Same profile + week → same seed (holds all week); next week → different.
        assert_eq!(weekly_seed(Some(1), "2026-W28"), weekly_seed(Some(1), "2026-W28"));
        assert_ne!(weekly_seed(Some(1), "2026-W28"), weekly_seed(Some(1), "2026-W29"));
        assert_ne!(weekly_seed(Some(1), "2026-W28"), weekly_seed(Some(2), "2026-W28"));
        // Domain-separated from daily_seed for the same string input.
        assert_ne!(weekly_seed(Some(1), "2026-07-01"), daily_seed(Some(1), "2026-07-01"));
    }

    #[test]
    fn stat_top_tracks_excludes_skips() {
        let conn = open_test_db();
        let pid = Some(1);
        let track = |sid: &str, title: &str| {
            upsert_track(&conn, &catalog_track("d", sid, title, &["A"], None, None, None))
                .unwrap()
                .0
        };
        let finished = track("1", "Finished"); // 3 completed        → 3 real
        let skipped = track("2", "Skipped"); //   5 skips            → 0 real (dropped)
        let mixed = track("3", "Mixed"); //       1 completed + 4 skips → 1 real
        let legacy = track("4", "Legacy"); //     4 untracked (ms=0) → 4 real

        for _ in 0..3 {
            seed_play(&conn, finished, pid, plays_ago(1), 200_000, true);
        }
        for _ in 0..5 {
            seed_play(&conn, skipped, pid, plays_ago(1), 3_000, false);
        }
        seed_play(&conn, mixed, pid, plays_ago(1), 200_000, true);
        for _ in 0..4 {
            seed_play(&conn, mixed, pid, plays_ago(1), 3_000, false);
        }
        for _ in 0..4 {
            seed_play(&conn, legacy, pid, plays_ago(1), 0, false);
        }

        let top = stat_top_tracks(&conn, pid, 0, 25);

        // A song you only ever skipped is not a "top song".
        assert!(
            !top.iter().any(|t| t.track_id == skipped),
            "skip-only track must be excluded"
        );
        // Ranked by REAL plays: legacy(4) > finished(3) > mixed(1).
        let ids: Vec<i64> = top.iter().map(|t| t.track_id).collect();
        assert_eq!(ids, vec![legacy, finished, mixed], "ranked by real plays");
        // The shown count is real plays: untracked plays count, skips don't inflate it.
        let count = |id: i64| top.iter().find(|t| t.track_id == id).unwrap().count;
        assert_eq!(count(legacy), 4, "untracked (ms=0) plays count as real");
        assert_eq!(count(finished), 3);
        assert_eq!(count(mixed), 1, "the 4 skips on 'mixed' don't count");
    }

    #[test]
    fn seeded_shuffle_is_permutation_and_deterministic() {
        let src: Vec<u32> = (0..40).collect();
        let seed = daily_seed(Some(7), "2026-07-01");

        // Permutation: shuffling the whole vec drops/dupes nothing.
        let mut full = seeded_shuffle_take(src.clone(), seed, 40);
        assert_eq!(full.len(), 40);
        full.sort();
        assert_eq!(full, src);

        // Deterministic: same seed → identical order (the refresh case).
        assert_eq!(
            seeded_shuffle_take(src.clone(), seed, 16),
            seeded_shuffle_take(src.clone(), seed, 16)
        );

        // Different seeds → different order (try a few to avoid a coincidence).
        let a = seeded_shuffle_take(src.clone(), 111, 16);
        let differs = [222u64, 333, 444]
            .iter()
            .any(|&s| seeded_shuffle_take(src.clone(), s, 16) != a);
        assert!(differs, "shuffle ignored the seed");

        // take beyond length / empty / single are no-ops.
        assert_eq!(seeded_shuffle_take(src.clone(), seed, 999).len(), 40);
        assert_eq!(
            seeded_shuffle_take(Vec::<u32>::new(), seed, 5),
            Vec::<u32>::new()
        );
        assert_eq!(seeded_shuffle_take(vec![9u32], seed, 5), vec![9u32]);
    }

    // VERIFY-FIRST: `local_date_string()` (chrono::Local) must equal SQLite
    // `date('now','localtime')`, because play_events timestamps use the SQLite
    // basis. Both read the OS zone. (Vanishingly rare midnight-boundary flake.)
    #[test]
    fn local_date_matches_sqlite() {
        let conn = open_test_db();
        let sql_date: String = conn
            .query_row("SELECT date('now','localtime')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(local_date_string(), sql_date);
    }

    #[test]
    fn home_fixtures_and_top_songs_smoke() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        for i in 0..3 {
            let id = seed_track(
                &conn,
                &format!("test:{i}"),
                &format!("Song {i}"),
                &["Artist"],
                Some("Album"),
                200_000,
            );
            seed_play(&conn, id, None, now - i as i64, 200_000, true);
        }
        let shelf = build_top_songs(&conn, None, 0).expect("top songs shelf");
        assert_eq!(shelf.stat_tracks.len(), 3, "fixture rows didn't land");
    }

    // --- P1 quick-wins -------------------------------------------------

    #[test]
    fn daypart_for_hour_buckets() {
        assert_eq!(daypart_for_hour(5).0, "Good morning");
        assert_eq!(daypart_for_hour(11).0, "Good morning");
        assert_eq!(daypart_for_hour(12).0, "Good afternoon");
        assert_eq!(daypart_for_hour(16).0, "Good afternoon");
        assert_eq!(daypart_for_hour(17).0, "Good evening"); // was the 17:00 mismatch
        assert_eq!(daypart_for_hour(21).0, "Good evening");
        assert_eq!(daypart_for_hour(22).0, "Late night"); // was the 22:00 mismatch
        assert_eq!(daypart_for_hour(4).0, "Late night");
        assert_eq!(daypart_for_hour(0).0, "Late night");
    }

    #[test]
    fn home_out_serializes_greeting() {
        let out = HomeOut {
            shelves: vec![],
            greeting: "Good evening".into(),
            welcome_back: false,
            discovery_age_secs: Some(0),
            station_ready: true,
            partial: false,
        };
        assert!(
            serde_json::to_string(&out)
                .unwrap()
                .contains("\"greeting\":\"Good evening\"")
        );
        // Empty greeting is omitted, keeping the client's local fallback live.
        let empty = HomeOut {
            shelves: vec![],
            greeting: String::new(),
            welcome_back: false,
            discovery_age_secs: None,
            station_ready: true,
            partial: false,
        };
        let s = serde_json::to_string(&empty).unwrap();
        assert!(!s.contains("greeting"));
        // A None age is omitted so older clients see no unexpected field (N6).
        assert!(!s.contains("discovery_age_secs"));
    }

    // A brand-new profile has no plays, so the station seed pool is empty and a
    // station would build zero tracks — the feed must say so (the client hides
    // the tiles). One play is enough to flip it: that's exactly the pool
    // `station_seeds` samples.
    #[test]
    fn station_readiness_follows_the_seed_pool() {
        let conn = open_test_db();
        assert!(
            top_played_artists(&conn, None, 1).is_empty(),
            "fresh profile: nothing to seed a station with"
        );
        assert!(station_seeds(&conn, None, 42).is_empty());

        let id = seed_track(&conn, "t:a", "A", &["AA"], None, 200_000);
        seed_play(&conn, id, None, plays_ago(1), 200_000, true);

        assert!(!top_played_artists(&conn, None, 1).is_empty());
        assert!(
            !station_seeds(&conn, None, 42).is_empty(),
            "readiness and the real seed pool must agree"
        );
    }

    // imp 7 — "On repeat" must rank by completion weight, not raw play count:
    // 2 completed plays (weight 3.0) beat 3 early skips (weight 0.75) even though
    // the skips have the higher COUNT(*).
    #[test]
    fn on_repeat_ranks_by_weight_not_raw_count() {
        let conn = open_test_db();
        let recent = plays_ago(3); // inside the 28-day window
        let a = seed_track(&conn, "t:a", "A", &["AA"], None, 200_000);
        let b = seed_track(&conn, "t:b", "B", &["BB"], None, 200_000);
        let c = seed_track(&conn, "t:c", "C", &["CC"], None, 200_000);
        seed_play(&conn, a, None, recent, 200_000, true);
        seed_play(&conn, a, None, recent, 200_000, true);
        for _ in 0..3 {
            seed_play(&conn, b, None, recent, 5_000, false);
        }
        seed_play(&conn, c, None, recent, 200_000, true); // 1 play → gated by HAVING

        let shelf = build_on_repeat(&conn, None).expect("on repeat shelf");
        let ids: Vec<i64> = shelf.stat_tracks.iter().map(|t| t.track_id).collect();
        assert!(!ids.contains(&c), "single-play track should be gated out");
        let pa = ids.iter().position(|&x| x == a).expect("A present");
        let pb = ids.iter().position(|&x| x == b).expect("B present");
        assert!(pa < pb, "completed A must outrank skipped B (weight, not count)");
    }

    // imp 7 — "From your past" same weighting fix, plus its recency exclusion.
    #[test]
    fn from_your_past_ranks_by_weight_and_excludes_recent() {
        let conn = open_test_db();
        let old = plays_ago(60); // older than 45 days
        let recent = plays_ago(10); // inside 45 days
        let a = seed_track(&conn, "p:a", "A", &["AA"], None, 200_000);
        let b = seed_track(&conn, "p:b", "B", &["BB"], None, 200_000);
        let c = seed_track(&conn, "p:c", "C", &["CC"], None, 200_000);
        seed_play(&conn, a, None, old, 200_000, true);
        seed_play(&conn, a, None, old, 200_000, true);
        for _ in 0..3 {
            seed_play(&conn, b, None, old, 5_000, false);
        }
        seed_play(&conn, c, None, old, 200_000, true);
        seed_play(&conn, c, None, old, 200_000, true);
        seed_play(&conn, c, None, recent, 200_000, true); // recent → excluded

        let shelf = build_from_your_past(&conn, None).expect("from your past shelf");
        let ids: Vec<i64> = shelf.stat_tracks.iter().map(|t| t.track_id).collect();
        assert!(!ids.contains(&c), "recently-played track must be excluded");
        let pa = ids.iter().position(|&x| x == a).expect("A present");
        let pb = ids.iter().position(|&x| x == b).expect("B present");
        assert!(pa < pb, "completed A must outrank skipped B");
    }

    // Release-Radar reseed core: the shared play-weighted seed orders by
    // completion weight and never surfaces an unplayed (library-only) artist.
    #[test]
    fn top_played_artists_orders_by_weight_and_ignores_unplayed() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        let x = seed_track(&conn, "a:x", "X", &["Xavier"], None, 200_000);
        let y = seed_track(&conn, "a:y", "Y", &["Yolanda"], None, 200_000);
        for _ in 0..4 {
            seed_play(&conn, x, None, now, 200_000, true);
        }
        for _ in 0..2 {
            seed_play(&conn, y, None, now, 5_000, false);
        }
        let seeds = top_played_artists(&conn, None, 12);
        assert_eq!(seeds.first().map(String::as_str), Some("Xavier"));
        assert!(seeds.contains(&"Yolanda".to_string()));
        let _z = seed_track(&conn, "a:z", "Z", &["Zed"], None, 200_000); // no plays
        assert!(!top_played_artists(&conn, None, 12).contains(&"Zed".to_string()));
    }

    // N2: recency weighting lets a recently-played artist outrank one with a
    // larger all-time completed-play count but only stale (>90d) plays. Without
    // RECENCY_BOOST, Stale (6 completed = 9.0) beats Fresh (4 completed = 6.0);
    // with the boost, Fresh's 4×1.5×3.0 = 18.0 tops Stale's 6×1.5×1.0 = 9.0.
    #[test]
    fn top_played_artists_recency_boosts_recent_over_stale() {
        let conn = open_test_db();
        let fresh = seed_track(&conn, "a:f", "F", &["Fresh"], None, 200_000);
        let stale = seed_track(&conn, "a:s", "S", &["Stale"], None, 200_000);
        for _ in 0..4 {
            seed_play(&conn, fresh, None, plays_ago(5), 200_000, true);
        }
        for _ in 0..6 {
            seed_play(&conn, stale, None, plays_ago(200), 200_000, true);
        }
        let seeds = top_played_artists(&conn, None, 12);
        assert_eq!(seeds.first().map(String::as_str), Some("Fresh"));
        assert!(seeds.contains(&"Stale".to_string()));
    }

    // --- P2 daily rotation ---------------------------------------------

    // Top songs over-fetches then seed-shuffles: same (profile,date) seed is
    // stable (a refresh doesn't reshuffle), a different day rotates, and the
    // shelf still caps at 16.
    #[test]
    fn top_songs_rotates_by_seed_within_and_across_days() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        for i in 0..30 {
            let id = seed_track(
                &conn,
                &format!("r:{i}"),
                &format!("S{i}"),
                &[&format!("A{i}")],
                None,
                200_000,
            );
            seed_play(&conn, id, None, now - i as i64, 200_000, true);
        }
        let s1 = daily_seed(None, "2026-07-01");
        let s2 = daily_seed(None, "2026-07-02");
        let ids =
            |sh: &HomeShelf| sh.stat_tracks.iter().map(|t| t.track_id).collect::<Vec<_>>();
        let day1a = build_top_songs(&conn, None, s1).unwrap();
        let day1b = build_top_songs(&conn, None, s1).unwrap();
        let day2 = build_top_songs(&conn, None, s2).unwrap();
        assert_eq!(ids(&day1a), ids(&day1b), "same day must be stable (refresh)");
        assert_ne!(ids(&day1a), ids(&day2), "a different day must rotate");
        assert_eq!(day1a.stat_tracks.len(), 16, "shelf still caps at 16");
    }

    // "Recently played" must NOT be shuffled — strict most-recent-first.
    #[test]
    fn recently_played_is_recency_ordered_not_shuffled() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        let mut expected = Vec::new();
        for i in 0..5 {
            let id =
                seed_track(&conn, &format!("rp:{i}"), &format!("S{i}"), &["A"], None, 200_000);
            seed_play(&conn, id, None, now - (i as i64) * 100, 200_000, true); // i=0 newest
            expected.push(id);
        }
        let shelf = build_recently_played(&conn, None).unwrap();
        let got: Vec<i64> = shelf.stat_tracks.iter().map(|t| t.track_id).collect();
        assert_eq!(got, expected, "recently played must stay most-recent-first");
    }

    // --- P3 rotating daily mix -----------------------------------------

    // The mix seed artist is picked by daily_seed % pool: stable within a day,
    // but sweeps more than one artist across a run of days (not pinned to #1).
    #[test]
    fn daily_mix_seed_pick_rotates_across_days() {
        let pool_len = 8u64;
        let dates = [
            "2026-07-01",
            "2026-07-02",
            "2026-07-03",
            "2026-07-04",
            "2026-07-05",
            "2026-07-06",
            "2026-07-07",
            "2026-07-08",
            "2026-07-09",
            "2026-07-10",
            "2026-07-11",
            "2026-07-12",
        ];
        let picks: std::collections::HashSet<u64> = dates
            .iter()
            .map(|d| daily_seed(Some(1), d) % pool_len)
            .collect();
        assert!(picks.len() > 1, "daily mix never rotates off one artist");
        assert_eq!(
            daily_seed(Some(1), "2026-07-01") % pool_len,
            daily_seed(Some(1), "2026-07-01") % pool_len,
            "must be stable within a day"
        );
    }

    // --- P4 pre-warm ---------------------------------------------------

    #[test]
    fn should_prewarm_missing_and_fresh_and_stale() {
        assert!(should_prewarm(None), "missing key must warm");
        let fresh = HomeCacheEntry {
            fetched_at: std::time::Instant::now(),
            shelves: vec![],
        };
        assert!(!should_prewarm(Some(&fresh)), "fresh key must not warm");
        // A >HOME_TTL-old instant only constructs on machines up >HOME_TTL; skip
        // the stale assertion otherwise (fresh containers have tiny uptime).
        if let Some(old) =
            std::time::Instant::now().checked_sub(HOME_TTL + std::time::Duration::from_secs(60))
        {
            let stale = HomeCacheEntry {
                fetched_at: old,
                shelves: vec![],
            };
            assert!(should_prewarm(Some(&stale)), "stale key must warm");
        }
    }

    #[test]
    fn next_wake_after_lands_just_past_local_midnight() {
        use chrono::TimeZone;
        // 23:59:00 → next 00:00:30 is 90s away (avoid a DST-transition date).
        let now = chrono::Local.with_ymd_and_hms(2026, 6, 15, 23, 59, 0).unwrap();
        let secs = next_wake_after(now).as_secs();
        assert!(
            (60..=180).contains(&secs),
            "expected ~90s to next midnight, got {secs}"
        );
    }

    #[test]
    fn prewarm_targets_include_none_and_profiles() {
        let conn = open_test_db();
        // Migration 006 seeds a default profile (id=1); add a second.
        conn.execute("INSERT INTO profiles (name) VALUES ('B')", [])
            .unwrap();
        let pids = prewarm_target_pids(&conn);
        assert_eq!(pids.first(), Some(&None), "no-profile default comes first");
        assert!(pids.contains(&Some(1)), "seeded default profile included");
        assert!(pids.contains(&Some(2)), "added profile included");
        assert_eq!(pids.len(), 3);
    }

    // --- P5 fusion ranking ---------------------------------------------

    fn th(id: u64, title: &str, artist: &str, rank: u64) -> crate::deezer::TrackHit {
        crate::deezer::TrackHit {
            id,
            title: title.into(),
            duration: 200,
            artist: crate::deezer::ArtistRef {
                name: artist.into(),
            },
            album: crate::deezer::AlbumRef {
                id: 0,
                title: "Alb".into(),
                cover_xl: None,
                cover_big: None,
                cover_medium: None,
            },
            isrc: None,
            release_date: None,
            preview: None,
            explicit_lyrics: false,
            rank,
            contributors: Vec::new(),
        }
    }

    fn pos(tracks: &[CatalogTrackOut], source_id: u64) -> Option<usize> {
        tracks
            .iter()
            .position(|t| t.source_id == source_id.to_string())
    }

    #[test]
    fn fuse_rank_rewards_multi_source_corroboration() {
        let empty = std::collections::HashSet::new();
        // Track id 1 appears in BOTH sources (rank 0 each) → summed RRF; id 2 once.
        let a = [th(1, "c", "C", 300_000)];
        let b = [th(1, "c", "C", 300_000), th(2, "d", "D", 300_000)];
        let out = fuse_rank(&[&a, &b], &empty, 10, None, PopMode::Favor);
        assert!(
            pos(&out, 1).unwrap() < pos(&out, 2).unwrap(),
            "a track two sources agree on must outrank a one-source track"
        );
    }

    #[test]
    fn fuse_rank_uses_per_source_rank_not_global_concatenation() {
        let empty = std::collections::HashSet::new();
        // Ta sits at rank 5 of source A; Tb at rank 0 of source B. Per-source RRF
        // => Tb (1/61) beats Ta (1/66). GLOBAL concatenation would push Tb to
        // rank 6 (1/67) and flip the order — the only fixture that catches that.
        let a = [
            th(10, "x0", "A0", 300_000),
            th(11, "x1", "A1", 300_000),
            th(12, "x2", "A2", 300_000),
            th(13, "x3", "A3", 300_000),
            th(14, "x4", "A4", 300_000),
            th(15, "Ta", "A5", 300_000),
        ];
        let b = [th(20, "Tb", "B0", 300_000)];
        let out = fuse_rank(&[&a, &b], &empty, 10, None, PopMode::Favor);
        assert!(
            pos(&out, 20).unwrap() < pos(&out, 15).unwrap(),
            "per-source RRF: rank-0-of-B must outrank rank-5-of-A"
        );
    }

    #[test]
    fn fuse_rank_mmr_declumps_repeated_artist() {
        let empty = std::collections::HashSet::new();
        let a = [
            th(1, "x0", "X", 300_000),
            th(2, "x1", "X", 300_000),
            th(3, "x2", "X", 300_000),
        ];
        let b = [th(9, "y0", "Y", 300_000)];
        let out = fuse_rank(&[&a, &b], &empty, 4, None, PopMode::Favor);
        let artists: Vec<&str> = out
            .iter()
            .map(|t| t.artists.first().map(String::as_str).unwrap_or(""))
            .collect();
        for w in artists.windows(3) {
            assert!(
                !(w[0] == w[1] && w[1] == w[2]),
                "MMR left 3 of one artist in a row: {artists:?}"
            );
        }
        assert!(
            pos(&out, 9).unwrap() <= 1,
            "MMR should promote the rival artist early, not bury it"
        );
    }

    // --- P6 win-back ---------------------------------------------------

    #[test]
    fn is_dormant_detects_lapsed_profile() {
        let conn = open_test_db();
        let t = seed_track(&conn, "d:1", "S", &["A"], None, 200_000);
        seed_play(&conn, t, None, plays_ago(20), 200_000, true); // last play 20d ago
        assert!(is_dormant(&conn, None, 14), "20d idle at N=14 is dormant");
        seed_play(&conn, t, None, plays_ago(2), 200_000, true); // a recent play
        assert!(!is_dormant(&conn, None, 14), "a recent play clears dormancy");
        assert!(
            !is_dormant(&conn, Some(999), 14),
            "a profile with no plays is not dormant (nothing to win back)"
        );
    }

    // Hoisting win-back to the FRONT lets it claim its tracks under curation's
    // first-claimant rule; left in the trail, "Your top songs" guts it (shared tracks).
    #[test]
    fn win_back_hoist_survives_curation() {
        let conn = open_test_db();
        let old = plays_ago(60);
        for i in 0..6 {
            let id = seed_track(
                &conn,
                &format!("wb:{i}"),
                &format!("S{i}"),
                &[&format!("A{i}")],
                None,
                200_000,
            );
            // Loved long ago → qualifies for BOTH "From your past" and "Your top songs".
            seed_play(&conn, id, None, old, 200_000, true);
            seed_play(&conn, id, None, old - 100, 200_000, true);
        }
        let from_past = build_from_your_past(&conn, None).expect("from your past");
        let top = build_top_songs(&conn, None, 0).expect("top songs");
        let mut wb = from_past;
        wb.title = "Welcome back".into();

        // In the trail (top songs curated first), win-back is gutted → dropped.
        let no_hoist =
            curate_home_shelves(vec![top.clone(), wb.clone()], &std::collections::HashSet::new());
        assert!(
            !no_hoist.iter().any(|s| s.title == "Welcome back"),
            "un-hoisted win-back should be gutted by top songs"
        );
        // Hoisted first, it claims its tracks and survives at the top.
        let hoisted = curate_home_shelves(vec![wb, top], &std::collections::HashSet::new());
        assert_eq!(
            hoisted.first().map(|s| s.title.as_str()),
            Some("Welcome back"),
            "hoisted win-back should be first"
        );
        assert!(hoisted[0].stat_tracks.len() >= 5, "and keep its tracks");
    }

    #[test]
    fn fuse_rank_downweights_owned_and_drops_excluded() {
        let mut lib = std::collections::HashSet::new();
        lib.insert(norm_artist("Owned"));
        // Same source rank; the owned artist is novelty-down-weighted below fresh.
        let a = [th(1, "song", "Owned", 300_000)];
        let b = [th(2, "song2", "Fresh", 300_000)];
        let out = fuse_rank(&[&a, &b], &lib, 10, None, PopMode::Favor);
        assert!(
            pos(&out, 2).unwrap() < pos(&out, 1).unwrap(),
            "an owned-artist track must rank below an equivalent fresh one"
        );
        // `excl` drops a title outright (the currently-playing track, for radio).
        let c = [th(3, "Skip Me", "Z", 300_000)];
        let out2 = fuse_rank(&[&c], &lib, 10, Some("skip me"), PopMode::Favor);
        assert!(out2.is_empty(), "excluded title must be dropped");
    }

    // --- P14 under-the-radar + new-for-you ------------------------------

    // Popularity inversion must FLIP order (not just scale it): a 2-source-
    // corroborated mega-popular track leads under Favor, but an obscure single-
    // source track overtakes it under Invert.
    #[test]
    fn fuse_rank_pop_invert_flips_obscure_above_popular() {
        let empty = std::collections::HashSet::new();
        let a = [th(1, "A", "AA", 700_000)];
        let a2 = [th(1, "A", "AA", 700_000)]; // A again in a 2nd source
        let b = [th(2, "B", "BB", 5_000)];
        let favor = fuse_rank(&[&a, &a2, &b], &empty, 10, None, PopMode::Favor);
        assert!(
            pos(&favor, 1).unwrap() < pos(&favor, 2).unwrap(),
            "Favor: the corroborated popular track leads"
        );
        let invert = fuse_rank(&[&a, &a2, &b], &empty, 10, None, PopMode::Invert);
        assert!(
            pos(&invert, 2).unwrap() < pos(&invert, 1).unwrap(),
            "Invert: the obscure track overtakes the popular one"
        );
    }

    fn ah(id: u64, artist: &str) -> crate::deezer::AlbumHit {
        crate::deezer::AlbumHit {
            id,
            title: "Alb".into(),
            artist: Some(crate::deezer::ArtistRef {
                name: artist.into(),
            }),
            cover_xl: None,
            cover_big: None,
            cover_medium: None,
            record_type: None,
            release_date: None,
            nb_tracks: None,
        }
    }

    #[test]
    fn filter_fresh_albums_excludes_known_and_dedups() {
        let mut known = std::collections::HashSet::new();
        known.insert(norm_artist("Known"));
        let releases = vec![
            ah(1, "Fresh1"),
            ah(2, "Known"),  // played/owned → excluded (anti-collision w/ Radar)
            ah(1, "Fresh1"), // duplicate id → excluded
            ah(3, "Fresh2"),
        ];
        let out = filter_fresh_albums(releases, &known);
        let ids: Vec<&str> = out.iter().map(|a| a.source_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "3"]);
    }

    // --- P15 explicit ban ----------------------------------------------

    fn seed_ban(conn: &Connection, pid: Option<i64>, name: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO artist_bans (profile_id, artist_key) VALUES (?1, ?2)",
            params![pid, norm_artist(name)],
        )
        .unwrap();
    }

    fn artist_out(name: &str) -> SearchArtistOut {
        SearchArtistOut {
            source: "deezer".into(),
            source_id: name.into(),
            name: name.into(),
            picture_url: None,
            total_albums: None,
            total_fans: None,
        }
    }

    #[test]
    fn norm_artist_truncates_at_semicolon() {
        // Legacy CSV imports stored multi-artist strings as one element; the
        // key must be the PRIMARY artist so bans/tags/seeds match.
        assert_eq!(norm_artist("Aminé;Leon Thomas"), norm_artist("Aminé"));
        assert_eq!(norm_artist("Aminé;Leon Thomas"), "amine");
        assert_eq!(
            crate::tags::artist_key("Aminé;Leon Thomas"),
            crate::tags::artist_key("Aminé"),
            "tags::artist_key must agree on the primary artist"
        );
        // No semicolon → unchanged behavior.
        assert_eq!(norm_artist("  Beyoncé "), "beyonce");
    }

    #[test]
    fn load_ban_set_isolates_per_profile() {
        let conn = open_test_db();
        seed_ban(&conn, Some(1), "Banned One");
        seed_ban(&conn, None, "Banned None");
        let b1 = load_ban_set(&conn, Some(1));
        assert!(b1.contains(&norm_artist("Banned One")));
        assert!(
            !b1.contains(&norm_artist("Banned None")),
            "profile 1 must not see the no-profile ban"
        );
        assert!(
            load_ban_set(&conn, Some(2)).is_empty(),
            "profile 2 has no bans"
        );
        assert!(load_ban_set(&conn, None).contains(&norm_artist("Banned None")));
    }

    #[test]
    fn curate_strips_banned_across_kinds() {
        let mut banned = std::collections::HashSet::new();
        banned.insert(norm_artist("Ban"));
        let tr = track_row_shelf(
            "T",
            vec![
                th(1, "s1", "A", 0),
                th(2, "s2", "B", 0),
                th(3, "s3", "C", 0),
                th(4, "s4", "D", 0),
                th(5, "s5", "E", 0),
                th(6, "s6", "Ban", 0), // banned → stripped
            ],
        );
        let ar = HomeShelf::artist_row(
            "More like X",
            None,
            vec![artist_out("Fresh1"), artist_out("Ban"), artist_out("Fresh2")],
        );
        let out = curate_home_shelves(vec![tr, ar], &banned);
        let t = out.iter().find(|s| s.kind == "track_row").expect("track_row");
        assert_eq!(t.tracks.len(), 5, "banned track dropped, 5 remain");
        assert!(
            !t.tracks
                .iter()
                .any(|x| x.artists.first().map(String::as_str) == Some("Ban")),
            "no banned artist survives in the track_row"
        );
        let a = out.iter().find(|s| s.kind == "artist_row").expect("artist_row");
        assert_eq!(a.artists.len(), 2, "banned artist dropped from artist_row");
        assert!(!a.artists.iter().any(|x| x.name == "Ban"));
    }

    #[test]
    fn empty_ban_set_is_a_no_op() {
        let empty = std::collections::HashSet::new();
        let tr = track_row_shelf(
            "T",
            vec![
                th(1, "s1", "A", 0),
                th(2, "s2", "B", 0),
                th(3, "s3", "C", 0),
                th(4, "s4", "D", 0),
                th(5, "s5", "E", 0),
            ],
        );
        let out = curate_home_shelves(vec![tr], &empty);
        assert_eq!(out[0].tracks.len(), 5, "empty ban set changes nothing");
    }

    // --- N1 per-visit selection -----------------------------------------

    #[test]
    fn select_shelf_items_anchors_and_rotates_per_visit() {
        let pool: Vec<crate::deezer::TrackHit> = (1..=24)
            .map(|i| th(i, &format!("s{i}"), &format!("Artist{i}"), 0))
            .collect();
        let fresh = FatigueMap::default();
        let make = || track_row_shelf("More like your favorites", pool.clone()).rotating(4, 12);
        let ids = |s: &HomeShelf| -> Vec<String> {
            s.tracks.iter().map(|t| t.source_id.clone()).collect()
        };

        // Ranked shelves pass through untouched.
        let mut ranked = track_row_shelf("Ranked", pool.clone());
        select_shelf_items(&mut ranked, 42, &fresh);
        assert_eq!(ranked.tracks.len(), 24, "Ranked policy never trims");

        // N3: selection now REORDERS but keeps the whole pool (curate trims to
        // `display` after de-dup so drops can backfill) — top `anchors` first.
        let mut a = make();
        select_shelf_items(&mut a, 1, &fresh);
        assert_eq!(a.tracks.len(), 24, "select keeps the full pool for backfill");
        let top: Vec<&str> = a.tracks[..4].iter().map(|t| t.source_id.as_str()).collect();
        assert_eq!(top, vec!["1", "2", "3", "4"], "top anchors keep ranked order");

        // curate trims a Rotate shelf to its display size, keeping the priority
        // prefix (anchors + the visit-seeded fill) select laid out.
        let curated = curate_home_shelves(vec![a.clone()], &std::collections::HashSet::new());
        assert_eq!(curated[0].tracks.len(), 12, "curate trims Rotate to display");
        assert_eq!(
            ids(&curated[0]),
            ids(&a)[..12].to_vec(),
            "the visible 12 are select's priority prefix"
        );

        // Same visit seed → identical selection (stable within a visit).
        let mut a2 = make();
        select_shelf_items(&mut a2, 1, &fresh);
        assert_eq!(ids(&a), ids(&a2), "same seed reproduces the same slice");

        // A different visit seed changes the non-anchor slice (checked across a
        // few seeds so the assertion isn't hostage to one lucky collision).
        let differs = (2u64..6).any(|s| {
            let mut b = make();
            select_shelf_items(&mut b, s, &fresh);
            ids(&b) != ids(&a)
        });
        assert!(differs, "different visits draw different slices");
    }

    #[test]
    fn fatigue_demotes_over_shown_items_below_fresh_ones() {
        let pool: Vec<crate::deezer::TrackHit> = (1..=24)
            .map(|i| th(i, &format!("s{i}"), &format!("Artist{i}"), 0))
            .collect();
        // Mark the four would-be anchors (ids 1-4) as heavily shown (tier 2) and
        // ids 5-8 as mildly shown (tier 1); the rest are fresh (tier 0).
        let mut fatigue = std::collections::HashMap::new();
        for i in 1..=4 {
            fatigue.insert(fatigue_key("track", &format!("deezer:{i}")), 30);
        }
        for i in 5..=8 {
            fatigue.insert(fatigue_key("track", &format!("deezer:{i}")), 4);
        }
        let fatigue = FatigueMap(fatigue);

        let mut a = track_row_shelf("More like your favorites", pool).rotating(4, 12);
        select_shelf_items(&mut a, 1, &fatigue);
        let visible: Vec<u64> = a.tracks[..12]
            .iter()
            .map(|t| t.source_id.parse().unwrap())
            .collect();
        // The heavily-shown ids never lead: none of 1-4 is an anchor now.
        assert!(
            a.tracks[..4].iter().all(|t| {
                let id: u64 = t.source_id.parse().unwrap();
                id > 4
            }),
            "tier-2 items are demoted out of the anchor slots"
        );
        // Fresh items (ids 9-24) fill ahead of the stale ones in the visible 12.
        let stale_shown = visible.iter().filter(|&&id| id <= 8).count();
        let fresh_shown = visible.iter().filter(|&&id| id > 8).count();
        assert!(
            fresh_shown >= stale_shown,
            "fresh items are preferred over fatigued ones in the visible slice \
             (fresh={fresh_shown}, stale={stale_shown})"
        );
    }

    // --- N4 safe exploration --------------------------------------------

    #[test]
    fn exploration_reserves_novel_tail_slots_every_visit() {
        // 24-item pool, anchors 4 / display 12 → fill 8, EXPLORE_FRACTION 0.2 →
        // 2 reserved exploration slots. The novel tail is ranks >= 12 (ids > 12).
        let pool: Vec<crate::deezer::TrackHit> = (1..=24)
            .map(|i| th(i, &format!("s{i}"), &format!("Artist{i}"), 0))
            .collect();
        let fresh = FatigueMap::default();
        let explore = (8f64 * EXPLORE_FRACTION).round() as usize; // 2

        // Across several visit seeds, the reserved exploration slots (the last
        // `explore` of the visible 12) ALWAYS come from the novel tail — a
        // guaranteed floor, not a shuffle that only sometimes reaches the tail.
        for s in 1u64..8 {
            let mut a = track_row_shelf("More like your favorites", pool.clone()).rotating(4, 12);
            select_shelf_items(&mut a, s, &fresh);
            assert_eq!(a.tracks.len(), 24, "full pool kept for backfill");
            let visible: Vec<u64> =
                a.tracks[..12].iter().map(|t| t.source_id.parse().unwrap()).collect();
            for &id in &visible[12 - explore..] {
                assert!(id > 12, "seed {s}: reserved slot must be a novel-tail pick, got {id}");
            }
            // Anchors are still the exploitation top (ranks 0-3 = ids 1-4).
            assert_eq!(
                &visible[..4],
                &[1, 2, 3, 4],
                "seed {s}: anchors still lead with the top-ranked items"
            );
        }

        // A shelf with NO novel tail (pool == display) reserves nothing and is
        // left untouched (small-pool skip), so exploration never forces a pick
        // that doesn't exist.
        let small: Vec<crate::deezer::TrackHit> = (1..=12)
            .map(|i| th(i, &format!("s{i}"), &format!("Artist{i}"), 0))
            .collect();
        let mut b = track_row_shelf("Small", small).rotating(4, 12);
        select_shelf_items(&mut b, 1, &fresh);
        let ids: Vec<&str> = b.tracks.iter().map(|t| t.source_id.as_str()).collect();
        assert_eq!(ids, (1..=12).map(|i| i.to_string()).collect::<Vec<_>>(), "no tail → untouched");
    }

    #[test]
    fn exploration_prefers_fresh_tail_and_stays_stable_per_visit() {
        // The whole novel tail is available, but half of it is heavily shown.
        // Exploration must prefer the FRESH tail items (fatigue-aware), and the
        // pick must be stable for a given visit seed.
        let pool: Vec<crate::deezer::TrackHit> = (1..=24)
            .map(|i| th(i, &format!("s{i}"), &format!("Artist{i}"), 0))
            .collect();
        // Fatigue the odd-id tail (13,15,17,19,21,23); even-id tail stays fresh.
        let mut fatigue = std::collections::HashMap::new();
        for i in (13..=23).step_by(2) {
            fatigue.insert(fatigue_key("track", &format!("deezer:{i}")), 40);
        }
        let fatigue = FatigueMap(fatigue);
        let explore = (8f64 * EXPLORE_FRACTION).round() as usize;

        let sel = |seed: u64| -> Vec<u64> {
            let mut a = track_row_shelf("More like your favorites", pool.clone()).rotating(4, 12);
            select_shelf_items(&mut a, seed, &fatigue);
            a.tracks[..12].iter().map(|t| t.source_id.parse().unwrap()).collect()
        };
        let v = sel(3);
        let reserved = &v[12 - explore..];
        for &id in reserved {
            assert!(id > 12 && id % 2 == 0, "explores the FRESH (even) tail, got {id}");
        }
        assert_eq!(sel(3), v, "exploration is stable for a fixed visit seed");
    }

    // --- N5 shelf lineup selection --------------------------------------

    #[test]
    fn arrange_shelves_balances_intents_caps_and_rotates() {
        use ShelfIntent::*;
        let mk = |title: &str, intent: ShelfIntent| {
            let mut s = track_row_shelf(title, vec![th(1, "a", "A", 0)]);
            s.intent = intent;
            s
        };
        // 12 candidates: 4 Familiar, 2 Fresh, 3 Discover, 3 Editorial.
        let candidates = || {
            vec![
                mk("F1", Familiar),
                mk("F2", Familiar),
                mk("F3", Familiar),
                mk("F4", Familiar),
                mk("R1", Fresh),
                mk("R2", Fresh),
                mk("D1", Discover),
                mk("D2", Discover),
                mk("D3", Discover),
                mk("E1", Editorial),
                mk("E2", Editorial),
                mk("E3", Editorial),
            ]
        };
        let titles = |v: &[HomeShelf]| -> Vec<String> {
            v.iter().map(|s| s.title.clone()).collect()
        };

        let a = arrange_shelves(candidates(), 1, chrono::Weekday::Mon);
        assert!(a.len() <= 7, "page budget capped at 7, got {}", a.len());
        for lane in [Familiar, Fresh, Discover, Editorial] {
            let c = a.iter().filter(|s| s.intent == lane).count();
            assert!(c <= 2, "{lane:?} exceeds the per-intent cap: {c}");
            assert!(c >= 1, "{lane:?} missing — every lane should be represented");
        }
        // No two adjacent shelves share an intent (the round-robin interleaves).
        assert!(
            a.windows(2).all(|w| w[0].intent != w[1].intent),
            "intents should interleave, not clump"
        );
        // The lineup rotates across visits (which shelves and/or their order).
        let differs = (2u64..8).any(|s| titles(&arrange_shelves(candidates(), s, chrono::Weekday::Mon)) != titles(&a));
        assert!(differs, "the shelf lineup should rotate visit to visit");
        // Same seed reproduces the same lineup (per-visit stable).
        assert_eq!(titles(&arrange_shelves(candidates(), 1, chrono::Weekday::Mon)), titles(&a));

        // A small candidate set hides nothing — it's only (re)ordered.
        let small = vec![mk("F1", Familiar), mk("R1", Fresh), mk("D1", Discover)];
        assert_eq!(arrange_shelves(small, 5, chrono::Weekday::Mon).len(), 3, "small feeds keep every shelf");
    }

    #[test]
    fn arrange_shelves_friday_promotes_release_lead() {
        use ShelfIntent::*;
        let mk = |title: &str, intent: ShelfIntent, rank: u8| {
            let mut s = track_row_shelf(title, vec![th(1, "a", "A", 0)]);
            s.intent = intent;
            s.release_rank = rank;
            s
        };
        let cands = || {
            vec![
                mk("F1", Familiar, 0),
                mk("Release Radar", Fresh, 3),
                mk("D1", Discover, 0),
                mk("New releases", Fresh, 1),
                mk("New for you", Discover, 2),
                mk("E1", Editorial, 0),
            ]
        };
        // Friday: the highest-rank release shelf leads, retitled, exactly once.
        let fri = arrange_shelves(cands(), 1, chrono::Weekday::Fri);
        assert_eq!(fri[0].title, "New this Friday", "Friday opens on new music");
        assert_eq!(fri[0].eyebrow.as_deref(), Some("It's release day"));
        assert_eq!(
            fri.iter().filter(|s| s.eyebrow.as_deref() == Some("It's release day")).count(),
            1,
            "the promoted shelf isn't double-served"
        );
        assert!(fri.iter().all(|s| s.title != "Release Radar"), "the rank-3 shelf was the one promoted");
        // Any other day: no promotion, release shelves keep their titles.
        let mon = arrange_shelves(cands(), 1, chrono::Weekday::Mon);
        assert!(mon.iter().all(|s| s.title != "New this Friday"), "no Friday lead on other days");
        assert!(mon.iter().any(|s| s.title == "Release Radar"), "release shelf untouched on Mon");
    }

    #[test]
    fn arrange_shelves_pins_release_radar_off_friday() {
        use ShelfIntent::*;
        let mk = |title: &str, intent: ShelfIntent, rank: u8| {
            let mut s = track_row_shelf(title, vec![th(1, "a", "A", 0)]);
            s.intent = intent;
            s.release_rank = rank;
            s
        };
        // A full lineup that exhausts the 7-slot budget and would rotate a lone
        // Fresh shelf off the page on some visits — Release Radar (rank 3) must
        // survive EVERY non-Friday visit regardless of the seed, exactly once.
        let cands = || {
            vec![
                mk("F1", Familiar, 0),
                mk("F2", Familiar, 0),
                mk("F3", Familiar, 0),
                mk("F4", Familiar, 0),
                mk("Release Radar", Fresh, 3),
                mk("New releases", Fresh, 1),
                mk("D1", Discover, 0),
                mk("D2", Discover, 0),
                mk("D3", Discover, 0),
                mk("E1", Editorial, 0),
                mk("E2", Editorial, 0),
                mk("E3", Editorial, 0),
            ]
        };
        for seed in 1u64..24 {
            let a = arrange_shelves(cands(), seed, chrono::Weekday::Wed);
            assert_eq!(
                a.iter().filter(|s| s.title == "Release Radar").count(),
                1,
                "Release Radar must be pinned exactly once on every non-Friday visit (seed {seed})"
            );
        }
    }

    // --- rail tiles + spotlight (Made-for-you) --------------------------

    #[test]
    fn home_shelf_serializes_display_hint() {
        // A normal row omits `display` entirely — the byte-level guarantee that
        // an older bundled client sees no unexpected field.
        let row = track_row_shelf("Row", vec![th(1, "a", "A", 0)]);
        assert!(
            !serde_json::to_string(&row).unwrap().contains("display"),
            "an untagged shelf must omit the field"
        );
        // A rail shelf advertises the hint.
        let rail = track_row_shelf("Mix", vec![th(1, "a", "A", 0)]).rail();
        assert!(
            serde_json::to_string(&rail)
                .unwrap()
                .contains("\"display\":\"rail\""),
            "a rail shelf must serialize the hint"
        );
    }

    #[test]
    fn arrange_shelves_rail_bypasses_lanes_and_budget() {
        use ShelfIntent::*;
        let mk = |title: &str, intent: ShelfIntent| {
            let mut s = track_row_shelf(title, vec![th(1, "a", "A", 0)]);
            s.intent = intent;
            s
        };
        // 12 lane candidates (enough to fill the 7-slot budget) + one Familiar
        // rail mix that must NOT count against either the budget or the lane cap.
        let mut cands = vec![
            mk("F1", Familiar),
            mk("F2", Familiar),
            mk("F3", Familiar),
            mk("F4", Familiar),
            mk("R1", Fresh),
            mk("R2", Fresh),
            mk("D1", Discover),
            mk("D2", Discover),
            mk("D3", Discover),
            mk("E1", Editorial),
            mk("E2", Editorial),
            mk("E3", Editorial),
        ];
        let mut rail = track_row_shelf("ArtistMix", vec![th(1, "a", "A", 0)]).rail();
        rail.intent = Familiar;
        cands.push(rail);

        let out = arrange_shelves(cands, 3, chrono::Weekday::Mon);
        assert_eq!(
            out.last().unwrap().title,
            "ArtistMix",
            "the rail mix survives and rides at the end"
        );
        let non_rail = out.iter().filter(|s| s.display != Some("rail")).count();
        assert!(non_rail <= 7, "budget still caps NON-rail rows at 7, got {non_rail}");
        let fam_rows = out
            .iter()
            .filter(|s| s.intent == Familiar && s.display != Some("rail"))
            .count();
        assert!(fam_rows <= 2, "Familiar lane cap still holds for rows, got {fam_rows}");
    }

    #[test]
    fn arrange_shelves_marks_exactly_one_spotlight() {
        use ShelfIntent::*;
        let disc = |title: &str, intent: ShelfIntent| {
            let mut s = track_row_shelf(title, vec![th(1, "a", "A", 0)]).discovery();
            s.intent = intent;
            s
        };
        let candidates = || {
            // 5 discovery track_rows across 3 lanes (all survive the caps), one
            // non-discovery stat_row (ineligible), one rail mix (ineligible).
            let mut stat = HomeShelf::stat_row("Stat", None, vec![]);
            stat.intent = Editorial;
            let mut rail = track_row_shelf("Mix", vec![th(1, "a", "A", 0)]).discovery().rail();
            rail.intent = Familiar;
            vec![
                disc("t1", Familiar),
                disc("t2", Familiar),
                disc("t3", Fresh),
                disc("t4", Discover),
                disc("t5", Discover),
                stat,
                rail,
            ]
        };
        let spot_title = |seed: u64| -> Option<String> {
            let out = arrange_shelves(candidates(), seed, chrono::Weekday::Mon);
            let hits: Vec<&HomeShelf> =
                out.iter().filter(|s| s.display == Some("spotlight")).collect();
            assert!(hits.len() <= 1, "at most one spotlight per visit");
            for h in &hits {
                assert_eq!(h.kind, "track_row", "spotlight is only ever a track_row");
                assert!(h.discovery, "spotlight is only ever a discovery shelf");
                assert_ne!(h.title, "Mix", "the rail mix is never spotlit");
                assert_ne!(h.title, "Stat", "a stat_row is never spotlit");
            }
            assert!(
                out.iter().any(|s| s.title == "Mix" && s.display == Some("rail")),
                "the rail mix keeps its own hint"
            );
            hits.first().map(|s| s.title.clone())
        };
        let a = spot_title(1);
        assert!(a.is_some(), "a feed with eligible shelves gets a spotlight");
        assert_eq!(spot_title(1), a, "the spotlight pick is stable per seed");
        let differs = (2u64..12).any(|s| spot_title(s) != a);
        assert!(differs, "the spotlight pick rotates across visits");

        // Zero eligible (only a stat_row) → zero spotlights, no panic.
        let mut stat = HomeShelf::stat_row("Stat", None, vec![]);
        stat.intent = Familiar;
        let out = arrange_shelves(vec![stat], 7, chrono::Weekday::Mon);
        assert!(out.iter().all(|s| s.display != Some("spotlight")));
    }

    #[test]
    fn mix_shelves_tagged_rail() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        // 8 distinct Rock tracks, each played → clears the >=8-distinct genre gate
        // and the >=5-track shelf floor, so build_genre_mixes yields the Rock mix.
        for i in 0..8 {
            let id = seed_track(&conn, &format!("rock:{i}"), "S", &["A"], None, 200_000);
            set_genre(&conn, id, "Rock");
            seed_play(&conn, id, None, now, 200_000, true);
        }
        let mixes = build_genre_mixes(&conn, None, 42);
        assert!(!mixes.is_empty(), "expected at least the Rock mix");
        for m in &mixes {
            assert_eq!(m.display, Some("rail"), "a genre mix must carry the rail hint");
            assert_eq!(m.kind, "stat_row");
        }
    }

    // --- N0 impression memory -------------------------------------------

    #[test]
    fn annotate_overlays_library_credits_onto_catalog_hits_richer_wins() {
        let conn = open_test_db();
        // A library row healed to full credits (backfill / import enrichment).
        let full = catalog_track(
            "deezer",
            "77",
            "When I'm Home",
            &["James Blake", "Travis Scott", "Ludwig Göransson"],
            None,
            None,
            None,
        );
        upsert_track(&conn, &full).unwrap();
        // The same track arriving from a catalog surface (album tracklist /
        // search), which only ever knows the primary artist…
        let mut hits =
            vec![catalog_track("deezer", "77", "When I'm Home", &["James Blake"], None, None, None)];
        annotate_with_library_state(&conn, &mut hits, None).unwrap();
        assert_eq!(
            hits[0].artists,
            vec!["James Blake", "Travis Scott", "Ludwig Göransson"],
            "an owned track shows its library credits on catalog surfaces"
        );
        assert!(hits[0].local_track_id.is_some());

        // …and the reverse: a THIN library row must never strip names the
        // catalog provided.
        let thin = catalog_track("deezer", "78", "Solo", &["A"], None, None, None);
        upsert_track(&conn, &thin).unwrap();
        let mut hits2 = vec![catalog_track("deezer", "78", "Solo", &["A", "B"], None, None, None)];
        annotate_with_library_state(&conn, &mut hits2, None).unwrap();
        assert_eq!(hits2[0].artists, vec!["A", "B"]);
    }

    #[test]
    fn credit_names_prefers_contributors_dedups_and_falls_back_to_primary() {
        let refs = |names: &[&str]| -> Vec<crate::deezer::ArtistRef> {
            names.iter().map(|n| crate::deezer::ArtistRef { name: (*n).into() }).collect()
        };
        // Full credits, order preserved, case-insensitive dedup, blanks dropped.
        assert_eq!(
            credit_names(
                &refs(&["James Blake", "Travis Scott", "james blake", " ", "Ludwig Göransson"]),
                "James Blake"
            ),
            vec!["James Blake", "Travis Scott", "Ludwig Göransson"]
        );
        // No contributors (search hits) → the primary artist alone.
        assert_eq!(credit_names(&refs(&[]), "James Blake"), vec!["James Blake"]);
    }

    #[test]
    fn upsert_never_downgrades_a_richer_artists_array() {
        let conn = open_test_db();
        // Born with full credits (the import-time enrichment or Spotify sync).
        let full = catalog_track(
            "deezer",
            "42",
            "When I'm Home",
            &["James Blake", "Travis Scott", "Ludwig Göransson"],
            None,
            None,
            Some("USQ4E2600373"),
        );
        let (tid, new) = upsert_track(&conn, &full).unwrap();
        assert!(new);
        // Re-touched later via a /search hit that only knows one artist —
        // exactly what tap-to-play sends. This used to shrink the array.
        let thin = catalog_track(
            "deezer",
            "42",
            "When I'm Home",
            &["James Blake"],
            None,
            None,
            Some("USQ4E2600373"),
        );
        let (tid2, new2) = upsert_track(&conn, &thin).unwrap();
        assert_eq!((tid2, new2), (tid, false), "same row, not a duplicate");
        let stored: String = conn
            .query_row("SELECT artists FROM tracks WHERE id = ?1", params![tid], |r| r.get(0))
            .unwrap();
        let names: Vec<String> = serde_json::from_str(&stored).unwrap();
        assert_eq!(names.len(), 3, "full credits survive a thin re-upsert: {stored}");
        // And the reverse still upgrades: a thin row later touched with full
        // credits adopts them.
        let thin2 = catalog_track("deezer", "43", "Solo", &["A"], None, None, None);
        let (t2, _) = upsert_track(&conn, &thin2).unwrap();
        let full2 = catalog_track("deezer", "43", "Solo", &["A", "B"], None, None, None);
        upsert_track(&conn, &full2).unwrap();
        let stored2: String = conn
            .query_row("SELECT artists FROM tracks WHERE id = ?1", params![t2], |r| r.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&stored2).unwrap(), vec!["A", "B"]);
    }

    #[test]
    fn home_impressions_bump_once_per_day_and_skip_non_discovery() {
        let conn = open_test_db();
        let disc =
            track_row_shelf("Disc", vec![th(1, "s1", "A", 0), th(2, "s2", "B", 0)]).discovery();
        let plain = track_row_shelf("Plain", vec![th(9, "s9", "Z", 0)]);
        let shelves = vec![disc, plain];

        // Two serves on the same day: one row per discovery item, shown_days = 1.
        log_home_impressions(&conn, Some(7), "2026-07-06", &shelves);
        log_home_impressions(&conn, Some(7), "2026-07-06", &shelves);
        let row = |key: &str| -> Option<(i64, String, String)> {
            conn.query_row(
                "SELECT shown_days, first_shown, last_shown FROM home_impressions
                 WHERE profile_id = 7 AND item_kind = 'track' AND item_key = ?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
        };
        assert_eq!(
            row("deezer:1"),
            Some((1, "2026-07-06".into(), "2026-07-06".into())),
            "same-day repeats don't inflate shown_days"
        );

        // A later date bumps the counter and advances last_shown, not first_shown.
        log_home_impressions(&conn, Some(7), "2026-07-07", &shelves);
        assert_eq!(
            row("deezer:1"),
            Some((2, "2026-07-06".into(), "2026-07-07".into())),
            "a new day bumps shown_days once"
        );

        // A serve with an EARLIER local date (clock rollback / westward travel)
        // must NOT regress last_shown or double-count: max() keeps it monotonic.
        log_home_impressions(&conn, Some(7), "2026-07-05", &shelves);
        assert_eq!(
            row("deezer:1"),
            Some((2, "2026-07-06".into(), "2026-07-07".into())),
            "a backdated serve leaves shown_days + last_shown untouched"
        );

        // Non-discovery shelves are never logged.
        assert_eq!(row("deezer:9"), None, "non-discovery shelf items not logged");

        // The no-profile default logs under the 0 sentinel.
        log_home_impressions(&conn, None, "2026-07-06", &shelves);
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM home_impressions WHERE profile_id = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2, "None profile stored under sentinel 0");
    }

    #[test]
    fn home_impressions_prune_drops_stale_rows_and_load_fatigue_reads_prior_days() {
        let conn = open_test_db();
        // A very old impression (last shown years ago) and today's serve.
        conn.execute(
            "INSERT INTO home_impressions
                 (profile_id, item_kind, item_key, first_shown, last_shown, shown_days)
             VALUES (7, 'track', 'deezer:old', '2000-01-01', '2000-01-01', 9)",
            [],
        )
        .unwrap();
        let disc = track_row_shelf("Disc", vec![th(1, "s1", "A", 0)]).discovery();
        log_home_impressions(&conn, Some(7), "2026-07-06", &[disc]);

        // The stale row is pruned; today's fresh impression survives.
        let has = |key: &str| -> bool {
            conn.query_row(
                "SELECT 1 FROM home_impressions WHERE profile_id = 7 AND item_key = ?1",
                params![key],
                |_| Ok(()),
            )
            .is_ok()
        };
        assert!(!has("deezer:old"), "impressions older than 180d are pruned");
        assert!(has("deezer:1"), "today's impression is retained");

        // load_fatigue counts only PRIOR days: an item last shown TODAY is
        // excluded (so repeat serves within a day don't shift the discount).
        conn.execute(
            "INSERT INTO home_impressions
                 (profile_id, item_kind, item_key, first_shown, last_shown, shown_days)
             VALUES (7, 'track', 'deezer:prior', '2026-07-01', '2026-07-05', 5)",
            [],
        )
        .unwrap();
        let f = load_fatigue(&conn, Some(7), "2026-07-06");
        assert_eq!(f.tier(&fatigue_key("track", "deezer:prior")), 1, "5 prior days → tier 1");
        assert_eq!(
            f.tier(&fatigue_key("track", "deezer:1")),
            0,
            "an item last shown TODAY is not counted as prior exposure"
        );
        assert_eq!(
            f.tier(&fatigue_key("track", "deezer:unseen")),
            0,
            "an unseen item is freshest (tier 0)"
        );
    }

    /// Live smoke test for the Deezer resolution half of the song shelf's
    /// network path (keyless API — needs only a network). Ignored by default;
    /// run with `cargo test -- --ignored deezer`.
    #[tokio::test]
    #[ignore = "live network"]
    async fn deezer_resolves_a_known_pair_to_playable_hits() {
        let hits = deezer_resolve_tracks_parallel(
            vec![("Believe".to_string(), "Cher".to_string())],
            resolve_limiter(),
        )
        .await;
        assert!(!hits.is_empty(), "a globally known track should resolve");
        assert!(hits.iter().all(|h| h.id > 0 && !h.title.is_empty()));
    }

    #[test]
    fn song_similar_pick_drops_seed_song_seed_artist_and_dupes_but_keeps_library_artists() {
        let hits = vec![
            th(1, "Pyramid Song", "Radiohead", 0), // the seed itself — dropped
            th(2, "Weird Fishes", "Radiohead", 0), // seed artist's catalog — dropped
            th(3, "Teardrop", "Massive Attack", 0),
            th(3, "Teardrop", "Massive Attack", 0), // dupe id — dropped
            th(4, "Roads", "Portishead", 0),
        ];
        let out = song_similar_pick(hits, "Pyramid Song", "Radiohead", 24);
        let titles: Vec<&str> = out.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, vec!["Teardrop", "Roads"]);

        // The cap is honored.
        let many: Vec<_> = (10..40).map(|i| th(i, &format!("t{i}"), "X", 0)).collect();
        assert_eq!(song_similar_pick(many, "seed", "Seed Artist", 5).len(), 5);
    }

    #[test]
    fn discovery_report_joins_impressions_to_adoption_and_groups_by_shelf() {
        let conn = open_test_db();
        // play_events.profile_id gained an FK in migration 024 — the profile
        // must exist before a play can reference it.
        conn.execute("INSERT INTO profiles (id, name) VALUES (7, 'T')", [])
            .unwrap();
        let radar = track_row_shelf("Radar", vec![th(1, "kept", "A", 0)]).discovery();
        let under = track_row_shelf("Under", vec![th(2, "ignored", "B", 0)]).discovery();
        log_home_impressions(&conn, Some(7), "2026-07-01", &[radar, under]);

        // Track 1 was adopted: imported to the library (catalog identity becomes
        // spotify_id) and played twice after it was shown — one full listen, one
        // partial. Track 2 was shown and never touched.
        conn.execute(
            "INSERT INTO tracks (spotify_id, title, artists, duration_ms)
             VALUES ('deezer:1', 'kept', '[\"A\"]', 200000)",
            [],
        )
        .unwrap();
        let tid: i64 = conn
            .query_row("SELECT id FROM tracks WHERE spotify_id = 'deezer:1'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO play_events (track_id, profile_id, played_at, ms_played, completed)
             VALUES (?1, 7, strftime('%s','2026-07-02'), 200000, 1),
                    (?1, 7, strftime('%s','2026-07-03'), 90000, 0)",
            params![tid],
        )
        .unwrap();
        // A play from BEFORE the impression must not count toward the funnel.
        conn.execute(
            "INSERT INTO play_events (track_id, profile_id, played_at, ms_played, completed)
             VALUES (?1, 7, strftime('%s','2026-06-01'), 200000, 1)",
            params![tid],
        )
        .unwrap();

        let rep = home_discovery_report(&conn, Some(7));
        let kept = rep.items.iter().find(|i| i.item_key == "deezer:1").unwrap();
        assert!(kept.in_library);
        assert_eq!(kept.plays_since_shown, 2, "the pre-impression play is excluded");
        assert_eq!(kept.completed_since_shown, 1);
        assert_eq!(kept.shelf.as_deref(), Some("Radar"));
        let ignored = rep.items.iter().find(|i| i.item_key == "deezer:2").unwrap();
        assert!(!ignored.in_library);
        assert_eq!(ignored.plays_since_shown, 0);

        let radar_row = rep.shelves.iter().find(|s| s.shelf == "Radar").unwrap();
        assert_eq!((radar_row.items, radar_row.in_library, radar_row.played), (1, 1, 1));
        let under_row = rep.shelves.iter().find(|s| s.shelf == "Under").unwrap();
        assert_eq!((under_row.items, under_row.in_library, under_row.played), (1, 0, 0));

        // Another profile sees nothing — the funnel is profile-scoped.
        assert!(home_discovery_report(&conn, Some(8)).items.is_empty());
    }

    // --- P16 station ---------------------------------------------------

    #[test]
    fn station_seeds_rotate_and_shuffle() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        for i in 0..8 {
            let id = seed_track(
                &conn,
                &format!("st:{i}"),
                "S",
                &[&format!("Ar{i}")],
                None,
                200_000,
            );
            seed_play(&conn, id, None, now - i as i64, 200_000, true);
        }
        let s1 = daily_seed(None, "2026-07-01");
        let s2 = daily_seed(None, "2026-07-02");
        let a = station_seeds(&conn, None, s1);
        assert_eq!(a.len(), 5, "capped at 5");
        assert_eq!(a, station_seeds(&conn, None, s1), "stable within a day");
        assert_ne!(a, station_seeds(&conn, None, s2), "rotates across days");
    }

    #[test]
    fn station_mode_maps_knobs() {
        assert_eq!(station_mode(None), (PopMode::Favor, false));
        assert_eq!(station_mode(Some("deep")), (PopMode::Invert, false));
        assert_eq!(station_mode(Some("fresh")), (PopMode::Favor, true));
        assert_eq!(station_mode(Some("bogus")), (PopMode::Favor, false));
    }

    #[test]
    fn station_cache_key_canonicalizes_modes() {
        // The cache key is derived from the RESOLVED (pop, discovery) pair, so an
        // unknown mode shares the same cached batch as the default — and each real
        // mode gets its own slot.
        let for_you = station_mode(None);
        let deep = station_mode(Some("deep"));
        let fresh = station_mode(Some("fresh"));
        let bogus = station_mode(Some("bogus"));
        assert_eq!(station_cache_key(for_you.0, for_you.1), "for-you");
        assert_eq!(station_cache_key(deep.0, deep.1), "deep");
        assert_eq!(station_cache_key(fresh.0, fresh.1), "fresh");
        // Unknown mode must collapse onto the default key (not create a third).
        assert_eq!(
            station_cache_key(bogus.0, bogus.1),
            station_cache_key(for_you.0, for_you.1),
        );
    }

    // --- P7 tag shelf --------------------------------------------------

    #[test]
    fn dominant_tags_aggregates_across_top_artists() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        let a = seed_track(&conn, "tg:a", "A", &["Alpha"], None, 200_000);
        let b = seed_track(&conn, "tg:b", "B", &["Beta"], None, 200_000);
        seed_play(&conn, a, None, now, 200_000, true);
        seed_play(&conn, b, None, now, 200_000, true);
        let ins = |k: &str, tag: &str, w: i64| {
            conn.execute(
                "INSERT INTO artist_tags (artist_key, tag, weight) VALUES (?1,?2,?3)",
                params![k, tag, w],
            )
            .unwrap();
        };
        let ka = crate::tags::artist_key("Alpha");
        let kb = crate::tags::artist_key("Beta");
        ins(&ka, "shoegaze", 80);
        ins(&kb, "shoegaze", 70); // shared → summed to 150
        ins(&ka, "noise pop", 90);
        ins(&ka, "seen live", 100); // generic → excluded
        let tags = dominant_tags(&conn, None, 12);
        assert_eq!(
            tags.first().map(String::as_str),
            Some("shoegaze"),
            "a tag two top artists share should dominate"
        );
        assert!(tags.contains(&"noise pop".to_string()));
        assert!(!tags.contains(&"seen live".to_string()), "generic tag excluded");
    }

    #[test]
    fn tag_shelf_pick_drops_owned_and_dedups() {
        let mut lib = std::collections::HashSet::new();
        lib.insert(norm_artist("Owned"));
        let hits = vec![
            th(1, "s1", "Fresh1", 0),
            th(1, "s1dup", "Fresh1", 0), // duplicate id → dropped
            th(2, "s2", "Owned", 0),     // owned artist → dropped
            th(3, "s3", "Fresh2", 0),
        ];
        let out = tag_shelf_pick(hits, &lib);
        let ids: Vec<&str> = out.iter().map(|t| t.source_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "3"]);
    }

    // --- P8 cross-shelf de-dup -----------------------------------------

    fn track_row_shelf(title: &str, hits: Vec<crate::deezer::TrackHit>) -> HomeShelf {
        HomeShelf::track_row(title, None, hits.into_iter().map(track_hit_to_out).collect())
    }

    #[test]
    fn curate_dedups_across_discovery_track_rows() {
        // Shelves A and B both contain deezer track id 1; A is first so it keeps
        // it and B drops the duplicate (B has an extra track so it still meets 5).
        let a = track_row_shelf(
            "A",
            vec![
                th(1, "shared", "Zed", 0),
                th(2, "a2", "Ann", 0),
                th(3, "a3", "Bo", 0),
                th(4, "a4", "Cy", 0),
                th(5, "a5", "Di", 0),
            ],
        );
        let b = track_row_shelf(
            "B",
            vec![
                th(1, "shared2", "Zed", 0), // ("deezer","1") already claimed by A
                th(6, "b2", "Ev", 0),
                th(7, "b3", "Fi", 0),
                th(8, "b4", "Gu", 0),
                th(9, "b5", "Ha", 0),
                th(10, "b6", "Io", 0),
            ],
        );
        let out = curate_home_shelves(vec![a, b], &std::collections::HashSet::new());
        assert_eq!(out.len(), 2, "both shelves should survive");
        let a_ids: Vec<&str> = out[0].tracks.iter().map(|t| t.source_id.as_str()).collect();
        let b_ids: Vec<&str> = out[1].tracks.iter().map(|t| t.source_id.as_str()).collect();
        assert!(a_ids.contains(&"1"));
        assert!(!b_ids.contains(&"1"), "a shared track must not repeat across shelves");
        assert!(out[1].tracks.len() >= 5, "B still meets the floor");
    }

    #[test]
    fn curate_caps_per_artist_in_track_rows() {
        let a = track_row_shelf(
            "A",
            vec![
                th(1, "x1", "Solo", 0),
                th(2, "x2", "Solo", 0),
                th(3, "x3", "Solo", 0), // 3rd by Solo → capped out
                th(4, "x4", "B", 0),
                th(5, "x5", "C", 0),
                th(6, "x6", "D", 0),
            ],
        );
        let out = curate_home_shelves(vec![a], &std::collections::HashSet::new());
        let solo = out[0]
            .tracks
            .iter()
            .filter(|t| t.artists.first().map(String::as_str) == Some("Solo"))
            .count();
        assert!(solo <= 2, "at most 2 tracks per artist in a discovery shelf");
    }

    // --- P12 editorial-on-Home -----------------------------------------

    fn set_genre(conn: &Connection, id: i64, genre: &str) {
        conn.execute("UPDATE tracks SET genre = ?1 WHERE id = ?2", params![genre, id])
            .unwrap();
    }

    #[test]
    fn top_genre_profile_orders_gates_and_isolates() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        let mk = |g: &str, n: usize, plays: usize, pid: Option<i64>| {
            for i in 0..n {
                let id = seed_track(&conn, &format!("{g}:{i}"), "S", &["A"], None, 200_000);
                set_genre(&conn, id, g);
                for _ in 0..plays {
                    seed_play(&conn, id, pid, now, 200_000, true);
                }
            }
        };
        mk("Rock", 8, 2, None); // 8 distinct, weight 24 — leads
        mk("Pop", 8, 1, None); // 8 distinct, weight 12
        mk("Jazz", 7, 5, None); // only 7 distinct → below the >=8 gate
        let u = seed_track(&conn, "u:1", "U", &["A"], None, 200_000);
        set_genre(&conn, u, "Unknown");
        seed_play(&conn, u, None, now, 200_000, true);
        // The decoy needs a real profile row now: play_events cascades off
        // profiles(id) since migration 024, so plays belonging to a profile
        // that was never created are a state neither the DB nor the app can
        // reach. Only the fixture was pretending otherwise.
        conn.execute(
            "INSERT INTO profiles (id, name, avatar_color) VALUES (2, 'Decoy', '#222222')",
            [],
        )
        .unwrap();
        mk("Electronic", 8, 9, Some(2)); // profile 2 decoy — must not leak

        assert_eq!(
            top_genre_profile(&conn, None, 3),
            vec!["Rock", "Pop"],
            "weight order; Jazz gated (<8 distinct); Unknown + other-profile excluded"
        );
    }

    #[test]
    fn top_genre_profile_tops_up_from_onboarding_picks() {
        let conn = open_test_db();
        let now = chrono::Utc::now().timestamp();
        let set_saved_genres = |json: &str| {
            conn.execute(
                "INSERT OR REPLACE INTO profile_kv (profile_id, key, value)
                 VALUES (1, 'saved_genres', ?1)",
                params![json],
            )
            .unwrap();
        };
        let mk = |g: &str, plays: usize| {
            for i in 0..8 {
                let id = seed_track(&conn, &format!("{g}:{i}"), "S", &["A"], None, 200_000);
                set_genre(&conn, id, g);
                for _ in 0..plays {
                    seed_play(&conn, id, Some(1), now, 200_000, true);
                }
            }
        };
        set_saved_genres(r#"["Electronic","Jazz"]"#);

        // Cold profile: no play history → the onboarding genre picks stand in,
        // so the "Popular in {genre}" shelves have something on day one.
        assert_eq!(
            top_genre_profile(&conn, Some(1), 3),
            vec!["Electronic", "Jazz"],
            "no history → onboarding genre picks fill the shelf"
        );

        // Thin history (one qualifying bucket, below MIN_GENRE_SEEDS): history
        // leads, picks top up to fill the remaining slots.
        mk("Rock", 2);
        assert_eq!(
            top_genre_profile(&conn, Some(1), 3),
            vec!["Rock", "Electronic", "Jazz"],
            "thin history leads, picks top up"
        );

        // Warm profile (>= MIN_GENRE_SEEDS real buckets): seeded purely by
        // history, the picks fade — an established profile is unaffected.
        mk("Pop", 1);
        assert_eq!(
            top_genre_profile(&conn, Some(1), 3),
            vec!["Rock", "Pop"],
            "warm profile seeded by history; picks ignored"
        );
    }

    #[test]
    fn bucket_to_deezer_genre_maps_known_skips_folk() {
        assert_eq!(bucket_to_deezer_genre("Hip-Hop"), Some(116));
        assert_eq!(bucket_to_deezer_genre("Rock"), Some(152));
        assert_eq!(bucket_to_deezer_genre("Electronic"), Some(113));
        assert_eq!(bucket_to_deezer_genre("Folk"), None);
        assert_eq!(bucket_to_deezer_genre("nonsense"), None);
    }

    #[test]
    fn pick_artist_prefers_exact_name_with_photo_by_fans() {
        let real = "https://cdn-images.dzcdn.net/images/artist/hash/1000x1000-000000-80-0-0.jpg";
        let blank = "https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg";
        let mk = |id: u64, name: &str, pic: Option<&str>, fans: u64| crate::deezer::ArtistHit {
            id,
            name: name.into(),
            picture_xl: pic.map(Into::into),
            picture_big: None,
            picture_medium: None,
            nb_album: None,
            nb_fan: Some(fans),
        };

        // Deezer's real ordering for "Drake": a 50-fan impostor first, the real
        // 24M-fan Drake buried, plus a photo-less phantom. Must pick the real one.
        let hits = vec![
            mk(1, "Drake", Some(real), 50),
            mk(2, "Drake", Some(real), 29),
            mk(3, "Drake", Some(real), 24_030_757),
            mk(4, "Nick Drake", Some(real), 101_633),
            mk(5, "Drake", Some(blank), 14),
        ];
        assert_eq!(pick_artist_for_name(hits, "Drake").map(|a| a.id), Some(3));

        // Exact name but every match is photo-less → still the most-fans exact
        // match (not a different-name artist that happens to have a photo).
        let no_photos = vec![
            mk(10, "Zzz", Some(real), 9_000_000),
            mk(11, "Solo", Some(blank), 100),
            mk(12, "Solo", None, 5_000),
        ];
        assert_eq!(pick_artist_for_name(no_photos, "Solo").map(|a| a.id), Some(12));

        assert!(pick_artist_for_name(vec![], "Anyone").is_none());
    }

    #[test]
    fn curate_dedups_playlist_rows() {
        let pl = |id: &str, title: &str| PlaylistOut {
            source: "deezer",
            source_id: id.into(),
            title: title.into(),
            cover_url: None,
            track_count: None,
            creator: None,
        };
        let a = HomeShelf::playlist_row("A", None, vec![pl("1", "Shared"), pl("2", "A2")]);
        let b = HomeShelf::playlist_row("B", None, vec![pl("1", "Shared"), pl("3", "B3")]);
        let out = curate_home_shelves(vec![a, b], &std::collections::HashSet::new());
        assert_eq!(out.len(), 2, "both survive");
        let b_ids: Vec<&str> = out[1].playlists.iter().map(|p| p.source_id.as_str()).collect();
        assert!(!b_ids.contains(&"1"), "shared playlist de-duped from the later shelf");
        assert!(b_ids.contains(&"3"));
    }

    // CI-style backstop mirroring the pre-commit leak-guard: catches a
    // `--no-verify` bypass that lands forbidden tokens in the open core. The
    // token list lives ONLY in the (untracked) hook / its source script, so this
    // test carries no such literals itself. Locally it reads the installed hook;
    // point $BEETBOT_LEAKGUARD at the source script in CI (a fresh clone has no
    // installed hook).
    #[test]
    fn open_core_has_no_forbidden_tokens() {
        use std::path::PathBuf;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let pattern_src = std::env::var("BEETBOT_LEAKGUARD")
            .ok()
            .map(PathBuf::from)
            .into_iter()
            .chain(std::iter::once(root.join(".git/hooks/pre-commit")))
            .find_map(|p| std::fs::read_to_string(&p).ok());
        let Some(script) = pattern_src else {
            eprintln!("leak-guard pattern source not found; skipping tree scan");
            return;
        };
        let line = script
            .lines()
            .find(|l| l.trim_start().starts_with("patterns="))
            .expect("patterns= line in leak-guard script");
        let raw = line
            .split_once('=')
            .unwrap()
            .1
            .trim()
            .trim_matches('\'')
            .trim_matches('"');
        // Expand each alternation into concrete lowercase needles (the single
        // `[-_]` character-class becomes two variants).
        let mut needles: Vec<String> = Vec::new();
        for pat in raw.split('|') {
            if pat.contains("[-_]") {
                needles.push(pat.replace("[-_]", "-").to_lowercase());
                needles.push(pat.replace("[-_]", "_").to_lowercase());
            } else {
                needles.push(pat.to_lowercase());
            }
        }

        let scan_dirs = ["src-tauri/src", "shared", "src", "web-player"];
        let exts = ["rs", "ts", "tsx", "js", "jsx", "sql"];
        let skip = ["node_modules", "target", "dist", ".git"];
        let mut offenders: Vec<String> = Vec::new();
        for d in scan_dirs {
            let mut stack = vec![root.join(d)];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for e in entries.flatten() {
                    let p = e.path();
                    let name = e.file_name().to_string_lossy().to_string();
                    if p.is_dir() {
                        if !skip.contains(&name.as_str()) {
                            stack.push(p);
                        }
                        continue;
                    }
                    let scannable = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| exts.contains(&x))
                        .unwrap_or(false);
                    if !scannable {
                        continue;
                    }
                    let Ok(body) = std::fs::read_to_string(&p) else {
                        continue;
                    };
                    let lower = body.to_lowercase();
                    for needle in &needles {
                        if lower.contains(needle) {
                            offenders.push(format!("{} :: {needle}", p.display()));
                        }
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "open core contains forbidden tokens:\n{}",
            offenders.join("\n")
        );
    }
}
