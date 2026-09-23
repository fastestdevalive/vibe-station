//! Regression tests for the `handle_fallback` path-traversal guard.
//!
//! The fallback serves the SPA `dist` directory, but must never serve a file
//! outside it, even when the request path contains `..` segments (literal or
//! percent-encoded). Uses `tower::ServiceExt::oneshot` — no real TCP port is
//! ever bound, and all state lives under a `tempfile::tempdir()`.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::auth::AuthState;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

use vst_daemon::server::{build_app, BuildServerOptions};

fn make_opts(tmp: &Path, dist_path: std::path::PathBuf) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        port: 0,
        auth_state: Some(AuthState::new("super-secret-token", 0)),
        no_auth: false,
        dist_path: Some(dist_path),
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

/// A non-loopback (tunnel) request — otherwise the middleware skips auth as a
/// loopback unit-test default.
fn remote_get(uri: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri(uri)
        .method("GET")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap()
}

/// Build a temp dir acting as the SPA `dist` root, with a real file inside and
/// a sentinel file just outside it.
struct DistFixture {
    tmp: tempfile::TempDir,
    dist: std::path::PathBuf,
}

impl DistFixture {
    fn new() -> Self {
        let tmp = tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(dist.join("assets").join("hello.txt"), "inside-content").unwrap();
        std::fs::write(dist.join("index.html"), "<html>index</html>").unwrap();
        let outside_secret = tmp.path().join("outside-secret.txt");
        std::fs::write(&outside_secret, "TOP-SECRET").unwrap();
        Self { tmp, dist }
    }
}

#[tokio::test]
async fn traversal_assets_dotdot_is_rejected_not_served() {
    let fx = DistFixture::new();
    let router = build_app(make_opts(fx.tmp.path(), fx.dist.clone()));

    let resp = router
        .oneshot(remote_get("/assets/../../../../etc/hostname"))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("inside-content"));
    assert!(!text.contains("TOP-SECRET"));
    assert!(!text.contains("hostname"));
}

#[tokio::test]
async fn traversal_percent_encoded_dotdot_is_rejected() {
    let fx = DistFixture::new();
    let router = build_app(make_opts(fx.tmp.path(), fx.dist.clone()));

    let resp = router
        .oneshot(remote_get("/assets/%2e%2e/%2e%2e/%2e%2e/etc/hostname"))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("TOP-SECRET"));
}

#[tokio::test]
async fn traversal_mixed_dotdot_and_dotdotdot_is_rejected() {
    let fx = DistFixture::new();
    let router = build_app(make_opts(fx.tmp.path(), fx.dist.clone()));

    // A path that lexically normalises to a location outside dist.
    let resp = router
        .oneshot(remote_get(&format!(
            "/assets/../../..{}",
            "/outside-secret.txt"
        )))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("TOP-SECRET"));
    assert!(!text.contains("outside-secret"));
}

#[tokio::test]
async fn legitimate_file_within_dist_is_still_served() {
    let fx = DistFixture::new();
    let router = build_app(make_opts(fx.tmp.path(), fx.dist.clone()));

    let resp = router.oneshot(remote_get("/assets/hello.txt")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&body), "inside-content");
}
