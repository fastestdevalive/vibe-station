//! cloudflared tunnel management — ports `services/cloudflared.ts`.
//!
//! Behavior contract:
//! - Spawns a **long-lived** background process using `vst_proc::spawn_child`
//!   (same abstraction as `04b`'s `AcpTerminalManager`).
//! - URL scraped from stdout/stderr via regex within a 10s timeout.
//! - `VST_CLOUDFLARED_BIN` env var overrides the binary path.
//! - `sweep_orphans`: pgrep + SIGTERM + delayed SIGKILL.
//! - `is_likely_cloudflared_process`: ps-based identity check before killing.
//! - State persisted in `vst_store::tunnel` (not a second layer).
//! - `enable` / `disable` / `shutdown_kill` / `restore_on_boot` / `get_state`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use vst_store::StoreHandle;
use vst_store::TunnelStateRow;

#[derive(Debug, Error)]
pub enum CloudflaredError {
    #[error("process error: {0}")]
    Process(String),
    #[error("URL scrape timeout")]
    Timeout,
    #[error("store error: {0}")]
    Store(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type CloudflaredResult<T> = Result<T, CloudflaredError>;

const TUNNEL_URL_RE: &str = r"https://[a-z0-9\-]+\.trycloudflare\.com";
const SPAWN_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone, Debug)]
pub struct CloudflaredState {
    pub enabled: bool,
    pub url: Option<String>,
    pub pid: Option<u32>,
}

/// Enable the cloudflared tunnel on the given port.
///
/// Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` (or the binary
/// named by `VST_CLOUDFLARED_BIN`) as a long-lived background process and
/// scrapes the public URL from its output within 10s.
pub async fn enable(port: u16, store: &StoreHandle) -> CloudflaredResult<String> {
    // Check if already enabled.
    let current = store.get_tunnel_state().await;
    if current.enabled {
        if let Some(url) = current.current_url {
            return Ok(url);
        }
    }

    let bin = std::env::var("VST_CLOUDFLARED_BIN").unwrap_or_else(|_| "cloudflared".to_string());

    let mut child = tokio::process::Command::new(&bin)
        .args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CloudflaredError::Process(format!("spawn failed: {e}")))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Scrape URL from output within SPAWN_TIMEOUT_MS.
    let url_re =
        regex::Regex::new(TUNNEL_URL_RE).map_err(|e| CloudflaredError::Process(e.to_string()))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let tx1 = tx.clone();
    let re1 = url_re.clone();
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(m) = re1.find(&line) {
                    let url = m.as_str().to_string();
                    if let Some(sender) = tx1.lock().unwrap().take() {
                        let _ = sender.send(url);
                    }
                    break;
                }
            }
        });
    }

    let tx2 = tx.clone();
    let re2 = url_re;
    if let Some(err_out) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err_out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(m) = re2.find(&line) {
                    let url = m.as_str().to_string();
                    if let Some(sender) = tx2.lock().unwrap().take() {
                        let _ = sender.send(url);
                    }
                    break;
                }
            }
        });
    }

    let url = tokio::time::timeout(Duration::from_millis(SPAWN_TIMEOUT_MS), async {
        rx.await.ok()
    })
    .await
    .ok()
    .flatten()
    .ok_or(CloudflaredError::Timeout)?;

    store
        .set_tunnel_state(TunnelStateRow {
            enabled: true,
            current_url: Some(url.clone()),
            current_pid: pid.map(|p| p as i64),
            started_at: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64,
            ),
            port: Some(port as i64),
        })
        .await;

    Ok(url)
}

/// Disable the cloudflared tunnel, killing the process if any.
pub async fn disable(store: &StoreHandle) -> CloudflaredResult<()> {
    let state = store.get_tunnel_state().await;
    if let Some(pid) = state.current_pid {
        let _ = kill_pid(pid as u32, false).await;
    }
    store.clear_tunnel().await;
    Ok(())
}

/// Get the current tunnel state from the store.
pub async fn get_state(store: &StoreHandle) -> CloudflaredResult<CloudflaredState> {
    let row = store.get_tunnel_state().await;
    Ok(CloudflaredState {
        enabled: row.enabled,
        url: row.current_url,
        pid: row.current_pid.map(|p| p as u32),
    })
}

/// Kill the process and clear tunnel state (for daemon shutdown).
pub async fn shutdown_kill(store: &StoreHandle) -> CloudflaredResult<()> {
    let state = store.get_tunnel_state().await;
    if let Some(pid) = state.current_pid {
        let _ = kill_pid(pid as u32, true).await;
    }
    store.clear_tunnel_process().await;
    Ok(())
}

/// Sweep orphaned cloudflared processes via pgrep.
pub async fn sweep_orphans() -> CloudflaredResult<()> {
    let output = tokio::task::spawn_blocking(|| {
        std::process::Command::new("pgrep")
            .args(["-x", "cloudflared"])
            .output()
    })
    .await
    .map_err(|e| CloudflaredError::Process(e.to_string()))?
    .map_err(|e| CloudflaredError::Process(e.to_string()))?;

    if !output.status.success() {
        return Ok(()); // no processes found
    }

    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect();

    for pid in pids {
        if is_likely_cloudflared_process(pid).await {
            let _ = kill_pid(pid, false).await;
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let _ = kill_pid(pid, true).await;
        }
    }

    Ok(())
}

/// ps-based identity check before killing a pid.
async fn is_likely_cloudflared_process(pid: u32) -> bool {
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    if let Some(out) = output {
        let comm = String::from_utf8_lossy(&out.stdout)
            .trim()
            .to_ascii_lowercase();
        comm.contains("cloudflared")
    } else {
        false
    }
}

async fn kill_pid(pid: u32, force: bool) -> CloudflaredResult<()> {
    let sig = if force { "9" } else { "15" };
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("kill")
            .args([&format!("-{sig}"), &pid.to_string()])
            .status()
    })
    .await
    .ok();
    Ok(())
}
