//! Ports `recover.ts` — boot-time recovery for sessions stuck at
//! `not_started` after an unclean daemon restart, plus the orphan turn-PID
//! sweep and the direct-pty boot sweep.

use std::collections::HashMap;
use std::path::PathBuf;

use vst_proc::Tmux;
use vst_store::StoreHandle;
use vst_types::{Channel, LifecycleState, SessionLifecycle, SessionRecord};

use crate::direct_pty::DirectPtyRegistry;
use crate::paths::Paths;

/// `comm` names of every process this daemon may mirror into a session's
/// `turn.pids` pidfile — the allowlist `verify_pid_is_turn_process` checks a
/// recorded PID against before killing it. Kept here (not re-derived from the
/// plugin registry) so recovery doesn't depend on the whole plugin layer.
const KNOWN_TURN_BINARIES: &[&str] = &["claude", "cursor-agent", "opencode", "agy", "MainThread"];

/// Whether a named tmux session is alive — abstracted so `recover` can be
/// unit-tested without a real tmux server (the TS mocks `tmux.hasSession`).
pub trait SessionLiveness {
    fn has_session(&self, name: &str) -> bool;
}

impl SessionLiveness for Tmux {
    fn has_session(&self, name: &str) -> bool {
        Tmux::has_session(self, name)
    }
}

/// Is a session on the JSON (Rich Chat) channel?
fn session_is_json(session: &SessionRecord) -> bool {
    session.channel == Some(Channel::Json)
}

fn lifecycle(state: LifecycleState, reason: &str) -> SessionLifecycle {
    SessionLifecycle {
        state,
        reason: Some(reason.to_string()),
        last_transition_at: now_iso(),
    }
}

/// JSON-channel boot reconciliation (Decision 11): a session left `working`
/// had its turn killed by the restart -> reconcile to `idle`. A fresh
/// `not_started` JSON session is normal and stays untouched. Returns `None` to
/// leave the state untouched.
fn recover_json_session(session: &SessionRecord) -> Option<SessionLifecycle> {
    if session.lifecycle.state == LifecycleState::Working {
        return Some(lifecycle(LifecycleState::Idle, "json-restart-reconcile"));
    }
    None
}

/// Best-effort identity check before killing a pidfile-recorded PID on boot:
/// read `/proc/<pid>/stat`'s `(comm)` field and confirm it's still one of our
/// own CLI binaries. Returns `true` (proceed with the kill) whenever the check
/// is inconclusive — no `/proc` (non-Linux), unreadable entry — narrowing the
/// blast radius without weakening the sweep's best-effort guarantee.
pub fn verify_pid_is_turn_process(pid: i32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return true; // no /proc, or pid already gone — inconclusive, proceed
    };
    // `pid (comm) state ppid …` — comm can contain spaces/parens, so read
    // between the FIRST '(' and the LAST ')' rather than naive splitting.
    let Some(open) = stat.find('(') else {
        return true; // unparseable — don't block the sweep
    };
    let Some(close) = stat.rfind(')') else {
        return true;
    };
    if close <= open {
        return true;
    }
    let comm = &stat[open + 1..close];
    KNOWN_TURN_BINARIES.contains(&comm)
}

/// Boot-time orphan sweep (Decision 13): a JSON turn child is spawned in its
/// own process group and mirrors its PID to `<dataDir>/turn.pids`. On an
/// unclean restart that child can survive, so before we recover session state
/// we SIGKILL any recorded-but-orphaned turn process groups and delete the
/// stale pidfiles. Best-effort throughout.
pub async fn sweep_orphan_turn_pids(store: &StoreHandle, paths: &Paths) {
    let projects = store.get_all_projects().await;
    let mut pid_files: Vec<PathBuf> = Vec::new();
    for project in &projects {
        for wt in &project.worktrees {
            for s in &wt.sessions {
                if session_is_json(s) {
                    pid_files.push(
                        paths
                            .session_data_dir(&project.id, &wt.id, &s.id)
                            .join("turn.pids"),
                    );
                }
            }
        }
        for s in &project.direct_sessions {
            if session_is_json(s) {
                pid_files.push(
                    paths
                        .direct_session_data_dir(&project.id, &s.id)
                        .join("turn.pids"),
                );
            }
        }
    }

    tokio::task::spawn_blocking(move || {
        for pid_file in pid_files {
            if !pid_file.exists() {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&pid_file) {
                for line in content.split('\n') {
                    let pid = line.trim().parse::<i32>().unwrap_or(0);
                    if pid <= 1 {
                        continue;
                    }
                    if !verify_pid_is_turn_process(pid) {
                        continue; // PID-reuse guard
                    }
                    // SIGKILL the whole process group (detached turn child).
                    let _ = std::process::Command::new("kill")
                        .arg("-KILL")
                        .arg(format!("-{pid}"))
                        .status();
                }
            }
            let _ = std::fs::remove_file(&pid_file);
        }
    })
    .await
    .ok();
}

/// Boot sweep (runs AFTER `recover_not_started_sessions`): a direct-pty PTY is
/// a child of the daemon process, so it dies on restart and cannot be
/// recovered — mark any non-exited direct-pty worktree session `exited`. JSON
/// sessions are SKIPPED (they have no direct-pty stream).
pub async fn sweep_direct_pty_sessions_on_boot(store: &StoreHandle, _paths: &Paths) {
    let projects = store.get_all_projects().await;
    for project in projects {
        let mut decisions: HashMap<String, SessionLifecycle> = HashMap::new();
        let mut direct_decisions: HashMap<String, SessionLifecycle> = HashMap::new();
        for wt in &project.worktrees {
            for session in &wt.sessions {
                if session_is_json(session) {
                    continue;
                }
                if !session.use_tmux && session.lifecycle.state != LifecycleState::Exited {
                    decisions.insert(
                        session.id.clone(),
                        lifecycle(LifecycleState::Exited, "direct-pty-died-with-daemon"),
                    );
                }
            }
        }
        for session in &project.direct_sessions {
            if session_is_json(session) {
                continue;
            }
            if !session.use_tmux && session.lifecycle.state != LifecycleState::Exited {
                direct_decisions.insert(
                    session.id.clone(),
                    lifecycle(LifecycleState::Exited, "direct-pty-died-with-daemon"),
                );
            }
        }
        if decisions.is_empty() && direct_decisions.is_empty() {
            continue;
        }
        apply_decisions(store, &project.id, decisions, direct_decisions).await;
    }
}

/// Boot-time recovery for sessions stuck at `not_started` after an unclean
/// daemon restart. Kills orphaned JSON turn processes first.
pub async fn recover_not_started_sessions(
    store: &StoreHandle,
    tmux: &dyn SessionLiveness,
    direct_pty: &DirectPtyRegistry,
    paths: &Paths,
) {
    sweep_orphan_turn_pids(store, paths).await;

    let projects = store.get_all_projects().await;
    for project in projects {
        let mut worktree_decisions: HashMap<String, SessionLifecycle> = HashMap::new();
        let mut direct_decisions: HashMap<String, SessionLifecycle> = HashMap::new();

        // Recover worktree sessions
        for wt in &project.worktrees {
            for session in &wt.sessions {
                if session_is_json(session) {
                    if let Some(decision) = recover_json_session(session) {
                        worktree_decisions.insert(session.id.clone(), decision);
                    }
                    continue;
                }
                if session.lifecycle.state != LifecycleState::NotStarted {
                    continue;
                }
                let decision = if !session.use_tmux {
                    // Direct-pty sessions can't survive a restart; the registry
                    // is empty on boot.
                    if direct_pty.has(&session.id) {
                        lifecycle(LifecycleState::Working, "recovered-from-not-started")
                    } else {
                        lifecycle(LifecycleState::Exited, "daemon-restart-during-spawn")
                    }
                } else if tmux.has_session(&session.tmux_name) {
                    lifecycle(LifecycleState::Working, "recovered-from-not-started")
                } else {
                    lifecycle(LifecycleState::Exited, "daemon-restart-during-spawn")
                };
                worktree_decisions.insert(session.id.clone(), decision);
            }
        }

        // Recover direct sessions
        for session in &project.direct_sessions {
            if session_is_json(session) {
                if let Some(decision) = recover_json_session(session) {
                    direct_decisions.insert(session.id.clone(), decision);
                }
                continue;
            }
            if session.lifecycle.state != LifecycleState::NotStarted {
                continue;
            }
            let decision = if !session.use_tmux {
                if direct_pty.has(&session.id) {
                    lifecycle(LifecycleState::Working, "recovered-from-not-started")
                } else {
                    lifecycle(LifecycleState::Exited, "daemon-restart-during-spawn")
                }
            } else if tmux.has_session(&session.tmux_name) {
                lifecycle(LifecycleState::Working, "recovered-from-not-started")
            } else {
                lifecycle(LifecycleState::Exited, "daemon-restart-during-spawn")
            };
            direct_decisions.insert(session.id.clone(), decision);
        }

        if worktree_decisions.is_empty() && direct_decisions.is_empty() {
            continue;
        }
        apply_decisions(store, &project.id, worktree_decisions, direct_decisions).await;
    }
}

async fn apply_decisions(
    store: &StoreHandle,
    project_id: &str,
    worktree_decisions: HashMap<String, SessionLifecycle>,
    direct_decisions: HashMap<String, SessionLifecycle>,
) {
    let project_id = project_id.to_string();
    let _ = store
        .mutate_project(&project_id, move |p| {
            for w in &mut p.worktrees {
                for s in &mut w.sessions {
                    if let Some(decision) = worktree_decisions.get(&s.id) {
                        s.lifecycle = decision.clone();
                    }
                }
            }
            for s in &mut p.direct_sessions {
                if let Some(decision) = direct_decisions.get(&s.id) {
                    s.lifecycle = decision.clone();
                }
            }
            Ok(p.clone())
        })
        .await;
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_iso(secs)
}

fn format_iso(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let rem = unix_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.000Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
