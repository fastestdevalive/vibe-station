use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Information about a running daemon instance.
#[derive(Debug, Clone)]
pub struct DaemonInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

/// Shape of ~/.vibe-station/config.json written by the daemon on startup.
#[derive(Debug, Deserialize)]
struct DaemonConfig {
    port: u16,
    pid: u32,
    /// Pre-minted scope:tauri token (written by the daemon since auth-redesign).
    /// Falls back to cli_token, then the legacy `token` field for older daemons.
    #[serde(rename = "tauriToken", default)]
    tauri_token: Option<String>,
    /// Pre-minted scope:cli token. Written to config so the CLI can read it.
    #[serde(rename = "cliToken", default)]
    cli_token: Option<String>,
    /// Legacy field: raw daemonToken written by pre-auth-redesign daemons.
    /// Used as last-resort fallback so the Tauri shell can still auto-login
    /// against an older daemon without showing the login screen.
    #[serde(default)]
    token: Option<String>,
}

/// Path to the daemon's config file.
fn config_path() -> Option<std::path::PathBuf> {
    dirs_next::home_dir().map(|h| h.join(".vibe-station").join("config.json"))
}

/// Read the daemon config from `~/.vibe-station/config.json`.
fn read_config() -> Option<DaemonConfig> {
    let text = fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// Check if a process with `pid` is alive using kill(pid, 0).
/// Returns true if the process exists.
fn is_pid_alive(pid: u32) -> bool {
    // Safety: signal 0 just checks existence, never kills.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Detect a running daemon by reading config.json and checking if the pid is alive.
/// Returns Some(DaemonInfo) if a live daemon is found, None otherwise.
pub fn detect_running_daemon() -> Option<DaemonInfo> {
    let config = read_config()?;
    if is_pid_alive(config.pid) {
        // Prefer the tauri-scoped token; fall back to cli token, then legacy token.
        let token = config.tauri_token
            .or(config.cli_token)
            .or(config.token)
            .unwrap_or_default();
        Some(DaemonInfo {
            port: config.port,
            pid: config.pid,
            token,
        })
    } else {
        None
    }
}

/// Spawn the bundled vst-daemon sidecar and wait for it to be ready.
/// Returns DaemonInfo once the daemon is listening.
///
/// `cloudflared_bin` — absolute path to the bundled cloudflared binary.
/// `vst_bin` — absolute path to the bundled vst CLI binary.
/// `skill_path` — absolute path to the bundled SKILL.md resource.
pub fn spawn_daemon(
    app_handle: &tauri::AppHandle,
    cloudflared_bin: &Path,
    vst_bin: &Path,
    skill_path: &Path,
) -> Result<DaemonInfo, String> {
    use tauri_plugin_shell::ShellExt;
    use tauri_plugin_shell::process::CommandEvent;

    // Record the pid that was running BEFORE we spawn so we can tell when
    // config.json has been refreshed with a new pid.
    // NOTE: we deliberately do NOT delete config.json — it may contain the
    // user's persisted settings (defaultProjectsDir, auth token, etc.)
    let old_pid: Option<u32> = read_config().map(|c| c.pid);

    let cloudflared_str = cloudflared_bin
        .to_str()
        .ok_or("cloudflared path is not valid UTF-8")?;
    let vst_bin_str = vst_bin
        .to_str()
        .ok_or("vst_bin path is not valid UTF-8")?;
    let skill_path_str = skill_path
        .to_str()
        .ok_or("skill_path is not valid UTF-8")?;

    // The bundled vst-daemon binary is the daemon entrypoint itself —
    // it starts listening immediately on launch without any subcommand args.
    let (mut rx, _child) = app_handle
        .shell()
        .sidecar("vst-daemon")
        .map_err(|e| format!("failed to create sidecar command: {e}"))?
        .env("VST_CLOUDFLARED_BIN", cloudflared_str)
        .env("VST_CLI_BIN", vst_bin_str)
        .env("VST_SKILL_PATH", skill_path_str)
        .spawn()
        .map_err(|e| format!("failed to spawn vst-daemon sidecar: {e}"))?;

    // Poll stdout/stderr for the ready signal.
    let ready_pattern =
        regex::Regex::new(r"listening on http://127\.0\.0\.1:(\d+)").expect("valid regex");

    let start = Instant::now();
    let timeout = Duration::from_secs(30);

    loop {
        if start.elapsed() > timeout {
            return Err("vst-daemon did not become ready within 30s".into());
        }

        match rx.try_recv() {
            Ok(event) => {
                match event {
                    CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                        let text = String::from_utf8_lossy(&line);
                        if ready_pattern.is_match(&text) {
                            break;
                        }
                    }
                    CommandEvent::Terminated(_) => {
                        return Err("vst-daemon exited before becoming ready".into());
                    }
                    _ => {}
                }
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    // After the ready signal, read config.json for authoritative port/pid/token.
    // Poll until the file has been updated with a NEW pid (different from the old one,
    // or the file didn't exist before and now does) — this confirms the sidecar we just
    // spawned has finished writing its state, not a leftover from a previous run.
    let poll_start = Instant::now();
    let config = loop {
        if poll_start.elapsed() > Duration::from_secs(5) {
            return Err("config.json not updated within 5s of ready signal".into());
        }
        if let Some(c) = read_config() {
            // Accept if: there was no previous pid (fresh start), or the pid changed.
            if old_pid.map_or(true, |old| c.pid != old) {
                break c;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    // Prefer the tauri-scoped token; fall back to cli token, then legacy token.
    let token = config.tauri_token
        .or(config.cli_token)
        .or(config.token)
        .unwrap_or_default();
    Ok(DaemonInfo {
        port: config.port,
        pid: config.pid,
        token,
    })
}
