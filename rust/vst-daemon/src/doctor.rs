#![forbid(unsafe_code)]

//! System health checks for `vst doctor`.
//! Ports `daemon/src/services/doctor.ts`:
//! - tmux on PATH
//! - git >= 2.20
//! - supported CLIs (claude, cursor, opencode, agy) on PATH (warn if missing)
//! - cloudflared (bundled via VST_CLOUDFLARED_BIN or on PATH)
//! - tailscale on PATH
//! - orphan tmux sessions (vr-* whose project/session is not in store)
//! - orphan worktree dirs (in store manifest but missing directory on disk)

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vst_agents::registry::SUPPORTED_CLIS;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::rest::doctor::{DoctorAction, DoctorHintDto, DoctorItemDto};
use vst_types::rest::doctor_hints::hint_dto;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub name: String,
    pub status: DoctorStatus,
    pub required: bool,
    pub group: CheckGroup,
    pub message: String,
    pub resolved_path: Option<String>,
    pub install_hint: Option<String>,
    /// Structured hint, filled centrally from `doctor_hints.rs` for non-OK checks.
    pub hint: Option<DoctorHintDto>,
    /// Per-item rows for list-style checks (orphans); empty otherwise.
    pub items: Vec<DoctorItemDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    #[default]
    Ok,
    Warn,
    Error,
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CheckGroup {
    #[default]
    Required,
    AgentCli,
    Optional,
    Diagnostic,
    Feature,
}

fn resolve_bin_path(binary: &str) -> Option<String> {
    Command::new("which")
        .arg(binary)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Whether `path` is a script whose shebang runs under `bun` (the npm/bun-installed
/// `omp`). A native binary or an unreadable file is not.
pub fn script_needs_bun(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 128];
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let n = f.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    head.starts_with(b"#!")
        && head
            .split(|b| *b == b'\n')
            .next()
            .is_some_and(|line| String::from_utf8_lossy(line).contains("bun"))
}

// Every subprocess-backed check goes through this — a hung `tailscale status`
// or CLI `--version` call degrades to Timeout instead of hanging run_doctor
// forever (PRD §1: "a timed-out check can never itself count as a blocking
// required failure").
async fn with_timeout(
    name: &str,
    group: CheckGroup,
    required: bool,
    f: impl FnOnce() -> DoctorCheck + Send + 'static,
) -> DoctorCheck {
    match tokio::time::timeout(Duration::from_secs(3), tokio::task::spawn_blocking(f)).await {
        Ok(Ok(check)) => check,
        _ => DoctorCheck {
            name: name.to_string(),
            status: DoctorStatus::Timeout,
            required,
            group,
            message: format!("{name} timed out after 3s"),
            resolved_path: None,
            ..Default::default()
        },
    }
}

pub fn check_tmux() -> DoctorCheck {
    let resolved_path = resolve_bin_path("tmux");
    if let Some(path) = resolved_path {
        DoctorCheck {
            name: "tmux".to_string(),
            status: DoctorStatus::Ok,
            required: true,
            group: CheckGroup::Required,
            message: "tmux found on PATH".to_string(),
            resolved_path: Some(path),
            ..Default::default()
        }
    } else {
        DoctorCheck {
            name: "tmux".to_string(),
            status: DoctorStatus::Error,
            required: true,
            group: CheckGroup::Required,
            message: "tmux not found on PATH".to_string(),
            resolved_path: None,
            ..Default::default()
        }
    }
}

/// Check git version is >= 2.20.
pub fn check_git_version() -> DoctorCheck {
    let resolved_path = resolve_bin_path("git");
    let output = match Command::new("git").arg("--version").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => {
            return DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Error,
                required: true,
                group: CheckGroup::Required,
                message: "git not found on PATH".to_string(),
                resolved_path,
                ..Default::default()
            }
        }
    };

    // Expected format: "git version 2.XX.X"
    let parts: Vec<&str> = output.split_whitespace().collect();
    let version_str = parts
        .iter()
        .find(|p| p.contains('.'))
        .copied()
        .unwrap_or("");
    let nums: Vec<u32> = version_str
        .split('.')
        .filter_map(|n| n.parse::<u32>().ok())
        .collect();

    if nums.len() < 2 {
        return DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Warn,
            required: true,
            group: CheckGroup::Required,
            message: "Could not parse git version".to_string(),
            resolved_path,
            ..Default::default()
        };
    }

    let major = nums[0];
    let minor = nums[1];
    if major < 2 || (major == 2 && minor < 20) {
        DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Error,
            required: true,
            group: CheckGroup::Required,
            message: format!("git {major}.{minor} found; git >= 2.20 required"),
            resolved_path,
            ..Default::default()
        }
    } else {
        DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Ok,
            required: true,
            group: CheckGroup::Required,
            message: format!("git {version_str}"),
            resolved_path,
            ..Default::default()
        }
    }
}

pub fn check_daemon_reachable() -> DoctorCheck {
    DoctorCheck {
        name: "daemon-reachable".to_string(),
        status: DoctorStatus::Ok,
        required: true,
        group: CheckGroup::Required,
        message: "Daemon reachable".to_string(),
        resolved_path: None,
        ..Default::default()
    }
}

pub fn check_cloudflared() -> DoctorCheck {
    if let Ok(bin) = std::env::var("VST_CLOUDFLARED_BIN") {
        let p = Path::new(&bin);
        if p.exists() {
            return DoctorCheck {
                name: "cloudflared".to_string(),
                status: DoctorStatus::Ok,
                required: false,
                group: CheckGroup::Optional,
                message: format!("cloudflared found at {bin} (bundled)"),
                resolved_path: Some(bin),
                ..Default::default()
            };
        }
    }
    if let Some(path) = resolve_bin_path("cloudflared") {
        DoctorCheck {
            name: "cloudflared".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Optional,
            message: "cloudflared found on PATH".to_string(),
            resolved_path: Some(path),
            ..Default::default()
        }
    } else {
        DoctorCheck {
            name: "cloudflared".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Optional,
            message: "cloudflared not found on PATH".to_string(),
            resolved_path: None,
            ..Default::default()
        }
    }
}

pub fn check_tailscale_binary(
    located: vst_lifecycle::tailscale_serve::locate::Located,
) -> DoctorCheck {
    use vst_lifecycle::tailscale_serve::locate::{self, Located};
    let mk = |status, message: String, resolved_path, install_hint| DoctorCheck {
        name: "tailscale".to_string(),
        status,
        required: false,
        group: CheckGroup::Optional,
        message,
        resolved_path,
        install_hint,
        ..Default::default()
    };
    match located {
        Located::OnPath => mk(
            DoctorStatus::Ok,
            "tailscale found on PATH".to_string(),
            resolve_bin_path("tailscale"),
            None,
        ),
        // Remote Access works off-PATH, so this is informational (Ok), not a warning.
        Located::OffPath(p) => mk(
            DoctorStatus::Ok,
            locate::off_path_message(&p),
            Some(p.to_string_lossy().into_owned()),
            None,
        ),
        Located::Missing => mk(
            DoctorStatus::Warn,
            "tailscale not found on PATH".to_string(),
            None,
            None,
        ),
    }
}

/// tmux sessions named `vr-*` that no stored session references.
pub async fn list_orphan_session_names(store: &StoreHandle, tmux: &Tmux) -> Vec<String> {
    let vr_sessions: Vec<String> = tmux
        .list_sessions()
        .into_iter()
        .filter(|s| s.starts_with("vr-"))
        .collect();

    let projects = store.get_all_projects().await;
    let mut known_tmux_names = HashSet::new();
    for p in projects {
        for w in p.worktrees {
            for s in w.sessions {
                known_tmux_names.insert(s.tmux_name);
            }
        }
        for s in p.direct_sessions {
            known_tmux_names.insert(s.tmux_name);
        }
    }

    vr_sessions
        .into_iter()
        .filter(|s| !known_tmux_names.contains(s))
        .collect()
}

/// Quote `s` for safe pasting into a POSIX shell. Names can originate outside
/// the daemon (tmux session names, ids), so anything beyond a conservative safe
/// set is single-quoted with embedded `'` escaped.
fn shell_quote(s: &str) -> String {
    let safe = !s.is_empty()
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '-' | '.' | '/' | ':' | '@' | '+' | '=' | ',')
        });
    if safe {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Check for orphan tmux sessions (named vr-* whose project is no longer in store).
pub async fn check_orphan_sessions(store: &StoreHandle, tmux: &Tmux) -> DoctorCheck {
    let orphans = list_orphan_session_names(store, tmux).await;

    if !orphans.is_empty() {
        DoctorCheck {
            name: "orphan-sessions".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Diagnostic,
            message: format!("Found {} orphan tmux session(s)", orphans.len()),
            resolved_path: None,
            items: orphans
                .into_iter()
                .map(|name| DoctorItemDto {
                    command: format!("tmux kill-session -t {}", shell_quote(&name)),
                    id: name.clone(),
                    label: name,
                    path: None,
                    action: DoctorAction::Kill,
                })
                .collect(),
            ..Default::default()
        }
    } else {
        DoctorCheck {
            name: "orphan-sessions".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Diagnostic,
            message: "No orphan tmux sessions".to_string(),
            resolved_path: None,
            ..Default::default()
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KillOrphanError {
    /// The name is not (or is no longer) in the freshly computed orphan list.
    NotOrphan,
}

/// Kill one orphan tmux session. The orphan list is recomputed first and any
/// name outside it is refused, so this can never become an arbitrary
/// `tmux kill-session`.
pub async fn kill_orphan_session(
    store: &StoreHandle,
    tmux: &Tmux,
    name: &str,
) -> Result<(), KillOrphanError> {
    if !list_orphan_session_names(store, tmux)
        .await
        .iter()
        .any(|n| n == name)
    {
        return Err(KillOrphanError::NotOrphan);
    }
    let tmux = tmux.clone();
    let name = name.to_string();
    let _ = tokio::task::spawn_blocking(move || tmux.kill_session(&name)).await;
    Ok(())
}

/// Check for orphan worktree directories referenced in store but missing from disk.
pub async fn check_orphan_worktrees(store: &StoreHandle, paths: &Paths) -> DoctorCheck {
    let mut items = Vec::new();
    let projects = store.get_all_projects().await;
    for project in projects {
        for wt in project.worktrees {
            let wt_path = paths.worktree_path(&project.id, &wt.id);
            if !Path::new(&wt_path).exists() {
                items.push(DoctorItemDto {
                    command: format!("vst worktree rm {} --yes", shell_quote(&wt.id)),
                    // The project's display name is its id (see `serialize_project`).
                    label: format!("{} / {}", project.id, wt.id),
                    path: Some(wt_path.display().to_string()),
                    id: wt.id,
                    action: DoctorAction::Forget,
                });
            }
        }
    }

    if !items.is_empty() {
        DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Diagnostic,
            message: format!("{} worktree(s) missing on disk", items.len()),
            resolved_path: None,
            items,
            ..Default::default()
        }
    } else {
        DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Diagnostic,
            message: "All worktree directories exist".to_string(),
            resolved_path: None,
            ..Default::default()
        }
    }
}

/// Check that `gh` CLI is installed and >= 2.40.
pub async fn check_github_cli() -> DoctorCheck {
    let output = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("gh").arg("--version").output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        _ => {
            return DoctorCheck {
                name: "github-cli".to_string(),
                status: DoctorStatus::Error,
                required: false,
                group: CheckGroup::Feature,
                message: "gh CLI not installed (requires 2.40+)".to_string(),
                resolved_path: None,
                install_hint: Some("https://cli.github.com".to_string()),
                ..Default::default()
            };
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let re = regex::Regex::new(r"(\d+)\.(\d+)").unwrap();
    let caps = re.captures(&text);

    match caps {
        Some(caps) => {
            let major: u32 = caps[1].parse().unwrap_or(0);
            let minor: u32 = caps[2].parse().unwrap_or(0);
            let version_str = format!("{major}.{minor}");

            if (major, minor) >= (2, 40) {
                DoctorCheck {
                    name: "github-cli".to_string(),
                    status: DoctorStatus::Ok,
                    required: false,
                    group: CheckGroup::Feature,
                    message: format!("gh {version_str}"),
                    resolved_path: None,
                    ..Default::default()
                }
            } else {
                DoctorCheck {
                    name: "github-cli".to_string(),
                    status: DoctorStatus::Error,
                    required: false,
                    group: CheckGroup::Feature,
                    message: format!("gh {version_str} found, requires 2.40+"),
                    resolved_path: None,
                    install_hint: Some("https://cli.github.com".to_string()),
                    ..Default::default()
                }
            }
        }
        None => DoctorCheck {
            name: "github-cli".to_string(),
            status: DoctorStatus::Error,
            required: false,
            group: CheckGroup::Feature,
            message: "gh CLI not installed (requires 2.40+)".to_string(),
            resolved_path: None,
            install_hint: Some("https://cli.github.com".to_string()),
            ..Default::default()
        },
    }
}

/// Check GitHub auth status for PR lookups.
///
/// Priority: `GITHUB_TOKEN`/`GH_TOKEN` env var → `gh auth login` accounts.
pub async fn check_github_auth() -> DoctorCheck {
    // First check env token — this path must NOT depend on gh being installed.
    if vst_lifecycle::github_auth::env_generic_token().is_some() {
        return DoctorCheck {
            name: "github-auth".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Feature,
            message: "PR status active via GITHUB_TOKEN env var".to_string(),
            resolved_path: None,
            ..Default::default()
        };
    }

    // If no env token, gh CLI is required.
    let cli_check = check_github_cli().await;
    if cli_check.status == DoctorStatus::Error {
        return DoctorCheck {
            name: "github-auth".to_string(),
            status: DoctorStatus::Error,
            required: false,
            group: CheckGroup::Feature,
            message: "requires gh CLI (see github-cli check)".to_string(),
            resolved_path: None,
            ..Default::default()
        };
    }

    // Check accounts.
    let accounts = match tokio::time::timeout(
        Duration::from_secs(10),
        vst_lifecycle::github_auth::list_accounts(),
    )
    .await
    {
        Ok(accounts) => accounts,
        Err(_) => {
            return DoctorCheck {
                name: "github-auth".to_string(),
                status: DoctorStatus::Error,
                required: false,
                group: CheckGroup::Feature,
                message: "Not logged in — run gh auth login".to_string(),
                resolved_path: None,
                ..Default::default()
            };
        }
    };

    if !accounts.iter().any(|a| a.token.is_some()) {
        return DoctorCheck {
            name: "github-auth".to_string(),
            status: DoctorStatus::Error,
            required: false,
            group: CheckGroup::Feature,
            message: "Not logged in — run gh auth login".to_string(),
            resolved_path: None,
            ..Default::default()
        };
    }

    let logins: Vec<String> = accounts.iter().map(|a| a.login.clone()).collect();
    DoctorCheck {
        name: "github-auth".to_string(),
        status: DoctorStatus::Ok,
        required: false,
        group: CheckGroup::Feature,
        message: format!("Logged in as {}", logins.join(", ")),
        resolved_path: None,
        ..Default::default()
    }
}

pub fn resolve_hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

// A per-check timeout can NEVER itself count as a blocking required
// failure (PRD §1) — it degrades to a soft warning, not a hard block.
pub fn passes(status: DoctorStatus) -> bool {
    matches!(status, DoctorStatus::Ok | DoctorStatus::Timeout)
}

pub fn compute_hard_ok(checks: &[DoctorCheck]) -> bool {
    checks
        .iter()
        .filter(|c| c.group == CheckGroup::Required)
        .all(|c| passes(c.status))
}

pub fn compute_ok(checks: &[DoctorCheck]) -> bool {
    compute_hard_ok(checks)
        && checks
            .iter()
            .any(|c| c.group == CheckGroup::AgentCli && c.status == DoctorStatus::Ok)
}

/// Run all doctor health checks.
pub async fn run_doctor(store: &StoreHandle, tmux: &Tmux, paths: &Paths) -> Vec<DoctorCheck> {
    let mut checks = Vec::new();

    // 1. tmux (Required, true)
    checks.push(with_timeout("tmux", CheckGroup::Required, true, check_tmux).await);

    // 2. git version (Required, true)
    checks.push(with_timeout("git", CheckGroup::Required, true, check_git_version).await);

    // 3. daemon-reachable (Required, true)
    checks.push(check_daemon_reachable());

    // 4. Supported CLIs (AgentCli, false)
    for plugin in SUPPORTED_CLIS {
        let name = match plugin {
            vst_types::CliId::Claude => "claude",
            vst_types::CliId::Cursor => "cursor",
            vst_types::CliId::Opencode => "opencode",
            vst_types::CliId::Agy => "agy",
            vst_types::CliId::Codex => "codex",
            vst_types::CliId::Pi => "pi",
            vst_types::CliId::Omp => "omp",
        };
        let check_name = format!("plugin-{name}");
        let name_str = name.to_string();
        checks.push(
            with_timeout(&check_name, CheckGroup::AgentCli, false, move || {
                let path = resolve_bin_path(&name_str);
                if let Some(path) = path {
                    DoctorCheck {
                        name: format!("plugin-{name_str}"),
                        status: DoctorStatus::Ok,
                        required: false,
                        group: CheckGroup::AgentCli,
                        message: format!("{name_str} found on PATH"),
                        resolved_path: Some(path),
                        ..Default::default()
                    }
                } else {
                    DoctorCheck {
                        name: format!("plugin-{name_str}"),
                        status: DoctorStatus::Warn,
                        required: false,
                        group: CheckGroup::AgentCli,
                        message: format!("{name_str} not found on PATH (plugin unavailable)"),
                        resolved_path: None,
                        ..Default::default()
                    }
                }
            })
            .await,
        );
    }

    // 6. cloudflared (Optional, false — bundled via VST_CLOUDFLARED_BIN on desktop)
    checks.push(
        with_timeout(
            "cloudflared",
            CheckGroup::Optional,
            false,
            check_cloudflared,
        )
        .await,
    );

    // 7. tailscale (Optional, false). Located async (it may probe the user's shell for
    // an alias); bounded by the same 3s budget as every other check.
    checks.push(
        match tokio::time::timeout(
            Duration::from_secs(3),
            vst_lifecycle::tailscale_serve::locate::locate_async(),
        )
        .await
        {
            Ok(located) => check_tailscale_binary(located),
            Err(_) => DoctorCheck {
                name: "tailscale".to_string(),
                status: DoctorStatus::Timeout,
                required: false,
                group: CheckGroup::Optional,
                message: "tailscale timed out after 3s".to_string(),
                resolved_path: None,
                ..Default::default()
            },
        },
    );

    // 8. codex-acp vendor install (the official ACP adapter for
    // Codex, run via `bun` — see
    // `rust/vst-agents/src/codex.rs::codex_acp_entry_path`). Only checked when
    // codex itself is installed, so users without it aren't warned.
    if resolve_bin_path("codex").is_some() {
        // A bundled compiled `codex-acp` (curl install / desktop) needs no bun.
        let entry = vst_agents::codex::codex_acp_bin()
            .map(|b| b.to_string_lossy().to_string())
            .unwrap_or_else(vst_agents::codex::codex_acp_entry_path);
        let found = Path::new(&entry).is_file();
        checks.push(if found {
            DoctorCheck {
                name: "codex-acp".to_string(),
                status: DoctorStatus::Ok,
                required: false,
                group: CheckGroup::Feature,
                message: format!("codex-acp adapter found at {entry} (Codex Rich Chat / ACP)"),
                resolved_path: Some(entry),
                ..Default::default()
            }
        } else {
            DoctorCheck {
                name: "codex-acp".to_string(),
                status: DoctorStatus::Warn,
                required: false,
                group: CheckGroup::Feature,
                message: "codex-acp adapter not found — Codex Rich Chat (ACP) will fail."
                    .to_string(),
                resolved_path: None,
                // The hint table supplies the VST_CODEX_ACP_ENTRY text.
                ..Default::default()
            }
        });
    }

    // 8b. omp-bun: the npm/bun-installed `omp` is a `#!/usr/bin/env bun` script, so
    // omp sessions fail to spawn when `bun` is off the daemon PATH (typical for a
    // GUI-launched daemon). Only checked when omp is installed AND needs bun, so
    // users of a native omp build (brew/curl) aren't warned.
    // Blocking `which` + a file read: off the runtime and bounded like every other
    // subprocess-backed check.
    let omp_bun = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(|| {
            let omp_path = resolve_bin_path("omp")?;
            if !script_needs_bun(Path::new(&omp_path)) {
                return None;
            }
            let bun = resolve_bin_path("bun");
            Some(DoctorCheck {
                name: "omp-bun".to_string(),
                status: if bun.is_some() {
                    DoctorStatus::Ok
                } else {
                    DoctorStatus::Warn
                },
                required: false,
                group: CheckGroup::Feature,
                message: match &bun {
                    Some(p) => format!("bun found at {p} (omp runs under bun)"),
                    None => "bun not found on PATH — omp sessions will fail to start.".to_string(),
                },
                resolved_path: bun,
                ..Default::default()
            })
        }),
    )
    .await;
    if let Ok(Ok(Some(check))) = omp_bun {
        checks.push(check);
    }

    // 9. orphan-sessions (Diagnostic, false)
    checks.push(check_orphan_sessions(store, tmux).await);

    // 10. orphan-worktrees (Diagnostic, false)
    checks.push(check_orphan_worktrees(store, paths).await);

    // 11. github-cli (Feature, false)
    checks.push(check_github_cli().await);

    // 12. github-auth (Feature, false)
    checks.push(check_github_auth().await);

    // Central hint population for all non-Ok checks: `installHint` (host-OS
    // command, back-compat) and the structured `hint`, both from the one table.
    for check in &mut checks {
        if check.status != DoctorStatus::Ok {
            if let Some(hint) =
                vst_types::rest::doctor_hints::hint_for(&check.name, std::env::consts::OS)
            {
                check.install_hint = Some(hint.to_string());
            }
            check.hint = hint_dto(&check.name);
        }
    }

    checks
}

impl From<DoctorStatus> for vst_types::rest::doctor::DoctorCheckStatus {
    fn from(s: DoctorStatus) -> Self {
        match s {
            DoctorStatus::Ok => vst_types::rest::doctor::DoctorCheckStatus::Ok,
            DoctorStatus::Warn => vst_types::rest::doctor::DoctorCheckStatus::Warn,
            DoctorStatus::Error => vst_types::rest::doctor::DoctorCheckStatus::Error,
            DoctorStatus::Timeout => vst_types::rest::doctor::DoctorCheckStatus::Timeout,
        }
    }
}

impl From<CheckGroup> for vst_types::rest::doctor::CheckGroup {
    fn from(g: CheckGroup) -> Self {
        match g {
            CheckGroup::Required => vst_types::rest::doctor::CheckGroup::Required,
            CheckGroup::AgentCli => vst_types::rest::doctor::CheckGroup::AgentCli,
            CheckGroup::Optional => vst_types::rest::doctor::CheckGroup::Optional,
            CheckGroup::Diagnostic => vst_types::rest::doctor::CheckGroup::Diagnostic,
            CheckGroup::Feature => vst_types::rest::doctor::CheckGroup::Feature,
        }
    }
}

impl From<DoctorCheck> for vst_types::rest::doctor::DoctorCheckDto {
    fn from(c: DoctorCheck) -> Self {
        Self {
            name: c.name,
            status: c.status.into(),
            required: c.required,
            group: c.group.into(),
            message: c.message,
            resolved_path: c.resolved_path,
            install_hint: c.install_hint,
            hint: c.hint,
            items: c.items,
        }
    }
}

pub async fn build_report(
    store: &StoreHandle,
    tmux: &Tmux,
    paths: &Paths,
) -> vst_types::rest::doctor::DoctorReport {
    let checks = run_doctor(store, tmux, paths).await;
    let hard_ok = compute_hard_ok(&checks);
    let ok = compute_ok(&checks);
    let feature_ok = !checks
        .iter()
        .any(|c| c.group == CheckGroup::Feature && c.status == DoctorStatus::Error);
    let wire_checks = checks.into_iter().map(Into::into).collect();

    vst_types::rest::doctor::DoctorReport {
        hard_ok,
        ok,
        feature_ok,
        host_os: std::env::consts::OS.to_string(),
        hostname: resolve_hostname(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        checks: wire_checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Mutex to serialize tests that mutate environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // 3.T1
    #[test]
    fn check_daemon_reachable_returns_ok_required() {
        let check = check_daemon_reachable();
        assert_eq!(check.status, DoctorStatus::Ok);
        assert!(check.required);
        assert_eq!(check.group, CheckGroup::Required);
    }

    // 3.T2
    #[tokio::test(flavor = "multi_thread")]
    async fn with_timeout_returns_timeout_within_budget() {
        let start = std::time::Instant::now();
        let check = with_timeout("slow-check", CheckGroup::Optional, false, || {
            std::thread::sleep(Duration::from_secs(5));
            DoctorCheck {
                name: "slow-check".to_string(),
                status: DoctorStatus::Ok,
                required: false,
                group: CheckGroup::Optional,
                message: "completed".to_string(),
                resolved_path: None,
                ..Default::default()
            }
        })
        .await;

        let elapsed = start.elapsed();
        assert_eq!(check.status, DoctorStatus::Timeout);
        assert!(
            elapsed < Duration::from_secs(5),
            "Expected timeout before closure's 5s, took {:?}",
            elapsed
        );
        assert_eq!(check.name, "slow-check");
    }

    // 3.T3
    #[test]
    fn check_cloudflared_with_bundled_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp_file = tempfile::NamedTempFile::new().unwrap();
        let temp_path = temp_file.path().to_string_lossy().to_string();
        std::env::set_var("VST_CLOUDFLARED_BIN", &temp_path);
        let check = check_cloudflared();
        std::env::remove_var("VST_CLOUDFLARED_BIN");

        assert_eq!(check.status, DoctorStatus::Ok);
        assert!(
            check.message.contains("bundled"),
            "Expected message to contain 'bundled', got: {}",
            check.message
        );
        assert_eq!(check.install_hint, None);
        assert_eq!(check.hint, None);
        assert_eq!(check.resolved_path, Some(temp_path));
    }

    // 3.T4
    #[test]
    fn check_cloudflared_unset_falls_through_to_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("VST_CLOUDFLARED_BIN");
        let check = check_cloudflared();
        if check.status != DoctorStatus::Ok {
            assert_eq!(check.resolved_path, None);
        }
    }

    // 3.T8
    #[test]
    fn script_needs_bun_only_for_a_bun_shebang() {
        let dir = std::env::temp_dir().join(format!("vst-bun-shebang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        assert!(script_needs_bun(&write(
            "a",
            b"#!/usr/bin/env bun\nconsole.log(1)\n"
        )));
        assert!(!script_needs_bun(&write("b", b"#!/usr/bin/env node\n")));
        assert!(!script_needs_bun(&write("c", b"\x7fELF\x02\x01 bun")));
        assert!(!script_needs_bun(&dir.join("missing")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compute_hard_ok_handles_timeout_vs_error() {
        let checks_with_timeout = vec![
            DoctorCheck {
                name: "tmux".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "tmux ok".to_string(),
                resolved_path: None,
                ..Default::default()
            },
            DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "git ok".to_string(),
                resolved_path: None,
                ..Default::default()
            },
            DoctorCheck {
                name: "daemon-reachable".to_string(),
                status: DoctorStatus::Timeout,
                required: true,
                group: CheckGroup::Required,
                message: "timed out".to_string(),
                resolved_path: None,
                ..Default::default()
            },
        ];
        assert!(
            compute_hard_ok(&checks_with_timeout),
            "A Required check with Timeout must not block hard_ok"
        );

        let checks_with_error = vec![
            DoctorCheck {
                name: "tmux".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "tmux ok".to_string(),
                resolved_path: None,
                ..Default::default()
            },
            DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "git ok".to_string(),
                resolved_path: None,
                ..Default::default()
            },
            DoctorCheck {
                name: "daemon-reachable".to_string(),
                status: DoctorStatus::Error,
                required: true,
                group: CheckGroup::Required,
                message: "failed".to_string(),
                resolved_path: None,
                ..Default::default()
            },
        ];
        assert!(
            !compute_hard_ok(&checks_with_error),
            "A Required check with Error must block hard_ok"
        );
    }

    // 5.T4
    #[tokio::test]
    async fn orphan_worktrees_lists_one_forget_item_per_missing_dir() {
        use vst_types::{ProjectRecord, WorktreeRecord};
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::with_home(tmp.path().to_path_buf());
        let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
        store
            .add_project(ProjectRecord {
                id: "proj".into(),
                absolute_path: "/fake/proj".into(),
                prefix: "pr".into(),
                is_git: true,
                default_branch: Some("main".into()),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                hidden: None,
                direct_sessions: vec![],
                direct_session_seq: None,
                worktrees: vec![WorktreeRecord {
                    id: "pr-1".into(),
                    name: None,
                    branch: "b".into(),
                    branch_is_placeholder: None,
                    base_branch: "main".into(),
                    base_sha: "a".repeat(40),
                    created_at: "2024-01-01T00:00:00.000Z".into(),
                    pinned_at: None,
                    hidden_at: None,
                    sort_order: 0.0,
                    terminal_seq: Some(0),
                    agent_seq: Some(0),
                    lsp_enabled: None,
                    sessions: vec![],
                    open_files: vec![],
                }],
                next_worktree_num: None,
                lsp_enabled: None,
                open_files: vec![],
            })
            .await
            .unwrap();

        let check = check_orphan_worktrees(&store, &paths).await;
        assert_eq!(check.status, DoctorStatus::Warn);
        assert_eq!(check.message, "1 worktree(s) missing on disk");
        assert_eq!(check.items.len(), 1);
        let item = &check.items[0];
        assert_eq!(item.id, "pr-1");
        assert_eq!(item.command, "vst worktree rm pr-1 --yes");
        assert_eq!(item.action, DoctorAction::Forget);
        assert!(item.path.is_some());
    }

    #[test]
    fn shell_quote_handles_spaces_quotes_and_substitution() {
        assert_eq!(shell_quote("vr-abc_1"), "vr-abc_1");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote("`x`;y"), "'`x`;y'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn wire_conversion_keeps_hint_and_items() {
        let check = DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Diagnostic,
            message: "1 worktree(s) missing on disk".to_string(),
            resolved_path: None,
            install_hint: None,
            hint: hint_dto("orphan-worktrees"),
            items: vec![DoctorItemDto {
                id: "w1".into(),
                label: "p / w1".into(),
                path: None,
                command: "vst worktree rm w1 --yes".into(),
                action: DoctorAction::Forget,
            }],
        };
        let dto: vst_types::rest::doctor::DoctorCheckDto = check.into();
        assert_eq!(dto.items.len(), 1);
        assert_eq!(dto.hint.unwrap().action, Some(DoctorAction::Forget));
    }
}
