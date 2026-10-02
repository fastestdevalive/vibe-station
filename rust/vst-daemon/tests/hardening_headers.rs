//! Tests for the security headers applied to raw-file and SPA responses.
//!
//! Raw files served to the browser (`handle_*_get_file`, LSP external files)
//! must carry `x-content-type-options: nosniff` and a sandboxed
//! `content-security-policy` so attacker-influenced repo content (SVG, HTML,
//! markdown) can't execute script with the daemon origin. The SPA fallback
//! carries a broader CSP that still allows the built UI (wasm, Google Fonts,
//! blob images). Uses `tower::ServiceExt::oneshot` — no real TCP port is ever
//! bound, and all state lives under a `tempfile::tempdir()`.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::auth::AuthState;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{
    build_app, harden_raw_file_response, BuildServerOptions, RAW_FILE_CSP, SPA_CSP,
};

fn make_opts(tmp: &Path, dist_path: std::path::PathBuf) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: Some(AuthState::new("super-secret-token", 0)),
        no_auth: false,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
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

/// Build a temp dir acting as the SPA `dist` root.
fn dist_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("assets").join("app.js"), "console.log(1)").unwrap();
    std::fs::write(dist.join("index.html"), "<html>index</html>").unwrap();
    (tmp, dist)
}

#[test]
fn harden_raw_file_response_keeps_content_type_and_sets_headers() {
    let resp = harden_raw_file_response(
        (
            [(axum::http::header::CONTENT_TYPE, "image/svg+xml")],
            "svg".to_string(),
        )
            .into_response(),
    );

    assert_eq!(
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .unwrap(),
        "image/svg+xml"
    );
    assert_eq!(
        resp.headers()
            .get(axum::http::header::X_CONTENT_TYPE_OPTIONS)
            .unwrap(),
        "nosniff"
    );
    let csp = resp
        .headers()
        .get(axum::http::header::CONTENT_SECURITY_POLICY)
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(csp, RAW_FILE_CSP);
    assert!(csp.starts_with("sandbox"));
}

#[tokio::test]
async fn spa_fallback_sets_csp_on_index_and_assets() {
    let (tmp, dist) = dist_fixture();
    let router = build_app(make_opts(tmp.path(), dist));

    for uri in ["/", "/assets/app.js"] {
        let resp = router.clone().oneshot(remote_get(uri)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{} should be served", uri);
        let csp = resp
            .headers()
            .get(axum::http::header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(csp, SPA_CSP, "{} should carry the SPA CSP", uri);
    }
}

#[test]
fn spa_csp_allows_wasm_and_forbids_inline_script() {
    assert!(SPA_CSP.contains("script-src 'self' 'wasm-unsafe-eval'"));
    // Find the script-src directive and assert it has no 'unsafe-inline'.
    let script_src = SPA_CSP
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("script-src"))
        .expect("SPA_CSP should have a script-src directive");
    assert!(!script_src.contains("'unsafe-inline'"));
}
