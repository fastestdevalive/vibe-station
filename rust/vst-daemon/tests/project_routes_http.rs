//! HTTP-level tests for `GET /api/projects/:id/file-search`.

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
use vst_types::rest::worktrees::FileSearchResult;
use vst_types::ProjectRecord;

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

#[tokio::test]
async fn test_project_file_search_http() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("test.db")).unwrap();

    let proj_dir = tempdir().unwrap();
    std::fs::create_dir_all(proj_dir.path().join("src")).unwrap();
    std::fs::write(proj_dir.path().join("src/main.rs"), "fn main() {}").unwrap();

    let proj = ProjectRecord {
        id: "proj-search".into(),
        absolute_path: proj_dir.path().to_string_lossy().to_string(),
        prefix: "ps".into(),
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

    // 1. Existing project: GET /api/projects/proj-search/file-search?q=main
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/projects/proj-search/file-search?q=main")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let result: FileSearchResult = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result.files[0], "src/main.rs");
    assert!(!result.truncated);

    // 2. Unknown project: GET /api/projects/unknown/file-search?q=main -> 404
    let resp_404 = router
        .oneshot(
            Request::builder()
                .uri("/api/projects/unknown/file-search?q=main")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp_404.status(), StatusCode::NOT_FOUND);
}
