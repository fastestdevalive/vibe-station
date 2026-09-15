//! `routes/mobileAuth.ts` — tunnel enable/disable/status, local-qr, mobile-qr.
//! (`GET /mobile-auth` returns HTML, not JSON, so it has no shape here.)

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// `POST /auth/tunnel/enable` success (and the `tunnel already enabled` 409
/// body, which adds `error`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEnableResult {
    pub tunnel_url: String,
    pub enabled: bool,
    /// Present on the 409 "already enabled" body.
    pub error: Option<String>,
}

/// `POST /auth/tunnel/disable` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDisableResult {
    pub enabled: bool,
}

/// `GET /auth/tunnel/status` response.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub enabled: bool,
    /// JSON null when not enabled.
    pub tunnel_url: Option<String>,
    /// JSON null when not enabled; unix ms.
    pub started_at: Option<i64>,
}

/// `POST /auth/local-qr` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQrResult {
    pub qr_url: String,
    /// unix ms.
    pub expires_at: i64,
    pub connection_type: ConnectionType,
}

/// `connectionType` of `local-qr`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionType {
    Tailscale,
    Lan,
}

/// `POST /auth/mobile-qr` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileQrResult {
    pub qr_url: String,
    /// unix ms.
    pub expires_at: i64,
}
