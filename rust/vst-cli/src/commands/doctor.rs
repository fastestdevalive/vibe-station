//! `vst doctor`
//!
//! Checks system health. Mirrors `cli/src/commands/doctor.ts` — this is a
//! **client-side** command that runs its own subprocess checks (`tmux`, `git`,
//! `which`, `tailscale`) directly; it is NOT a thin wrapper around the daemon's
//! server-side `services/doctor.ts`. It only consults the daemon indirectly via
//! `getDaemonUrl` for the "Daemon is running" check.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command as SyncCommand;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;

use crate::daemon_url::get_daemon_url;

/// `doctor` takes no options.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DoctorOptions;

pub fn parse_doctor_options(args: &[String]) -> Result<DoctorOptions, String> {
    for arg in args {
        if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        }
    }
    Ok(DoctorOptions)
}

/// The `tailscale status --json` payload (the CLI's own output shape, not a
/// daemon wire type).
#[derive(Deserialize)]
pub struct TailscaleStatusJson {
    #[serde(rename = "BackendState")]
    pub backend_state: Option<String>,
    #[serde(rename = "Self")]
    pub self_: Option<TailscaleSelf>,
}

#[derive(Deserialize)]
pub struct TailscaleSelf {
    #[serde(rename = "DNSName")]
    pub dns_name: Option<String>,
}

/// The `tailscale serve status --json` payload (CLI output shape).
#[derive(Deserialize)]
pub struct TailscaleServeJson {
    #[serde(rename = "Web")]
    pub web: Option<HashMap<String, TailscaleWebEntry>>,
}

#[derive(Deserialize)]
pub struct TailscaleWebEntry {
    #[serde(rename = "Handlers")]
    pub handlers: Option<HashMap<String, TailscaleHandler>>,
}

#[derive(Deserialize)]
pub struct TailscaleHandler {
    #[serde(rename = "Proxy")]
    pub proxy: Option<String>,
}

/// Strip a single trailing `.` from a DNS name (`host.` → `host`).
pub fn trim_trailing_dot(s: &str) -> &str {
    match s.strip_suffix('.') {
        Some(trimmed) => trimmed,
        None => s,
    }
}

/// Extract the port from a proxy URL like `https://host:8443/`.
///
/// Returns the explicit port when present, else the scheme default (443 for
/// `https:`, 80 otherwise), or `None` for an unparseable URL.
pub fn parse_proxy_port(proxy_url: &str) -> Option<u16> {
    let rest = proxy_url.split("://").nth(1)?;
    let authority = rest.split('/').next().unwrap_or(rest);
    if let Some(idx) = authority.rfind(':') {
        let (host, port) = authority.split_at(idx);
        if host.is_empty() {
            return None;
        }
        let port_str = &port[1..];
        if port_str.is_empty() {
            return None;
        }
        return port_str.parse::<u16>().ok();
    }
    if proxy_url.starts_with("https://") {
        Some(443)
    } else if proxy_url.starts_with("http://") {
        Some(80)
    } else {
        None
    }
}

/// Find the port the tailscale serve rule proxies to, for a rule keyed `:443`
/// whose `/` handler has a proxy URL. Returns `None` when no such rule exists.
pub fn find_serve_port(config: Option<&TailscaleServeJson>) -> Option<u16> {
    let web = config?.web.as_ref()?;
    for (key, value) in web {
        if !key.ends_with(":443") {
            continue;
        }
        let proxy = value.handlers.as_ref()?.get("/")?.proxy.as_ref()?;
        let port = parse_proxy_port(proxy)?;
        return Some(port);
    }
    None
}

/// Read the daemon port the CLI would reach from `<home>/.vibe-station/config.json`.
/// Returns `None` when absent, malformed, or non-positive.
pub fn get_daemon_port_from_config(home: Option<&Path>) -> Option<u16> {
    let home = match home {
        Some(h) => h.to_path_buf(),
        None => std::env::var_os("HOME").map(PathBuf::from)?,
    };
    let raw = std::fs::read_to_string(home.join(".vibe-station").join("config.json")).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = cfg.get("port")?.as_u64()?;
    if port == 0 {
        return None;
    }
    u16::try_from(port).ok()
}

/// Run a check, printing a green ✓ (true) or red ✗ (false) line. Returns the
/// closure's result.
pub fn check(name: &str, f: impl FnOnce() -> bool) -> bool {
    let result = f();
    if result {
        println!("\x1b[32m✓\x1b[0m {name}");
    } else {
        println!("\x1b[31m✗\x1b[0m {name}");
    }
    result
}

fn print_hint(message: &str) {
    println!("\x1b[33m  →\x1b[0m {message}");
}

/// Resolve the claude-agent-acp adapter entrypoint the same way
/// `rust/vst-agents/src/claude.rs::resolve_claude_acp_entry_path` does, for a
/// health check here. Deliberately a separate, lightweight implementation
/// rather than a `vst-agents` dependency — this file is explicitly
/// self-contained (see its header comment), and pulling in the daemon-side
/// agent-plugin crate just for one path check would break that boundary.
fn find_claude_acp_entry() -> Option<PathBuf> {
    const SUFFIX: &[&str] = &[
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
        "dist",
        "index.js",
    ];
    if let Ok(p) = std::env::var("VST_CLAUDE_ACP_ENTRY") {
        if !p.is_empty() && Path::new(&p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Beside the exe (hand-staged layout; also where a Windows Tauri
            // bundle puts resources), then the Tauri bundle's resource dir
            // relative to the bundled `vst` sidecar: `Contents/Resources/` on
            // macOS (exe in `Contents/MacOS/`), `usr/lib/<productName>/` for a
            // Linux deb/AppImage (exe in `usr/bin/`). The daemon itself gets
            // the path via VST_CLAUDE_ACP_ENTRY from the Tauri host
            // (desktop/src-tauri/src/daemon.rs), but a user running `vst
            // doctor` from a terminal has no such env var.
            let bases = [
                dir.to_path_buf(),
                dir.join("..").join("Resources"),
                dir.join("..").join("lib").join("vibe-station"),
            ];
            for base in bases {
                let mut candidate = base.join("claude-acp-vendor");
                candidate.extend(SUFFIX);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(8) {
            let mut candidate = ancestor.join("vendor").join("claude-acp");
            candidate.extend(SUFFIX);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn which(bin: &str) -> bool {
    SyncCommand::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run `tailscale status --json` / `tailscale serve status --json` with a
/// per-invocation timeout, printing the connected DNS name and any serve-port
/// drift. Non-fatal: returns false when tailscale is absent/unconnected.
async fn check_tailscale() -> bool {
    let status_out = timeout(
        Duration::from_millis(15_000),
        AsyncCommand::new("tailscale")
            .args(["status", "--json"])
            .output(),
    )
    .await;

    let output = match status_out {
        Ok(Ok(o)) if o.status.success() => o,
        _ => {
            println!("\x1b[31m✗\x1b[0m tailscale not found");
            return false;
        }
    };

    let status: TailscaleStatusJson = match serde_json::from_slice(&output.stdout) {
        Ok(s) => s,
        Err(_) => {
            println!("\x1b[31m✗\x1b[0m tailscale status unparseable");
            return false;
        }
    };

    let backend = status.backend_state.as_deref().unwrap_or("NoState");
    if backend != "Running" {
        println!("\x1b[31m✗\x1b[0m tailscale not connected");
        return false;
    }

    let dns_name = match status.self_ {
        Some(s) => trim_trailing_dot(s.dns_name.as_deref().unwrap_or("")).to_string(),
        None => String::new(),
    };
    println!("\x1b[32m✓\x1b[0m tailscale connected ({dns_name})");

    let serve_out = timeout(
        Duration::from_millis(15_000),
        AsyncCommand::new("tailscale")
            .args(["serve", "status", "--json"])
            .output(),
    )
    .await;

    if let Ok(Ok(o)) = serve_out {
        if o.status.success() && !o.stdout.is_empty() {
            if let Ok(serve) = serde_json::from_slice::<TailscaleServeJson>(&o.stdout) {
                let serve_port = find_serve_port(Some(&serve));
                let daemon_port = get_daemon_port_from_config(None);
                if let (Some(sp), Some(dp)) = (serve_port, daemon_port) {
                    if sp != dp {
                        print_hint(&format!(
                            "Tailscale serve points to port {sp}; daemon is on {dp}. Enable again in Remote Access to repair."
                        ));
                    }
                }
            }
        }
    }

    true
}

/// Run all doctor checks. Returns `Err(("", 1))` when any check failed (the
/// caller uses the exit code directly, matching the TS `process.exit(allOk ? 0
/// : 1)`), `Ok(())` when all checks passed.
pub async fn run_doctor() -> Result<(), (String, i32)> {
    let mut all_ok = true;

    all_ok = check("tmux is available", || {
        SyncCommand::new("tmux")
            .arg("-V")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }) && all_ok;

    all_ok = check("git is available", || {
        SyncCommand::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }) && all_ok;

    for bin in ["claude", "cursor", "opencode", "agy"] {
        check(&format!("{bin} is on PATH"), || which(bin));
    }

    let bun_found = check(
        "bun is on PATH (required for claude Rich Chat / ACP)",
        || which("bun"),
    );
    if !bun_found {
        let install_cmd = if cfg!(target_os = "macos") {
            "brew install oven-sh/bun/bun  OR  curl -fsSL https://bun.sh/install | bash"
        } else {
            "curl -fsSL https://bun.sh/install | bash"
        };
        print_hint(&format!("Install: {install_cmd}"));
    }

    let agy_acp_found = check(
        "agy-acp adapter binary (required for agy Rich Chat / ACP)",
        vst_agy_acp::agy_acp_available,
    );
    if !agy_acp_found {
        print_hint(
            "Build it from the vendored submodule (rust/vendor/openab/agy-acp) or set AGY_ACP_BIN",
        );
    }

    let acp_entry = find_claude_acp_entry();
    let acp_found = check(
        "claude-agent-acp adapter found (Claude Rich Chat / ACP)",
        || acp_entry.is_some(),
    );
    if !acp_found {
        print_hint("Install it: ./scripts/install-claude-acp-vendor.sh (then set VST_CLAUDE_ACP_ENTRY to the path it prints, if this checkout isn't the one the daemon runs from)");
    }

    let cloudflared_found = check("cloudflared", || which("cloudflared"));
    if !cloudflared_found {
        print_hint("brew install cloudflared  OR  https://developers.cloudflare.com/cloudflared/");
    }

    check_tailscale().await;

    all_ok = check("Daemon is running", || get_daemon_url().is_some()) && all_ok;

    if all_ok {
        Ok(())
    } else {
        Err((String::new(), 1))
    }
}
