//! HTTP-level tests for `GET /api/doctor` and `POST /api/oobe/step2`.
//!
//! Follows `worktree_routes_http.rs` pattern: `vst_daemon::server::build_app` +
//! `tower::ServiceExt::oneshot`, `tempfile::tempdir()` for isolation, no real
//! TCP port is bound. `no_auth = true` so no token is needed.

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
use vst_types::rest::doctor::DoctorReport;
use vst_types::rest::oobe::OobeStateResponse;

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
    }
}

#[tokio::test]
async fn test_get_api_doctor_returns_report_with_checks() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());

    let db_path = tmp.path().join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();

    let router = build_app(make_opts(tmp.path(), store));

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/doctor")
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
    let report: DoctorReport = serde_json::from_slice(&bytes).unwrap();

    assert!(
        report.checks.len() >= 9,
        "Expected at least 9 checks, got {}",
        report.checks.len()
    );

    let names: Vec<&str> = report.checks.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"tmux"));
    assert!(names.contains(&"git"));
    assert!(names.contains(&"daemon-reachable"));
    assert!(names.contains(&"plugin-claude"));
    assert!(names.contains(&"bun"));
    assert!(names.contains(&"cloudflared"));
    assert!(names.contains(&"tailscale"));
    assert!(names.contains(&"orphan-sessions"));
    assert!(names.contains(&"orphan-worktrees"));
}

#[tokio::test]
async fn test_post_api_oobe_step2_advances_to_step_3() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());

    let db_path = tmp.path().join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();

    let router = build_app(make_opts(tmp.path(), store));

    // Confirm step 1 first
    let projects_dir = tmp.path().join("projects");
    std::fs::create_dir_all(&projects_dir).unwrap();
    let step1_body = serde_json::json!({
        "defaultProjectsDir": projects_dir.to_string_lossy().to_string()
    });

    let resp1 = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/oobe/step1")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(step1_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp1.status(), StatusCode::OK);

    // Confirm step 2
    let resp2 = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/oobe/step2")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(resp2.into_body(), usize::MAX)
        .await
        .unwrap();
    let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(val, serde_json::json!({ "ok": true }));

    // Verify GET /api/oobe/state shows currentStep: 3
    let resp_state = router
        .oneshot(
            Request::builder()
                .uri("/api/oobe/state")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp_state.status(), StatusCode::OK);

    let bytes = axum::body::to_bytes(resp_state.into_body(), usize::MAX)
        .await
        .unwrap();
    let state: OobeStateResponse = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(state.current_step, 3);
}
