//! `/health` bootId + `/api/update/{check,settings}` route tests.
//!
//! Uses `oneshot` (no TCP port) and a `mockito` GitHub. mockito 0.31's mock
//! server is process-global, so the mock-using tests are serialised.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_daemon::update::{UpdateConfig, UpdateService};
use vst_git::paths::Paths;
use vst_routes::auth::{mint_token, AuthState};
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::events::Broadcaster;

static MOCK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn opts(
    tmp: &std::path::Path,
    auth: Option<AuthState>,
    update: Arc<UpdateService>,
) -> BuildServerOptions {
    BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: auth,
        no_auth: false,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store: StoreHandle::open(&tmp.join("test.db")).unwrap(),
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: vst_proc::test_support::isolated_tmux(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.to_path_buf()),
        limits: vst_harness_limits::LimitsHandle::inert(
            vst_types::events::Broadcaster::new(16),
            "test".to_string(),
        ),
        update,
    }
}

fn mock_service(tmp: &std::path::Path) -> Arc<UpdateService> {
    UpdateService::new(UpdateConfig {
        vst_home: tmp.to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: std::path::PathBuf::from("/nonexistent/vst"),
        boot_id: "boot-123".to_string(),
        api_base: mockito::server_url(),
        broadcaster: None,
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    })
}

fn remote(method: &str, uri: &str, token: &str, body: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri(uri)
        .method(method)
        .header("cf-connecting-ip", "1.2.3.4")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn health_has_boot_id_and_no_store() {
    let tmp = tempdir().unwrap();
    let router = build_app(opts(tmp.path(), None, mock_service(tmp.path())));
    let req = Request::builder()
        .uri("/health")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(json(resp).await["bootId"], "boot-123");
}

/// The web UI's `api.health()` requests `${baseUrl()}/health` = `/api/health`
/// (the restart overlay polls it for a new `bootId`). It must be the real JSON
/// health response, not the SPA fallback's `index.html`, and unauthenticated
/// (a restarted daemon may not have the old session yet).
#[tokio::test]
async fn api_health_alias_serves_json_without_auth() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let router = build_app(opts(tmp.path(), Some(auth), mock_service(tmp.path())));
    let req = Request::builder()
        .uri("/api/health")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(json(resp).await["bootId"], "boot-123");
}

#[tokio::test]
async fn check_reports_update_available_with_mock_github() {
    let _g = MOCK_LOCK.lock().await;
    let _m = mockito::mock("GET", "/releases?per_page=20")
        .with_status(200)
        .with_body(r#"[{"tag_name":"v0.2.0","prerelease":false,"draft":false,"body":"hi","html_url":"https://example.test/r","assets":[]}]"#)
        .create();
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let tok = mint_token(TokenScope::Cli, &auth, None);
    let router = build_app(opts(tmp.path(), Some(auth), mock_service(tmp.path())));
    let resp = router
        .oneshot(remote("GET", "/api/update/check?force=true", &tok, ""))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json(resp).await;
    assert_eq!(v["updateAvailable"], true);
    assert_eq!(v["latest"], "0.2.0");
    assert_eq!(v["canInstall"], true);
}

#[tokio::test]
async fn settings_mobile_403_browser_200_persisted() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let mobile = mint_token(TokenScope::Mobile, &auth, None);
    let browser = mint_token(TokenScope::Browser, &auth, None);
    let router = build_app(opts(tmp.path(), Some(auth), mock_service(tmp.path())));

    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/update/settings",
            &mobile,
            r#"{"autoCheck":false}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let resp = router
        .oneshot(remote(
            "POST",
            "/api/update/settings",
            &browser,
            r#"{"autoCheck":false}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(json(resp).await["autoCheck"], false);
    let saved = std::fs::read_to_string(tmp.path().join("update-state.json")).unwrap();
    assert!(saved.contains("\"autoCheck\": false"), "{saved}");
}

#[tokio::test]
async fn mutating_routes_are_403_for_mobile() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let mobile = mint_token(TokenScope::Mobile, &auth, None);
    let router = build_app(opts(tmp.path(), Some(auth), mock_service(tmp.path())));
    for (uri, body) in [
        ("/api/update/install", "{}"),
        ("/api/update/cancel", "{}"),
        ("/api/update/skip", r#"{"version":"9.9.9"}"#),
        ("/api/update/unskip", r#"{"version":"9.9.9"}"#),
    ] {
        let resp = router
            .clone()
            .oneshot(remote("POST", uri, &mobile, body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "{uri}");
    }
}

#[tokio::test]
async fn skip_is_reflected_in_check_and_broadcast_unskip_and_validation() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let tok = mint_token(TokenScope::Browser, &auth, None);
    let b = Broadcaster::new(16);
    let mut rx = b.subscribe();
    let svc = UpdateService::new(UpdateConfig {
        broadcaster: Some(b),
        api_base: "http://127.0.0.1:9".to_string(),
        vst_home: tmp.path().to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: std::path::PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    });
    // Pin detection: the host may have a real `vst` install on PATH.
    svc.set_detected_for_tests(vst_types::rest::update::InstallMethod::Unknown, vec![]);
    let router = build_app(opts(tmp.path(), Some(auth), svc));

    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/update/skip",
            &tok,
            r#"{"version":"v9.9.9"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    match rx.try_recv().expect("update:changed broadcast") {
        vst_types::events::ServerEvent::UpdateChanged { status } => {
            assert_eq!(status.skipped, vec!["9.9.9".to_string()]);
        }
        other => panic!("unexpected event {other:?}"),
    }
    let resp = router
        .clone()
        .oneshot(remote("GET", "/api/update/check", &tok, ""))
        .await
        .unwrap();
    assert_eq!(json(resp).await["skipped"], serde_json::json!(["9.9.9"]));

    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/update/skip",
            &tok,
            r#"{"version":"nope"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json(resp).await["error"], "invalid_version");

    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/update/unskip",
            &tok,
            r#"{"version":"9.9.9"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(json(resp).await["skipped"], serde_json::json!([]));

    // Install rejected with no update available to install => 422 no_asset.
    let resp = router
        .clone()
        .oneshot(remote("POST", "/api/update/install", &tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json(resp).await["error"], "no_asset");

    // Cancel with nothing running => 409 not_cancellable.
    let resp = router
        .oneshot(remote("POST", "/api/update/cancel", &tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(json(resp).await["error"], "not_cancellable");
}

#[tokio::test]
async fn test_daemon_restart_route_flows() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let browser_tok = mint_token(TokenScope::Browser, &auth, None);
    let mobile_tok = mint_token(TokenScope::Mobile, &auth, None);

    let b = Broadcaster::new(16);
    let mut rx = b.subscribe();

    let cfg = UpdateConfig {
        broadcaster: Some(b.clone()),
        api_base: "http://127.0.0.1:9".to_string(),
        vst_home: tmp.path().to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: std::path::PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    };

    let svc = UpdateService::new(cfg);
    let build_opts = opts(tmp.path(), Some(auth), svc.clone());

    // 1. Mobile token => 403
    let router = build_app(build_opts.clone());
    let resp = router
        .clone()
        .oneshot(remote("POST", "/api/daemon/restart", &mobile_tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // 2. Add a working session to store => impact non-empty
    let store = &build_opts.store;
    let s = vst_types::SessionRecord {
        id: "s1".to_string(),
        worktree_id: None,
        project_id: "p1".to_string(),
        is_main: false,
        sort_order: 0.0,
        r#type: vst_types::domain::SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: Some("agent-1".to_string()),
        name_source: None,
        tmux_name: "tmux-s1".to_string(),
        use_tmux: true,
        channel: Some(vst_types::domain::Channel::Tmux),
        lifecycle: vst_types::domain::SessionLifecycle {
            state: vst_types::domain::LifecycleState::Working,
            reason: None,
            last_transition_at: "now".to_string(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
        carry_over: None,
    };
    let p = vst_types::ProjectRecord {
        id: "p1".into(),
        absolute_path: "/path".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![s],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    };
    store.add_project(p).await.unwrap();

    // 3. dryRun: true => 200 with impact, no restart initiated
    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/daemon/restart",
            &browser_tok,
            r#"{"dryRun":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let val = json(resp).await;
    assert_eq!(val["impact"].as_array().unwrap().len(), 1);
    assert_eq!(svc.is_restarting(), false);

    // 4. Non-confirmed POST => 409 restart_busy with impact
    let resp = router
        .clone()
        .oneshot(remote("POST", "/api/daemon/restart", &browser_tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let val = json(resp).await;
    assert_eq!(val["error"], "restart_busy");
    assert_eq!(val["impact"].as_array().unwrap().len(), 1);

    // 5. Confirmed POST => 202, WS daemon:restarting broadcast, Notify triggered
    let notify = svc.restart_signal();
    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/daemon/restart",
            &browser_tok,
            r#"{"confirm":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::ACCEPTED);
    assert_eq!(json(resp).await["ok"], true);
    assert_eq!(svc.is_restarting(), true);
    tokio::time::timeout(Duration::from_millis(100), notify.notified())
        .await
        .unwrap();

    // Check broadcast event
    match rx.try_recv().expect("daemon:restarting broadcast") {
        vst_types::events::ServerEvent::DaemonRestarting => {}
        other => panic!("unexpected event {other:?}"),
    }

    // 6. Second restart POST => 409 restart_in_progress
    let resp = router
        .clone()
        .oneshot(remote(
            "POST",
            "/api/daemon/restart",
            &browser_tok,
            r#"{"confirm":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(json(resp).await["error"], "restart_in_progress");

    // 7. Hosted by Tauri override => 409 tauri_hosted
    let svc_tauri = UpdateService::with_env_for_tests(cfg_of(tmp.path(), None), |k| {
        (k == "VST_HOSTED_BY").then(|| "tauri".to_string())
    });
    let auth_tauri = AuthState::new("secret-tauri", 3600);
    let browser_tok_tauri = mint_token(TokenScope::Browser, &auth_tauri, None);
    let router_tauri = build_app(opts(tmp.path(), Some(auth_tauri), svc_tauri));
    let resp = router_tauri
        .oneshot(remote(
            "POST",
            "/api/daemon/restart",
            &browser_tok_tauri,
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(json(resp).await["error"], "tauri_hosted");
}

fn cfg_of(dir: &std::path::Path, b: Option<Broadcaster>) -> UpdateConfig {
    UpdateConfig {
        vst_home: dir.to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: std::path::PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        api_base: "http://127.0.0.1:9".to_string(),
        broadcaster: b,
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    }
}

#[tokio::test]
async fn restart_not_tauri_hosted_by_cloudflared_env_alone() {
    let tmp = tempdir().unwrap();
    let auth = AuthState::new("secret", 0);
    let tok = mint_token(TokenScope::Browser, &auth, None);
    let cfg = |tmp: &std::path::Path| UpdateConfig {
        broadcaster: None,
        api_base: "http://127.0.0.1:9".to_string(),
        vst_home: tmp.to_path_buf(),
        current_version: "0.1.0".to_string(),
        boot_exe: std::path::PathBuf::from("/nonexistent/vst"),
        boot_id: "b".to_string(),
        check_interval: Duration::from_secs(3 * 24 * 3600),
        first_check_delay: Duration::from_secs(60),
        force_floor: Duration::from_secs(30),
    };

    // VST_CLOUDFLARED_BIN with a curl AppImage on disk: headless, restart OK.
    let svc = UpdateService::with_env_for_tests(cfg(tmp.path()), |k| {
        (k == "VST_CLOUDFLARED_BIN").then(|| "/x".to_string())
    });
    svc.set_detected_for_tests(vst_types::rest::update::InstallMethod::CurlAppImage, vec![]);
    let router = build_app(opts(tmp.path(), Some(auth.clone()), svc));
    let resp = router
        .oneshot(remote("POST", "/api/daemon/restart", &tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::ACCEPTED);

    // VST_HOSTED_BY=tauri: 409 tauri_hosted.
    let tmp2 = tempdir().unwrap();
    let svc = UpdateService::with_env_for_tests(cfg(tmp2.path()), |k| {
        (k == "VST_HOSTED_BY").then(|| "tauri".to_string())
    });
    let router = build_app(opts(tmp2.path(), Some(auth), svc));
    let resp = router
        .oneshot(remote("POST", "/api/daemon/restart", &tok, "{}"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(json(resp).await["error"], "tauri_hosted");
}
