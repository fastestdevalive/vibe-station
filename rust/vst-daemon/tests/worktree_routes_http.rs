//! HTTP-level tests for `POST /api/worktrees` error mapping.
//!
//! Follows `auth_middleware.rs`'s pattern: `vst_daemon::server::build_app` +
//! `tower::ServiceExt::oneshot`, `tempfile::tempdir()` for isolation, no real
//! TCP port is ever bound. `no_auth = true` so no token is needed.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::shared::Mode;
use vst_types::{CliId, ProjectRecord};

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};

fn make_opts(tmp: &std::path::Path, store: StoreHandle) -> BuildServerOptions {
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster,
        json_registry,
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths,
        limits: vst_harness_limits::LimitsHandle::inert(
            vst_types::events::Broadcaster::new(16),
            "test".to_string(),
        ),
    }
}

fn setup_temp_mode(home_path: &std::path::Path, mode_id: &str, cli: CliId) {
    let vst_dir = home_path.join(".vibe-station");
    std::fs::create_dir_all(&vst_dir).unwrap();
    let mode = Mode {
        id: mode_id.to_string(),
        name: mode_id.to_string(),
        cli,
        context: "test-context".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        model: Some("test-model".to_string()),
        icon: None,
    };
    let modes_json = serde_json::to_string(&vec![mode]).unwrap();
    std::fs::write(vst_dir.join("modes.json"), modes_json).unwrap();
}

#[tokio::test]
async fn create_worktree_on_non_git_project_returns_422_not_git() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    setup_temp_mode(tmp.path(), "test-mode", CliId::Claude);

    let db_path = tmp.path().join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();

    // Non-git project: the path exists on disk but is not a git repository.
    let non_git_dir = tempdir().unwrap();
    let proj = ProjectRecord {
        id: "proj-nongit".into(),
        absolute_path: non_git_dir.path().to_string_lossy().to_string(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    };
    store.add_project(proj).await.unwrap();

    let router = build_app(make_opts(tmp.path(), store));

    let body = serde_json::json!({
        "projectId": "proj-nongit",
        "modeId": "test-mode",
        "skipAutoTurn": true
    });

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/worktrees")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(val, serde_json::json!({ "error": "NOT_GIT" }));
}

/// An orphan worktree (listed in the store, folder deleted outside
/// vibe-station) with a still-"working" session must delete cleanly through the
/// plain `DELETE /api/worktrees/:id` the doctor's Forget button calls: no
/// done-check, no failure on the missing directory.
#[tokio::test]
async fn delete_orphan_worktree_with_running_session_succeeds() {
    use vst_types::{LifecycleState, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord};

    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();

    let repo_dir = tempdir().unwrap();
    let session = SessionRecord {
        id: "orph-s1".into(),
        worktree_id: Some("orph-1".into()),
        project_id: "proj-orph".into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: "orph-s1-pane".into(),
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
            id: "proj-orph".into(),
            absolute_path: repo_dir.path().to_string_lossy().to_string(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![],
            direct_session_seq: Some(1),
            worktrees: vec![WorktreeRecord {
                id: "orph-1".into(),
                name: None,
                branch: "feat".into(),
                branch_is_placeholder: None,
                base_branch: "main".into(),
                base_sha: "a".repeat(40),
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

    let router = build_app(make_opts(tmp.path(), store.clone()));
    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/worktrees/orph-1")
                .method("DELETE")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let project = store.get_project("proj-orph").await.unwrap();
    assert!(
        project.worktrees.iter().all(|w| w.id != "orph-1"),
        "worktree must be gone from the store"
    );
}
