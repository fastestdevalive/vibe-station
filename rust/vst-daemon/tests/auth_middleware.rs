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
    make_opts_with_dist(tmp, auth_state, no_auth, None)
}

fn make_opts_with_dist(
    tmp: &std::path::Path,
    auth_state: Option<AuthState>,
    no_auth: bool,
    dist_path: Option<std::path::PathBuf>,
) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network_access: false,
        port: 0,
        auth_state,
        no_auth,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path,
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

    let resp = router.oneshot(remote_get("/api/sessions")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_rejects_tampered_bearer_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(remote_get_with_auth(
            "/api/sessions",
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

#[tokio::test]
async fn auth_middleware_exempts_api_prefixed_health_and_ws() {
    let tmp = tempdir().unwrap();
    let router = build_app(make_opts(
        tmp.path(),
        Some(AuthState::new("super-secret-token", 0)),
        false,
    ));

    // A proxy in front of the daemon may probe these with the /api prefix. No
    // route serves them (routing happens before the middleware's path rewrite),
    // so the pre-change behavior was 404; the exemption must keep it from
    // turning into a 401 that a client would read as "auth expired".
    let health = router
        .clone()
        .oneshot(remote_get("/api/health"))
        .await
        .unwrap();
    assert_ne!(health.status(), StatusCode::UNAUTHORIZED);

    let ws = router.clone().oneshot(remote_get("/api/ws")).await.unwrap();
    assert_ne!(ws.status(), StatusCode::UNAUTHORIZED);

    // The exemption must not leak to other /api routes.
    let other = router.oneshot(remote_get("/api/sessions")).await.unwrap();
    assert_eq!(other.status(), StatusCode::UNAUTHORIZED);
}

// ── Phase 1b: broadened GET/HEAD SPA-fallback exemption ────────────────────

/// Build a temp dir acting as the SPA `dist` root with an `index.html`.
fn dist_fixture(tmp: &std::path::Path) -> std::path::PathBuf {
    let dist = tmp.join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<html>index</html>").unwrap();
    dist
}

#[tokio::test]
async fn deep_link_get_with_missing_token_serves_spa_not_401() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let dist = dist_fixture(tmp.path());
    let router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(auth_state),
        false,
        Some(dist),
    ));

    // Deep link with no token: must fall through to the SPA, not a raw 401.
    let resp = router.oneshot(remote_get("/worktree/abc")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("index"));
}

#[tokio::test]
async fn deep_link_get_with_invalid_token_serves_spa_not_401() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let dist = dist_fixture(tmp.path());
    let router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(auth_state),
        false,
        Some(dist),
    ));

    let resp = router
        .oneshot(remote_get_with_auth(
            "/settings",
            "totally-fake-token-that-wont-verify",
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("index"));
}

#[tokio::test]
async fn api_route_is_still_protected_by_get_exemption() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let dist = dist_fixture(tmp.path());
    let router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(auth_state),
        false,
        Some(dist),
    ));

    // /api/* must NOT be swept into the GET/HEAD fallback exemption.
    let resp = router.oneshot(remote_get("/api/sessions")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn non_get_method_on_deep_link_is_still_protected() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let dist = dist_fixture(tmp.path());
    let router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(auth_state),
        false,
        Some(dist),
    ));

    // The exemption is GET/HEAD only — a mutating verb on a deep-link-ish path
    // must still require a token.
    let req = Request::builder()
        .uri("/worktree/abc")
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ws_and_mobile_auth_not_served_as_spa_with_missing_token() {
    let tmp = tempdir().unwrap();
    let dist = dist_fixture(tmp.path());

    // /ws must reach its upgrade handler, not the SPA fallback (no 200 HTML).
    let ws_router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(AuthState::new("super-secret-token", 0)),
        false,
        Some(dist.clone()),
    ));
    let ws_resp = ws_router.oneshot(remote_get("/ws")).await.unwrap();
    let body = axum::body::to_bytes(ws_resp.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("index"));

    // /mobile-auth must reach its handler, not the SPA fallback.
    let ma_router = build_app(make_opts_with_dist(
        tmp.path(),
        Some(AuthState::new("super-secret-token", 0)),
        false,
        Some(dist),
    ));
    let ma_resp = ma_router.oneshot(remote_get("/mobile-auth")).await.unwrap();
    let body = axum::body::to_bytes(ma_resp.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("index"));
}

#[tokio::test]
async fn auth_logout_exemption_matches_post_rewrite_path() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    // POST /api/auth/logout is rewritten to /auth/logout; the middleware must
    // exempt it (pass it through to the handler) rather than 401 it.
    let req = Request::builder()
        .uri("/api/auth/logout")
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
}

/// A bare request with no `cf-connecting-ip` header — the middleware's
/// `client_ip.is_empty()` branch treats an absent TCP peer (as in these
/// `oneshot`-driven unit tests, which never bind a real socket) as loopback.
fn loopback_get(uri: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri(uri)
        .method("GET")
        .body(axum::body::Body::empty())
        .unwrap()
}

#[tokio::test]
async fn daemon_rejects_unauthenticated_loopback_request() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router.oneshot(loopback_get("/api/sessions")).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn daemon_allows_loopback_request_with_valid_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let valid_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(remote_get_with_auth("/sessions", &valid_token))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn daemon_stop_route_requires_auth_like_any_other_api_route() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    // No exemption exists for this route — a remote (non-loopback), unauthenticated
    // POST must be rejected exactly like any other /api route.
    let req = Request::builder()
        .uri("/api/daemon/stop")
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4")
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

/// Found in review: `/api/daemon/stop` checked only that a token was
/// present/valid, not its scope — a Browser (or Mobile) session could stop
/// the daemon out from under whoever's Tauri/CLI session actually owns it.
#[tokio::test]
async fn daemon_stop_route_rejects_a_browser_scoped_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let browser_token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let req = Request::builder()
        .uri("/api/daemon/stop")
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4")
        .header("authorization", format!("Bearer {browser_token}"))
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

/// Found in review: `/api/auth/continue/mint` is documented as CLI-only but
/// didn't enforce it — a Browser-scoped token could mint unlimited
/// `local-cli`-origin one-time codes.
#[tokio::test]
async fn continue_mint_route_rejects_a_browser_scoped_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let browser_token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    // Deliberately no `cf-connecting-ip` here -- that header trips a SEPARATE,
    // unrelated tunnel-block check in `mint_continue_code` itself (also a
    // 403), which would make this test pass for the wrong reason. Loopback
    // requests still get `TokenPayload` attached when a bearer token is
    // present (see `auth_middleware`'s loopback branch), so the scope check
    // is exercised either way.
    let req = Request::builder()
        .uri("/api/auth/continue/mint")
        .method("POST")
        .header("authorization", format!("Bearer {browser_token}"))
        .body(axum::body::Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

/// A CLI-scoped token must still be allowed through both scope gates above —
/// confirms the fix is a scope check, not an accidental blanket rejection.
#[tokio::test]
async fn daemon_stop_and_continue_mint_allow_a_cli_scoped_token() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let cli_token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let stop_req = Request::builder()
        .uri("/api/daemon/stop")
        .method("POST")
        .header("cf-connecting-ip", "1.2.3.4")
        .header("authorization", format!("Bearer {cli_token}"))
        .body(axum::body::Body::empty())
        .unwrap();
    let stop_resp = router.clone().oneshot(stop_req).await.unwrap();
    assert_eq!(stop_resp.status(), StatusCode::OK);

    // No `cf-connecting-ip` -- see the sibling rejection test's comment.
    let mint_req = Request::builder()
        .uri("/api/auth/continue/mint")
        .method("POST")
        .header("authorization", format!("Bearer {cli_token}"))
        .body(axum::body::Body::empty())
        .unwrap();
    let mint_resp = router.oneshot(mint_req).await.unwrap();
    assert_eq!(
        mint_resp.status(),
        StatusCode::OK,
        "a Cli-scoped token must pass the scope check and successfully mint a code"
    );
}

// ── Origin policy + CSRF header ───────────────────────────────────────────────

fn cookie_request(
    method: &str,
    token: &str,
    origin: Option<&str>,
    csrf: bool,
) -> Request<axum::body::Body> {
    let mut b = Request::builder()
        .uri("/api/sessions")
        .method(method)
        .header("host", "localhost:7421")
        .header("cookie", format!("vst-session={token}"));
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    if csrf {
        b = b.header("x-vst-csrf", "1");
    }
    b.body(axum::body::Body::empty()).unwrap()
}

#[tokio::test]
async fn cookie_request_from_other_localhost_port_is_forbidden() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(cookie_request(
            "GET",
            &token,
            Some("http://localhost:3000"),
            true,
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cookie_request_from_own_origin_is_allowed() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(cookie_request(
            "GET",
            &token,
            Some("http://localhost:7421"),
            false,
        ))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cookie_post_without_csrf_header_is_forbidden() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(cookie_request(
            "POST",
            &token,
            Some("http://localhost:7421"),
            false,
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cookie_post_with_csrf_header_passes_the_gate() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(cookie_request(
            "POST",
            &token,
            Some("http://localhost:7421"),
            true,
        ))
        .await
        .unwrap();

    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bearer_post_does_not_need_csrf_header() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Cli, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let req = Request::builder()
        .uri("/api/sessions")
        .method("POST")
        .header("authorization", format!("Bearer {token}"))
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();

    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn null_origin_is_forbidden() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let resp = router
        .oneshot(cookie_request("GET", &token, Some("null"), true))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cookie_get_marked_same_site_is_forbidden_even_without_origin() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let mut req = cookie_request("GET", &token, None, false);
    req.headers_mut()
        .insert("sec-fetch-site", "same-site".parse().unwrap());
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let mut req = cookie_request("GET", &token, None, false);
    req.headers_mut()
        .insert("sec-fetch-site", "same-origin".parse().unwrap());
    let resp = router.oneshot(req).await.unwrap();
    assert_ne!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn logout_from_hostile_origin_is_forbidden() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let req = Request::builder()
        .uri("/api/auth/logout")
        .method("POST")
        .header("host", "localhost:7421")
        .header("origin", "http://localhost:3000")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cors_preflight_allows_csrf_header_only_for_trusted_origins() {
    let tmp = tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let router = build_app(make_opts(tmp.path(), Some(auth_state), false));

    let preflight = |origin: &str| {
        Request::builder()
            .uri("/api/sessions")
            .method("OPTIONS")
            .header("host", "localhost:7421")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization,x-vst-csrf")
            .body(axum::body::Body::empty())
            .unwrap()
    };

    let ok = router
        .clone()
        .oneshot(preflight("tauri://localhost"))
        .await
        .unwrap();
    assert_eq!(
        ok.headers()
            .get("access-control-allow-origin")
            .map(|v| v.to_str().unwrap()),
        Some("tauri://localhost")
    );
    let bad = router
        .oneshot(preflight("http://localhost:3000"))
        .await
        .unwrap();
    assert!(bad.headers().get("access-control-allow-origin").is_none());
}
