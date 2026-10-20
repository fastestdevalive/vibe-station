//! `routes/tailscale.ts` — Tailscale serve endpoints, status, and up.
//!
//! Ports `daemon/src/routes/tailscale.ts` (78 LOC).

use vst_lifecycle::tailscale_serve::{self, TailscaleError, TailscaleStatus as ServiceStatus};
use vst_types::domain::{TokenPayload, TokenScope};
use vst_types::rest::tailscale::{
    TailscaleQr, TailscaleServeDisableResult, TailscaleServeEnableResult, TailscaleStatus,
    TailscaleUpResult,
};

use crate::mobile_auth::OneTimeCodeStore;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TailscaleRouteError {
    #[error("DESKTOP_ONLY")]
    DesktopOnly,
    #[error("TAILSCALE_SERVE_NOT_ACTIVE")]
    ServeNotActive,
    #[error("CERT_NEEDS_ENABLEMENT")]
    CertNeedsEnablement { enable_url: String },
    #[error("RULE_NOT_OURS")]
    RuleNotOurs { actual_port: i64 },
    #[error("internal_error: {0}")]
    Internal(String),
}

impl TailscaleRouteError {
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::DesktopOnly => "DESKTOP_ONLY",
            Self::ServeNotActive => "conflict",
            Self::CertNeedsEnablement { .. } => "CERT_NEEDS_ENABLEMENT",
            Self::RuleNotOurs { .. } => "RULE_NOT_OURS",
            Self::Internal(_) => "internal_error",
        }
    }
}

/// Handler for `/tailscale/*` routes.
#[derive(Clone)]
pub struct TailscaleRoutes {
    code_store: OneTimeCodeStore,
    port: u16,
}

impl TailscaleRoutes {
    pub fn new(code_store: OneTimeCodeStore, port: u16) -> Self {
        Self { code_store, port }
    }

    /// `GET /tailscale/status`
    pub async fn status(&self) -> TailscaleStatus {
        match tailscale_serve::get_status(self.port).await {
            Ok(status) => match status {
                ServiceStatus::NotInstalled => not_installed(),
                ServiceStatus::Starting => TailscaleStatus::Starting,
                ServiceStatus::NotConnected => TailscaleStatus::NotConnected {
                    up_command: Some(format!("{} up", tailscale_serve::display_cmd().await)),
                },
                ServiceStatus::NeedsOperator => TailscaleStatus::NeedsOperator {
                    fix_command: format!(
                        "sudo {} set --operator=$USER",
                        tailscale_serve::display_cmd().await
                    ),
                },
                ServiceStatus::CertsNotEnabled => TailscaleStatus::CertsNotEnabled {
                    dns_name: String::new(),
                },
                ServiceStatus::ConnectedNoServe => TailscaleStatus::ConnectedNoServe {
                    https_url: String::new(),
                    setup_command: format!(
                        "{} serve --bg --yes {}",
                        tailscale_serve::display_cmd().await,
                        self.port
                    ),
                },
                ServiceStatus::ServeActive { url } => {
                    TailscaleStatus::ServeActive { https_url: url }
                }
                ServiceStatus::PortMismatch { expected, actual } => TailscaleStatus::PortMismatch {
                    expected_port: expected as i64,
                    actual_port: actual as i64,
                    fix_command: format!(
                        "{} serve --bg --yes {}",
                        tailscale_serve::display_cmd().await,
                        self.port
                    ),
                },
                ServiceStatus::Error { message } => TailscaleStatus::Error { message },
            },
            Err(e) => match e {
                TailscaleError::NotInstalled => not_installed(),
                other => TailscaleStatus::Error {
                    message: other.to_string(),
                },
            },
        }
    }

    /// `POST /tailscale/serve/enable`
    pub async fn enable_serve(&self) -> Result<TailscaleServeEnableResult, TailscaleRouteError> {
        match tailscale_serve::enable_serve(self.port).await {
            Ok(url) => Ok(TailscaleServeEnableResult {
                https_url: url,
                enabled: true,
            }),
            Err(err) => match err {
                TailscaleError::Command(msg) if msg.contains("https://login.tailscale.com/") => {
                    // Extract URL if present
                    let url = msg
                        .split_whitespace()
                        .find(|p| p.starts_with("https://login.tailscale.com/"))
                        .unwrap_or_default()
                        .to_string();
                    Err(TailscaleRouteError::CertNeedsEnablement { enable_url: url })
                }
                other => Err(TailscaleRouteError::Internal(other.to_string())),
            },
        }
    }

    /// `POST /tailscale/serve/disable`
    pub async fn disable_serve(&self) -> Result<TailscaleServeDisableResult, TailscaleRouteError> {
        match tailscale_serve::disable_serve(self.port).await {
            Ok(()) => Ok(TailscaleServeDisableResult { enabled: false }),
            Err(err) => match err {
                TailscaleError::RuleNotOurs => {
                    Err(TailscaleRouteError::RuleNotOurs { actual_port: 0 })
                }
                other => Err(TailscaleRouteError::Internal(other.to_string())),
            },
        }
    }

    /// `POST /tailscale/up`
    pub async fn up(
        &self,
        auth_payload: Option<&TokenPayload>,
    ) -> Result<TailscaleUpResult, TailscaleRouteError> {
        if let Some(payload) = auth_payload {
            if payload.scope != TokenScope::Tauri {
                return Err(TailscaleRouteError::DesktopOnly);
            }
        }

        match tailscale_serve::up().await {
            Ok(Some(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let exit_code = out.status.code().unwrap_or(-1) as i64;
                let login_url = extract_login_url(&format!("{stdout}\n{stderr}"));

                Ok(TailscaleUpResult {
                    stdout: truncate_tail(&stdout, 4000),
                    stderr: truncate_tail(&stderr, 4000),
                    exit_code,
                    timed_out: false,
                    login_url,
                })
            }
            Ok(None) => Ok(TailscaleUpResult {
                stdout: String::new(),
                stderr: "timed out waiting for tailscale up".to_string(),
                exit_code: -1,
                timed_out: true,
                login_url: None,
            }),
            Err(e) => Err(TailscaleRouteError::Internal(e.to_string())),
        }
    }

    /// `GET /tailscale/qr`
    pub async fn qr(&self) -> Result<TailscaleQr, TailscaleRouteError> {
        let status = self.status().await;
        let https_url = match status {
            TailscaleStatus::ServeActive { https_url } => https_url,
            _ => return Err(TailscaleRouteError::ServeNotActive),
        };

        let (code, expires_at) = self.code_store.mint_one_time_code("local");
        let qr_url = format!("{}/mobile-auth?code={}", https_url, code);

        Ok(TailscaleQr { qr_url, expires_at })
    }
}

fn not_installed() -> TailscaleStatus {
    TailscaleStatus::NotInstalled {
        host_os: Some(std::env::consts::OS.to_string()),
    }
}

fn extract_login_url(text: &str) -> Option<String> {
    for word in text.split_whitespace() {
        if word.starts_with("https://login.tailscale.com/") {
            return Some(word.to_string());
        }
    }
    None
}

fn truncate_tail(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        s[s.len() - max_len..].to_string()
    }
}
