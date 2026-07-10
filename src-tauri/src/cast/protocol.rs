//! Cast V2 wire-format helpers + JSON payload shapes.
//!
//! Two layers:
//!   - Bottom: length-prefixed framing of the prost-generated
//!     `CastMessage`. Each TCP frame is `[4-byte BE length][protobuf
//!     bytes]`. `read_frame` / `write_frame` here are the only
//!     places that touch the socket directly.
//!   - Top: serde structs for the JSON payloads carried inside
//!     `payload_utf8`. We use serde_json for everything — the
//!     receiver echoes unknown fields back, so we keep our structs
//!     minimal and use `#[serde(rename_all = "camelCase")]` to
//!     match the receiver's casing.
//!
//! Namespaces we speak:
//!   urn:x-cast:com.google.cast.tp.connection  — CONNECT / CLOSE
//!   urn:x-cast:com.google.cast.tp.heartbeat   — PING / PONG
//!   urn:x-cast:com.google.cast.receiver       — LAUNCH / GET_STATUS / STOP
//!   urn:x-cast:com.google.cast.media          — LOAD / PLAY / PAUSE / SEEK / STOP

use bytes::{Buf, BufMut, BytesMut};
use prost::Message;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Bring in the prost-generated CastMessage. The .proto declares
// `package extensions.api.cast_channel`, so the module path is
// `extensions::api::cast_channel`.
pub mod proto {
    include!(concat!(
        env!("OUT_DIR"),
        "/extensions.api.cast_channel.rs"
    ));
}

pub use proto::{
    cast_message::{PayloadType, ProtocolVersion},
    CastMessage,
};

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

/// Default Media Receiver app id. No registration required —
/// Google ships it on every Chromecast. Plays MP3/M4A/MP4/etc.
/// from any HTTP(S) URL.
pub const DEFAULT_MEDIA_RECEIVER: &str = "CC1AD845";

pub const SENDER_ID: &str = "sender-0";
pub const RECEIVER_ID: &str = "receiver-0";

// ---- Framing -----------------------------------------------------------

/// Read one length-prefixed CastMessage from `r`.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
    r: &mut R,
) -> std::io::Result<CastMessage> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 64 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("cast frame too large: {len} bytes"),
        ));
    }
    let mut buf = BytesMut::with_capacity(len);
    buf.resize(len, 0);
    r.read_exact(&mut buf).await?;
    CastMessage::decode(buf.freeze()).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })
}

/// Write one length-prefixed CastMessage to `w`.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    w: &mut W,
    msg: &CastMessage,
) -> std::io::Result<()> {
    let mut buf = BytesMut::with_capacity(msg.encoded_len() + 4);
    buf.put_u32(msg.encoded_len() as u32);
    msg.encode(&mut buf).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })?;
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

/// Convenience: build a JSON-payload CastMessage targeting the given
/// destination + namespace. Most messages we send are of this shape.
pub fn json_msg(
    destination: &str,
    namespace: &str,
    payload: &impl Serialize,
) -> Result<CastMessage, serde_json::Error> {
    Ok(CastMessage {
        protocol_version: ProtocolVersion::Castv210 as i32,
        source_id: SENDER_ID.into(),
        destination_id: destination.into(),
        namespace: namespace.into(),
        payload_type: PayloadType::String as i32,
        payload_utf8: Some(serde_json::to_string(payload)?),
        payload_binary: None,
    })
}

// ---- JSON payload shapes ----------------------------------------------

#[derive(Serialize)]
pub struct EnvelopeType<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str,
}

/// `urn:...connection` CONNECT message.
#[derive(Serialize)]
pub struct ConnectPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str,
}

/// `urn:...heartbeat` PING / PONG.
#[derive(Serialize)]
pub struct HeartbeatPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str,
}

#[derive(Serialize)]
pub struct LaunchPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str, // "LAUNCH"
    #[serde(rename = "requestId")]
    pub request_id: u32,
    #[serde(rename = "appId")]
    pub app_id: &'a str,
}

#[derive(Serialize)]
pub struct StopReceiverPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str, // "STOP"
    #[serde(rename = "requestId")]
    pub request_id: u32,
    #[serde(rename = "sessionId")]
    pub session_id: &'a str,
}

#[derive(Serialize)]
pub struct LoadPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str, // "LOAD"
    #[serde(rename = "requestId")]
    pub request_id: u32,
    pub media: MediaInfo<'a>,
    pub autoplay: bool,
    #[serde(rename = "currentTime")]
    pub current_time: f64,
}

#[derive(Serialize)]
pub struct MediaInfo<'a> {
    #[serde(rename = "contentId")]
    pub content_id: &'a str,
    #[serde(rename = "contentType")]
    pub content_type: &'a str,
    #[serde(rename = "streamType")]
    pub stream_type: &'a str, // "BUFFERED"
    pub metadata: Option<MediaMetadata<'a>>,
}

#[derive(Serialize)]
pub struct MediaMetadata<'a> {
    #[serde(rename = "metadataType")]
    pub metadata_type: u8, // 3 = MUSIC_TRACK
    pub title: &'a str,
    pub artist: &'a str,
    pub album_name: Option<&'a str>,
    pub images: Vec<MediaImage<'a>>,
}

#[derive(Serialize)]
pub struct MediaImage<'a> {
    pub url: &'a str,
}

#[derive(Serialize)]
pub struct MediaCommandPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str, // "PLAY" / "PAUSE" / "STOP"
    #[serde(rename = "requestId")]
    pub request_id: u32,
    #[serde(rename = "mediaSessionId")]
    pub media_session_id: i64,
}

#[derive(Serialize)]
pub struct SeekPayload<'a> {
    #[serde(rename = "type")]
    pub kind: &'a str, // "SEEK"
    #[serde(rename = "requestId")]
    pub request_id: u32,
    #[serde(rename = "mediaSessionId")]
    pub media_session_id: i64,
    #[serde(rename = "currentTime")]
    pub current_time: f64,
}

// ---- Response parsing -------------------------------------------------

/// Top-level envelope for any inbound JSON payload — we use this to
/// dispatch by `type` before deserialising the full shape.
#[derive(Deserialize, Debug)]
pub struct InboundEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, rename = "requestId")]
    pub request_id: Option<u32>,
    #[serde(default)]
    pub status: Option<serde_json::Value>,
}

/// `RECEIVER_STATUS` carries an `applications` array; each entry has
/// `transportId` and `sessionId` we'll need to talk to the loaded app.
#[derive(Deserialize, Debug)]
pub struct ReceiverStatus {
    #[serde(default)]
    pub applications: Vec<ReceiverApplication>,
}

#[derive(Deserialize, Debug)]
pub struct ReceiverApplication {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "transportId")]
    pub transport_id: String,
}

/// `MEDIA_STATUS.status[0].mediaSessionId` — needed for subsequent
/// PLAY/PAUSE/SEEK commands.
#[derive(Deserialize, Debug)]
pub struct MediaStatus {
    #[serde(default)]
    pub status: Vec<MediaStatusEntry>,
}

#[derive(Deserialize, Debug)]
pub struct MediaStatusEntry {
    #[serde(rename = "mediaSessionId")]
    pub media_session_id: i64,
    #[serde(default, rename = "playerState")]
    pub player_state: Option<String>,
    #[serde(default, rename = "currentTime")]
    pub current_time: Option<f64>,
    /// Only set when player_state == "IDLE". Common values:
    /// "FINISHED" (track ended naturally — the queue-advance
    /// trigger), "CANCELLED", "INTERRUPTED", "ERROR".
    #[serde(default, rename = "idleReason")]
    pub idle_reason: Option<String>,
}

/// Some receiver firmware shape MEDIA_STATUS with an empty
/// `status[]` array and the idle reason at the top level when the
/// media session ends. Best-effort: scan the raw JSON for the key.
pub fn top_level_idle_reason(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let reason = v.get("idleReason")?.as_str()?;
    Some(reason.to_string())
}
