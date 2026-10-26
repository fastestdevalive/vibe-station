//! End-to-end integration test for diffstat poller with real git repo (plan Phase 5.T3).

use std::fs;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use tempfile::tempdir;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};
use vst_ws::connection::{WsConnection, WsSinkHandle};

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, BuildServerOptions};

fn run_git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git failed to spawn");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_string()
}

#[tokio::test]
async fn diffstat_e2e_file_edit_activity_and_client_gate() {
    let tmp = tempdir().unwrap();
    let paths = Paths::with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    let broadcaster = Broadcaster::new(64);

    let wt_dir = paths.worktree_path("proj-1", "wt-1");
    fs::create_dir_all(&wt_dir).unwrap();

    // Set up git repo
    run_git(&wt_dir, &["init", "-q", "-b", "main"]);
    run_git(&wt_dir, &["config", "user.email", "test@example.com"]);
    run_git(&wt_dir, &["config", "user.name", "Test"]);

    fs::write(wt_dir.join("file.txt"), "line 1\n").unwrap();
    run_git(&wt_dir, &["add", "file.txt"]);
    run_git(&wt_dir, &["commit", "-m", "init"]);
    let base_sha = run_git(&wt_dir, &["rev-parse", "HEAD"]);

    run_git(&wt_dir, &["checkout", "-b", "feat"]);
    fs::write(wt_dir.join("file.txt"), "line 1\nline 2\n").unwrap();
    run_git(&wt_dir, &["add", "file.txt"]);
    run_git(&wt_dir, &["commit", "-m", "add line 2"]);

    // Seed store
    let session = SessionRecord {
        id: "sess-1".into(),
        worktree_id: Some("wt-1".into()),
        project_id: "proj-1".into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: "vst-sess-1".into(),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    };
    store
        .add_project(ProjectRecord {
            id: "proj-1".into(),
            absolute_path: wt_dir.to_string_lossy().into(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(1),
            worktrees: vec![WorktreeRecord {
                id: "wt-1".into(),
                name: None,
                branch: "feat".into(),
                branch_is_placeholder: None,
                base_branch: "main".into(),
                base_sha,
                created_at: "2026-01-01T00:00:00.000Z".into(),
                pinned_at: None,
                hidden_at: None,
                sort_order: 0.0,
                terminal_seq: Some(0),
                agent_seq: Some(1),
                lsp_enabled: None,
                sessions: vec![session],
                open_files: vec![],
            }],
            next_worktree_num: Some(2),
            lsp_enabled: None,
            open_files: vec![],
        })
        .await
        .unwrap();

    let opts = BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster: broadcaster.clone(),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: vst_proc::test_support::isolated_tmux(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths,
        limits: vst_harness_limits::LimitsHandle::inert(broadcaster.clone(), "test".to_string()),
        update: vst_daemon::update::UpdateService::for_tests(tmp.path()),
    };

    let state = build_state(opts);
    let diffstat_poller = state.diffstat_poller.clone();
    let ws_hub = state.ws_hub.clone();

    let poller_task = diffstat_poller.start();
    let mut rx = broadcaster.subscribe();

    // Part A: Zero clients connected => editing/activity does NOT produce a diffstat event
    broadcaster.send(ServerEvent::SessionActivity {
        session_id: "sess-1".into(),
        last_activity_at: "2026-01-01T00:00:01.000Z".into(),
        last_line: None,
        last_tool: Some(vst_types::activity::ToolActivity {
            name: "Edit".into(),
            detail: Some("file.txt".into()),
        }),
    });

    // Wait past debounce (2 s)
    let recv_timeout = tokio::time::timeout(std::time::Duration::from_millis(2500), async {
        loop {
            match rx.recv().await {
                Ok(ServerEvent::WorktreeDiffStat { .. }) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await;

    // Timeout elapsed without receiving WorktreeDiffStat because gate is closed (0 clients)
    assert!(
        recv_timeout.is_err(),
        "Zero clients gate must suppress diffstat compute"
    );

    // Part B: Client connects => gate opens and backlog drains
    let conn = WsConnection::new(WsSinkHandle::mock(0));
    ws_hub.register_connection(&conn);

    // Expect WorktreeDiffStat within a reasonable timeout
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(ServerEvent::WorktreeDiffStat {
                    worktree_id,
                    insertions,
                    deletions,
                    state,
                    rev,
                    ..
                }) => return (worktree_id, insertions, deletions, state, rev),
                Ok(_) => continue,
                Err(e) => panic!("channel error: {e}"),
            }
        }
    })
    .await
    .expect("Must receive WorktreeDiffStat after client connects");

    assert_eq!(event.0, "wt-1");
    assert_eq!(event.1, 1, "insertions must match 1 added line");
    assert_eq!(event.2, 0, "deletions must match 0 deleted lines");
    assert_eq!(event.3, vst_types::rest::worktrees::DiffStatState::Ok);
    assert!(event.4 > 0, "rev must be > 0");

    ws_hub.unregister_connection(&conn);
    poller_task.abort();
}
