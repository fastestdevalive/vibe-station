#![forbid(unsafe_code)]

//! System health checks for `vst doctor`.
//! Ports `daemon/src/services/doctor.ts`:
//! - tmux on PATH
//! - git >= 2.20
//! - supported CLIs (claude, cursor, opencode, agy) on PATH (warn if missing)
//! - bun on PATH (warn if missing; required for claude ACP)
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub name: String,
    pub status: DoctorStatus,
    pub required: bool,
    pub group: CheckGroup,
    pub message: String,
    pub resolved_path: Option<String>,
    pub install_hint: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ok,
    Warn,
    Error,
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckGroup {
    Required,
    AgentCli,
    Optional,
    Diagnostic,
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
            install_hint: None,
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
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "tmux".to_string(),
            status: DoctorStatus::Error,
            required: true,
            group: CheckGroup::Required,
            message: "tmux not found on PATH".to_string(),
            resolved_path: None,
            install_hint: None,
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
                install_hint: None,
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
            install_hint: None,
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
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Ok,
            required: true,
            group: CheckGroup::Required,
            message: format!("git {version_str}"),
            resolved_path,
            install_hint: None,
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
        install_hint: None,
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
                install_hint: None,
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
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "cloudflared".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Optional,
            message: "cloudflared not found on PATH".to_string(),
            resolved_path: None,
            install_hint: None,
        }
    }
}

pub fn check_tailscale_binary() -> DoctorCheck {
    if let Some(path) = resolve_bin_path("tailscale") {
        DoctorCheck {
            name: "tailscale".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Optional,
            message: "tailscale found on PATH".to_string(),
            resolved_path: Some(path),
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "tailscale".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Optional,
            message: "tailscale not found on PATH".to_string(),
            resolved_path: None,
            install_hint: None,
        }
    }
}

/// Check for orphan tmux sessions (named vr-* whose project is no longer in store).
pub async fn check_orphan_sessions(store: &StoreHandle, tmux: &Tmux) -> DoctorCheck {
    let sessions = tmux.list_sessions();
    let vr_sessions: Vec<String> = sessions
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

    let orphans: Vec<String> = vr_sessions
        .into_iter()
        .filter(|s| !known_tmux_names.contains(s))
        .collect();

    if !orphans.is_empty() {
        DoctorCheck {
            name: "orphan-sessions".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Diagnostic,
            message: format!(
                "Found {} orphan tmux session(s): {}. Run 'tmux kill-session -t <name>' to clean up.",
                orphans.len(),
                orphans.join(", ")
            ),
            resolved_path: None,
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "orphan-sessions".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Diagnostic,
            message: "No orphan tmux sessions".to_string(),
            resolved_path: None,
            install_hint: None,
        }
    }
}

/// Check for orphan worktree directories referenced in store but missing from disk.
pub async fn check_orphan_worktrees(store: &StoreHandle, paths: &Paths) -> DoctorCheck {
    let mut orphans = Vec::new();
    let projects = store.get_all_projects().await;
    for project in projects {
        for wt in project.worktrees {
            let wt_path = paths.worktree_path(&project.id, &wt.id);
            if !Path::new(&wt_path).exists() {
                orphans.push(format!(
                    "{}/{} (expected at {})",
                    project.id,
                    wt.id,
                    wt_path.display()
                ));
            }
        }
    }

    if !orphans.is_empty() {
        DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Warn,
            required: false,
            group: CheckGroup::Diagnostic,
            message: format!(
                "Manifest references missing worktree directories:\n{}",
                orphans.join("\n")
            ),
            resolved_path: None,
            install_hint: None,
        }
    } else {
        DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Ok,
            required: false,
            group: CheckGroup::Diagnostic,
            message: "All worktree directories exist".to_string(),
            resolved_path: None,
            install_hint: None,
        }
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
                        install_hint: None,
                    }
                } else {
                    DoctorCheck {
                        name: format!("plugin-{name_str}"),
                        status: DoctorStatus::Warn,
                        required: false,
                        group: CheckGroup::AgentCli,
                        message: format!("{name_str} not found on PATH (plugin unavailable)"),
                        resolved_path: None,
                        install_hint: None,
                    }
                }
            })
            .await,
        );
    }

    // 5. bun (Optional, false)
    checks.push(
        with_timeout("bun", CheckGroup::Optional, false, || {
            let path = resolve_bin_path("bun");
            if let Some(path) = path {
                DoctorCheck {
                    name: "bun".to_string(),
                    status: DoctorStatus::Ok,
                    required: false,
                    group: CheckGroup::Optional,
                    message: "bun found on PATH (required for claude Rich Chat / ACP)".to_string(),
                    resolved_path: Some(path),
                    install_hint: None,
                }
            } else {
                DoctorCheck {
                    name: "bun".to_string(),
                    status: DoctorStatus::Warn,
                    required: false,
                    group: CheckGroup::Optional,
                    message: "bun not found on PATH — claude Rich Chat (ACP) will fail. Install: curl -fsSL https://bun.sh/install | bash".to_string(),
                    resolved_path: None,
                    install_hint: None,
                }
            }
        })
        .await,
    );

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

    // 7. tailscale (Optional, false)
    checks.push(
        with_timeout(
            "tailscale",
            CheckGroup::Optional,
            false,
            check_tailscale_binary,
        )
        .await,
    );

    // 8. orphan-sessions (Diagnostic, false)
    checks.push(check_orphan_sessions(store, tmux).await);

    // 9. orphan-worktrees (Diagnostic, false)
    checks.push(check_orphan_worktrees(store, paths).await);

    // Central install_hint population for all non-Ok checks
    for check in &mut checks {
        if check.status != DoctorStatus::Ok {
            if let Some(hint) =
                vst_types::rest::doctor_hints::hint_for(&check.name, std::env::consts::OS)
            {
                check.install_hint = Some(hint.to_string());
            }
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
    let wire_checks = checks.into_iter().map(Into::into).collect();

    vst_types::rest::doctor::DoctorReport {
        hard_ok,
        ok,
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
                install_hint: None,
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
    fn compute_hard_ok_handles_timeout_vs_error() {
        let checks_with_timeout = vec![
            DoctorCheck {
                name: "tmux".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "tmux ok".to_string(),
                resolved_path: None,
                install_hint: None,
            },
            DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "git ok".to_string(),
                resolved_path: None,
                install_hint: None,
            },
            DoctorCheck {
                name: "daemon-reachable".to_string(),
                status: DoctorStatus::Timeout,
                required: true,
                group: CheckGroup::Required,
                message: "timed out".to_string(),
                resolved_path: None,
                install_hint: None,
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
                install_hint: None,
            },
            DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Ok,
                required: true,
                group: CheckGroup::Required,
                message: "git ok".to_string(),
                resolved_path: None,
                install_hint: None,
            },
            DoctorCheck {
                name: "daemon-reachable".to_string(),
                status: DoctorStatus::Error,
                required: true,
                group: CheckGroup::Required,
                message: "failed".to_string(),
                resolved_path: None,
                install_hint: None,
            },
        ];
        assert!(
            !compute_hard_ok(&checks_with_error),
            "A Required check with Error must block hard_ok"
        );
    }
}
