//! `GET /tailscale/status`, `POST /tailscale/serve/enable|disable`,
//! `POST /tailscale/up`, `GET /tailscale/qr` — `routes/tailscale.ts`.

use serde::{Deserialize, Serialize};

/// `GET /tailscale/status` — a discriminated union on `state`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state")]
pub enum TailscaleStatus {
    #[serde(rename = "not_installed")]
    NotInstalled,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "not_connected")]
    NotConnected,
    #[serde(rename = "needs_operator", rename_all = "camelCase")]
    NeedsOperator { fix_command: String },
    #[serde(rename = "certs_not_enabled", rename_all = "camelCase")]
    CertsNotEnabled { dns_name: String },
    #[serde(rename = "connected_no_serve", rename_all = "camelCase")]
    ConnectedNoServe {
        https_url: String,
        setup_command: String,
    },
    #[serde(rename = "serve_active", rename_all = "camelCase")]
    ServeActive { https_url: String },
    #[serde(rename = "port_mismatch", rename_all = "camelCase")]
    PortMismatch {
        expected_port: i64,
        actual_port: i64,
        fix_command: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

/// `POST /tailscale/serve/enable` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleServeEnableResult {
    pub https_url: String,
    pub enabled: bool,
}

/// `POST /tailscale/serve/enable` 409 — cert needs enablement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleCertNeedsEnablement {
    pub error: String,
    pub enable_url: String,
}

/// `POST /tailscale/serve/disable` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleServeDisableResult {
    pub enabled: bool,
}

/// `POST /tailscale/serve/disable` 409 — rule not ours.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleRuleNotOurs {
    pub error: String,
    pub actual_port: i64,
}

/// `POST /tailscale/up` result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleUpResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
    pub timed_out: bool,
    pub login_url: Option<String>,
}

/// `GET /tailscale/qr` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleQr {
    pub qr_url: String,
    pub expires_at: String,
}
