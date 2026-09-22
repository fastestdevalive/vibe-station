#![forbid(unsafe_code)]

//! System health checks for `vst doctor`.
//! Ports `daemon/src/services/doctor.ts`:
//! - tmux on PATH
//! - git >= 2.20
//! - supported CLIs (claude, cursor, opencode, agy) on PATH (warn if missing)
//! - bun on PATH (warn if missing; required for claude ACP)
//! - claude-agent-acp vendor install present (warn if missing; the official
//!   ACP adapter for Claude Rich Chat, run via `bun` — see
//!   `scripts/install-claude-acp-vendor.sh`)
//! - agy-acp adapter binary (warn if missing; required for agy Rich Chat/ACP)
//! - orphan tmux sessions (vr-* whose project/session is not in store)
//! - orphan worktree dirs (in store manifest but missing directory on disk)

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

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
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ok,
    Warn,
    Error,
}

/// Check if a binary exists on PATH using `which <binary>`.
pub fn check_binary(binary: &str) -> bool {
    Command::new("which")
        .arg(binary)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check git version is >= 2.20.
pub fn check_git_version() -> DoctorCheck {
    let output = match Command::new("git").arg("--version").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => {
            return DoctorCheck {
                name: "git".to_string(),
                status: DoctorStatus::Error,
                message: "git not found on PATH".to_string(),
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
            message: "Could not parse git version".to_string(),
        };
    }

    let major = nums[0];
    let minor = nums[1];
    if major < 2 || (major == 2 && minor < 20) {
        DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Error,
            message: format!("git {major}.{minor} found; git >= 2.20 required"),
        }
    } else {
        DoctorCheck {
            name: "git".to_string(),
            status: DoctorStatus::Ok,
            message: format!("git {version_str}"),
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
            message: format!(
                "Found {} orphan tmux session(s): {}. Run 'tmux kill-session -t <name>' to clean up.",
                orphans.len(),
                orphans.join(", ")
            ),
        }
    } else {
        DoctorCheck {
            name: "orphan-sessions".to_string(),
            status: DoctorStatus::Ok,
            message: "No orphan tmux sessions".to_string(),
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
            message: format!(
                "Manifest references missing worktree directories:\n{}",
                orphans.join("\n")
            ),
        }
    } else {
        DoctorCheck {
            name: "orphan-worktrees".to_string(),
            status: DoctorStatus::Ok,
            message: "All worktree directories exist".to_string(),
        }
    }
}

/// Run all doctor health checks.
pub async fn run_doctor(store: &StoreHandle, tmux: &Tmux, paths: &Paths) -> Vec<DoctorCheck> {
    let mut checks = Vec::new();

    // 1. tmux
    checks.push(if check_binary("tmux") {
        DoctorCheck {
            name: "tmux".to_string(),
            status: DoctorStatus::Ok,
            message: "tmux found on PATH".to_string(),
        }
    } else {
        DoctorCheck {
            name: "tmux".to_string(),
            status: DoctorStatus::Error,
            message: "tmux not found on PATH".to_string(),
        }
    });

    // 2. git version
    checks.push(check_git_version());

    // 3. Supported CLIs (warn if missing)
    for plugin in SUPPORTED_CLIS {
        let name = match plugin {
            vst_types::CliId::Claude => "claude",
            vst_types::CliId::Cursor => "cursor",
            vst_types::CliId::Opencode => "opencode",
            vst_types::CliId::Agy => "agy",
        };
        let found = check_binary(name);
        checks.push(DoctorCheck {
            name: format!("plugin-{name}"),
            status: if found {
                DoctorStatus::Ok
            } else {
                DoctorStatus::Warn
            },
            message: if found {
                format!("{name} found on PATH")
            } else {
                format!("{name} not found on PATH (plugin unavailable)")
            },
        });
    }

    // 4. bun (required for Claude ACP — see check 6)
    checks.push(if check_binary("bun") {
        DoctorCheck {
            name: "bun".to_string(),
            status: DoctorStatus::Ok,
            message: "bun found on PATH (required for claude Rich Chat / ACP)".to_string(),
        }
    } else {
        DoctorCheck {
            name: "bun".to_string(),
            status: DoctorStatus::Warn,
            message: "bun not found on PATH — claude Rich Chat (ACP) will fail. Install: curl -fsSL https://bun.sh/install | bash".to_string(),
        }
    });

    // 5. agy-acp adapter binary (required for agy Rich Chat / ACP)
    checks.push(if vst_agy_acp::agy_acp_available() {
        DoctorCheck {
            name: "agy-acp".to_string(),
            status: DoctorStatus::Ok,
            message: "agy-acp adapter binary found (required for agy Rich Chat/ACP)".to_string(),
        }
    } else {
        DoctorCheck {
            name: "agy-acp".to_string(),
            status: DoctorStatus::Warn,
            message: "agy-acp adapter binary not found — agy Rich Chat (ACP) will fail. Build it from the vendored submodule (rust/vendor/openab/agy-acp) or set AGY_ACP_BIN.".to_string(),
        }
    });

    // 6. claude-agent-acp vendor install (the official ACP adapter for
    // Claude, run via `bun` — no system Node.js install needed; see
    // `rust/vst-agents/src/claude.rs::claude_acp_entry_path`).
    {
        let entry = vst_agents::claude::claude_acp_entry_path();
        let found = Path::new(&entry).is_file();
        checks.push(if found {
            DoctorCheck {
                name: "claude-agent-acp".to_string(),
                status: DoctorStatus::Ok,
                message: format!("claude-agent-acp adapter found at {entry} (Claude Rich Chat / ACP)"),
            }
        } else {
            DoctorCheck {
                name: "claude-agent-acp".to_string(),
                status: DoctorStatus::Warn,
                message: "claude-agent-acp adapter not found — Claude Rich Chat (ACP) will fail. Install it: ./scripts/install-claude-acp-vendor.sh (or set VST_CLAUDE_ACP_ENTRY to an existing install's dist/index.js)".to_string(),
            }
        });
    }

    // 7. Orphan tmux sessions
    checks.push(check_orphan_sessions(store, tmux).await);

    // 8. Orphan worktree dirs
    checks.push(check_orphan_worktrees(store, paths).await);

    checks
}
