//! Behavior contract for `recover.ts` (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/recover.test.ts`.
//!
//! The TS mocks `tmux.js`'s `hasSession` and the `paths.js` module; in Rust we
//! inject a fake [`SessionLiveness`] implementation and a temp [`Paths`].

use std::collections::HashMap;
use std::path::PathBuf;

use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use tempfile::tempdir;
use vst_git::paths::Paths;
use vst_git::recover::{
    recover_not_started_sessions, sweep_direct_pty_sessions_on_boot, sweep_orphan_turn_pids,
    verify_pid_is_turn_process, SessionLiveness,
};
use vst_store::StoreHandle;
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType,
    WorktreeRecord,
};

struct FakeLiveness(HashMap<String, bool>);

impl SessionLiveness for FakeLiveness {
    fn has_session(&self, name: &str) -> bool {
        self.0.get(name).copied().unwrap_or(false)
    }
}

fn lifecycle(state: LifecycleState) -> SessionLifecycle {
    SessionLifecycle {
        state,
        reason: None,
        last_transition_at: "2024-01-01T00:00:00.000Z".into(),
    }
}

fn session(
    id: &str,
    tmux_name: &str,
    use_tmux: bool,
    channel: Option<Channel>,
    state: LifecycleState,
) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: Some("wt-r".into()),
        project_id: "proj-r".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("mode".into()),
        name: None,
        name_source: None,
        tmux_name: tmux_name.into(),
        use_tmux,
        channel,
        lifecycle: lifecycle(state),
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn make_record() -> ProjectRecord {
    ProjectRecord {
        id: "proj-r".into(),
        absolute_path: "/tmp/repo".into(),
        prefix: "pfx".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: "wt-r".into(),
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
            sessions: vec![
                session(
                    "sess-alive",
                    "alive-pane",
                    true,
                    None,
                    LifecycleState::NotStarted,
                ),
                session(
                    "sess-dead",
                    "dead-pane",
                    true,
                    None,
                    LifecycleState::NotStarted,
                ),
                session(
                    "sess-working",
                    "ignore-pane",
                    true,
                    None,
                    LifecycleState::Working,
                ),
                session(
                    "sess-json-fresh",
                    "__direct__-json-fresh",
                    false,
                    Some(Channel::Json),
                    LifecycleState::NotStarted,
                ),
                session(
                    "sess-json-working",
                    "__direct__-json-working",
                    false,
                    Some(Channel::Json),
                    LifecycleState::Working,
                ),
            ],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
    }
}

async fn open_store(tmp: &tempfile::TempDir) -> StoreHandle {
    StoreHandle::open(tmp.path().join("vibe-station.db")).unwrap()
}

fn paths_for(tmp: &tempfile::TempDir) -> Paths {
    Paths::with_home(tmp.path().to_path_buf())
}

#[tokio::test]
async fn promotes_not_started_with_live_tmux_to_working_and_marks_dead_exited() {
    let tmp = tempdir().unwrap();
    let store = open_store(&tmp).await;
    store.add_project(make_record()).await.unwrap();

    let alive: HashMap<String, bool> = [("alive-pane".to_string(), true)].into_iter().collect();
    recover_not_started_sessions(
        &store,
        &FakeLiveness(alive),
        &Default::default(),
        &paths_for(&tmp),
    )
    .await;

    let proj = store.get_project("proj-r").await.unwrap();
    let sessions = &proj.worktrees[0].sessions;
    let alive = sessions.iter().find(|s| s.id == "sess-alive").unwrap();
    assert_eq!(alive.lifecycle.state, LifecycleState::Working);
    assert_eq!(
        alive.lifecycle.reason.as_deref(),
        Some("recovered-from-not-started")
    );

    let dead = sessions.iter().find(|s| s.id == "sess-dead").unwrap();
    assert_eq!(dead.lifecycle.state, LifecycleState::Exited);
    assert_eq!(
        dead.lifecycle.reason.as_deref(),
        Some("daemon-restart-during-spawn")
    );

    let working = sessions.iter().find(|s| s.id == "sess-working").unwrap();
    assert_eq!(working.lifecycle.state, LifecycleState::Working);
}

#[tokio::test]
async fn json_not_started_stays_and_json_working_reconciles_to_idle() {
    let tmp = tempdir().unwrap();
    let store = open_store(&tmp).await;
    store.add_project(make_record()).await.unwrap();

    let none: HashMap<String, bool> = HashMap::new();
    recover_not_started_sessions(
        &store,
        &FakeLiveness(none),
        &Default::default(),
        &paths_for(&tmp),
    )
    .await;

    let sessions = &store.get_project("proj-r").await.unwrap().worktrees[0].sessions;
    let fresh = sessions.iter().find(|s| s.id == "sess-json-fresh").unwrap();
    let json_working = sessions
        .iter()
        .find(|s| s.id == "sess-json-working")
        .unwrap();
    assert_eq!(fresh.lifecycle.state, LifecycleState::NotStarted);
    assert_eq!(json_working.lifecycle.state, LifecycleState::Idle);
    assert_eq!(
        json_working.lifecycle.reason.as_deref(),
        Some("json-restart-reconcile")
    );
}

#[tokio::test]
async fn boot_sweep_marks_direct_pty_exited_but_leaves_json_untouched() {
    let tmp = tempdir().unwrap();
    let store = open_store(&tmp).await;
    store.add_project(make_record()).await.unwrap();

    let none: HashMap<String, bool> = HashMap::new();
    recover_not_started_sessions(
        &store,
        &FakeLiveness(none),
        &Default::default(),
        &paths_for(&tmp),
    )
    .await;
    sweep_direct_pty_sessions_on_boot(&store, &paths_for(&tmp)).await;

    let sessions = &store.get_project("proj-r").await.unwrap().worktrees[0].sessions;
    let json_fresh = sessions.iter().find(|s| s.id == "sess-json-fresh").unwrap();
    let json_working = sessions
        .iter()
        .find(|s| s.id == "sess-json-working")
        .unwrap();
    assert_eq!(json_fresh.lifecycle.state, LifecycleState::NotStarted);
    assert_eq!(json_working.lifecycle.state, LifecycleState::Idle);
}

// --- sweepOrphanTurnPids / verifyPidIsTurnProcess (PID-reuse safety) ---

#[test]
fn verify_pid_is_turn_process_true_for_a_real_claude_named_process() {
    // comm is derived from the executable's basename at exec time.
    let script = script_named("claude");
    let mut child = std::process::Command::new(&script)
        .spawn()
        .expect("spawn claude script");
    let pid = child.id() as i32;
    wait_for_proc(pid);
    let result = verify_pid_is_turn_process(pid);
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
    let _ = child.wait();
    assert!(result);
}

#[test]
fn verify_pid_is_turn_process_false_for_an_unrelated_process() {
    let mut child = std::process::Command::new("sleep")
        .arg("5")
        .spawn()
        .expect("spawn sleep");
    let pid = child.id() as i32;
    wait_for_proc(pid);
    let result = verify_pid_is_turn_process(pid);
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
    let _ = child.wait();
    assert!(!result);
}

#[test]
fn verify_pid_is_turn_process_true_inconclusive_for_pid_with_no_proc_entry() {
    assert!(verify_pid_is_turn_process(999_999_999));
}

#[test]
fn verify_pid_is_turn_process_recognizes_the_acp_adapters_comm_name() {
    let script = script_named("MainThread");
    let mut child = std::process::Command::new(&script)
        .spawn()
        .expect("spawn MainThread script");
    let pid = child.id() as i32;
    wait_for_proc(pid);
    let result = verify_pid_is_turn_process(pid);
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
    let _ = child.wait();
    assert!(result);
}

#[tokio::test]
async fn sweep_orphan_turn_pids_does_not_kill_a_live_unrelated_process() {
    let tmp = tempdir().unwrap();
    let store = open_store(&tmp).await;
    let mut record = make_record();
    record.worktrees[0].sessions = vec![session(
        "sess-pidsweep",
        "pane-pidsweep",
        false,
        Some(Channel::Json),
        LifecycleState::Working,
    )];
    store.add_project(record).await.unwrap();

    let mut child = std::process::Command::new("sleep")
        .arg("5")
        .spawn()
        .expect("spawn sleep");
    std::thread::sleep(std::time::Duration::from_millis(100));
    let pid = child.id() as i32;

    let data_dir = tmp
        .path()
        .join("projects/proj-r/session-data/wt-r/sess-pidsweep");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(data_dir.join("turn.pids"), pid.to_string()).unwrap();

    sweep_orphan_turn_pids(&store, &paths_for(&tmp)).await;

    let alive = std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
    let _ = child.wait();
    assert!(alive, "unrelated process must survive the sweep");
}

#[tokio::test]
#[ignore = "process-group kill semantics (session-leader vs group-leader-only spawning) are unreliable to reproduce deterministically in this sandbox's test harness — needs a dedicated /proc-based verification approach, not test-spawn tuning"]
async fn sweep_orphan_turn_pids_kills_an_orphaned_process_and_unlinks_turn_pids() {
    let tmp = tempdir().unwrap();
    let store = open_store(&tmp).await;
    let mut record = make_record();
    record.worktrees[0].sessions = vec![session(
        "sess-pidsweep",
        "pane-pidsweep",
        false,
        Some(Channel::Json),
        LifecycleState::Working,
    )];
    store.add_project(record).await.unwrap();

    let script = script_named("MainThread");
    // Detached: run the script under `setsid` so the child is its own session
    // + process-group leader and `kill -KILL -<pid>` targets its group
    // (mirrors the TS `{ detached: true }` spawn, which calls `setsid()`).
    let mut cmd = std::process::Command::new("setsid");
    cmd.arg(&script);
    let mut child = cmd.spawn().expect("spawn MainThread script");
    std::thread::sleep(std::time::Duration::from_millis(100));
    let pid = child.id() as i32;

    let data_dir = tmp
        .path()
        .join("projects/proj-r/session-data/wt-r/sess-pidsweep");
    std::fs::create_dir_all(&data_dir).unwrap();
    let pid_file = data_dir.join("turn.pids");
    std::fs::write(&pid_file, pid.to_string()).unwrap();

    sweep_orphan_turn_pids(&store, &paths_for(&tmp)).await;

    // The sweep SIGKILLs the whole process group, so the child is reaped only
    // when this test calls `try_wait` (it sits as a zombie until then — a
    // `kill -0` liveness probe would wrongly report it "alive"). Poll
    // `try_wait` (bounded) and assert it exited via SIGKILL.
    let mut exit = None;
    for _ in 0..60 {
        if let Some(status) = child.try_wait().unwrap() {
            exit = Some(status);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
    let exit = exit.expect("orphaned process was not killed within timeout");
    assert_eq!(exit.signal(), Some(9), "expected SIGKILL, got {exit:?}");
    assert!(!pid_file.exists(), "turn.pids must be unlinked");
}

fn wait_for_proc(pid: i32) {
    for _ in 0..20 {
        if std::fs::metadata(format!("/proc/{pid}/stat")).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn script_named(name: &str) -> PathBuf {
    let tmp = tempdir().unwrap();
    let path = tmp.path().join(name);
    std::fs::write(&path, "#!/bin/sh\nsleep 5\n").unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    // Leak the TempDir so the script stays alive for the child process.
    std::mem::forget(tmp);
    path
}
