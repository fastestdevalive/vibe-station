//! Self-healing daemon launch (`cli-daemon-unification` Part 03): CUJ1
//! (launch Tauri if there's a display), CUJ2b (headless spawn otherwise, or
//! if Tauri isn't launchable — no prompt). Generalizes `commands/open.rs`'s
//! pre-existing launch-then-poll-then-retry code (previously bespoke to
//! `vst open`) into the shared path every command now uses via `preflight`.
//!
//! Scope note (rev 3, 2026-09-27): an earlier revision of this module also
//! had a CUJ2a interactive "Desktop app or Web UI?" prompt and a lock-probe
//! to distinguish "daemon gone" from "another process racing to start one."
//! Both were cut after a scope review found them disproportionate: the
//! lock-probe saved nothing (a losing racer's spawn just fails and the
//! caller polls regardless, with or without a prior probe), and the prompt's
//! "Desktop app" branch just opened a webpage and gave up without running
//! the user's actual command — worse UX than silently spawning headless.
//!
//! Follow-up fix (2026-09-28): the rev-3 cut went too far — it removed ALL
//! browser/login-URL handling, leaving a freshly-spawned headless daemon
//! with no way for a genuine human (not an agent) to ever reach its web UI.
//! Reinstated, scoped correctly this time:
//! - Display present, Tauri not launchable: a local browser DOES exist —
//!   auto-open it to a continue-flow login URL, same as the old CUJ2a
//!   "Web UI" choice, just without the now-cut prompt (there's nothing left
//!   to choose between once Tauri has already failed).
//! - No display, but stdin is a real TTY (a human at a headless terminal,
//!   e.g. SSH'd into a Linux box): there is no local browser to open into —
//!   PRINT the URL instead, so the human can paste it into a browser
//!   running somewhere else.
//! - No display, not a TTY (an agent, CI, a pipe): print nothing. Nobody is
//!   there to read it, and minting a code nobody redeems just wastes one of
//!   the `OneTimeCodeStore`'s 30s-TTL slots for no reason.
//! Only a **fresh** self-heal spawn does any of this (see `ensure_daemon_reachable_with_exe`) —
//! once the daemon is already reachable, subsequent commands never mint a
//! new code or open/print anything: an already-open browser tab is pushed to
//! the new project via the existing `/open` navigate-replay broadcast
//! (`vst-routes/src/open.rs`), and if no tab is open, revisiting the same
//! base URL just re-authenticates off the still-valid session cookie — no
//! CLI-side intervention needed either way.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::daemon_url::{
    get_daemon_token, get_daemon_url_from_home_and_env, set_self_heal_override,
};
use crate::platform::{has_display, is_interactive};

/// Ceiling for both Tauri-launch and headless-daemon-spawn readiness
/// polling — matches Tauri's own sidecar-spawn timeout
/// (`desktop/src-tauri/src/daemon.rs`'s 30s).
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait to see whether a just-launched Linux process exits
/// immediately (R46) — not used on macOS, which reads `open`'s own exit
/// status instead (see `LaunchOutcome`'s doc comment).
const FAST_EXIT_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightScope {
    Normal,
    Exempt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOutcome {
    Failed,
    Launched,
}

/// Launch the vibe-station desktop app in the background, detached from the
/// CLI. Platform-specific "did it actually launch" semantics (R46):
/// - **macOS**: `open -a vibe-station` is a short-lived Launch-Services shim
///   that hands off and exits almost immediately EVEN ON SUCCESS — its own
///   exit *status* is the real signal (non-zero means the named app couldn't
///   be found/launched at all), not how long the `open` process itself ran.
/// - **Linux**: the actual app binary/AppImage/launcher-symlink is spawned
///   directly (no intermediary) — `Failed` iff that process exits within
///   `FAST_EXIT_WINDOW` of being spawned.
pub async fn launch_app() -> LaunchOutcome {
    if cfg!(target_os = "macos") {
        match tokio::process::Command::new("open")
            .args(["-a", "vibe-station"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
        {
            Ok(status) if status.success() => LaunchOutcome::Launched,
            _ => LaunchOutcome::Failed,
        }
    } else if cfg!(target_os = "linux") {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            "/usr/lib/vibe-station/vibe-station".to_string(),
            "/opt/vibe-station/vibe-station".to_string(),
            format!("{home}/.local/bin/vibe-station"),
        ];
        for bin in &candidates {
            // Found in review: stdin was inherited here, unlike the headless
            // spawn path — a launched GUI app sharing this CLI process's
            // controlling terminal/session could receive a SIGHUP if that
            // terminal closes, unlike the headless daemon (which is fully
            // detached via spawn_detached). Redirect stdin too.
            if let Ok(child) = tokio::process::Command::new(bin)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                if !exited_within(child, FAST_EXIT_WINDOW).await {
                    return LaunchOutcome::Launched;
                }
            }
        }
        if let Ok(app_image) = std::env::var("APPIMAGE") {
            if let Ok(child) = tokio::process::Command::new(&app_image)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                if !exited_within(child, FAST_EXIT_WINDOW).await {
                    return LaunchOutcome::Launched;
                }
            }
        }
        LaunchOutcome::Failed
    } else {
        LaunchOutcome::Failed
    }
}

/// macOS only: was `vibe-station.app` already running BEFORE this self-heal
/// attempt? `open -a` exits 0 both when it starts a fresh instance and when
/// it merely brings an already-running instance to the front (R46 follow-up
/// fix) — those two cases need different handling once we're waiting for a
/// daemon to show up, so this must be checked *before* calling `launch_app`.
async fn is_app_already_running() -> bool {
    if cfg!(target_os = "macos") {
        tokio::process::Command::new("pgrep")
            .args(["-x", "vibe-station"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        false
    }
}

/// macOS only: printed just before falling back to a headless daemon spawn
/// because `vibe-station.app` isn't installed/launchable. The headless path
/// works fine on its own, but on a machine with a display the desktop app is
/// the better-supported experience (native window, tray, no manual browser
/// hop) -- this is a one-line nudge, not a blocker.
fn suggest_desktop_app() {
    if cfg!(target_os = "macos") {
        eprintln!(
            "(no vibe-station.app found -- for a better experience, consider installing the \
             desktop app: https://github.com/fastestdevalive/vibe-station/releases)"
        );
    }
}

/// macOS only: printed when the app was already running but its daemon
/// wasn't found (e.g. it crashed or was stopped independently of the app) --
/// distinct from `suggest_desktop_app`'s "no app installed at all" message.
fn suggest_desktop_app_daemon_gone() {
    if cfg!(target_os = "macos") {
        eprintln!(
            "(vibe-station.app is running but its daemon isn't responding -- falling back to a \
             headless daemon for this command; quitting and reopening the app should restore \
             the normal desktop experience)"
        );
    }
}

/// Poll `child` briefly to see if it exits within `window`. Returns `true`
/// if it exited (regardless of exit code — even a "successful" fast exit
/// means this wasn't a real long-running GUI process).
async fn exited_within(mut child: tokio::process::Child, window: Duration) -> bool {
    tokio::select! {
        _ = child.wait() => true,
        _ = tokio::time::sleep(window) => false,
    }
}

/// Poll `GET /health` on `base_url` until it responds OK or the timeout elapses.
pub async fn poll_for_daemon_at(base_url: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        let client = reqwest::Client::new();
        let ok = client
            .get(format!("{base_url}/health"))
            .timeout(Duration::from_millis(1000))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if ok {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

/// Poll using **config.json only**, deliberately bypassing `VST_DAEMON_URL`
/// (R44) — a self-heal caller with a stale env var must not keep re-checking
/// that same stale value on every poll iteration; it needs to observe the
/// freshly-written `config.json` a just-spawned daemon produces.
async fn poll_config_json_only(timeout: Duration) -> Option<String> {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if let Some(url) = get_daemon_url_from_home_and_env(None, None) {
            if poll_for_daemon_at(&url, Duration::from_millis(1000)).await {
                return Some(url);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

/// Poll the daemon URL derived from the environment/config (kept for
/// backward compat with `vst open`'s own pre-self-heal retry path, which
/// intentionally still honors `VST_DAEMON_URL` for its own direct retry).
pub async fn poll_for_daemon(timeout: Duration) -> bool {
    match crate::daemon_url::get_daemon_url() {
        Some(url) => poll_for_daemon_at(&url, timeout).await,
        None => false,
    }
}

/// Env vars stripped from a headless daemon spawn's environment — all
/// session-scoped identity belonging to whichever agent/session triggered
/// this self-heal, none of which makes sense for a freshly-spawned daemon.
const STRIPPED_ENV_VARS: &[&str] = &[
    "VST_SESSION",
    "VST_SPAWN_TOKEN",
    "VST_PROJECT",
    "VST_WORKTREE",
    "VST_DATA_DIR",
    "VST_DAEMON_URL",
];

fn stripped_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    for key in STRIPPED_ENV_VARS {
        env.remove(*key);
    }
    env
}

/// Best-effort read of `config.json`'s own `pid` field — used only to tell
/// "our spawn won the flock race" apart from "some other, already-running
/// daemon simply answered" (see `spawn_headless_daemon_with_exe`'s doc
/// comment). Returns `None` on any read/parse failure, which callers treat
/// as "can't confirm we won" rather than an error.
fn config_json_pid(home: &Path) -> Option<u32> {
    let config_path = home.join(".vibe-station").join("config.json");
    let content = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32)
}

/// Spawn a headless daemon (CUJ2b, or CUJ1's fallback when Tauri isn't
/// launchable), detached from this CLI process, and poll until it's ready or
/// `READY_TIMEOUT` elapses. Returns the URL it became reachable on, plus
/// whether THIS spawn is the one that actually won (vs. some other,
/// already-running daemon that was just slow to answer `/health` — see
/// `preflight.rs`'s 3s timeout, which can misfire on a merely-slow daemon and
/// trigger a spawn that then loses the flock race pointlessly). Resolves its
/// own exe via `current_exe()` — see `spawn_headless_daemon_with_exe` for the
/// testable, exe-injectable core this wraps.
pub async fn spawn_headless_daemon() -> Result<(String, bool), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve current_exe: {e}"))?;
    spawn_headless_daemon_with_exe(&exe).await
}

/// Testable core of `spawn_headless_daemon` — `exe` is injected so
/// integration tests can substitute `env!("CARGO_BIN_EXE_vst")` (the actual
/// compiled test binary under `cargo test` is the test harness, not `vst`).
pub async fn spawn_headless_daemon_with_exe(
    exe: &std::path::Path,
) -> Result<(String, bool), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let home_path = PathBuf::from(&home);
    // Found in review: this used to hardcode `~/.vibe-station/daemon.log`,
    // silently diverging from the existing `daemon_log_path()` helper's real
    // `~/.vibe-station/logs/daemon.log` (which is what the README/other docs
    // actually point people at) -- reuse the real one instead of a second,
    // slightly-wrong path.
    let log_path = crate::paths::daemon_log_path_from_home(Some(&home_path));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let our_pid = vst_proc::spawn_detached(
        exe,
        &["daemon", "run"],
        &home_path,
        &stripped_env(),
        &log_path,
    )
    .map_err(|e| format!("failed to spawn headless daemon: {e}"))?;

    // No lock-probe check needed here (cut in rev 3): if a concurrent
    // self-heal elsewhere wins the flock race first, THIS spawn's own child
    // just exits immediately with "already running" -- irrelevant to us,
    // since we poll config.json/​/health regardless of that child's own exit
    // status, and whichever daemon actually wins becomes reachable either way.
    let url = poll_config_json_only(READY_TIMEOUT)
        .await
        .ok_or_else(|| "headless daemon did not become ready within 30s".to_string())?;
    let we_won = config_json_pid(&home_path) == Some(our_pid);
    Ok((url, we_won))
}

/// The self-healing orchestrator. Called by `preflight::preflight_scoped`
/// when the daemon is unreachable for a non-exempt command. Resolves its own
/// exe via `current_exe()` — see `ensure_daemon_reachable_with_exe` for the
/// testable, exe-injectable core this wraps.
pub async fn ensure_daemon_reachable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve current_exe: {e}"))?;
    ensure_daemon_reachable_with_exe(&exe).await
}

/// Testable core of `ensure_daemon_reachable` — `exe` is injected so
/// integration tests can substitute `env!("CARGO_BIN_EXE_vst")`.
pub async fn ensure_daemon_reachable_with_exe(exe: &std::path::Path) -> Result<(), String> {
    let display_present = has_display();

    if display_present {
        let already_running = is_app_already_running().await;
        match launch_app().await {
            LaunchOutcome::Launched => {
                if let Some(url) = poll_config_json_only(READY_TIMEOUT).await {
                    set_self_heal_override(url);
                    return Ok(());
                }
                // Found in review: on macOS, `open -a vibe-station` exits 0
                // both when it starts a fresh instance AND when it merely
                // brings an already-running instance to the front — the app
                // only ever detects-or-spawns its own daemon once, at its own
                // startup (`desktop/src-tauri/src/main.rs`), so if the app was
                // ALREADY running before this call and its daemon died/was
                // stopped since, re-focusing that same still-running app will
                // never make a daemon appear no matter how long we wait.
                // Decision 7's "never fall back to headless once Launched" is
                // only correct for the FRESH-launch case (a Tauri that might
                // still be slowly booting) — fall back to headless here
                // instead of waiting out the full timeout and leaving the
                // user stuck with no recovery but manually reopening the app.
                if already_running {
                    suggest_desktop_app_daemon_gone();
                } else {
                    return Err(
                        "vibe-station app launched but the daemon never became ready within 30s"
                            .to_string(),
                    );
                }
            }
            LaunchOutcome::Failed => {
                // Not installed / not launchable -- fall through to headless.
                suggest_desktop_app();
            }
        }
    }

    // No prompt: spawn headless directly, then present a login URL if (and
    // only if) there's a human who'd otherwise have no way to reach it --
    // see this module's doc comment for the three-way display/TTY split.
    let (url, we_won) = spawn_headless_daemon_with_exe(exe).await?;
    set_self_heal_override(url.clone());

    // Found in review: `preflight.rs`'s 3s `/health` timeout can misfire on a
    // merely-slow (not actually gone) daemon, triggering a spawn here that
    // then loses the flock race to that original, still-alive daemon. Only
    // present a login URL when THIS spawn is the one config.json now
    // actually records as running — presenting a fresh login link against a
    // daemon we didn't spawn (and that was reachable the whole time) is at
    // best pointless and at worst a spurious browser tab / stderr code for no
    // reason.
    if we_won {
        if display_present {
            // A local browser exists (Tauri just wasn't launchable) -- open it.
            present_login_url(&url, true).await;
        } else if is_interactive() {
            // No local browser, but a human is at this terminal -- print it.
            present_login_url(&url, false).await;
        }
        // else: no display, not a TTY (agent/CI/pipe) -- present nothing.
    }

    Ok(())
}

/// Mint a continue-flow code against the just-spawned daemon and either open
/// it in a local browser (`open_locally: true`) or print it to stderr
/// (`false`) for a human to paste into a browser elsewhere. Best-effort:
/// mint/open failures are logged to stderr, never fatal to the original
/// command that triggered self-heal in the first place.
async fn present_login_url(base_url: &str, open_locally: bool) {
    let Some(token) = get_daemon_token() else {
        eprintln!("(warning: could not read cliToken to mint a login link)");
        return;
    };
    let client = reqwest::Client::new();
    let resp = match client
        .post(format!("{base_url}/api/auth/continue/mint"))
        .bearer_auth(&token)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("(warning: failed to mint a login link: {e})");
            return;
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            eprintln!("(warning: invalid mint response: {e})");
            return;
        }
    };
    let Some(code) = json.get("code").and_then(|c| c.as_str()) else {
        eprintln!("(warning: mint response missing code)");
        return;
    };
    let login_url = format!("{base_url}/continue?code={code}");

    if open_locally {
        open_url(&login_url);
        eprintln!("Opened {login_url} in your browser to log in.");
    } else {
        eprintln!("Open this URL in a browser to log in (expires in 30s):");
        eprintln!("  {login_url}");
        if base_url.contains("127.0.0.1") {
            eprintln!(
                "  (this daemon is on a headless machine -- if you're viewing this over SSH, \
                 replace 127.0.0.1 with this machine's real hostname/IP, or forward the port, \
                 e.g. `ssh -L <port>:localhost:<port> ...` -- if that takes longer than 30s and \
                 this link expires before you can use it, re-running this command won't mint a \
                 new one since the daemon is now up; instead mint a fresh link with \
                 `curl -X POST -H \"Authorization: Bearer <cliToken from \
                 ~/.vibe-station/config.json>\" <daemon url>/api/auth/continue/mint` and open \
                 `/continue?code=<code>`)"
            );
        }
    }
}

/// Open `url` in the default browser — same shell-out pattern `launch_app`
/// already establishes (no URL-opener crate exists in this workspace).
/// Best-effort: a failure here just means the URL printed above (or logged
/// on failure) is the fallback.
fn open_url(url: &str) {
    if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    } else if cfg!(target_os = "linux") {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}
