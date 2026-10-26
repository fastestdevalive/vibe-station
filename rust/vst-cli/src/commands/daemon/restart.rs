//! `vst daemon restart [--yes]`.
//!
//! Sends `POST /daemon/restart`.

use std::io::BufRead;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::json;
use vst_types::rest::update::{ImpactItem, ImpactKind, UpdateApiError, UpdateApiErrorCode};

use crate::client::{fetch_health, probe_route, RouteProbe};
use crate::confirm::confirm_yes_default;
use crate::daemon_url::{get_daemon_token, get_daemon_url};
use crate::launch::{spawn_headless_daemon_with_exe, PreflightScope};
use crate::output::die;
use crate::preflight::preflight_scoped;

// The watcher's whole budget fits inside this (see `update/timing.rs`).
const POLL_TIMEOUT: Duration = vst_daemon::update::UI_CLI_RESTART_WAIT;
const POLL_INTERVAL: Duration = Duration::from_millis(500);

pub async fn run_restart(yes: bool, impact_seen: bool) -> i32 {
    preflight_scoped(PreflightScope::Exempt).await;

    let base = match get_daemon_url() {
        Some(u) => u,
        None => die(
            "Daemon is not running. Open the vibe-station app to start it.",
            Some(4),
        ),
    };
    let token = get_daemon_token();

    let initial_health = match fetch_health(&base).await {
        Ok(h) => h,
        Err(e) => die(&format!("failed to fetch daemon health: {e}"), Some(1)),
    };
    let old_boot_id = initial_health.boot_id;

    // A rollback marker left by an EARLIER restart must not be reported
    // for this one, so remember its timestamp before restarting.
    let rb_before = rolled_back_at(&base, token.as_deref()).await;

    let body = if impact_seen {
        json!({ "confirm": true })
    } else {
        json!({})
    };

    let probe = probe_route(
        &base,
        token.as_deref(),
        Method::POST,
        "/daemon/restart",
        Some(&body),
    )
    .await;

    match probe {
        RouteProbe::Json { status: 202, .. } => {
            // Restart accepted
        }
        RouteProbe::Json {
            status: 409,
            body: resp_body,
        } => {
            let api_err: Option<UpdateApiError> = serde_json::from_value(resp_body.clone()).ok();
            let error_code = api_err.as_ref().map(|e| &e.error);
            if error_code == Some(&UpdateApiErrorCode::TauriHosted) {
                eprintln!("Quit and relaunch vibe-station");
                return 1;
            }
            if error_code == Some(&UpdateApiErrorCode::RestartInProgress) {
                eprintln!("A daemon restart is already in progress.");
                return 1;
            }
            if error_code == Some(&UpdateApiErrorCode::RestartBusy) {
                let impacts: Vec<ImpactItem> = api_err.and_then(|e| e.impact).unwrap_or_default();
                print_impact_list(&impacts);

                if let Err(code) = confirm_busy(
                    &mut std::io::stdin().lock(),
                    crate::platform::is_interactive(),
                    yes,
                ) {
                    return code;
                }

                // Re-POST with confirm: true
                let confirm_body = json!({ "confirm": true });
                let p2 = probe_route(
                    &base,
                    token.as_deref(),
                    Method::POST,
                    "/daemon/restart",
                    Some(&confirm_body),
                )
                .await;
                match p2 {
                    RouteProbe::Json { status: 202, .. } => {}
                    RouteProbe::Json { status, body } => {
                        eprintln!(
                            "error: restart refused ({status}): {}",
                            body["error"].as_str().unwrap_or("unknown")
                        );
                        return 1;
                    }
                    _ => {
                        eprintln!("error: lost connection to daemon");
                        return 1;
                    }
                }
            } else {
                eprintln!(
                    "error: restart refused: {}",
                    resp_body["error"].as_str().unwrap_or("unknown")
                );
                return 1;
            }
        }
        RouteProbe::OldDaemon => {
            return fallback_old_daemon(&base, token.as_deref()).await;
        }
        RouteProbe::Unreachable => {
            eprintln!("error: could not reach daemon to restart");
            return 1;
        }
        RouteProbe::Json { status, body } => {
            eprintln!(
                "error: daemon returned status {status}: {}",
                body["error"].as_str().unwrap_or("unknown")
            );
            return 1;
        }
    }

    // Poll until bootId changes
    let start = Instant::now();
    while start.elapsed() < POLL_TIMEOUT {
        tokio::time::sleep(POLL_INTERVAL).await;
        if let Ok(health) = fetch_health(&base).await {
            if health.boot_id != old_boot_id {
                if health.version == initial_health.version {
                    // Check if THIS restart rolled back.
                    let check_probe =
                        probe_route(&base, token.as_deref(), Method::GET, "/update/check", None)
                            .await;
                    if let RouteProbe::Json { status: 200, body } = check_probe {
                        if let Some(lines) =
                            rollback_report(rb_before.as_deref(), &body, &health.version)
                        {
                            eprintln!("{}\n{}", lines[0], lines[1]);
                            eprintln!("Details: ~/.vibe-station/logs/update-watch.log");
                            return 1;
                        }
                    }
                }
                println!("Restarted: v{}", health.version);
                return 0;
            }
        }
    }

    eprintln!("vibe-station didn't come back. Run `vst open` in a terminal.");
    1
}

/// `rolledBack.at` of the current (non-forced, so no GitHub call) update
/// snapshot, or `None` when absent / unreachable / not a 200.
async fn rolled_back_at(base: &str, token: Option<&str>) -> Option<String> {
    match probe_route(base, token, Method::GET, "/update/check", None).await {
        RouteProbe::Json { status: 200, body } => {
            body["rolledBack"]["at"].as_str().map(str::to_owned)
        }
        _ => None,
    }
}

/// The rollback lines when the snapshot's rollback marker is newer than the
/// one seen before this restart (i.e. this restart rolled back), else `None`.
fn rollback_report(
    before_at: Option<&str>,
    after: &serde_json::Value,
    version: &str,
) -> Option<[String; 2]> {
    let rb = after.get("rolledBack")?;
    let at = rb["at"].as_str()?;
    if Some(at) == before_at {
        return None;
    }
    let failed = rb["failedVersion"].as_str()?;
    Some(crate::commands::update::rollback_lines(failed, version))
}

/// Busy confirm: `Restart the daemon now? [Y/n]`. `Err(code)` means
/// stop with that exit code (0 = declined, 1 = no terminal to ask on).
fn confirm_busy<R: BufRead>(reader: &mut R, interactive: bool, yes: bool) -> Result<(), i32> {
    if yes {
        return Ok(());
    }
    if !interactive {
        eprintln!("stdin is not a terminal; re-run with --yes");
        return Err(1);
    }
    if confirm_yes_default(reader, "Restart the daemon now?") {
        Ok(())
    } else {
        eprintln!("Cancelled.");
        Err(0)
    }
}

pub(crate) fn print_impact_list(impacts: &[ImpactItem]) {
    if impacts.is_empty() {
        return;
    }
    eprintln!("Restarting will interrupt:");
    for item in impacts {
        let label = item.name.as_deref().unwrap_or(&item.session_id);
        let detail = match item.kind {
            ImpactKind::Working => "agent is working",
            ImpactKind::Pty => "terminal process is attached",
            ImpactKind::JsonTurn => "request is in flight",
        };
        eprintln!("  - {label} ({detail})");
    }
}

async fn fallback_old_daemon(base: &str, token: Option<&str>) -> i32 {
    // Request stop
    let stop_probe = probe_route(base, token, Method::POST, "/daemon/stop", None).await;
    match stop_probe {
        RouteProbe::Json {
            status: 200..=299, ..
        } => {}
        _ => {
            eprintln!("Failed to request daemon stop");
            return 1;
        }
    }

    // Poll until /health fails
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(10) {
            eprintln!("Stop requested, but the daemon did not exit within 10s");
            return 1;
        }
        if fetch_health(base).await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Spawn headless daemon with current exe
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("cannot resolve current_exe: {e}");
            return 1;
        }
    };

    match spawn_headless_daemon_with_exe(&exe).await {
        Ok((_url, _)) => {
            println!("Browser tabs must reload and sign in again");
            0
        }
        Err(e) => {
            eprintln!("error spawning daemon: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn c(s: &str) -> Cursor<Vec<u8>> {
        Cursor::new(s.as_bytes().to_vec())
    }

    #[test]
    fn rollback_report_cases() {
        let v = "0.0.6-beta";
        let after = json!({"rolledBack":{"failedVersion":"0.0.7-beta","at":"T2"}});
        let l = rollback_report(None, &after, v).expect("fresh rollback");
        assert_eq!(
            l[1],
            "Retry with `vst update`, or skip with `vst update --skip 0.0.7-beta`."
        );
        assert!(rollback_report(Some("T1"), &after, v).is_some());
        assert!(rollback_report(Some("T2"), &after, v).is_none());
        assert!(rollback_report(None, &json!({"rolledBack":null}), v).is_none());
    }

    #[test]
    fn busy_confirm_accepts_y() {
        assert_eq!(confirm_busy(&mut c("y\n"), true, false), Ok(()));
    }

    #[test]
    fn busy_confirm_declined_exits_zero() {
        assert_eq!(confirm_busy(&mut c("n\n"), true, false), Err(0));
    }

    #[test]
    fn busy_confirm_without_tty_exits_one() {
        assert_eq!(confirm_busy(&mut c(""), false, false), Err(1));
    }

    #[test]
    fn busy_confirm_yes_flag_skips_prompt() {
        assert_eq!(confirm_busy(&mut c(""), false, true), Ok(()));
    }
}
