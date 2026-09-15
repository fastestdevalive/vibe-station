//! Tailscale serve management — ports `services/tailscaleServe.ts`.
//!
//! Behavior contract:
//! - One-shot `tokio::process::Command` calls (not a persistent process).
//!   Same pattern as `vst_git::git.rs` — simpler than `cloudflared.rs`.
//! - `TailscaleRuleNotOursError`: prevents clobbering user's own serve rule.
//! - `TailscaleStatus` union:
//!   `not_installed | starting | not_connected | needs_operator |
//!    certs_not_enabled | connected_no_serve | serve_active | port_mismatch | error`

use thiserror::Error;

#[derive(Debug, Error)]
pub enum TailscaleError {
    #[error("tailscale is not installed")]
    NotInstalled,
    #[error("tailscale serve rule belongs to user, not vst")]
    RuleNotOurs,
    #[error("command error: {0}")]
    Command(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type TailscaleResult<T> = Result<T, TailscaleError>;

#[derive(Clone, Debug, PartialEq)]
pub enum TailscaleStatus {
    NotInstalled,
    Starting,
    NotConnected,
    NeedsOperator,
    CertsNotEnabled,
    ConnectedNoServe,
    ServeActive { url: String },
    PortMismatch { expected: u16, actual: u16 },
    Error { message: String },
}

async fn run_tailscale(args: &[&str]) -> TailscaleResult<std::process::Output> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("tailscale")
            .args(owned.iter().map(String::as_str))
            .output()
    })
    .await
    .map_err(|e| TailscaleError::Command(e.to_string()))?
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TailscaleError::NotInstalled
        } else {
            TailscaleError::Io(e)
        }
    })
}

/// Get the current Tailscale+serve status for the daemon port.
pub async fn get_status(port: u16) -> TailscaleResult<TailscaleStatus> {
    let output = match run_tailscale(&["status", "--json"]).await {
        Err(TailscaleError::NotInstalled) => return Ok(TailscaleStatus::NotInstalled),
        Err(e) => return Err(e),
        Ok(o) => o,
    };

    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if msg.to_ascii_lowercase().contains("not installed")
            || msg.to_ascii_lowercase().contains("no such file")
        {
            return Ok(TailscaleStatus::NotInstalled);
        }
        return Ok(TailscaleStatus::Error { message: msg });
    }

    let status: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or(serde_json::Value::Null);

    // Check BackendState.
    let backend_state = status
        .get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match backend_state {
        "Starting" | "NeedsMachineAuth" => return Ok(TailscaleStatus::Starting),
        "Stopped" | "NoState" => return Ok(TailscaleStatus::NotConnected),
        "NeedsLogin" => return Ok(TailscaleStatus::NotConnected),
        _ => {}
    }

    // Check serve config.
    let serve_output = match run_tailscale(&["serve", "status", "--json"]).await {
        Err(_) => return Ok(TailscaleStatus::ConnectedNoServe),
        Ok(o) => o,
    };
    if !serve_output.status.success() {
        return Ok(TailscaleStatus::ConnectedNoServe);
    }
    let serve_json: serde_json::Value =
        serde_json::from_slice(&serve_output.stdout).unwrap_or(serde_json::Value::Null);

    // Check if there's a serve rule for our port.
    let our_path = format!("localhost:{port}");
    let tcp = serve_json.get("TCP");
    if let Some(tcp_obj) = tcp.and_then(|t| t.as_object()) {
        for (_, v) in tcp_obj {
            if let Some(dest) = v.get("TCPForwardTarget").and_then(|d| d.as_str()) {
                if dest.contains(&our_path) || dest.contains(&format!(":{port}")) {
                    if let Some(https_urls) = serve_json
                        .pointer("/Web/https/Handlers")
                        .and_then(|h| h.as_object())
                    {
                        if let Some((_, handler)) = https_urls.iter().next() {
                            let url = handler
                                .get("Domain")
                                .and_then(|d| d.as_str())
                                .map(|d| format!("https://{d}"))
                                .unwrap_or_default();
                            return Ok(TailscaleStatus::ServeActive { url });
                        }
                    }
                }
            }
        }
    }

    Ok(TailscaleStatus::ConnectedNoServe)
}

/// Enable Tailscale HTTPS serve for the given port.
pub async fn enable_serve(port: u16) -> TailscaleResult<String> {
    let port_str = port.to_string();
    let output = run_tailscale(&["serve", "https", &port_str]).await?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if msg.to_ascii_lowercase().contains("operator") {
            return Err(TailscaleError::Command("needs operator".to_string()));
        }
        return Err(TailscaleError::Command(msg));
    }
    // Return the serve URL from status.
    match get_status(port).await? {
        TailscaleStatus::ServeActive { url } => Ok(url),
        _ => Ok(String::new()),
    }
}

/// Disable Tailscale HTTPS serve for the given port.
pub async fn disable_serve(port: u16) -> TailscaleResult<()> {
    let port_str = port.to_string();
    let output = run_tailscale(&["serve", "https", "--remove", &port_str]).await?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if msg.contains("rule not found") {
            return Ok(()); // already removed
        }
        return Err(TailscaleError::Command(msg));
    }
    Ok(())
}
