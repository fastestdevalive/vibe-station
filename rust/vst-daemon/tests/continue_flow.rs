//! Integration tests for the browser "continue" flow (CUJ4,
//! `cli-daemon-unification` Part 02): `POST /api/auth/continue/mint` +
//! `GET /continue?code=`.
//!
//! Uses `tower::ServiceExt::oneshot` — no real TCP port is ever bound.

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

fn make_opts(tmp: &std::path::Path, auth_state: Option<AuthState>) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network_access: false,
        port: 0,
        auth_state,
        no_auth: false,
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

fn mint_post(uri: &str, token: Option<&str>) -> Request<axum::body::Body> {
    let mut b = Request::builder().uri(uri).method("POST");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(axum::body::Body::empty()).unwrap()
}

fn mint_post_remote(uri: &str, token: Option<&str>) -> Request<axum::body::Body> {
    let mut b = Request::builder()
        .uri(uri)
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(axum::body::Body::empty()).unwrap()
}

#[tokio::test]
async fn mint_requires_auth() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let req = Request::builder()
        .uri("/api/auth/continue/mint")
        .method("POST")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn mint_succeeds_with_valid_cli_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let resp = router
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json.get("code").and_then(|c| c.as_str()).is_some());
    let expires_at = json
        .get("expiresAt")
        .and_then(|e| e.as_i64())
        .expect("expiresAt should be present");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    // expiresAt is an absolute epoch-ms timestamp ~30s in the future.
    assert!(expires_at > now && expires_at <= now + 30_000);
}

#[tokio::test]
async fn mint_is_blocked_over_tunnel() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let resp = router
        .oneshot(mint_post_remote(
            "/api/auth/continue/mint",
            Some(&cli_token),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn mint_is_blocked_with_non_local_origin() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mut req = mint_post("/api/auth/continue/mint", Some(&cli_token));
    req.headers_mut()
        .insert("origin", "http://192.168.1.50:7421".parse().unwrap());
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn mint_is_blocked_with_remote_peer_ip() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mut req = mint_post("/api/auth/continue/mint", Some(&cli_token));
    req.extensions_mut().insert(axum::extract::ConnectInfo(
        "192.168.1.100:12345"
            .parse::<std::net::SocketAddr>()
            .unwrap(),
    ));
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn full_round_trip_mint_then_redeem_then_authenticated_call() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    // Mint.
    let mint_resp = router
        .clone()
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    assert_eq!(mint_resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(mint_resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let code = json.get("code").unwrap().as_str().unwrap().to_string();

    // Redeem.
    let redeem_req = Request::builder()
        .uri(format!("/continue?code={code}"))
        .method("GET")
        .body(axum::body::Body::empty())
        .unwrap();
    let redeem_resp = router.clone().oneshot(redeem_req).await.unwrap();
    assert_eq!(redeem_resp.status(), StatusCode::FOUND);
    assert_eq!(
        redeem_resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok()),
        Some("/")
    );
    let cookie = redeem_resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("expected Set-Cookie")
        .to_string();

    // The cookie must actually authenticate a subsequent /api request.
    let cookie_value = cookie.split(';').next().unwrap();
    let authed_req = Request::builder()
        .uri("/api/sessions")
        .method("GET")
        .header("cookie", cookie_value)
        .body(axum::body::Body::empty())
        .unwrap();
    let authed_resp = router.oneshot(authed_req).await.unwrap();
    assert_ne!(authed_resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn redeem_is_blocked_over_tunnel_even_with_a_valid_code() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mint_resp = router
        .clone()
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    let body = axum::body::to_bytes(mint_resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let code = json.get("code").unwrap().as_str().unwrap().to_string();

    let redeem_req = Request::builder()
        .uri(format!("/continue?code={code}"))
        .method("GET")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();
    let redeem_resp = router.oneshot(redeem_req).await.unwrap();
    assert_eq!(redeem_resp.status(), StatusCode::GONE);
}

#[tokio::test]
async fn redeem_is_blocked_with_non_local_origin() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mint_resp = router
        .clone()
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    let body = axum::body::to_bytes(mint_resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let code = json.get("code").unwrap().as_str().unwrap().to_string();

    let redeem_req = Request::builder()
        .uri(format!("/continue?code={code}"))
        .method("GET")
        .header("origin", "http://192.168.1.50:7421")
        .body(axum::body::Body::empty())
        .unwrap();
    let redeem_resp = router.oneshot(redeem_req).await.unwrap();
    assert_eq!(redeem_resp.status(), StatusCode::GONE);
}

#[tokio::test]
async fn redeem_is_blocked_with_remote_peer_ip() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mint_resp = router
        .clone()
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    let body = axum::body::to_bytes(mint_resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let code = json.get("code").unwrap().as_str().unwrap().to_string();

    let mut redeem_req = Request::builder()
        .uri(format!("/continue?code={code}"))
        .method("GET")
        .body(axum::body::Body::empty())
        .unwrap();
    redeem_req
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(
            "192.168.1.100:12345"
                .parse::<std::net::SocketAddr>()
                .unwrap(),
        ));
    let redeem_resp = router.oneshot(redeem_req).await.unwrap();
    assert_eq!(redeem_resp.status(), StatusCode::GONE);
}

#[tokio::test]
async fn redeem_same_code_twice_is_rejected_the_second_time() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let mint_resp = router
        .clone()
        .oneshot(mint_post("/api/auth/continue/mint", Some(&cli_token)))
        .await
        .unwrap();
    let body = axum::body::to_bytes(mint_resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let code = json.get("code").unwrap().as_str().unwrap().to_string();

    let req1 = Request::builder()
        .uri(format!("/continue?code={code}"))
        .body(axum::body::Body::empty())
        .unwrap();
    let resp1 = router.clone().oneshot(req1).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::FOUND);

    let req2 = Request::builder()
        .uri(format!("/continue?code={code}"))
        .body(axum::body::Body::empty())
        .unwrap();
    let resp2 = router.oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::GONE);
}

#[tokio::test]
async fn redeem_with_no_code_param_is_400() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let req = Request::builder()
        .uri("/continue")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn continue_route_is_exempt_from_auth_middleware_not_served_as_spa() {
    // Confirms /continue is reachable pre-auth (unlike a real API route),
    // and that reaching it doesn't accidentally serve the SPA fallback.
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state)));

    let req = Request::builder()
        .uri("/continue")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    // Missing code -> 400 from the real handler, not a 401 (would mean the
    // route was NOT exempt) and not a 200 SPA page (would mean it fell
    // through to handle_fallback instead of its own handler).
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
