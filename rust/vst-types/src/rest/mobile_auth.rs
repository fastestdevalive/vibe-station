//! `routes/mobileAuth.ts` — tunnel enable/disable/status, local-qr, mobile-qr.
//! (`GET /mobile-auth` returns HTML, not JSON, so it has no shape here.)

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use super::doctor::DoctorHintDto;

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

/// `GET /auth/tunnel/status` response. NOT `skip_serializing_none`: the Node
/// daemon (Fastify) emits `"tunnelUrl": null` / `"startedAt": null` explicitly,
/// so F1 byte-compat requires them present as `null` rather than omitted
/// (parity harness, part 10).
///
/// The three binary-discovery fields are the exception: they are omitted
/// (`skip_serializing_if`) unless the caller asked for a probe
/// (`GET /auth/tunnel/status?binary=1`), so the plain body stays byte-identical
/// to the Node fixture.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub enabled: bool,
    /// JSON null when not enabled.
    pub tunnel_url: Option<String>,
    /// JSON null when not enabled; unix ms.
    pub started_at: Option<i64>,
    /// Where `cloudflared` was found (and whether it runs). Only present when
    /// the request asked for a probe; absent (not null) otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<CloudflaredBinary>,
    /// `std::env::consts::OS` ("macos" | "linux" | "windows"); only with `binary`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_os: Option<String>,
    /// Per-OS install commands, filled only when `binary.state != installed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<DoctorHintDto>,
}

/// Result of locating + probing `cloudflared` on disk, evaluated fresh per
/// request by `vst_lifecycle::cloudflared::locate` (no caching, so a fresh
/// install is picked up on the next Re-check without a daemon restart).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CloudflaredBinary {
    /// Found and `--version` succeeded.
    Installed { path: String, version: String },
    /// No executable found on PATH, the shell PATH or the well-known dirs.
    NotInstalled,
    /// Found, but it can't be run (`VST_CLOUDFLARED_BIN` points at a missing or
    /// non-executable path, exec format error, `--version` failed, timeout, …).
    Unusable { path: String, error: String },
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
