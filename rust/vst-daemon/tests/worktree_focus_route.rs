//! `POST /api/worktrees/:id/focus` — the client tells the daemon which
//! worktree it just opened so the pollers can refresh it sooner.
//!
//! Mounted under `/api` like every other REST route; `204` on a known
//! worktree, `404` on an unknown one. The PR hint closure is registered in
//! `build_state`, so this exercises the real wiring (no stubs).

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

async fn post_focus(router: axum::Router, worktree_id: &str) -> (StatusCode, axum::body::Body) {
    let response = router
        .oneshot(
            Request::builder()
                .uri(format!("/api/worktrees/{worktree_id}/focus"))
                .method("POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (status, response.into_body())
}

#[tokio::test]
async fn focus_returns_204_and_hints_the_pr_poller() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    seed(&store).await;

    let state = build_state(make_opts(tmp.path(), store));
    let pr_poller = state.pr_poller.clone();
    let diffstat_poller = state.diffstat_poller.clone();
    let router = router_from_state(state);

    assert!(
        !pr_poller.has_pending(),
        "no hint yet: nothing pending before the request"
    );

    let (status, body) = post_focus(router, "wt-1").await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    assert!(bytes.is_empty(), "204 must have an empty body");

    assert!(
        pr_poller.has_pending(),
        "the registered focus hint must mark the PR poller dirty"
    );
    assert!(
        diffstat_poller.has_pending("wt-1"),
        "the registered focus hint must mark the diffstat poller dirty"
    );
}

#[tokio::test]
async fn focus_returns_404_for_an_unknown_worktree() {
    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();
    seed(&store).await;

    let state = build_state(make_opts(tmp.path(), store));
    let pr_poller = state.pr_poller.clone();
    let router = router_from_state(state);

    let (status, body) = post_focus(router, "nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        val.get("error").is_some(),
        "404 must carry the standard error body: {val}"
    );

    assert!(
        !pr_poller.has_pending(),
        "an unknown worktree must not hint any poller"
    );
}
