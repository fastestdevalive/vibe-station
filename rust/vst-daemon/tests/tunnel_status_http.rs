//! HTTP-level tests for `GET /api/auth/tunnel/status` (+ the `?binary=1` probe)
//! and `POST /api/auth/tunnel/enable` (phase 1 of `cloudflared-detached`).
//!
//! Follows `doctor_routes_http.rs`: `build_app` + `tower::ServiceExt::oneshot`,
//! `tempfile::tempdir()` for isolation, no real TCP port is bound.
//!
//! `VST_CLOUDFLARED_BIN` is process-global, so the tests that touch it are
//! serialised with a mutex. Every case uses the override (authoritative), which
//! makes the result independent of whatever `cloudflared` happens to be
//! installed on the machine running the tests.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::auth::{mint_token, AuthState};
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::events::Broadcaster;

/// Async-aware: these tests await the locator/probe while holding it.
static CF_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn make_opts(
    tmp: &std::path::Path,
    store: StoreHandle,
    auth_state: Option<AuthState>,
) -> BuildServerOptions {
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state,
        no_auth: false,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.to_path_buf()),
        limits: vst_harness_limits::LimitsHandle::inert(
            vst_types::events::Broadcaster::new(16),
            "test".to_string(),
        ),
    }
}

async fn get(router: axum::Router, uri: &str) -> (StatusCode, String) {
    let resp = router
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(unix)]
fn fake_cloudflared(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join("cloudflared");
    std::fs::write(&p, body).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

/// The plain call must stay byte-identical to the Node fixture
/// (`tests/fixtures/node_parity_fixtures.json`), i.e. the three new fields are
/// omitted rather than serialised as `null`.
#[tokio::test]
async fn plain_status_body_omits_the_binary_fields() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store, None));

    let (status, body) = get(router, "/api/auth/tunnel/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        r#"{"enabled":false,"tunnelUrl":null,"startedAt":null}"#
    );
}

#[cfg(unix)]
#[tokio::test]
async fn binary_flag_reports_installed_and_host_os() {
    let _guard = CF_ENV_LOCK.lock().await;
    let tmp = tempdir().unwrap();
    let home = with_home(tmp.path().to_path_buf());
    let bin = fake_cloudflared(
        tmp.path(),
        "#!/bin/sh\necho 'cloudflared version 2025.1.0 (built x)'\n",
    );
    std::env::set_var("VST_CLOUDFLARED_BIN", &bin);

    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store, None));
    let (status, body) = get(router, "/api/auth/tunnel/status?binary=1").await;
    std::env::remove_var("VST_CLOUDFLARED_BIN");
    drop(home);

    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["binary"]["state"], "installed");
    assert_eq!(v["binary"]["path"], bin.to_string_lossy().as_ref());
    assert_eq!(v["binary"]["version"], "2025.1.0");
    assert_eq!(v["hostOs"], std::env::consts::OS);
    assert!(
        v.get("installHint").is_none(),
        "an installed binary carries no install hint: {body}"
    );
}

/// A missing/unusable binary fills `installHint` with the per-OS commands.
/// (NotInstalled is covered by the locator's own unit test; an override makes
/// this deterministic regardless of what is installed on the test machine.)
#[tokio::test]
async fn binary_flag_reports_unusable_with_an_install_hint() {
    let _guard = CF_ENV_LOCK.lock().await;
    let tmp = tempdir().unwrap();
    let home = with_home(tmp.path().to_path_buf());
    let missing = tmp.path().join("no-cloudflared-here");
    std::env::set_var("VST_CLOUDFLARED_BIN", &missing);

    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store, None));
    let (status, body) = get(router, "/api/auth/tunnel/status?binary=1").await;
    std::env::remove_var("VST_CLOUDFLARED_BIN");
    drop(home);

    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["binary"]["state"], "unusable");
    assert_eq!(v["binary"]["path"], missing.to_string_lossy().as_ref());
    assert!(
        v["installHint"]["commands"]
            .as_array()
            .is_some_and(|c| !c.is_empty()),
        "expected install commands: {body}"
    );
}

/// `POST /api/auth/tunnel/enable` with a broken binary is a 409 carrying the
/// machine-readable code the UI branches on (not a generic 500).
#[tokio::test]
async fn enable_with_an_unusable_binary_is_a_409_with_a_code() {
    let _guard = CF_ENV_LOCK.lock().await;
    let tmp = tempdir().unwrap();
    let home = with_home(tmp.path().to_path_buf());
    let missing = tmp.path().join("no-cloudflared-here");
    std::env::set_var("VST_CLOUDFLARED_BIN", &missing);

    let auth_state = AuthState::new("test-daemon-key", 0);
    let token = mint_token(TokenScope::Tauri, &auth_state, None);
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store.clone(), Some(auth_state)));

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/auth/tunnel/enable")
                .method("POST")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    std::env::remove_var("VST_CLOUDFLARED_BIN");
    drop(home);

    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["code"], "cloudflared_unusable", "{v}");
    assert_eq!(
        store.get_tunnel_state().await,
        vst_store::TunnelStateRow::empty(),
        "a rejected enable must not persist anything"
    );
}
