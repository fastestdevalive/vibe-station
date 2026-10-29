//! cloudflared tunnel management — ports `services/cloudflared.ts`.
//!
//! Behavior contract:
//! - Spawns a **long-lived** background process using `vst_proc::spawn_child`
//!   (same abstraction as `04b`'s `AcpTerminalManager`).
//! - The binary is **located** by [`locate`] (PATH + shell PATH + well-known
//!   dirs, `VST_CLOUDFLARED_BIN` authoritative); nothing is bundled.
//! - URL scraped from stdout/stderr via regex within a 10s timeout.
//! - `sweep_orphans`: pgrep + SIGTERM + delayed SIGKILL, narrowed to vst's own
//!   quick-tunnel command line (a user's own `cloudflared tunnel run` is safe).
//! - State persisted in `vst_store::tunnel` (not a second layer).
//! - `enable` / `disable` / `shutdown_kill` / `restore_on_boot` / `get_state`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use vst_store::StoreHandle;
use vst_store::TunnelStateRow;
use vst_types::rest::mobile_auth::CloudflaredBinary;

pub mod locate;

#[derive(Debug, Error)]
pub enum CloudflaredError {
    #[error("process error: {0}")]
    Process(String),
    #[error("URL scrape timeout")]
    Timeout,
    #[error("cloudflared is not installed — run `vst doctor` for install steps")]
    NotInstalled,
    #[error("cloudflared at {path} is unusable: {error}")]
    Unusable { path: String, error: String },
    #[error("store error: {0}")]
    Store(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type CloudflaredResult<T> = Result<T, CloudflaredError>;

const TUNNEL_URL_RE: &str = r"https://[a-z0-9\-]+\.trycloudflare\.com";
const SPAWN_TIMEOUT_MS: u64 = 10_000;

/// Serialises everything that spawns or kills cloudflared processes
/// (`enable`, `disable`, `sweep_orphans`, `restore_on_boot`). The boot-time
/// orphan sweep may kill vst's own quick tunnel, so it must never interleave
/// with an `enable` — otherwise a tunnel the user turns on while the
/// (post-bind, background) restore is still sweeping would be killed.
/// `shutdown_kill` does not take it (it must not wait out a 10s `enable`);
/// shutdown instead aborts and awaits the boot restore task first.
///
/// A `OnceLock` rather than `LazyLock` because the workspace MSRV is 1.77.
fn tunnel_op() -> &'static Arc<tokio::sync::Mutex<()>> {
    static OP: std::sync::OnceLock<Arc<tokio::sync::Mutex<()>>> = std::sync::OnceLock::new();
    OP.get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
}

/// Guard returned by [`lock_for_boot_restore`].
pub struct BootRestoreGuard(#[allow(dead_code)] tokio::sync::OwnedMutexGuard<()>);

/// Take the tunnel lock for the boot restore. The caller acquires it *before*
/// spawning the restore task (and before the server starts serving), so an API
/// `enable` can never win the lock first and then be swept by the restore.
pub async fn lock_for_boot_restore() -> BootRestoreGuard {
    BootRestoreGuard(tunnel_op().clone().lock_owned().await)
}

/// Kills a freshly spawned child if the `enable` future is dropped (e.g. the
/// boot task is aborted mid-scrape on shutdown) or fails before the tunnel is
/// recorded, so we never leak an untracked cloudflared. Disarmed on success.
struct SpawnGuard(Option<tokio::process::Child>);

impl SpawnGuard {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.start_kill();
        }
    }
}

#[derive(Clone, Debug)]
pub struct CloudflaredState {
    pub enabled: bool,
    pub url: Option<String>,
    pub pid: Option<u32>,
}

/// Enable the cloudflared tunnel on the given port.
///
/// Locates `cloudflared` (see [`locate`]) and spawns
/// `cloudflared tunnel --url http://127.0.0.1:<port>` as a long-lived
/// background process, scraping the public URL from its output within 10s.
///
/// A missing / unusable binary is a typed [`CloudflaredError::NotInstalled`] /
/// [`CloudflaredError::Unusable`] — never a raw `spawn failed: No such file`.
pub async fn enable(port: u16, store: &StoreHandle) -> CloudflaredResult<String> {
    let _op = tunnel_op().lock().await;
    // An active tunnel never needs a probe: answer from the store first.
    let current = store.get_tunnel_state().await;
    if current.enabled {
        if let Some(url) = current.current_url {
            return Ok(url);
        }
    }
    let bin = locate::resolve().await;
    enable_with_binary_locked(port, store, bin).await
}

/// [`enable`] with the resolved binary injected (unit tests use this directly,
/// so they need no PATH/env mutation).
async fn enable_with_binary_locked(
    port: u16,
    store: &StoreHandle,
    bin: CloudflaredBinary,
) -> CloudflaredResult<String> {
    // Check if already enabled.
    let current = store.get_tunnel_state().await;
    if current.enabled {
        if let Some(url) = current.current_url {
            return Ok(url);
        }
    }

    let path = match bin {
        CloudflaredBinary::Installed { path, .. } => path,
        CloudflaredBinary::NotInstalled => return Err(CloudflaredError::NotInstalled),
        CloudflaredBinary::Unusable { path, error } => {
            return Err(CloudflaredError::Unusable { path, error })
        }
    };

    let mut child = tokio::process::Command::new(&path)
        .args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CloudflaredError::Process(format!("spawn failed ({path}): {e}")))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut guard = SpawnGuard(Some(child));

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

    // `set_tunnel_state` below is the last await that could be cancelled; a
    // drop between the scrape and it would leave an untracked process, so
    // keep the guard armed until the state is recorded.
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
    guard.disarm();

    Ok(url)
}

/// Disable the cloudflared tunnel, killing the process if any.
pub async fn disable(store: &StoreHandle) -> CloudflaredResult<()> {
    let _op = tunnel_op().lock().await;
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

/// Sweep orphaned cloudflared processes via pgrep, narrowed to vst's own quick
/// tunnel on `port` (see [`is_vst_quick_tunnel_args`]).
pub async fn sweep_orphans(port: u16) -> CloudflaredResult<()> {
    let _op = tunnel_op().lock().await;
    sweep_orphans_locked(&[port]).await
}

/// Boot-time restore: sweep orphans, then re-enable the tunnel if the store
/// says it was `enabled`. Sweep and enable run under ONE hold of the tunnel
/// lock, so an API `enable`/`disable` issued while this runs (it is spawned
/// after the listener binds) waits for it instead of racing the sweep.
/// Errors are logged, never returned — boot must not fail on tunnel trouble.
pub async fn restore_on_boot(_guard: BootRestoreGuard, port: u16, store: &StoreHandle) {
    // The sweep may only kill vst's own quick tunnel: this boot's port and the
    // port persisted with the previous row (a daemon whose port changed must
    // still clean up its own orphan). Anything else named `cloudflared` is the
    // user's and is left alone.
    let persisted = store.get_tunnel_state().await;
    let mut ports = vec![port];
    if let Some(p) = persisted.port.and_then(|p| u16::try_from(p).ok()) {
        if p != port {
            ports.push(p);
        }
    }
    if let Err(e) = sweep_orphans_locked(&ports).await {
        tracing::warn!("[vst] cloudflared sweep_orphans failed (non-fatal): {e}");
    }
    restore_locked(port, store).await;
}

/// The post-sweep half of [`restore_on_boot`] (split out so tests can exercise
/// it without the process sweep). Resolves the binary, then hands it to
/// [`restore_with_binary_locked`].
async fn restore_locked(port: u16, store: &StoreHandle) {
    match get_state(store).await {
        Ok(state) if state.enabled => {
            let bin = locate::resolve().await;
            restore_with_binary_locked(port, store, bin).await;
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[vst] cloudflared get_state failed (non-fatal): {e}"),
    }
}

/// Decision 5: a missing/unusable binary logs ONE warn and leaves the persisted
/// row alone — `enabled` stays true, no url/pid, no retry timer. The tunnel
/// resumes on the next boot or when the user installs cloudflared and clicks
/// Re-check in Remote Access; no crash-loop.
///
/// Split from [`restore_locked`] with the binary injected, like
/// [`enable_with_binary_locked`], so tests need no PATH/env mutation.
async fn restore_with_binary_locked(port: u16, store: &StoreHandle, bin: CloudflaredBinary) {
    if !matches!(&bin, CloudflaredBinary::Installed { .. }) {
        tracing::warn!(
            "[vst] cloudflared was enabled but is not usable ({bin:?}) — keeping the tunnel \
             enabled; install cloudflared and Re-check in Remote Access to resume"
        );
        return;
    }
    tracing::info!("[vst] cloudflared was enabled — restoring tunnel on port {port}");
    match enable_with_binary_locked(port, store, bin).await {
        Ok(url) => tracing::info!("[vst] cloudflared tunnel restored: {url}"),
        Err(e) => tracing::warn!("[vst] cloudflared restore failed (non-fatal): {e}"),
    }
}

/// Identity predicate for the orphan sweep: only a process running vst's own
/// quick tunnel may be killed. Since the bundled binary is gone, the
/// `cloudflared` on disk is usually the user's own — a `cloudflared tunnel run
/// <name>` (e.g. `brew services start cloudflared`) must survive a daemon boot.
///
/// A quick tunnel is only ours when its URL targets one of the daemon's own
/// ports (`ports` = this boot's port + the persisted row's port). A second vst
/// daemon (e.g. a dev daemon next to the desktop app) runs the identical shape
/// on a different port and must not be killed by this one's boot sweep.
pub fn is_vst_quick_tunnel_args(args: &str, ports: &[u16]) -> bool {
    args.contains("cloudflared")
        && ports.iter().any(|port| {
            let url = format!("http://127.0.0.1:{port}");
            // `--url` takes the URL as its own argument, and the port ends it.
            args.split_whitespace().any(|arg| arg == url)
        })
}

async fn sweep_orphans_locked(ports: &[u16]) -> CloudflaredResult<()> {
    // `kill_on_drop`: the sweep runs as an abortable post-bind task, and a
    // `spawn_blocking` pgrep can't be cancelled (runtime shutdown would wait
    // for it); an async child is killed when the aborted future drops.
    let output = tokio::process::Command::new("pgrep")
        .args(["-x", "cloudflared"])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| CloudflaredError::Process(e.to_string()))?;

    if !output.status.success() {
        return Ok(()); // no processes found
    }

    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect();

    for pid in pids {
        if is_likely_cloudflared_process(pid, ports).await {
            let _ = kill_pid(pid, false).await;
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let _ = kill_pid(pid, true).await;
        }
    }

    Ok(())
}

/// ps-based identity check before killing a pid: it must be `cloudflared` AND
/// run vst's quick-tunnel command line for one of `ports`.
async fn is_likely_cloudflared_process(pid: u32, ports: &[u16]) -> bool {
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    match output {
        Some(out) => is_vst_quick_tunnel_args(&String::from_utf8_lossy(&out.stdout), ports),
        None => false,
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

#[cfg(test)]
pub(crate) static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// RAII guard for a test-only env var: sets it, then restores the previous value
/// on drop (removes it when it was unset) — even if the test panics — so one
/// test can never leak a value into another. The caller must hold [`ENV_LOCK`]
/// for the whole mutation window.
#[cfg(test)]
pub(crate) struct EnvVarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl EnvVarGuard {
    pub(crate) fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

#[cfg(test)]
impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &std::path::Path) -> StoreHandle {
        StoreHandle::open(&dir.join("t.db")).unwrap()
    }

    /// `enable`/`disable` (and `sweep_orphans`) all wait on the tunnel lock, which
    /// `restore_on_boot` holds across sweep + enable.
    #[tokio::test]
    async fn tunnel_ops_wait_for_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(&dir.path().join("t.db")).unwrap();

        let held = tunnel_op().lock().await;
        let s = store.clone();
        let mut first = tokio::spawn(async move { disable(&s).await });
        let s = store.clone();
        let second = tokio::spawn(async move { disable(&s).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!first.is_finished() && !second.is_finished());

        drop(held);
        tokio::time::timeout(Duration::from_secs(5), &mut first)
            .await
            .expect("op proceeds once the lock is released")
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .expect("second waiter proceeds too")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn enable_rejects_not_installed_without_writing_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());

        let err = enable_with_binary_locked(7421, &store, CloudflaredBinary::NotInstalled)
            .await
            .unwrap_err();
        assert!(matches!(err, CloudflaredError::NotInstalled), "{err}");
        assert_eq!(
            store.get_tunnel_state().await,
            TunnelStateRow::empty(),
            "a rejected enable must not touch the persisted row"
        );
    }

    #[tokio::test]
    async fn enable_rejects_unusable_with_path_and_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());

        let err = enable_with_binary_locked(
            7421,
            &store,
            CloudflaredBinary::Unusable {
                path: "/opt/homebrew/bin/cloudflared".to_string(),
                error: "Exec format error".to_string(),
            },
        )
        .await
        .unwrap_err();
        match err {
            CloudflaredError::Unusable { path, error } => {
                assert_eq!(path, "/opt/homebrew/bin/cloudflared");
                assert_eq!(error, "Exec format error");
            }
            other => panic!("expected Unusable, got {other}"),
        }
        assert_eq!(store.get_tunnel_state().await, TunnelStateRow::empty());
    }

    #[tokio::test]
    async fn enable_returns_the_live_url_without_consulting_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let url = "https://abc-def-ghi.trycloudflare.com";
        store
            .set_tunnel_state(TunnelStateRow {
                enabled: true,
                current_url: Some(url.to_string()),
                current_pid: None,
                started_at: None,
                port: Some(7421),
            })
            .await;

        // NotInstalled would be an error — unless the active tunnel short-circuits first.
        let got = enable_with_binary_locked(7421, &store, CloudflaredBinary::NotInstalled)
            .await
            .unwrap();
        assert_eq!(got, url);
    }

    #[tokio::test]
    async fn restore_keeps_enabled_when_the_binary_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store
            .set_tunnel_state(TunnelStateRow {
                enabled: true,
                current_url: None,
                current_pid: None,
                started_at: None,
                port: Some(7421),
            })
            .await;

        // The binary is injected: no PATH/env mutation, so this can't race the
        // locator's own `VST_CLOUDFLARED_BIN` tests.
        let started = std::time::Instant::now();
        restore_with_binary_locked(7421, &store, CloudflaredBinary::NotInstalled).await;

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "restore must return promptly, took {:?}",
            started.elapsed()
        );
        let row = store.get_tunnel_state().await;
        assert!(
            row.enabled,
            "the persisted intent must survive a missing binary"
        );
        assert_eq!(row.current_url, None);
        assert_eq!(row.current_pid, None);
    }

    #[test]
    fn sweep_only_kills_vst_quick_tunnels() {
        assert!(is_vst_quick_tunnel_args(
            "/opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:7422",
            &[7422]
        ));
        assert!(is_vst_quick_tunnel_args(
            "cloudflared tunnel --url http://127.0.0.1:3000",
            &[7421, 3000]
        ));
        // Another vst daemon (e.g. a dev daemon next to the desktop app) runs the
        // same shape on a different port — not ours, so its tunnel survives.
        assert!(!is_vst_quick_tunnel_args(
            "cloudflared tunnel --url http://127.0.0.1:7422",
            &[7421]
        ));
        // A user's own named tunnel (e.g. `brew services start cloudflared`) is safe.
        assert!(!is_vst_quick_tunnel_args(
            "cloudflared tunnel run my-named-tunnel",
            &[7421]
        ));
        assert!(!is_vst_quick_tunnel_args(
            "/usr/local/bin/cloudflared tunnel run --token abc",
            &[7421]
        ));
        assert!(!is_vst_quick_tunnel_args(
            "cloudflared version 2025.1.0",
            &[7421]
        ));
        assert!(!is_vst_quick_tunnel_args("", &[7421]));
    }
}
