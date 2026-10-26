//! HTTP-level tests for `POST /api/sessions/:id/reset` body validation.
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
async fn reset_with_unknown_carry_over_is_400_and_unknown_session_is_404() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let post = |body: serde_json::Value| {
        let router = router.clone();
        async move {
            let resp = router
                .oneshot(
                    Request::builder()
                        .uri("/api/sessions/nope/reset")
                        .method("POST")
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            resp.status()
        }
    };

    // axum's typed `Json<ResetBody>` would answer 422 here; every other
    // route reports a bad body as 400.
    assert_eq!(
        post(serde_json::json!({ "carryOver": "bogus" })).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(serde_json::json!({ "carryOver": "nothing" })).await,
        StatusCode::BAD_REQUEST
    );
    // A valid body reaches the handler (session does not exist).
    assert_eq!(
        post(serde_json::json!({ "carryOver": "none" })).await,
        StatusCode::NOT_FOUND
    );
}
