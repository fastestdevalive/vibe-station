//! `GET /api/worktrees/diffstats` route tests (plan poller-redesign Phase 5.T1).

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::worktrees::DiffStatsSnapshot;
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_state, router_from_state, BuildServerOptions};

fn make_opts(tmp: &std::path::Path, store: StoreHandle) -> BuildServerOptions {
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: vst_proc::test_support::isolated_tmux(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.to_path_buf()),
        limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".to_string()),
        update: vst_daemon::update::UpdateService::for_tests(tmp),
    }
}

async fn seed(store: &StoreHandle) {
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
            state: LifecycleState::Idle,
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
            absolute_path: "/tmp/proj-1".into(),
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
}

#[tokio::test]
async fn diffstats_snapshot_route_returns_200_and_marks_dirty() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    seed(&store).await;

    let state = build_state(make_opts(tmp.path(), store));
    let diffstat_poller = state.diffstat_poller.clone();
    let router = router_from_state(state);

    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/worktrees/diffstats")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot: DiffStatsSnapshot = serde_json::from_slice(&bytes).unwrap();
    // Initially empty cache before background compute
    assert!(snapshot.stats.is_empty() || snapshot.stats.contains_key("wt-1"));

    // Snapshot marks uncomputed/stale worktrees dirty
    assert!(
        diffstat_poller.has_pending("wt-1"),
        "snapshot must mark uncomputed worktrees dirty"
    );
}

#[tokio::test]
async fn diffstats_not_captured_as_id_parameter() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    seed(&store).await;

    let state = build_state(make_opts(tmp.path(), store));
    let router = router_from_state(state);

    // If route order were wrong, /api/worktrees/diffstats might be captured
    // as /api/worktrees/:id (which has no GET, so would 405 MethodNotAllowed)
    // or /api/worktrees/:id/diffstat (404/422).
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/worktrees/diffstats")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn legacy_diffstat_route_returns_422_on_unresolvable_worktree() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    seed(&store).await;

    let state = build_state(make_opts(tmp.path(), store));
    let router = router_from_state(state);

    // /api/worktrees/wt-1/diffstat legacy route: git directory doesn't exist,
    // so legacy route returns 422 (UnprocessableEntity), unchanged.
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/worktrees/wt-1/diffstat")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
