//! Cast V2 session: one TLS connection per active cast, plus a
//! tokio task that owns it.
//!
//! Architecture: the public entry point [`CastSession::start`] returns
//! a [`CastHandle`] that the HTTP layer holds onto. The handle has a
//! command channel; sending commands (Play, Pause, Seek, Stop) is
//! how the caller drives playback after launch. The owning task
//! processes commands and incoming receiver/media messages in a
//! single `tokio::select!` loop, so we never split the TLS stream
//! across threads — one read, one write, simple.
//!
//! TLS note: Chromecasts present a self-signed cert and never expect
//! the sender to chain-validate it. We supply a `ServerCertVerifier`
//! that accepts anything. The actual trust model is LAN-bound: only
//! a device on the same network can reach `:8009` at all.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{
    self, ClientConfig, DigitallySignedStruct, SignatureScheme,
};
use tokio_rustls::TlsConnector;

use super::protocol::{
    self as proto, top_level_idle_reason, ConnectPayload, EnvelopeType,
    HeartbeatPayload, InboundEnvelope, LaunchPayload, LoadPayload,
    MediaCommandPayload, MediaImage, MediaInfo, MediaMetadata, MediaStatus,
    ReceiverStatus, SeekPayload, StopReceiverPayload, DEFAULT_MEDIA_RECEIVER,
    NS_CONNECTION, NS_HEARTBEAT, NS_MEDIA, NS_RECEIVER, RECEIVER_ID, SENDER_ID,
};

/// What the HTTP layer wants the cast session to do.
#[derive(Debug)]
pub enum CastCommand {
    Play,
    Pause,
    Seek(f64),
    Stop,
    /// Replace the currently-loaded media without tearing the session
    /// down. Used on track change to avoid the receiver re-initialising
    /// the Default Media Receiver app (which plays the "connect" chime
    /// every time). The driver sends a LOAD frame on the existing
    /// transport channel; the receiver replies with a fresh
    /// MEDIA_STATUS carrying a new mediaSessionId.
    LoadMedia(MediaPayload),
}

#[derive(Debug, Clone)]
pub struct MediaPayload {
    pub url: String,
    pub content_type: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub image_url: Option<String>,
    /// Local tracks.id we're loading. Recorded into CastStatus so
    /// the frontend can detect "track end" events accurately even
    /// across reconnects.
    pub track_id: i64,
    /// Where to start playback within the file, in seconds. 0.0 for
    /// a fresh track click; set to the previous session's currentTime
    /// when transferring playback between speakers, so the user
    /// resumes where they left off instead of starting over.
    pub start_time: f64,
}

/// Latest known state of the active receiver, populated by the
/// driver task from MEDIA_STATUS frames. The HTTP `GET /api/cast/status`
/// endpoint returns a snapshot of this so the frontend can sync the
/// scrubber and auto-advance the queue on track end.
#[derive(Debug, Clone, Serialize, Default)]
pub struct CastStatus {
    /// "PLAYING" / "PAUSED" / "BUFFERING" / "IDLE" (or empty if no
    /// MEDIA_STATUS has arrived yet). Mirrored verbatim from the
    /// receiver.
    pub player_state: String,
    /// Seconds into the current media. `None` between LOAD and the
    /// first MEDIA_STATUS that includes it.
    pub current_time: Option<f64>,
    /// Set when player_state is IDLE. "FINISHED" is the one the
    /// frontend listens for to advance the queue.
    pub idle_reason: Option<String>,
    /// Local track id we LOADed onto the device. Lets the frontend
    /// confirm the device is playing the same track it thinks it is.
    pub track_id: Option<i64>,
}

/// Handle the HTTP layer holds onto.  Cheap to clone; sending on the
/// dropped channel returns Err and the session task exits cleanly.
#[derive(Clone)]
pub struct CastHandle {
    pub device_id: String,
    pub device_name: String,
    tx: mpsc::Sender<CastCommand>,
    status: Arc<RwLock<CastStatus>>,
}

impl CastHandle {
    pub async fn send(&self, cmd: CastCommand) -> Result<(), CastError> {
        self.tx
            .send(cmd)
            .await
            .map_err(|_| CastError::Closed)
    }

    /// Snapshot of the latest receiver status. Cheap; the driver
    /// task updates this whenever a MEDIA_STATUS frame arrives.
    pub async fn status_snapshot(&self) -> CastStatus {
        self.status.read().await.clone()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CastError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("tls: {0}")]
    Tls(#[from] rustls::Error),
    #[error("invalid server name: {0}")]
    BadName(String),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("cast session is no longer running")]
    Closed,
    #[error("timeout waiting for {0}")]
    Timeout(&'static str),
}

pub struct CastSession;

impl CastSession {
    /// Connect to `ip:port`, launch the Default Media Receiver, and
    /// LOAD the given media. Returns once the LOAD has been
    /// acknowledged with a `mediaSessionId`. The owning task keeps
    /// running in the background and is reachable via the returned
    /// handle.
    pub async fn start(
        device_id: String,
        device_name: String,
        ip: std::net::IpAddr,
        port: u16,
        media: MediaPayload,
    ) -> Result<CastHandle, CastError> {
        // Build a TLS client that trusts whatever cert the Chromecast
        // hands us. Cast doesn't use chain-validated trust; the model
        // is "you can only talk to me if you're on my LAN."
        let mut tls_config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertVerify))
            .with_no_client_auth();
        // ALPN: Cast doesn't negotiate ALPN — leaving it empty keeps
        // the handshake compatible with older firmware.
        tls_config.alpn_protocols.clear();
        let connector = TlsConnector::from(Arc::new(tls_config));

        let tcp = TcpStream::connect((ip, port)).await?;
        tcp.set_nodelay(true)?;
        // ServerName must parse but the Chromecast doesn't actually
        // verify it (and we don't either).
        let name = ServerName::try_from(ip.to_string())
            .map_err(|e| CastError::BadName(e.to_string()))?;
        let mut tls = connector.connect(name, tcp).await?;

        // Connection-layer CONNECT to the device-wide receiver.
        proto::write_frame(
            &mut tls,
            &proto::json_msg(
                RECEIVER_ID,
                NS_CONNECTION,
                &ConnectPayload { kind: "CONNECT" },
            )?,
        )
        .await?;

        // LAUNCH the default media receiver. Track the request id and
        // wait for the RECEIVER_STATUS that echoes it.
        let mut next_request: u32 = 1;
        let launch_id = next_request;
        next_request += 1;
        proto::write_frame(
            &mut tls,
            &proto::json_msg(
                RECEIVER_ID,
                NS_RECEIVER,
                &LaunchPayload {
                    kind: "LAUNCH",
                    request_id: launch_id,
                    app_id: DEFAULT_MEDIA_RECEIVER,
                },
            )?,
        )
        .await?;

        let (transport_id, session_id) = wait_for_launch(&mut tls).await?;
        tracing::debug!(
            %transport_id, %session_id,
            "cast: receiver app launched"
        );

        // Virtual connection on the per-app transport.
        proto::write_frame(
            &mut tls,
            &proto::json_msg(
                &transport_id,
                NS_CONNECTION,
                &ConnectPayload { kind: "CONNECT" },
            )?,
        )
        .await?;

        // LOAD the media URL. mediaSessionId comes back in MEDIA_STATUS.
        let load_id = next_request;
        next_request += 1;
        proto::write_frame(
            &mut tls,
            &proto::json_msg(
                &transport_id,
                NS_MEDIA,
                &LoadPayload {
                    kind: "LOAD",
                    request_id: load_id,
                    media: MediaInfo {
                        content_id: &media.url,
                        content_type: &media.content_type,
                        stream_type: "BUFFERED",
                        metadata: Some(MediaMetadata {
                            metadata_type: 3,
                            title: &media.title,
                            artist: &media.artist,
                            album_name: media.album.as_deref(),
                            images: media
                                .image_url
                                .as_deref()
                                .map(|url| vec![MediaImage { url }])
                                .unwrap_or_default(),
                        }),
                    },
                    autoplay: true,
                    current_time: media.start_time,
                },
            )?,
        )
        .await?;

        let media_session_id = wait_for_media_status(&mut tls).await?;
        tracing::info!(
            device = %device_id,
            name = %device_name,
            media_session_id,
            url = %media.url,
            "cast: media loaded"
        );

        // Spawn the background driver task.
        let (cmd_tx, cmd_rx) = mpsc::channel(8);
        let status = Arc::new(RwLock::new(CastStatus {
            // Seed the snapshot so the frontend's first poll sees
            // who's playing what before the first MEDIA_STATUS frame.
            // Reflect the resume point we asked the receiver to start
            // at — otherwise the scrubber briefly snaps to 0 between
            // LOAD and the first echoed MEDIA_STATUS.
            player_state: "BUFFERING".into(),
            current_time: Some(media.start_time),
            track_id: Some(media.track_id),
            ..Default::default()
        }));
        let state = SessionState {
            transport_id,
            session_id,
            media_session_id: Arc::new(AtomicI64::new(media_session_id)),
            next_request: Arc::new(Mutex::new(next_request)),
            status: status.clone(),
        };
        tauri::async_runtime::spawn(driver(tls, cmd_rx, state));

        Ok(CastHandle {
            device_id,
            device_name,
            tx: cmd_tx,
            status,
        })
    }
}

struct SessionState {
    transport_id: String,
    session_id: String,
    /// Atomic so the driver task can update it from MEDIA_STATUS
    /// frames following a LoadMedia command — the receiver assigns a
    /// new mediaSessionId on each LOAD, and PLAY/PAUSE/SEEK refer to
    /// it.
    media_session_id: Arc<AtomicI64>,
    next_request: Arc<Mutex<u32>>,
    /// Shared with the parent CastHandle; the driver task writes
    /// here as MEDIA_STATUS arrives, the HTTP layer reads.
    status: Arc<RwLock<CastStatus>>,
}

impl SessionState {
    async fn next_id(&self) -> u32 {
        let mut g = self.next_request.lock().await;
        let id = *g;
        *g = g.wrapping_add(1).max(1);
        id
    }
}

async fn driver<S: AsyncReadExt + AsyncWriteExt + Unpin + Send + 'static>(
    mut tls: S,
    mut cmd_rx: mpsc::Receiver<CastCommand>,
    state: SessionState,
) {
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    // Skip the immediate fire — first tick is right away which would
    // hammer the receiver.
    heartbeat.tick().await;
    // Chromecasts don't push MEDIA_STATUS frames spontaneously — only on
    // state transitions (PLAY/PAUSE/SEEK/IDLE). Without explicit polling
    // we'd be stuck with whatever currentTime the receiver happened to
    // report on the initial LOAD (typically 0.0) for the entire track.
    // The frontend scrubber needs fresh time updates, so we send
    // GET_STATUS every second to nudge the receiver into replying.
    let mut media_status_poll = tokio::time::interval(Duration::from_secs(1));
    media_status_poll.tick().await;
    loop {
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { break; };
                if let Err(e) = handle_command(&mut tls, &state, cmd).await {
                    tracing::warn!(?e, "cast: command failed; closing session");
                    break;
                }
            }
            frame = proto::read_frame(&mut tls) => {
                match frame {
                    Ok(msg) => {
                        // Reply to heartbeat PINGs from the receiver.
                        if msg.namespace == NS_HEARTBEAT {
                            if let Some(p) = &msg.payload_utf8 {
                                if p.contains("\"PING\"") {
                                    let _ = proto::write_frame(
                                        &mut tls,
                                        &proto::json_msg(
                                            RECEIVER_ID,
                                            NS_HEARTBEAT,
                                            &HeartbeatPayload { kind: "PONG" },
                                        )
                                        .unwrap_or_else(|_| panic!("static pong")),
                                    )
                                    .await;
                                }
                            }
                        } else if msg.namespace == NS_MEDIA {
                            // Capture MEDIA_STATUS frames into the shared
                            // status so /api/cast/status can serve a live
                            // snapshot. The receiver sends one of these
                            // after every state change (play/pause/seek)
                            // plus periodically while playing.
                            if let Some(payload) = &msg.payload_utf8 {
                                if let Ok(parsed) = serde_json::from_str::<
                                    proto::InboundEnvelope,
                                >(payload) {
                                    if parsed.kind == "MEDIA_STATUS" {
                                        if let Ok(inner) = serde_json::from_str::<
                                            proto::MediaStatus,
                                        >(payload) {
                                            if let Some(entry) =
                                                inner.status.first()
                                            {
                                                // The receiver assigns
                                                // a fresh mediaSessionId
                                                // on each LOAD. Keep our
                                                // copy current so
                                                // PLAY/PAUSE/SEEK target
                                                // the right session.
                                                state
                                                    .media_session_id
                                                    .store(
                                                        entry.media_session_id,
                                                        Ordering::Relaxed,
                                                    );
                                                let mut s =
                                                    state.status.write().await;
                                                if let Some(ps) =
                                                    &entry.player_state
                                                {
                                                    s.player_state = ps.clone();
                                                }
                                                if let Some(t) =
                                                    entry.current_time
                                                {
                                                    s.current_time = Some(t);
                                                }
                                                s.idle_reason =
                                                    entry.idle_reason.clone();
                                            } else if let Some(reason) =
                                                top_level_idle_reason(payload)
                                            {
                                                // Some firmware ships an
                                                // empty status[] when the
                                                // media session ends, with
                                                // idleReason at the top
                                                // level. Pick it up.
                                                let mut s =
                                                    state.status.write().await;
                                                s.player_state = "IDLE".into();
                                                s.idle_reason = Some(reason);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Other messages (MEDIA_STATUS updates, etc.)
                        // are useful future telemetry. For M2 we just
                        // drop them — controller commands work from
                        // the cached mediaSessionId.
                    }
                    Err(e) => {
                        tracing::info!(?e, "cast: session read error; closing");
                        break;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if let Ok(msg) = proto::json_msg(
                    RECEIVER_ID,
                    NS_HEARTBEAT,
                    &HeartbeatPayload { kind: "PING" },
                ) {
                    if proto::write_frame(&mut tls, &msg).await.is_err() {
                        break;
                    }
                }
            }
            _ = media_status_poll.tick() => {
                // Ask the receiver for a fresh MEDIA_STATUS. The reply
                // arrives on the same TLS connection and is consumed by
                // the read_frame branch above, which updates the shared
                // CastStatus. Failure to write means the connection is
                // gone — drop out of the loop.
                let id = state.next_id().await;
                if let Ok(msg) = proto::json_msg(
                    &state.transport_id,
                    NS_MEDIA,
                    &MediaCommandPayload {
                        kind: "GET_STATUS",
                        request_id: id,
                        media_session_id: state.media_session_id.load(Ordering::Relaxed),
                    },
                ) {
                    if proto::write_frame(&mut tls, &msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    tracing::debug!("cast: session driver exited");
}

async fn handle_command<S: AsyncWriteExt + Unpin>(
    tls: &mut S,
    state: &SessionState,
    cmd: CastCommand,
) -> Result<(), CastError> {
    match cmd {
        CastCommand::Play => {
            let id = state.next_id().await;
            proto::write_frame(
                tls,
                &proto::json_msg(
                    &state.transport_id,
                    NS_MEDIA,
                    &MediaCommandPayload {
                        kind: "PLAY",
                        request_id: id,
                        media_session_id: state.media_session_id.load(Ordering::Relaxed),
                    },
                )?,
            )
            .await?;
        }
        CastCommand::Pause => {
            let id = state.next_id().await;
            proto::write_frame(
                tls,
                &proto::json_msg(
                    &state.transport_id,
                    NS_MEDIA,
                    &MediaCommandPayload {
                        kind: "PAUSE",
                        request_id: id,
                        media_session_id: state.media_session_id.load(Ordering::Relaxed),
                    },
                )?,
            )
            .await?;
        }
        CastCommand::Seek(t) => {
            let id = state.next_id().await;
            proto::write_frame(
                tls,
                &proto::json_msg(
                    &state.transport_id,
                    NS_MEDIA,
                    &SeekPayload {
                        kind: "SEEK",
                        request_id: id,
                        media_session_id: state.media_session_id.load(Ordering::Relaxed),
                        current_time: t,
                    },
                )?,
            )
            .await?;
        }
        CastCommand::Stop => {
            // STOP at the receiver level — tears down the app on the
            // device and returns it to the idle/screensaver state.
            let id = state.next_id().await;
            proto::write_frame(
                tls,
                &proto::json_msg(
                    RECEIVER_ID,
                    NS_RECEIVER,
                    &StopReceiverPayload {
                        kind: "STOP",
                        request_id: id,
                        session_id: &state.session_id,
                    },
                )?,
            )
            .await?;
            // Quiet the EnvelopeType warning if a future caller adds it.
            let _ = EnvelopeType { kind: "" };
        }
        CastCommand::LoadMedia(media) => {
            // Send a LOAD on the existing transport. Reuses the open
            // TLS channel + the already-LAUNCHed Default Media
            // Receiver, so the user hears no chime on track change.
            // The receiver will reply with a fresh MEDIA_STATUS that
            // includes a new mediaSessionId — the read-frame branch
            // captures it into state.media_session_id atomically, so
            // any subsequent PLAY/PAUSE/SEEK targets the right session.
            let id = state.next_id().await;
            // Optimistically reflect the new track + a "buffering"
            // state in the shared status so the frontend's status
            // poller flips the scrubber UI to the new track right
            // away, before the receiver's MEDIA_STATUS reply arrives.
            {
                let mut s = state.status.write().await;
                s.track_id = Some(media.track_id);
                s.current_time = Some(media.start_time);
                s.player_state = "BUFFERING".into();
                s.idle_reason = None;
            }
            proto::write_frame(
                tls,
                &proto::json_msg(
                    &state.transport_id,
                    NS_MEDIA,
                    &LoadPayload {
                        kind: "LOAD",
                        request_id: id,
                        media: MediaInfo {
                            content_id: &media.url,
                            content_type: &media.content_type,
                            stream_type: "BUFFERED",
                            metadata: Some(MediaMetadata {
                                metadata_type: 3,
                                title: &media.title,
                                artist: &media.artist,
                                album_name: media.album.as_deref(),
                                images: media
                                    .image_url
                                    .as_deref()
                                    .map(|url| vec![MediaImage { url }])
                                    .unwrap_or_default(),
                            }),
                        },
                        autoplay: true,
                        current_time: media.start_time,
                    },
                )?,
            )
            .await?;
        }
    }
    Ok(())
}

async fn wait_for_launch<S: AsyncReadExt + Unpin>(
    tls: &mut S,
) -> Result<(String, String), CastError> {
    // Wait for the first RECEIVER_STATUS that contains an application
    // entry for our app id. Discard heartbeats etc.
    //
    // 20s — TVs with built-in Chromecast (Sony Bravia, Vizio, etc.)
    // have to spin up their Cast subsystem from idle on the first
    // LAUNCH after the TV's been quiet. Dedicated Cast devices
    // (Google Home Mini, Nest Hub) respond in <1s; TVs can take
    // 10-15s. Erring on the side of patience.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or(CastError::Timeout("LAUNCH"))?;
        let msg = tokio::time::timeout(remaining, proto::read_frame(tls))
            .await
            .map_err(|_| CastError::Timeout("LAUNCH"))??;
        if msg.namespace != NS_RECEIVER {
            continue;
        }
        let Some(payload) = msg.payload_utf8 else {
            continue;
        };
        let env: InboundEnvelope = serde_json::from_str(&payload)?;
        if env.kind != "RECEIVER_STATUS" {
            continue;
        }
        let status: ReceiverStatus = match serde_json::from_value(
            env.status.unwrap_or(serde_json::Value::Null),
        ) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Some(app) = status
            .applications
            .into_iter()
            .find(|a| a.app_id == DEFAULT_MEDIA_RECEIVER)
        {
            return Ok((app.transport_id, app.session_id));
        }
    }
}

async fn wait_for_media_status<S: AsyncReadExt + Unpin>(
    tls: &mut S,
) -> Result<i64, CastError> {
    // 15s — same TV-warmup rationale as wait_for_launch. After a
    // fresh LAUNCH the receiver still has to fetch the LOAD URL,
    // buffer enough to start, and only then emits the MEDIA_STATUS
    // we want.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or(CastError::Timeout("MEDIA_STATUS"))?;
        let msg = tokio::time::timeout(remaining, proto::read_frame(tls))
            .await
            .map_err(|_| CastError::Timeout("MEDIA_STATUS"))??;
        if msg.namespace != NS_MEDIA {
            continue;
        }
        let Some(payload) = msg.payload_utf8 else {
            continue;
        };
        let env: InboundEnvelope = serde_json::from_str(&payload)?;
        if env.kind != "MEDIA_STATUS" {
            continue;
        }
        let inner: MediaStatus = serde_json::from_str(&payload)?;
        if let Some(entry) = inner.status.first() {
            return Ok(entry.media_session_id);
        }
    }
}

// ---- Insecure cert verifier ------------------------------------------
//
// rustls 0.23 forces an explicit opt-in for "trust everything" — exactly
// what Cast requires. The Chromecast presents a self-signed cert that
// no real CA chain validates; the protocol uses TLS purely as an
// encrypted pipe.

#[derive(Debug)]
struct NoCertVerify;

impl ServerCertVerifier for NoCertVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}
