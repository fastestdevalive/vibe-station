//! Rollback watcher.
//!
//! Spawns from `.vst.prev` upon a restart when a binary replacement occurred.
//! Observes the successor daemon:
//! - Phase A (≤15 s): poll `/health` every 500 ms until it fails or returns `bootId != old_boot_id`.
//!   If the OLD bootId is still served at the end, the graceful drain hung: nothing in the running
//!   process was replaced, so log it and exit 0 WITHOUT rolling back.
//! - Phase B (30 s, the successor's boot budget): poll `/health` every 500 ms until `bootId != old_boot_id`.
//!
//! Window choice: A (<=15 s) + B (30 s) + the restored daemon's boot (~15 s bind/lock
//! retry) must fit inside what the UI overlay and `vst daemon restart` wait, so those waits are
//! 75 s (see [`UI_CLI_RESTART_WAIT`](crate::update::timing::UI_CLI_RESTART_WAIT) and `timing.rs`); the watcher always decides before they give up.
//!
//! If a healthy successor boots, exit 0 without touching anything.
//! If the successor fails to boot or times out:
//! 1. Kill hung `--pid` if alive and still running `daemon run`.
//! 2. Take `<vst_home>/.daemon.lock`; if anyone else holds it, abort without writing anything
//!    (a booting daemon owns the DB). Held until the restore is finished.
//! 3. Restore all `.<name>.prev` files in `--bin-dir`.
//! 4. Restore the SQLite snapshot from `--db-snapshot` only if it exists (copy to a temp file,
//!    rename over the DB, then delete `-wal`/`-shm`). No snapshot -> `-wal`/`-shm` are left alone.
//! 5. Update `update-state.json` with `rolledBack` and `lastError{kind: Restart, reason: BootFailed}`.
//! 6. Release the lock and spawn restored `<bin-dir>/vst daemon run` detached with
//!    `VST_RESTART_NONCE`/`VST_RESTART_PORT`.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Utc;
use vst_proc::posix::{kill_pid, pid_alive};
use vst_types::rest::health::Health;
use vst_types::rest::update::{UpdateError, UpdateErrorKind, UpdateReason};

use crate::lock::LockWait;
use crate::update::install::replace::KNOWN_NAMES;
use crate::update::paths;
use crate::update::restart::{ENV_RESTART_NONCE, ENV_RESTART_PORT};
use crate::update::state::{RolledBack, StateStore};
use crate::update::timing::{
    WATCH_DAEMON_LOCK_WAIT, WATCH_PHASE_A_MAX, WATCH_PHASE_B, WATCH_POLL, WATCH_UPDATE_LOCK_WAIT,
};

/// The rollback watcher's command line: BOTH sides of the contract live here
/// ([`to_args`](Self::to_args) builds it, [`parse`](Self::parse) reads it), plus
/// the spawn ([`spawn`](Self::spawn)) that adds the env half.
///
/// The watcher is the PREVIOUS version's binary (`.vst.prev`), so its parser is
/// one release older than the producer: keep every flag, never make a new one
/// required, and ignore tokens you do not know. `--vst-home` is the newest flag;
/// an older producer omits it and the watcher derives it from `--db-snapshot`.
///
/// The restart nonce travels in the env (`VST_RESTART_NONCE`), not argv: argv is
/// visible in `ps`.
#[derive(Clone, Debug, PartialEq)]
pub struct WatchArgs {
    pub expect_version: String,
    pub port: u16,
    pub pid: u32,
    pub bin_dir: PathBuf,
    pub vst_home: PathBuf,
    pub db_snapshot: PathBuf,
    pub old_boot_id: String,
    pub nonce: Option<String>,
}

impl WatchArgs {
    /// `argv[1..]` for `.vst.prev` (starts with `daemon _restart-watch`).
    pub fn to_args(&self) -> Vec<String> {
        let path = |p: &Path| p.to_string_lossy().into_owned();
        vec![
            "daemon".to_string(),
            "_restart-watch".to_string(),
            "--expect-version".to_string(),
            self.expect_version.clone(),
            "--port".to_string(),
            self.port.to_string(),
            "--pid".to_string(),
            self.pid.to_string(),
            "--bin-dir".to_string(),
            path(&self.bin_dir),
            "--vst-home".to_string(),
            path(&self.vst_home),
            "--db-snapshot".to_string(),
            path(&self.db_snapshot),
            "--old-boot-id".to_string(),
            self.old_boot_id.clone(),
        ]
    }

    /// Parse the tokens AFTER `_restart-watch` (`--flag value` or `--flag=value`).
    /// `nonce` stays `None`: see [`with_env_nonce`](Self::with_env_nonce).
    pub fn parse(iter: impl Iterator<Item = String>) -> Result<Self, String> {
        let (mut version, mut old_boot_id) = (String::new(), String::new());
        let (mut port, mut pid) = (None::<u16>, None::<u32>);
        let (mut bin_dir, mut vst_home, mut snapshot) = (None, None, None);
        let mut it = iter;
        while let Some(tok) = it.next() {
            let (flag, inline) = match tok.split_once('=') {
                Some((f, v)) => (f.to_string(), Some(v.to_string())),
                None => (tok, None),
            };
            if !flag.starts_with("--") {
                continue;
            }
            let known = matches!(
                flag.as_str(),
                "--expect-version"
                    | "--port"
                    | "--pid"
                    | "--bin-dir"
                    | "--vst-home"
                    | "--db-snapshot"
                    | "--old-boot-id"
            );
            if !known {
                continue; // a newer producer's flag
            }
            let value = inline
                .or_else(|| it.next())
                .ok_or_else(|| format!("{flag} needs a value"))?;
            let bad = |what: &str| format!("{flag}: {what}");
            match flag.as_str() {
                "--expect-version" => version = value,
                "--port" => {
                    port = Some(
                        value
                            .parse::<u16>()
                            .ok()
                            .filter(|&p| p > 0)
                            .ok_or_else(|| bad("expected a port above 0"))?,
                    )
                }
                "--pid" => {
                    pid = Some(
                        value
                            .parse::<u32>()
                            .ok()
                            .filter(|&p| p > 0)
                            .ok_or_else(|| bad("expected a pid above 0"))?,
                    )
                }
                "--bin-dir" => bin_dir = Some(PathBuf::from(value)),
                "--vst-home" => vst_home = Some(PathBuf::from(value)),
                "--db-snapshot" => snapshot = Some(PathBuf::from(value)),
                _ => old_boot_id = value,
            }
        }
        let missing = |flag: &str| format!("missing required {flag}");
        let db_snapshot = snapshot.ok_or_else(|| missing("--db-snapshot"))?;
        // Older producers have no `--vst-home`: it is the snapshot's grandparent.
        let vst_home = vst_home
            .or_else(|| db_snapshot.parent()?.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| vst_git::paths::Paths::default_home().vst_home().clone());
        if version.is_empty() {
            return Err(missing("--expect-version"));
        }
        if old_boot_id.is_empty() {
            return Err(missing("--old-boot-id"));
        }
        Ok(WatchArgs {
            expect_version: version,
            port: port.ok_or_else(|| missing("--port"))?,
            pid: pid.ok_or_else(|| missing("--pid"))?,
            bin_dir: bin_dir.ok_or_else(|| missing("--bin-dir"))?,
            vst_home,
            db_snapshot,
            old_boot_id,
            nonce: None,
        })
    }

    /// Fill `nonce` from `VST_RESTART_NONCE` (the watcher's env, set by [`spawn`](Self::spawn)).
    pub fn with_env_nonce(mut self) -> Self {
        self.nonce = std::env::var(ENV_RESTART_NONCE)
            .ok()
            .filter(|n| !n.is_empty());
        self
    }

    /// Spawn the watcher detached from `prev_vst` (the old, known-good binary),
    /// logging to `logs/update-watch.log`. It inherits the daemon's env (the
    /// restored daemon is respawned with it) plus the nonce and port.
    pub fn spawn(&self, prev_vst: &Path) -> io::Result<u32> {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        if let Some(nonce) = &self.nonce {
            env.insert(ENV_RESTART_NONCE.to_string(), nonce.clone());
        }
        env.insert(ENV_RESTART_PORT.to_string(), self.port.to_string());
        let log_path = paths::watch_log(&self.vst_home);
        if let Some(dir) = log_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let args = self.to_args();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        vst_proc::spawn_detached(prev_vst, &args, &self.vst_home, &env, &log_path)
    }
}

fn append_watch_log(vst_home: &Path, msg: &str) {
    let log_path = paths::watch_log(vst_home);
    if let Some(dir) = log_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        use std::io::Write;
        let ts = Utc::now().to_rfc3339();
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

async fn fetch_health_boot_id(client: &reqwest::Client, port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{port}/health");
    match client.get(&url).timeout(WATCH_POLL).send().await {
        Ok(res) => {
            if res.status().is_success() {
                if let Ok(h) = res.json::<Health>().await {
                    return Some(h.boot_id);
                }
            }
            None
        }
        Err(_) => None,
    }
}

fn is_daemon_run_process(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        let cmdline_path = format!("/proc/{pid}/cmdline");
        if let Ok(cmd) = fs::read(cmdline_path) {
            let cmd_str = String::from_utf8_lossy(&cmd);
            return cmd_str.contains("daemon") && cmd_str.contains("run");
        }
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            return s.contains("daemon") && s.contains("run");
        }
        false
    }
}

/// Take `<vst_home>/.daemon.lock` exclusively. `None` = someone else holds it.
/// `wait_for_killed`: retry briefly while the process we just killed exits.
async fn acquire_daemon_lock(vst_home: &Path, wait_for_killed: bool) -> Option<fs::File> {
    let wait = if wait_for_killed {
        WATCH_DAEMON_LOCK_WAIT
    } else {
        LockWait::NONE
    };
    crate::lock::try_lock_async(paths::daemon_lock(vst_home), wait)
        .await
        .ok()
        .flatten()
}

fn restore_db_snapshot(vst_home: &Path, snapshot: &Path) {
    if !snapshot.is_file() {
        append_watch_log(
            vst_home,
            "No database snapshot; leaving the database and its -wal/-shm untouched.",
        );
        return;
    }
    let db_path = paths::db(vst_home);
    let staged = paths::db_restore_staging(vst_home);
    append_watch_log(
        vst_home,
        &format!("Restoring database snapshot from {snapshot:?}"),
    );
    let res = fs::copy(snapshot, &staged).and_then(|_| fs::rename(&staged, &db_path));
    match res {
        Ok(()) => {
            for sidecar in paths::db_sidecars(vst_home) {
                let _ = fs::remove_file(sidecar);
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&staged);
            append_watch_log(
                vst_home,
                &format!("Database restore failed ({e}); database left as it was."),
            );
        }
    }
}

/// Phase A / phase B bounds. Test seam: `VST_RESTART_WATCH_WINDOW_MS` (compiled in only
/// with `test-seams`) lets one value bound both, so a rollback test need not wait minutes.
fn watch_windows() -> (Duration, Duration) {
    #[cfg(any(test, feature = "test-seams"))]
    if let Some(ms) = std::env::var("VST_RESTART_WATCH_WINDOW_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return (Duration::from_millis(ms), Duration::from_millis(ms));
    }
    (WATCH_PHASE_A_MAX, WATCH_PHASE_B)
}

pub async fn run_watch(args: WatchArgs) -> i32 {
    let vst_home = args.vst_home.clone();

    append_watch_log(
        &vst_home,
        &format!(
            "Starting watch for successor version {} on port {} (pid={}, old_boot_id={})",
            args.expect_version, args.port, args.pid, args.old_boot_id
        ),
    );

    let client = super::http::timeout_client(WATCH_POLL);

    let (phase_a_timeout, phase_b_timeout) = watch_windows();

    // Phase A: wait until the old daemon stops serving its old_boot_id.
    let started = Instant::now();
    let poll_interval = WATCH_POLL;

    let mut phase_a_done = false;
    while started.elapsed() < phase_a_timeout {
        match fetch_health_boot_id(&client, args.port).await {
            Some(boot_id) => {
                if boot_id != args.old_boot_id {
                    // Successor already up and healthy!
                    append_watch_log(
                        &vst_home,
                        &format!("Successor daemon already booted with new boot_id: {boot_id}"),
                    );
                    return 0;
                }
            }
            None => {
                // Old daemon disconnected or closed port
                phase_a_done = true;
                break;
            }
        }
        tokio::time::sleep(poll_interval).await;
    }

    if !phase_a_done {
        // The old daemon never stopped (hung drain): no successor ever ran, so
        // there is nothing to roll back and `--pid` is the healthy-looking old
        // daemon. A later restart can retry.
        append_watch_log(
            &vst_home,
            "Phase A timed out: old daemon did not stop. Not rolling back.",
        );
        return 0;
    }

    // Phase B: wait for a new bootId.
    let start_b = Instant::now();
    let mut booted = false;
    while start_b.elapsed() < phase_b_timeout {
        if let Some(boot_id) = fetch_health_boot_id(&client, args.port).await {
            if boot_id != args.old_boot_id {
                append_watch_log(
                    &vst_home,
                    &format!("Successor daemon healthy with boot_id: {boot_id}"),
                );
                booted = true;
                break;
            }
        }
        tokio::time::sleep(poll_interval).await;
    }

    if booted {
        return 0;
    }

    // --- Rollback execution ---
    append_watch_log(&vst_home, "Successor failed to boot. Initiating rollback!");

    // 1. Kill hung --pid if still alive and is `daemon run`
    let mut killed = false;
    if pid_alive(args.pid) && is_daemon_run_process(args.pid) {
        append_watch_log(
            &vst_home,
            &format!("Killing hung daemon process {}", args.pid),
        );
        killed = kill_pid(args.pid, 9).is_ok();
    }

    // 2. Take `.daemon.lock`: the DB and binaries must not be replaced
    // under a daemon that is (still) booting. The killed `--pid`'s lock dies
    // with it, so give it a moment to be released; any other holder aborts.
    let Some(daemon_lock) = acquire_daemon_lock(&vst_home, killed).await else {
        append_watch_log(
            &vst_home,
            "Another process holds .daemon.lock; aborting rollback without changes.",
        );
        return 0;
    };

    // 3. Restore the known `.<name>.prev` files only: `--bin-dir` can be
    // a shared dir like `~/.local/bin`, so never act on other tools' `.X.prev`.
    let names_to_restore: Vec<String> = KNOWN_NAMES.iter().map(|k| k.to_string()).collect();

    for name in names_to_restore {
        let prev_path = args.bin_dir.join(format!(".{name}.prev"));
        let target_path = args.bin_dir.join(&name);
        if prev_path.exists() {
            append_watch_log(
                &vst_home,
                &format!("Restoring {prev_path:?} -> {target_path:?}"),
            );
            let _ = fs::rename(&prev_path, &target_path);
        }
    }

    // 4. Restore the SQLite snapshot, only if there is one. Atomic: copy beside
    // the DB, rename over it, and only then drop the stale `-wal`/`-shm`.
    // With no snapshot the live `-wal`/`-shm` hold committed data: keep them.
    restore_db_snapshot(&vst_home, &args.db_snapshot);

    // 5. Update update-state.json under .update.lock
    // The daemon and the CLI fallback may write concurrently, so write only
    // while HOLDING `.update.lock`. A busy lock (an install or the CLI fallback
    // is running) is retried briefly, then the write is
    // skipped and logged rather than racing the holder.
    let update_lock =
        crate::lock::try_lock_async(paths::update_lock(&vst_home), WATCH_UPDATE_LOCK_WAIT)
            .await
            .ok()
            .flatten();
    let locked = update_lock.is_some();
    if locked {
        let state_file_path = paths::update_state(&vst_home);
        let (state_store, mut state) = StateStore::load_or_default(state_file_path);
        state.pending_restart = None;
        state.rolled_back = Some(RolledBack {
            failed_version: args.expect_version.clone(),
            at: Utc::now().to_rfc3339(),
        });
        state.last_error = Some(UpdateError {
            kind: UpdateErrorKind::Restart,
            reason: UpdateReason::BootFailed,
            message: format!(
                "v{} failed to start — rolled back to previous version",
                args.expect_version
            ),
            retry_after: None,
        });
        let _ = state_store.save(&state);
    } else {
        append_watch_log(
            &vst_home,
            ".update.lock is busy; skipping the update-state write (rollback itself is done).",
        );
    }

    // 6. Release `.daemon.lock` so the restored daemon can take it, then spawn
    // the restored `<bin-dir>/vst daemon run` detached
    drop(daemon_lock);
    let vst_bin = args.bin_dir.join("vst");
    let log_path = vst_home.join("logs").join("daemon.log");
    // The watcher was spawned with the old daemon's full env; hand all of it
    // to the restored daemon (same argv/env: API keys, VST_* config),
    // since `spawn_detached` clears the environment.
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.remove(ENV_RESTART_NONCE);
    if let Some(ref nonce) = args.nonce {
        env.insert(ENV_RESTART_NONCE.to_string(), nonce.clone());
    }
    env.insert(ENV_RESTART_PORT.to_string(), args.port.to_string());

    append_watch_log(
        &vst_home,
        &format!("Respawning restored daemon at {:?}", vst_bin),
    );
    let spawn_res =
        vst_proc::spawn_detached(&vst_bin, &["daemon", "run"], &vst_home, &env, &log_path);

    match spawn_res {
        Ok(child_pid) => {
            append_watch_log(
                &vst_home,
                &format!("Restored daemon spawned with PID {child_pid}"),
            );
            1
        }
        Err(e) => {
            append_watch_log(
                &vst_home,
                &format!("Failed to respawn restored daemon: {e}"),
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::timing::{
        HANDOFF_TTL, RESTART_LOCK_RETRY, UI_CLI_RESTART_WAIT, WATCH_PHASE_B,
    };

    /// The watcher's worst case plus the restored daemon's lock
    /// retry fits inside the UI/CLI wait (they never give up first), and the
    /// handoff outlives the watcher.
    #[test]
    fn timing_budget_holds() {
        assert_eq!(WATCH_PHASE_B, Duration::from_secs(30));
        assert!(WATCH_PHASE_A_MAX + WATCH_PHASE_B + RESTART_LOCK_RETRY <= UI_CLI_RESTART_WAIT);
        assert!(WATCH_PHASE_A_MAX + WATCH_PHASE_B < HANDOFF_TTL);
    }

    fn sample() -> WatchArgs {
        WatchArgs {
            expect_version: "1.2.3".into(),
            port: 7007,
            pid: 4242,
            bin_dir: "/opt/bin dir".into(),
            vst_home: "/home/u/.vibe-station".into(),
            db_snapshot: "/home/u/.vibe-station/.prev/vibe-station.db".into(),
            old_boot_id: "boot-abc".into(),
            nonce: None,
        }
    }

    #[test]
    fn watch_args_round_trip() {
        let a = sample();
        let argv = a.to_args();
        assert_eq!(&argv[..2], ["daemon", "_restart-watch"]);
        assert_eq!(WatchArgs::parse(argv.into_iter().skip(2)).unwrap(), a);
    }

    #[test]
    fn parse_accepts_equals_form_and_ignores_unknown_flags() {
        let toks = "--expect-version=2.0.0 --port=9 --pid=3 --bin-dir=/b --db-snapshot=/h/.prev/vibe-station.db --old-boot-id=x --future-flag y"
            .split(' ')
            .map(String::from);
        let a = WatchArgs::parse(toks).unwrap();
        assert_eq!((a.port, a.pid), (9, 3));
        // No `--vst-home` (older producer): derived from the snapshot path.
        assert_eq!(a.vst_home, Path::new("/h"));
    }

    #[test]
    fn parse_rejects_zero_port_zero_pid_and_missing_fields() {
        let with = |port: &str, pid: &str| {
            let mut v = sample().to_args();
            v.drain(..2);
            let i = v.iter().position(|t| t == "--port").unwrap();
            v[i + 1] = port.into();
            let i = v.iter().position(|t| t == "--pid").unwrap();
            v[i + 1] = pid.into();
            WatchArgs::parse(v.into_iter())
        };
        assert!(with("0", "1").is_err());
        assert!(with("1", "0").is_err());
        assert!(with("x", "1").is_err());
        assert!(with("1", "1").is_ok());
        assert!(WatchArgs::parse(std::iter::empty()).is_err());
    }
}
