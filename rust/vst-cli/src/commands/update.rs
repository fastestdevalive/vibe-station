//! `vst update` — `--check`, install, `--skip`/`--unskip` (install flow in
//! `update_install.rs`).
//!
//! Exit codes: 0 up to date / done / cancelled at the prompt, 10 update
//! available (`--check`), 1 error, 130 interrupted during download.
//! Never goes through `die(.., 4)`: when the daemon is missing, old, or
//! returns non-JSON, the check falls back to an in-process `UpdateService`
//! (one writer at a time: the daemon's `UpdateService`, or this fallback while
//! it holds `.update.lock`).

use reqwest::Method;
use vst_daemon::lock::LockWait;
use vst_daemon::update::{try_update_lock, vst_home, UpdateConfig, UpdateService};
use vst_types::rest::update::{UpdateCheckResponse, UpdateStatus};

use crate::client::{probe_route, RouteProbe};
use crate::commands::update_install;
use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::preflight::preflight_with_url;
use crate::program::UpdateArgs;

pub const EXIT_UP_TO_DATE: i32 = 0;
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_UPDATE_AVAILABLE: i32 = 10;

pub async fn run_update(args: UpdateArgs) -> i32 {
    if args.help {
        println!("{}", crate::program::UPDATE_USAGE);
        return EXIT_UP_TO_DATE;
    }
    if let Some(bad) = &args.bad_arg {
        eprintln!("error: Unknown option: {bad}");
        return EXIT_ERROR;
    }
    if args.skip.is_some() && args.unskip.is_some() {
        eprintln!("error: --skip and --unskip cannot be combined");
        return EXIT_ERROR;
    }
    if let Some(v) = &args.skip {
        return update_install::run_skip(v, true).await;
    }
    if let Some(v) = &args.unskip {
        return update_install::run_skip(v, false).await;
    }
    if args.check {
        return match check_status().await {
            Ok(status) => report(&status),
            Err(msg) => {
                eprintln!("error: {msg}");
                EXIT_ERROR
            }
        };
    }
    update_install::run_install_flow(args.yes).await
}

pub(crate) const UNAUTHORIZED_MSG: &str =
    "the daemon rejected this CLI's token; run `vst open` to refresh it";

/// A reachable daemon that serves `/api/update/*`.
pub(crate) struct DaemonConn {
    pub url: String,
    pub token: Option<String>,
}

/// Result of probing for an update-capable daemon.
pub(crate) enum DaemonProbe {
    /// Daemon answered `/api/update/check` with a snapshot.
    Ready(DaemonConn, Box<UpdateCheckResponse>),
    /// A daemon answered but rejected our token (401/403): not an old daemon,
    /// so no in-process fallback (it would race the daemon's own state).
    Unauthorized,
    /// A daemon answered `/health` but lacks the update routes.
    Old,
    /// No daemon (not configured, not running, or unreachable).
    Absent,
}

/// Never calls `die()`; never uses `preflight_scoped`: the check must work with no daemon.
pub(crate) async fn probe_daemon(force: bool) -> DaemonProbe {
    let Some(url) = get_daemon_url() else {
        return DaemonProbe::Absent;
    };
    let token = get_daemon_token();
    if preflight_with_url(&url, token.as_deref()).await.is_err() {
        return DaemonProbe::Absent;
    }
    let path = format!("/update/check?force={force}");
    match probe_route(&url, token.as_deref(), Method::GET, &path, None).await {
        RouteProbe::Json { status: 200, body } => {
            match serde_json::from_value::<UpdateCheckResponse>(body) {
                Ok(r) => DaemonProbe::Ready(DaemonConn { url, token }, Box::new(r)),
                Err(_) => DaemonProbe::Old,
            }
        }
        RouteProbe::Json {
            status: 401 | 403, ..
        } => DaemonProbe::Unauthorized,
        RouteProbe::Json { .. } | RouteProbe::OldDaemon => DaemonProbe::Old,
        RouteProbe::Unreachable => DaemonProbe::Absent,
    }
}

/// Daemon first, in-process fallback second.
async fn check_status() -> Result<UpdateStatus, String> {
    match probe_daemon(true).await {
        DaemonProbe::Ready(_, r) => return Ok(r.status),
        DaemonProbe::Unauthorized => return Err(UNAUTHORIZED_MSG.to_string()),
        DaemonProbe::Old | DaemonProbe::Absent => {}
    }
    let fb = Fallback::open()?;
    let status = fb.service.check(true).await;
    Ok(status) // lock released with `fb`
}

/// The daemon-less path: an in-process service under a held `.update.lock`
/// (one writer at a time). The lock is released when this is dropped.
pub(crate) struct Fallback {
    pub service: std::sync::Arc<UpdateService>,
    _lock: std::fs::File,
}

impl Fallback {
    pub fn open() -> Result<Fallback, String> {
        let vst_home = vst_home().ok_or("HOME is not set")?;
        let lock = try_update_lock(&vst_home, LockWait::NONE)
            .map_err(|e| e.to_string())?
            .ok_or("An update is already running")?;
        let boot_exe = std::env::current_exe().unwrap_or_default();
        let service = UpdateService::new(UpdateConfig::with_defaults(
            vst_home,
            vst_daemon::version::current().to_string(),
            boot_exe,
            String::new(),
            None,
        ));
        Ok(Fallback {
            service,
            _lock: lock,
        })
    }
}

/// `Some(failed_version)` when the latest release is the one that just failed
/// to boot and was rolled back. The daemon clears `rolledBack` as soon as a
/// newer release is seen, so no version comparison is needed (such a
/// version is never `updateAvailable`, but the CLI is the retry path).
pub(crate) fn rolled_back_retry(s: &UpdateStatus) -> Option<&str> {
    let rb = s.rolled_back.as_ref()?;
    (s.latest.as_deref() == Some(rb.failed_version.as_str())).then_some(rb.failed_version.as_str())
}

/// The two user-facing rollback lines, shared by `--check` and
/// `vst daemon restart`.
pub(crate) fn rollback_lines(failed: &str, current: &str) -> [String; 2] {
    [
        format!("v{failed} failed to start \u{2014} rolled back to v{current}."),
        format!("Retry with `vst update`, or skip with `vst update --skip {failed}`."),
    ]
}

/// Lines `--check` prints on stdout for a rolled-back latest release.
fn rolled_back_check_lines(s: &UpdateStatus) -> Option<[String; 2]> {
    let v = rolled_back_retry(s)?;
    Some(rollback_lines(v, &s.current))
}

fn report(s: &UpdateStatus) -> i32 {
    if s.update_available {
        if let Some(latest) = &s.latest {
            println!("v{} \u{2192} v{latest}", s.current);
            return EXIT_UPDATE_AVAILABLE;
        }
    }
    // Exit 0, not 10: deliberately not "available", so a `--check || update
    // --yes` cron cannot loop-install a version that fails to boot.
    if let Some(lines) = rolled_back_check_lines(s) {
        for l in lines {
            println!("{l}");
        }
        return EXIT_UP_TO_DATE;
    }
    if let Some(e) = &s.last_error {
        eprintln!("error: {}", e.message);
        return EXIT_ERROR;
    }
    println!("vibe-station v{} is already the latest version.", s.current);
    EXIT_UP_TO_DATE
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn rolled_snapshot(latest: &str, failed: &str) -> UpdateStatus {
        serde_json::from_value(json!({
            "current": "0.0.5-beta", "latest": latest, "updateAvailable": false,
            "behindCount": 0, "targets": [], "skipped": [], "noAsset": false,
            "installMethod": "curl", "autoCheck": true, "platform": "linux-aarch64",
            "rolledBack": {"failedVersion": failed, "at": "2026-10-26T00:00:00Z"}
        }))
        .expect("status fixture")
    }

    #[test]
    fn rolled_back_latest_is_retryable_not_up_to_date() {
        let s = rolled_snapshot("0.0.6-beta", "0.0.6-beta");
        assert_eq!(rolled_back_retry(&s), Some("0.0.6-beta"));
        let out = rolled_back_check_lines(&s).unwrap().join("\n");
        assert!(out.contains("failed to start"), "{out}");
        assert!(out.contains("rolled back to v0.0.5-beta"), "{out}");
        assert!(out.contains("vst update --skip 0.0.6-beta"), "{out}");
        assert!(!out.contains("already the latest"), "{out}");
        assert_eq!(report(&s), EXIT_UP_TO_DATE);
    }

    #[test]
    fn rollback_lines_match_prd() {
        let l = rollback_lines("0.0.7-beta", "0.0.6-beta");
        assert_eq!(
            l[0],
            "v0.0.7-beta failed to start \u{2014} rolled back to v0.0.6-beta."
        );
        assert_eq!(
            l[1],
            "Retry with `vst update`, or skip with `vst update --skip 0.0.7-beta`."
        );
    }

    #[test]
    fn rolled_back_with_newer_latest_is_not_matched() {
        let s = rolled_snapshot("0.0.7-beta", "0.0.6-beta");
        assert_eq!(rolled_back_retry(&s), None);
        assert!(rolled_back_check_lines(&s).is_none());
    }
}
