//! `vst update` install flow: summary, confirm prompt, daemon-driven
//! install with progress polling, the daemon-less fallback, and
//! `--skip` / `--unskip`.
//!
//! Exit codes: 0 done / cancelled at the prompt / install continues in the
//! background, 1 any error, 130 interrupted (Ctrl-C) during download.

use std::io::BufRead;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};
use vst_daemon::update::{assets_for, parse_version as parse, platform_key, CancelToken};
use vst_types::rest::update::{
    InstallResult, InstallStage, UpdateApiError, UpdateApiErrorCode, UpdateCheckResponse,
    UpdateError, UpdateStatus,
};

use crate::client::{probe_route, RouteProbe};
use crate::commands::update::{
    probe_daemon, DaemonConn, DaemonProbe, Fallback, EXIT_ERROR, EXIT_UP_TO_DATE,
};
use crate::confirm::confirm_by_typing_name_with_reader;
use crate::platform::is_interactive;

pub const EXIT_INTERRUPTED: i32 = 130;
/// Exit code after the user declines the prompt (not an error).
pub const EXIT_CANCELLED: i32 = 0;
const CONFIRM_WORD: &str = "confirm";
const MAX_CHANGELOG_LINES: usize = 20;
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Ask the user to type `confirm`. `Err("Cancelled.")` for anything else.
pub(crate) fn prompt_install<R: BufRead>(reader: &mut R) -> Result<(), String> {
    confirm_by_typing_name_with_reader(reader, CONFIRM_WORD, "Install this update?")
}

fn method_label(s: &UpdateStatus, i: usize) -> String {
    serde_json::to_value(&s.targets[i].method)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Print the update summary (current to latest, changelog, targets).
pub(crate) fn print_summary(s: &UpdateStatus) {
    let latest = s.latest.as_deref().unwrap_or("?");
    println!("vibe-station v{} → v{latest}", s.current);
    if let Some(body) = &s.changelog {
        let lines: Vec<&str> = body.lines().collect();
        for l in lines.iter().take(MAX_CHANGELOG_LINES) {
            println!("  {l}");
        }
        if lines.len() > MAX_CHANGELOG_LINES {
            println!("  …");
        }
    }
    if let Some(url) = &s.release_url {
        println!("Release notes: {url}");
    }
    if s.targets.is_empty() {
        println!("Installs found: none");
    } else {
        println!("Will update:");
        for (i, t) in s.targets.iter().enumerate() {
            let note = if t.auto { "" } else { " — update manually" };
            let ver = t
                .version
                .as_deref()
                .map(|v| format!(" {v}"))
                .unwrap_or_default();
            println!("  - {} ({}){ver}{note}", t.path, method_label(s, i));
        }
    }
}

fn stage_line(stage: &InstallStage, asset: &str) -> String {
    match stage {
        InstallStage::Preflight => "Checking prerequisites…".to_string(),
        InstallStage::Downloading => format!("Downloading {asset}…"),
        InstallStage::Verifying => "Verifying checksum…".to_string(),
        InstallStage::Installing => "Installing…".to_string(),
    }
}

/// The release asset the first auto target downloads, falling back to
/// the version when the platform has no matching asset.
fn download_asset(s: &UpdateStatus) -> String {
    download_asset_for(s, platform_key())
}

fn download_asset_for(s: &UpdateStatus, platform: &str) -> String {
    use vst_types::rest::update::InstallMethod as M;
    let assets = assets_for(platform);
    s.targets
        .iter()
        .find(|t| t.auto)
        .and_then(|t| match t.method {
            M::Curl => assets.cli,
            M::CurlAppImage | M::AppImage => assets.appimage,
            M::Deb => assets.deb,
            _ => None,
        })
        .map(str::to_string)
        .unwrap_or_else(|| format!("v{}", s.latest.as_deref().unwrap_or("?")))
}

const STAGES: [InstallStage; 4] = [
    InstallStage::Preflight,
    InstallStage::Downloading,
    InstallStage::Verifying,
    InstallStage::Installing,
];

/// Stages to print when the 500 ms poll moves from `last` to `now`: every
/// stage after `last` up to `now`, so a stage that finished between two polls
/// (a fast download) still gets its line.
fn stages_between(last: Option<&InstallStage>, now: &InstallStage) -> Vec<InstallStage> {
    let idx = |s: &InstallStage| STAGES.iter().position(|x| x == s).unwrap_or(0);
    let from = last.map_or(0, |l| idx(l) + 1);
    let to = idx(now);
    if from > to {
        return Vec::new();
    }
    STAGES[from..=to].to_vec()
}

/// Reasons where the downloaded artifact failed verification.
fn is_verification_failure(r: &vst_types::rest::update::UpdateReason) -> bool {
    use vst_types::rest::update::UpdateReason as R;
    matches!(
        r,
        R::MissingChecksum
            | R::MissingSignature
            | R::BadSignature
            | R::Downgrade
            | R::ChecksumMismatch
            | R::SmokeFailed
    )
}

fn error_lines(e: &UpdateError, current: &str) -> Vec<String> {
    if is_verification_failure(&e.reason) {
        vec![
            "error: Download failed verification. Nothing was changed.".to_string(),
            format!("  ({})", e.message),
            format!("Your current version (v{current}) is unchanged."),
        ]
    } else if matches!(
        e.reason,
        vst_types::rest::update::UpdateReason::Offline
            | vst_types::rest::update::UpdateReason::GithubError
    ) {
        vec![
            "error: Couldn't reach GitHub.".to_string(),
            format!("  ({})", e.message),
            "Check your internet connection and try again.".to_string(),
        ]
    } else {
        vec![format!("error: {}", e.message)]
    }
}

fn print_error(e: &UpdateError, current: &str) {
    for l in error_lines(e, current) {
        eprintln!("{l}");
    }
}

fn open_browser_url(url: &str) {
    if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    } else if cfg!(target_os = "linux") {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

fn print_done(r: &InstallResult, hint_reload: bool) {
    if !r.updated.is_empty() {
        println!("Updated to v{}:", r.version);
        for p in &r.updated {
            println!("  - {p}");
        }
    }

    if let Some(deb_path) = &r.deb_path {
        println!("Downloaded and verified {deb_path}");
    }

    let dmg_step = r.manual.iter().find(|m| {
        m.kind == vst_types::rest::update::ManualStepKind::OpenUrl
            && m.url.as_ref().is_some_and(|u| u.ends_with(".dmg"))
    });

    if let Some(step) = dmg_step {
        if let Some(url) = &step.url {
            if crate::platform::has_display() {
                println!("Opening {url} in your browser…");
                open_browser_url(url);
            } else {
                println!("Opening {url} in your browser…");
            }
            println!("  To finish the update:");
        }
    }

    for m in &r.manual {
        if m.kind == vst_types::rest::update::ManualStepKind::OpenUrl {
            if m.url.as_ref().is_some_and(|u| u.ends_with(".dmg")) {
                continue;
            }
            println!("  {}", m.text);
        } else if m.kind == vst_types::rest::update::ManualStepKind::Command {
            println!("To finish: {}", m.text);
        } else {
            println!("  {}", m.text);
        }
    }

    if hint_reload && !r.updated.is_empty() {
        println!("Reload open vibe-station tabs to pick up the new UI.");
    }
}

/// Shared by both backends: bail out when there is nothing to do, else print
/// the summary and confirm. `Some(code)` means stop with that exit code.
fn gate(s: &UpdateStatus, yes: bool) -> Option<i32> {
    if !s.update_available {
        if let Some(v) = crate::commands::update::rolled_back_retry(s) {
            // A rolled-back version is hidden from `updateAvailable`; the CLI is the Retry path.
            println!(
                "v{v} failed to start last time \u{2014} rolled back to v{}. Retrying the install.",
                s.current
            );
        } else {
            if let Some(e) = &s.last_error {
                print_error(e, &s.current);
                return Some(EXIT_ERROR);
            }
            println!("vibe-station v{} is already the latest version.", s.current);
            return Some(EXIT_UP_TO_DATE);
        }
    }
    let has_auto = s.targets.iter().any(|t| t.auto);
    let has_supported_manual = s.targets.iter().any(|t| {
        matches!(
            t.method,
            vst_types::rest::update::InstallMethod::Dmg
                | vst_types::rest::update::InstallMethod::Deb
        )
    });
    if !has_auto && !has_supported_manual {
        eprintln!("error: no automatically updatable install found; update manually");
        return Some(EXIT_ERROR);
    }
    print_summary(s);
    // Anything that downloads or replaces needs explicit consent. A
    // dmg-only target merely opens a URL, so it stays prompt-free; a `.deb`
    // is downloaded into ~/Downloads and so is gated like an auto install.
    let has_deb = s
        .targets
        .iter()
        .any(|t| matches!(t.method, vst_types::rest::update::InstallMethod::Deb));
    if !has_auto && !has_deb {
        return None;
    }
    if yes {
        return None;
    }
    if !is_interactive() {
        eprintln!("stdin is not a terminal; re-run with --yes");
        return Some(EXIT_ERROR);
    }
    match prompt_install(&mut std::io::stdin().lock()) {
        Ok(()) => None,
        Err(msg) => {
            println!("{msg}");
            Some(EXIT_CANCELLED)
        }
    }
}

pub async fn run_install_flow(yes: bool) -> i32 {
    match probe_daemon(true).await {
        DaemonProbe::Ready(conn, resp) => daemon_install(&conn, *resp, yes).await,
        DaemonProbe::Old => {
            println!("Daemon is too old for in-app updates; updating directly.");
            fallback_install(yes).await
        }
        DaemonProbe::Unauthorized => {
            eprintln!("error: {}", crate::commands::update::UNAUTHORIZED_MSG);
            EXIT_ERROR
        }
        DaemonProbe::Absent => fallback_install(yes).await,
    }
}

// ---- daemon path ----------------------------------------------------------

async fn post(conn: &DaemonConn, path: &str, body: &Value) -> RouteProbe {
    probe_route(
        &conn.url,
        conn.token.as_deref(),
        Method::POST,
        path,
        Some(body),
    )
    .await
}

async fn daemon_install(conn: &DaemonConn, resp: UpdateCheckResponse, yes: bool) -> i32 {
    let status = resp.status;
    if let Some(code) = gate(&status, yes) {
        return code;
    }
    if !resp.can_install {
        eprintln!("error: this token is not allowed to install updates");
        return EXIT_ERROR;
    }
    let asset = download_asset(&status);
    let current = status.current.clone();
    match post(conn, "/update/install", &json!({})).await {
        RouteProbe::Json {
            status: 202 | 200, ..
        } => {}
        RouteProbe::Json { status: 409, body } => {
            let who = match body["startedBy"].as_str() {
                Some("ui") => "the web UI",
                _ => "another vst command",
            };
            eprintln!("error: An update is already running (started from {who})");
            return EXIT_ERROR;
        }
        RouteProbe::Json { status: 422, body } => {
            eprintln!(
                "error: cannot install: {}",
                body["error"].as_str().unwrap_or("unknown")
            );
            return EXIT_ERROR;
        }
        RouteProbe::Json { status, .. } => {
            eprintln!("error: daemon rejected the install request (HTTP {status})");
            return EXIT_ERROR;
        }
        RouteProbe::OldDaemon | RouteProbe::Unreachable => {
            eprintln!("error: could not reach the daemon to start the install");
            return EXIT_ERROR;
        }
    }
    let last_stage: Arc<Mutex<Option<InstallStage>>> = Arc::new(Mutex::new(None));
    let poll = poll_install(conn, &asset, &current, last_stage.clone(), yes);
    tokio::select! {
        code = poll => code,
        _ = tokio::signal::ctrl_c() => {
            let stage = last_stage.lock().unwrap().clone();
            if stage == Some(InstallStage::Downloading) {
                let _ = post(conn, "/update/cancel", &json!({})).await;
                eprintln!("Cancelled.");
                EXIT_INTERRUPTED
            } else {
                println!("Install continues in the background — see Settings > Updates");
                0
            }
        }
    }
}

/// Poll the snapshot, print one line per stage change, return the exit code.
async fn poll_install(
    conn: &DaemonConn,
    asset: &str,
    current: &str,
    last_stage: Arc<Mutex<Option<InstallStage>>>,
    yes: bool,
) -> i32 {
    loop {
        let snap = match probe_route(
            &conn.url,
            conn.token.as_deref(),
            Method::GET,
            "/update/check",
            None,
        )
        .await
        {
            RouteProbe::Json { status: 200, body } => {
                match serde_json::from_value::<UpdateCheckResponse>(body) {
                    Ok(r) => r.status,
                    Err(e) => {
                        eprintln!("error: unreadable update status from the daemon: {e}");
                        return EXIT_ERROR;
                    }
                }
            }
            _ => {
                eprintln!("error: lost contact with the daemon while installing");
                return EXIT_ERROR;
            }
        };
        if let Some(p) = &snap.install {
            let mut last = last_stage.lock().unwrap();
            if last.as_ref() != Some(&p.stage) {
                for st in stages_between(last.as_ref(), &p.stage) {
                    println!("{}", stage_line(&st, asset));
                }
                *last = Some(p.stage.clone());
            }
        } else if let Some(e) = snap
            .last_error
            .as_ref()
            .filter(|e| e.kind == vst_types::rest::update::UpdateErrorKind::Install)
        {
            print_error(e, current);
            return EXIT_ERROR;
        } else if let Some(r) = &snap.last_result {
            // The poll can miss the (short) installing stage: flush the
            // stages that finished since the last printed one.
            if !r.updated.is_empty() {
                let mut last = last_stage.lock().unwrap();
                for st in stages_between(last.as_ref(), &InstallStage::Installing) {
                    println!("{}", stage_line(&st, asset));
                }
                *last = Some(InstallStage::Installing);
            }
            print_done(r, false);
            if snap.restart_pending.is_some() {
                return handle_daemon_restart(conn, yes).await;
            }
            return 0;
        } else {
            eprintln!("error: install ended without a result (cancelled?)");
            return EXIT_ERROR;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn handle_daemon_restart(conn: &DaemonConn, yes: bool) -> i32 {
    let dry_run_probe = post(conn, "/daemon/restart", &json!({ "dryRun": true })).await;
    match dry_run_probe {
        RouteProbe::Json { status: 409, body }
            if serde_json::from_value::<UpdateApiError>(body.clone())
                .is_ok_and(|e| e.error == UpdateApiErrorCode::TauriHosted) =>
        {
            eprintln!("Quit and relaunch vibe-station");
            return 0;
        }
        RouteProbe::Json { status: 200, body } => {
            let impacts: Vec<vst_types::rest::update::ImpactItem> = body
                .get("impact")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            if !impacts.is_empty() {
                crate::commands::daemon::restart::print_impact_list(&impacts);
            }

            if yes {
                if impacts.is_empty() {
                    return crate::commands::daemon::restart::run_restart(true, false).await;
                } else {
                    println!("Restart the daemon to finish: vst daemon restart");
                    return 0;
                }
            }

            if restart_prompt(&mut std::io::stdin().lock()) {
                let impact_seen = !impacts.is_empty();
                return crate::commands::daemon::restart::run_restart(false, impact_seen).await;
            }
            println!("Restart the daemon later: vst daemon restart");
            0
        }
        _ => {
            println!("Restart the daemon to finish: vst daemon restart");
            0
        }
    }
}

/// `Restart the daemon now? [Y/n]`; EOF (Ctrl-D / closed stdin) is "no", like
/// every other prompt (`confirm::confirm_yes_default`).
fn restart_prompt<R: BufRead>(reader: &mut R) -> bool {
    crate::confirm::confirm_yes_default(reader, "Restart the daemon now?")
}

// ---- fallback path --------------------------------------------------

async fn fallback_install(yes: bool) -> i32 {
    let fb = match Fallback::open() {
        Ok(fb) => fb,
        Err(msg) => {
            eprintln!("error: {msg}");
            return EXIT_ERROR;
        }
    };
    let status = fb.service.check(true).await;
    if let Some(code) = gate(&status, yes) {
        return code;
    }
    let latest = status.latest.clone().unwrap_or_default();
    let asset = download_asset(&status);
    let current = status.current.clone();
    let last: Arc<Mutex<Option<InstallStage>>> = Arc::new(Mutex::new(None));
    let last_for_progress = last.clone();
    let progress = move |stage: InstallStage, _pct: u8| {
        let mut l = last_for_progress.lock().unwrap();
        if l.as_ref() != Some(&stage) {
            println!("{}", stage_line(&stage, &asset));
            *l = Some(stage);
        }
    };
    let cancel = Arc::new(CancelToken::new());
    // Ctrl-C during the download cancels (the install future then
    // returns `Cancelled`, exit 130). Past the download the process cannot
    // detach, so further Ctrl-C is ignored until the replace step finishes
    // and the install future is awaited to completion either way.
    let install = fb.service.install_foreground(&progress, cancel.clone());
    tokio::pin!(install);
    let mut interrupted = false;
    let outcome = loop {
        tokio::select! {
            r = &mut install => break r,
            _ = tokio::signal::ctrl_c() => {
                let stage = last.lock().unwrap().clone();
                if stage == Some(InstallStage::Downloading) {
                    interrupted = true;
                    cancel.cancel();
                }
            }
        }
    };
    match outcome {
        Ok(result) => {
            print_done(&result, true);
            if !result.updated.is_empty() {
                println!("The next `vst open` starts v{latest}.");
            }
            0
        }
        Err(_) if interrupted => {
            eprintln!("Cancelled.");
            EXIT_INTERRUPTED
        }
        Err(e) => {
            print_error(&e, &current);
            EXIT_ERROR
        }
    }
}

// ---- --skip / --unskip ----------------------------------------------------

pub async fn run_skip(version: &str, skip: bool) -> i32 {
    let v = version.trim().trim_start_matches('v').to_string();
    if parse(&v).is_none() {
        eprintln!("error: invalid version: {version}");
        return EXIT_ERROR;
    }
    let route = if skip {
        "/update/skip"
    } else {
        "/update/unskip"
    };
    let verb = if skip {
        "Skipped"
    } else {
        "No longer skipping"
    };
    let probe = probe_daemon(false).await;
    if matches!(probe, DaemonProbe::Unauthorized) {
        eprintln!("error: {}", crate::commands::update::UNAUTHORIZED_MSG);
        return EXIT_ERROR;
    }
    if let DaemonProbe::Ready(conn, _) = probe {
        return match post(&conn, route, &json!({ "version": v })).await {
            RouteProbe::Json { status: 200, .. } => {
                println!("{verb} v{v}.");
                0
            }
            RouteProbe::Json { status, body } => {
                eprintln!(
                    "error: daemon refused ({status}): {}",
                    body["error"].as_str().unwrap_or("unknown")
                );
                EXIT_ERROR
            }
            _ => {
                eprintln!("error: could not reach the daemon");
                EXIT_ERROR
            }
        };
    }
    let fb = match Fallback::open() {
        Ok(fb) => fb,
        Err(msg) => {
            eprintln!("error: {msg}");
            return EXIT_ERROR;
        }
    };
    if skip {
        fb.service.skip(&v).await;
    } else {
        fb.service.unskip(&v).await;
    }
    println!("{verb} v{v}.");
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn restart_prompt_treats_eof_as_later_and_empty_as_yes() {
        assert!(!super::restart_prompt(&mut std::io::Cursor::new("")));
        assert!(super::restart_prompt(&mut std::io::Cursor::new("\n")));
        assert!(!super::restart_prompt(&mut std::io::Cursor::new("n\n")));
    }

    use super::*;
    use std::io::Cursor;

    #[test]
    fn prompt_declines_anything_but_confirm() {
        let mut r = Cursor::new(b"nope\n".to_vec());
        assert_eq!(prompt_install(&mut r), Err("Cancelled.".to_string()));
        assert_eq!(EXIT_CANCELLED, 0, "declining is not an error");
    }

    #[test]
    fn skipped_stages_are_still_printed() {
        use InstallStage::*;
        assert_eq!(stages_between(None, &Preflight), vec![Preflight]);
        assert_eq!(
            stages_between(Some(&Preflight), &Verifying),
            vec![Downloading, Verifying]
        );
        assert_eq!(stages_between(Some(&Verifying), &Verifying), vec![]);
    }

    fn target(
        method: vst_types::rest::update::InstallMethod,
        auto: bool,
    ) -> vst_types::rest::update::UpdateTarget {
        vst_types::rest::update::UpdateTarget {
            method,
            path: "/x/vst".into(),
            version: None,
            auto,
        }
    }

    fn status_with(targets: Vec<vst_types::rest::update::UpdateTarget>) -> UpdateStatus {
        let mut s: UpdateStatus = serde_json::from_value(json!({
            "current": "0.0.3-beta", "latest": "0.0.4-beta", "updateAvailable": true,
            "behindCount": 1, "targets": [], "skipped": [], "noAsset": false,
            "installMethod": "curl", "autoCheck": true, "platform": "linux-aarch64"
        }))
        .expect("status fixture");
        s.targets = targets;
        s
    }

    #[test]
    fn download_line_names_the_asset_without_step_prefix() {
        use vst_types::rest::update::InstallMethod;
        let s = status_with(vec![target(InstallMethod::Curl, true)]);
        let asset = download_asset_for(&s, "linux-aarch64");
        let line = stage_line(&InstallStage::Downloading, &asset);
        assert!(
            line.contains("vst-aarch64-unknown-linux-musl.tar.gz"),
            "{line}"
        );
        for st in STAGES {
            assert!(!stage_line(&st, &asset).starts_with('['));
        }
        assert_eq!(
            download_asset_for(&status_with(vec![]), "linux-aarch64"),
            "v0.0.4-beta"
        );
    }

    #[test]
    fn verification_errors_say_nothing_changed() {
        use vst_types::rest::update::{UpdateErrorKind, UpdateReason};
        let e = UpdateError {
            kind: UpdateErrorKind::Install,
            reason: UpdateReason::BadSignature,
            message: "SHA256SUMS signature check failed: signature does not match the release key"
                .into(),
            retry_after: None,
        };
        let out = error_lines(&e, "0.0.3-beta").join("\n");
        assert!(out.contains("Download failed verification. Nothing was changed."));
        assert!(out.contains("Your current version (v0.0.3-beta) is unchanged."));
        assert!(!out.contains("BadSignature"));
        let other = UpdateError {
            reason: UpdateReason::Offline,
            message: "offline".into(),
            ..e
        };
        assert_eq!(
            error_lines(&other, "0.0.3-beta"),
            vec![
                "error: Couldn't reach GitHub.".to_string(),
                "  (offline)".to_string(),
                "Check your internet connection and try again.".to_string()
            ]
        );
        let gh = UpdateError {
            reason: UpdateReason::GithubError,
            message: "SHA256SUMS.minisig returned HTTP 500".into(),
            ..other
        };
        let out = error_lines(&gh, "0.0.3-beta").join("\n");
        assert!(out.contains("Couldn't reach GitHub."), "{out}");
        assert!(
            out.contains("SHA256SUMS.minisig returned HTTP 500"),
            "{out}"
        );
        assert!(!out.contains("failed verification"), "{out}");
    }

    #[test]
    fn gate_proceeds_for_a_rolled_back_latest() {
        use vst_types::rest::update::InstallMethod;
        let mut s = status_with(vec![target(InstallMethod::Curl, true)]);
        s.update_available = false;
        s.rolled_back = Some(vst_types::rest::update::RolledBack {
            failed_version: "0.0.4-beta".into(),
            at: "2026-10-26T00:00:00Z".into(),
        });
        assert_eq!(gate(&s, true), None, "retry proceeds to the install");
        s.rolled_back = None;
        assert_eq!(gate(&s, true), Some(EXIT_UP_TO_DATE));
    }

    #[test]
    fn prompt_accepts_confirm() {
        let mut r = Cursor::new(b"confirm\n".to_vec());
        assert_eq!(prompt_install(&mut r), Ok(()));
    }
}
