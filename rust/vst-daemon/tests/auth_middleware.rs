//! Tests for the auth middleware assembled into the full Axum Router.
//!
//! Uses `tower::ServiceExt::oneshot` — no real TCP port is ever bound.
//! All temporary state uses `tempfile::tempdir()`, never `~/.vibe-station`.

use std::sync::Arc;
use std::time::Instant;

use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::auth::{mint_token, AuthState};
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::events::Broadcaster;

use vst_daemon::server::{build_app, BuildServerOptions};

fn make_opts(
    tmp: &std::path::Path,
    auth_state: Option<AuthState>,
    no_auth: bool,
) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        port: 0,
        auth_state,
        no_auth,
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

/// Simulate a non-loopback (tunnel) request by setting `cf-connecting-ip`.
/// Without this header the middleware treats the request as loopback (unit-test
/// default) and skips token verification entirely.
fn remote_get(uri: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri(uri)
        .method("GET")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap()
}

fn remote_get_with_auth(uri: &str, token: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri(uri)
        .method("GET")
        .header("cf-connecting-ip", "1.2.3.4")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::empty())
        .unwrap()
}

#[tokio::test]
async fn auth_middleware_rejects_unauthenticated_remote_request() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router.oneshot(remote_get("/sessions")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_rejects_tampered_bearer_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(remote_get_with_auth(
            "/sessions",
            "totally-fake-token-that-wont-verify",
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_allows_valid_cli_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let valid_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(remote_get_with_auth("/sessions", &valid_token))
        .await
        .unwrap();

    // Auth passed — route handler runs and returns a non-401 response.
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn auth_middleware_allows_everything_in_no_auth_mode() {
    let tmp = tempdir().unwrap();
    // no_auth = true, no auth_state provided
    let router = build_app(make_opts(tmp.path(), None, true));

    // No token, still a "remote" request
    let resp = router.oneshot(remote_get("/sessions")).await.unwrap();

    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn auth_middleware_exempts_health_endpoint() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    // /health is exempt even from remote requests
    let req = Request::builder()
        .uri("/health")
        .method("GET")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}
