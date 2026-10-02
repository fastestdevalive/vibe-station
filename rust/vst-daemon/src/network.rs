#![forbid(unsafe_code)]

//! Live network-access control (`allowNetworkAccess` toggle).
//!
//! The bind address used to be a startup constant (`resolve_bind_host` in
//! `run.rs`) — nothing could change it or revoke already-accepted LAN
//! connections at runtime. `NetworkControl` is the runtime knob: it owns the
//! enabled flag (an `AtomicBool` for the peer-gate middleware and the live QR
//! gate) and a `watch` so WebSocket tasks can react to a disable. Rebinding
//! the listener itself lives in `run.rs`'s supervisor via `SwapCmd` (Phase 2);
//! this module only exposes the channel so the control surface stays local.

use std::net::{IpAddr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::Router;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

/// Command a `NetworkControl::set` sends to the listener supervisor so it can
/// swap `127.0.0.1` ↔ `0.0.0.0`. The reply carries the bind result back to the
/// HTTP handler, which reports `500` on failure (after the supervisor rolled
/// the listener back to the previous host).
pub struct SwapCmd {
    pub enabled: bool,
    pub reply: oneshot::Sender<Result<(), String>>,
}

/// Runtime network-access state shared across the daemon's surfaces.
#[derive(Clone)]
pub struct NetworkControl {
    enabled: Arc<AtomicBool>,
    watch_tx: Arc<watch::Sender<bool>>,
    swap_tx: Option<mpsc::Sender<SwapCmd>>,
    config_path: Option<PathBuf>,
    lock: Arc<tokio::sync::Mutex<()>>,
    /// A previous `set` failed part-way (swap or persist), so the listener / config
    /// may disagree with the flag. The next `set` retries even if the flag already
    /// matches, instead of returning early.
    dirty: Arc<AtomicBool>,
}

impl NetworkControl {
    /// Build a control that only flips its own flag/watch — no listener swap
    /// and no config persistence. Used by tests and the `fixed` placeholder in
    /// `run.rs` until the supervisor is wired in (Phase 2).
    pub fn fixed(enabled: bool) -> Self {
        let (watch_tx, _) = watch::channel(enabled);
        Self {
            enabled: Arc::new(AtomicBool::new(enabled)),
            watch_tx: Arc::new(watch_tx),
            swap_tx: None,
            config_path: None,
            lock: Arc::new(tokio::sync::Mutex::new(())),
            dirty: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Build the live control: listener swaps go over `swap_tx`, and enabling
    /// persists `allowNetworkAccess` to `config_path`.
    pub fn new(initial: bool, swap_tx: mpsc::Sender<SwapCmd>, config_path: PathBuf) -> Self {
        let (watch_tx, _) = watch::channel(initial);
        Self {
            enabled: Arc::new(AtomicBool::new(initial)),
            watch_tx: Arc::new(watch_tx),
            swap_tx: Some(swap_tx),
            config_path: Some(config_path),
            lock: Arc::new(tokio::sync::Mutex::new(())),
            dirty: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// The live flag, for the peer-gate middleware and `mobile_auth.rs`'s QR gate.
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.enabled.clone()
    }

    /// For WebSocket tasks that must close non-loopback peers when disabled.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.watch_tx.subscribe()
    }

    /// Flip network access. Idempotent — a second `set` to the same value is a no-op.
    ///
    /// Disable fails CLOSED: the flag (peer gate + WS cut-off) flips first, so LAN
    /// peers are refused even while the listener is mid-swap or if the swap fails.
    /// Enable only flips the flag after the swap and persist both succeeded; a
    /// persist failure swaps back so the listener never disagrees with the flag.
    pub async fn set(&self, enabled: bool) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        if enabled == self.is_enabled() && !self.dirty.load(Ordering::SeqCst) {
            return Ok(());
        }
        let result = self.set_locked(enabled).await;
        self.dirty.store(result.is_err(), Ordering::SeqCst);
        result
    }

    async fn set_locked(&self, enabled: bool) -> Result<(), String> {
        if !enabled {
            self.apply_flag(false);
        }
        self.swap(enabled).await?;
        if let Some(config_path) = self.config_path.clone() {
            let persisted =
                tokio::task::spawn_blocking(move || persist_allow_network(&config_path, enabled))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r.map_err(|e| format!("persist allowNetworkAccess: {e}")));
            if let Err(e) = persisted {
                if enabled {
                    let _ = self.swap(false).await;
                }
                return Err(e);
            }
        }
        if enabled {
            self.apply_flag(true);
        }
        Ok(())
    }

    async fn swap(&self, enabled: bool) -> Result<(), String> {
        let Some(swap_tx) = &self.swap_tx else {
            return Ok(());
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        swap_tx
            .send(SwapCmd {
                enabled,
                reply: reply_tx,
            })
            .await
            .map_err(|_| "listener supervisor is gone".to_string())?;
        reply_rx
            .await
            .map_err(|_| "listener supervisor dropped the reply".to_string())?
    }

    fn apply_flag(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        // `send_replace` (not `send`) so the stored watch value updates even when
        // no receiver is currently subscribed — `send` skips the update when the
        // receiver count is 0, which would leave late subscribers reading stale.
        self.watch_tx.send_replace(enabled);
    }
}

/// Persist `allowNetworkAccess` in `config.json`, preserving every other key.
///
/// Reads the raw JSON (missing/invalid → `{}`), sets the one key, and writes
/// mode 0600 via temp file + rename, mirroring the permission handling in
/// `run.rs`'s `write_config`. Notably this never writes from a stale boot
/// snapshot — it re-reads the file, so it can't revert an epoch bump or a
/// concurrent `PATCH /settings` (Risks #2/#4).
pub fn persist_allow_network(path: &Path, enabled: bool) -> std::io::Result<()> {
    use std::io::Write;

    // Only a missing file starts from `{}`. A read or parse failure must not
    // overwrite the file with just this key — that would drop `cliToken`/`tauriToken`.
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut cfg: serde_json::Value = if raw.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?
    };
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("allowNetworkAccess".into(), serde_json::json!(enabled));
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "config.json is not a JSON object",
        ));
    }
    let out = serde_json::to_string_pretty(&cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // Distinct from `run.rs`'s `write_config` temp so concurrent writers never share a file.
    let tmp = path.with_extension("json.net.tmp");
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 0600 at creation, so the tokens are never briefly world-readable.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(out.as_bytes())?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Decide whether an incoming peer must be refused because network access is off.
///
/// `no_auth` builds (Docker sandbox) skip the gate entirely so the
/// port-forward can't be killed (Risks #3). A `None` peer means loopback or a
/// test without `ConnectInfo` — never cut. `true` = cut this request.
pub fn should_cut(peer: Option<IpAddr>, enabled: bool, no_auth: bool) -> bool {
    !no_auth && !enabled && peer.is_some_and(|ip| !ip.is_loopback())
}

// ─── Listener supervisor ────────────────────────────────────────────────────

/// Spawn the `axum::serve` accept loop for `listener`. The graceful-shutdown
/// future shares the supervisor's shutdown watch, so either firing shutdown or
/// aborting this task (a swap) ends it. The task resolves to `()` so the
/// supervisor can hold it as a plain `JoinHandle<()>`.
fn spawn_serve(
    router: Router,
    shutdown: watch::Receiver<bool>,
    listener: tokio::net::TcpListener,
) -> JoinHandle<()> {
    let mut shutdown = shutdown;
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown.wait_for(|v| *v).await;
        })
        .await;
    })
}

/// One accept-loop per listen address. Owns the router + the current
/// `axum::serve` task; a swap aborts the old task (dropping its `TcpListener` —
/// already-spawned connection tasks keep running) and binds a new one.
struct Supervisor {
    port: u16,
    router: Router,
    shutdown: watch::Receiver<bool>,
    /// `None` only after a swap where both the new and rollback binds failed.
    accept_task: Option<JoinHandle<()>>,
}

impl Supervisor {
    /// Rebinding the SAME port needs the old listener fully dropped first —
    /// abort and await the task before binding. On bind failure, roll back to
    /// the previous host so the daemon never ends up unreachable.
    async fn swap(&mut self, enabled: bool) -> Result<(), String> {
        let host = if enabled { "0.0.0.0" } else { "127.0.0.1" };
        let prev = if enabled { "127.0.0.1" } else { "0.0.0.0" };
        if let Some(mut task) = self.accept_task.take() {
            task.abort();
            let _ = (&mut task).await;
        }
        match tokio::net::TcpListener::bind(format!("{host}:{}", self.port)).await {
            Ok(l) => {
                self.accept_task = Some(spawn_serve(self.router.clone(), self.shutdown.clone(), l));
                Ok(())
            }
            Err(e) => {
                let new_err = format!("bind {host}:{}: {e}", self.port);
                match tokio::net::TcpListener::bind(format!("{prev}:{}", self.port)).await {
                    Ok(l) => {
                        self.accept_task =
                            Some(spawn_serve(self.router.clone(), self.shutdown.clone(), l));
                        Err(new_err)
                    }
                    Err(prev_e) => {
                        // No listener now; the next swap rebinds from scratch.
                        tracing::error!("[vst] no listener bound on port {}: {prev_e}", self.port);
                        Err(format!(
                            "{new_err}; rollback bind {prev}:{}: {prev_e}",
                            self.port
                        ))
                    }
                }
            }
        }
    }
}

/// Run the listener swap loop on an already-bound `listener` (the caller binds
/// so a bind failure is a startup error). `select!`s on `swap_rx` (a
/// `NetworkControl::set`) and the shutdown watch; on shutdown awaits the current
/// accept task so its in-flight connections drain, then returns.
pub fn spawn_supervisor_with_listener(
    router: Router,
    listener: tokio::net::TcpListener,
    shutdown: watch::Receiver<bool>,
    mut swap_rx: mpsc::Receiver<SwapCmd>,
) -> JoinHandle<()> {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let mut sup = Supervisor {
        port,
        router: router.clone(),
        shutdown: shutdown.clone(),
        accept_task: Some(spawn_serve(router, shutdown.clone(), listener)),
    };
    tokio::spawn(async move {
        let mut shutdown = shutdown;
        loop {
            tokio::select! {
                cmd = swap_rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    let result = sup.swap(cmd.enabled).await;
                    let _ = cmd.reply.send(result);
                }
                _ = shutdown.changed() => {
                    // Shutdown fired (or the sender dropped) — stop accepting
                    // swaps, drain, exit.
                    break;
                }
            }
        }
        if let Some(task) = sup.accept_task.take() {
            let _ = task.await;
        }
    })
}

/// Convenience for tests: bind `port` on loopback (`initial == false`) or the
/// wildcard, then run [`spawn_supervisor_with_listener`]. A bind failure is
/// logged and the returned task ends immediately.
pub fn spawn_listener_supervisor(
    router: Router,
    port: u16,
    initial: bool,
    shutdown: watch::Receiver<bool>,
    swap_rx: mpsc::Receiver<SwapCmd>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let host = if initial { "0.0.0.0" } else { "127.0.0.1" };
        match tokio::net::TcpListener::bind(format!("{host}:{port}")).await {
            Ok(l) => {
                let _ = spawn_supervisor_with_listener(router, l, shutdown, swap_rx).await;
            }
            Err(e) => tracing::error!("[vst] initial bind {host}:{port} failed: {e}"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_creates_key_and_keeps_others_with_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, serde_json::json!({ "port": 7421 }).to_string()).unwrap();

        persist_allow_network(&path, true).unwrap();

        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(cfg["allowNetworkAccess"], serde_json::json!(true));
        assert_eq!(cfg["port"], serde_json::json!(7421));

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn persist_creates_file_when_missing_and_refuses_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        persist_allow_network(&missing, false).unwrap();
        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&missing).unwrap()).unwrap();
        assert_eq!(cfg["allowNetworkAccess"], serde_json::json!(false));

        let invalid = dir.path().join("invalid.json");
        std::fs::write(&invalid, "not json").unwrap();
        // A corrupt config must NOT be overwritten with just this key (it would
        // drop cliToken/tauriToken): the write fails and the file is untouched.
        assert!(persist_allow_network(&invalid, true).is_err());
        assert_eq!(std::fs::read_to_string(&invalid).unwrap(), "not json");
    }

    #[test]
    fn should_cut_truth_table() {
        let lan = "192.168.1.9".parse::<IpAddr>().ok();
        let loopback = "127.0.0.1".parse::<IpAddr>().ok();

        // Enabled: never cut.
        assert!(!should_cut(lan, true, false));
        assert!(!should_cut(loopback, true, false));
        assert!(!should_cut(None, true, false));

        // Disabled, auth on: cut LAN only.
        assert!(should_cut(lan, false, false));
        assert!(!should_cut(loopback, false, false));
        assert!(!should_cut(None, false, false));

        // no_auth: never cut.
        assert!(!should_cut(lan, false, true));
        assert!(!should_cut(loopback, false, true));
        assert!(!should_cut(None, false, true));
    }

    #[tokio::test]
    async fn set_on_fixed_flips_flag_and_watch_second_is_noop() {
        let ctrl = NetworkControl::fixed(false);
        assert!(!ctrl.is_enabled());
        assert!(!*ctrl.subscribe().borrow());

        ctrl.set(true).await.unwrap();
        assert!(ctrl.is_enabled());
        assert!(*ctrl.subscribe().borrow());

        ctrl.set(true).await.unwrap();
        assert!(ctrl.is_enabled());
    }
}
