//! In-place daemon restart: the successor's boot side lives
//! here ([`take_boot_restart`], [`bind_with_restart_retry`], [`finish_handoff`],
//! [`exec_successor`]); the outgoing daemon's side is [`prepare_restart`] in
//! `shutdown.rs`. `run.rs` only calls these. Timings: `update/timing.rs`.

mod shutdown;

pub use shutdown::{prepare_restart, RestartCtx};

use std::ffi::OsString;
use std::fs::File;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use vst_routes::auth::HandoffAuth;

use super::timing::{
    HANDOFF_DELETE_GIVE_UP, HANDOFF_DELETE_POLL, RESTART_BIND_RETRY, RESTART_LOCK_RETRY,
    RESTART_RETRY_INTERVAL,
};
use super::{handoff, paths};

/// Env the outgoing daemon sets for its successor (and the watcher's restored
/// daemon): the handoff nonce and the port to pin.
pub const ENV_RESTART_NONCE: &str = "VST_RESTART_NONCE";
pub const ENV_RESTART_PORT: &str = "VST_RESTART_PORT";

/// Execute the successor daemon in place via `exec(2)`.
///
/// Keeps the process PID and standard streams, releases the flock automatically
/// on exec (as the lock is O_CLOEXEC), and never returns on success.
/// On failure, logs an error and exits with code 1.
///
/// An empty `nonce` (handoff write failed) is NOT exported: the successor
/// still gets `VST_RESTART_PORT` and pins the same port.
pub fn exec_successor(exe: &Path, args: &[OsString], nonce: &str, port: u16) -> ! {
    let mut cmd = Command::new(exe);
    cmd.args(args).env(ENV_RESTART_PORT, port.to_string());
    if nonce.is_empty() {
        cmd.env_remove(ENV_RESTART_NONCE);
    } else {
        cmd.env(ENV_RESTART_NONCE, nonce);
    }

    let err = cmd.exec();
    tracing::error!(%err, exe = ?exe, "failed to exec successor daemon");
    std::process::exit(1);
}

/// The restart handoff variables a successor was exec'd with.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RestartEnv {
    pub nonce: Option<String>,
    pub port: Option<u16>,
}

/// Read `VST_RESTART_NONCE` / `VST_RESTART_PORT` and REMOVE them from the
/// process environment so they never leak to children (tmux servers, agents)
/// or a later rollback-watcher env. Call once, early in boot.
pub fn take_restart_env() -> RestartEnv {
    let out = parse_restart_env(
        std::env::var(ENV_RESTART_NONCE).ok().as_deref(),
        std::env::var(ENV_RESTART_PORT).ok().as_deref(),
    );
    std::env::remove_var(ENV_RESTART_NONCE);
    std::env::remove_var(ENV_RESTART_PORT);
    out
}

fn parse_restart_env(nonce: Option<&str>, port: Option<&str>) -> RestartEnv {
    RestartEnv {
        nonce: nonce.filter(|s| !s.is_empty()).map(str::to_string),
        port: port.and_then(|v| v.parse::<u16>().ok()).filter(|&p| p > 0),
    }
}

/// What this boot learned about being (or not being) a planned restart.
#[derive(Default)]
pub struct BootRestart {
    /// Exec'd by a restarting daemon (a nonce was present): the lock and bind
    /// retry, and the handoff is deleted once serving.
    pub is_restart: bool,
    /// Auth carried over from the previous daemon (warm restart, nonce matched).
    pub auth: Option<HandoffAuth>,
    /// The port to pin, by precedence ([`resolve_port`]); `None` = pick a free one.
    pub port: Option<u16>,
}

/// Boot side of a restart, called first thing in `run_daemon`: read AND remove
/// the handoff env before anything is spawned, take `.daemon.lock`
/// (retrying while the old daemon exits when this is a restart), then consume
/// the handoff (warm) or discard a stale one (cold boot) and resolve the port.
///
/// The returned `File` is the daemon lock: keep it alive for the daemon's life.
pub async fn take_boot_restart(vst_home: &Path) -> Result<(BootRestart, File)> {
    let env = take_restart_env();
    let lock_path: PathBuf = paths::daemon_lock(vst_home);
    let is_restart = env.nonce.is_some();
    let lock = if is_restart {
        crate::lock::acquire_lock_with_retry(&lock_path, RESTART_LOCK_RETRY)
            .await
            .context("acquire daemon lock (restart retry)")?
    } else {
        crate::lock::acquire_lock(&lock_path)
            .await
            .context("acquire daemon lock")?
    };
    let handoff = match &env.nonce {
        Some(nonce) => handoff::consume(vst_home, nonce),
        None => {
            handoff::delete(vst_home);
            None
        }
    };
    let vst_port = std::env::var("VST_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p > 0);
    let port = resolve_port(
        env.port,
        handoff.as_ref().map(|h| h.port),
        vst_port,
        is_restart,
    );
    let restart = BootRestart {
        is_restart,
        auth: handoff.map(|h| h.auth),
        port,
    };
    Ok((restart, lock))
}

/// Bind `addr`. A successor retries `AddrInUse` for [`RESTART_BIND_RETRY`]
/// (the old daemon's listener is still closing); a cold boot fails at once.
pub async fn bind_with_restart_retry(
    addr: &str,
    is_restart: bool,
) -> Result<tokio::net::TcpListener> {
    if !is_restart {
        return tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("bind {addr}"));
    }
    let start = std::time::Instant::now();
    loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => return Ok(l),
            Err(e)
                if e.kind() == std::io::ErrorKind::AddrInUse
                    && start.elapsed() < RESTART_BIND_RETRY =>
            {
                tokio::time::sleep(RESTART_RETRY_INTERVAL).await;
            }
            Err(e) => return Err(e).with_context(|| format!("bind {addr} (restart retry)")),
        }
    }
}

/// Delete the handoff file only once `/health` answers, so a
/// successor that binds and dies first leaves it for the rollback watcher.
pub async fn finish_handoff(vst_home: PathBuf, port: u16) {
    handoff::delete_once_serving(
        vst_home,
        format!("http://127.0.0.1:{port}/health"),
        HANDOFF_DELETE_POLL,
        HANDOFF_DELETE_GIVE_UP,
    )
    .await;
}

/// Port precedence: a valid `VST_RESTART_PORT` always wins (independent of
/// the nonce); on a warm restart the handoff port comes next; then
/// `VST_PORT`. `None` means "pick a free port".
pub fn resolve_port(
    restart_port: Option<u16>,
    handoff_port: Option<u16>,
    vst_port: Option<u16>,
    warm: bool,
) -> Option<u16> {
    restart_port
        .or(if warm { handoff_port } else { None })
        .or(vst_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_port_honoured_without_nonce_d14() {
        let e = parse_restart_env(Some(""), Some("5123"));
        assert_eq!(e.nonce, None);
        assert_eq!(resolve_port(e.port, None, Some(4040), false), Some(5123));
    }

    #[test]
    fn resolve_port_precedence() {
        assert_eq!(resolve_port(None, Some(5), Some(6), true), Some(5));
        assert_eq!(resolve_port(None, Some(5), Some(6), false), Some(6));
        assert_eq!(resolve_port(Some(4), Some(5), Some(6), true), Some(4));
        assert_eq!(resolve_port(None, None, None, true), None);
        assert_eq!(parse_restart_env(None, Some("0")).port, None);
        assert_eq!(parse_restart_env(None, Some("x")).port, None);
    }

    #[test]
    fn take_restart_env_removes_the_variables_d18() {
        // Only test in this crate touching these two names.
        std::env::set_var("VST_RESTART_NONCE", "n0nce");
        std::env::set_var("VST_RESTART_PORT", "5555");
        let e = take_restart_env();
        assert_eq!(e.nonce.as_deref(), Some("n0nce"));
        assert_eq!(e.port, Some(5555));
        assert!(std::env::var("VST_RESTART_NONCE").is_err());
        assert!(std::env::var("VST_RESTART_PORT").is_err());
        let child = Command::new("sh")
            .args(["-c", "echo \"[$VST_RESTART_NONCE$VST_RESTART_PORT]\""])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&child.stdout).trim(), "[]");
    }
}
