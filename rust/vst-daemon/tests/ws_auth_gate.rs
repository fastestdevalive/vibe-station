//! Integration tests for the WS auth gate: a non-loopback request with a
//! missing/invalid/expired token must be ACCEPTED as an upgrade and immediately
//! closed with the auth-expired close code (4401) — not rejected with a bare
//! HTTP 401. The browser sees a 401-before-upgrade as close code 1006, which
//! the client treats as an ordinary disconnect and reconnects forever; 4401 is
//! the one code the web-ui maps to its login screen.
//!
//! These tests bind a real TCP listener and speak WebSocket over it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::HeaderValue;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::{connect_async, MaybeTlsStream};

use futures::{SinkExt, StreamExt};

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_routes::auth::{mint_token, AuthState};
use vst_store::StoreHandle;
use vst_types::domain::TokenScope;
use vst_types::events::Broadcaster;

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};

fn make_opts(tmp: &std::path::Path, auth_state: Option<AuthState>) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        network: NetworkControl::fixed(false),
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

/// Bind the app on an ephemeral loopback port and serve it in the background.
/// Returns the `ws://` base URL to connect to.
async fn serve(tmp: &std::path::Path, auth_state: AuthState) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = build_app(make_opts(tmp, Some(auth_state)));
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service())
            .await
            .unwrap();
    });
    format!("ws://{addr}/ws")
}

/// Open a WS connection to `url`, tagging it as a tunnel (non-loopback) request
/// via `cf-connecting-ip` so the upgrade auth gate is actually enforced.
async fn connect_remote(url: &str, token: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let mut req = format!("{url}?token={token}")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("cf-connecting-ip", HeaderValue::from_static("1.2.3.4"));
    let (ws, _resp) = connect_async(req).await.unwrap();
    ws
}

/// Open a WS connection with NO `cf-connecting-ip` tag and NO token — a
/// genuinely loopback connection (real TCP to 127.0.0.1) as far as the
/// server's `ConnectInfo` sees it.
async fn connect_loopback_no_token(url: &str) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let req = url.into_client_request().unwrap();
    let (ws, _resp) = connect_async(req).await.unwrap();
    ws
}

#[tokio::test]
async fn invalid_token_is_closed_with_4401_not_a_reconnectable_drop() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state).await;

    // A tampered / malformed token over a non-loopback connection.
    let mut ws = connect_remote(&base, "garbage.token.that.wont.verify").await;

    // The server accepts the upgrade, then immediately closes with 4401.
    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should close within 5s") {
        Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => {
            assert_eq!(
                u16::from(code),
                4401,
                "expected auth-expired close code 4401"
            );
        }
        other => panic!("expected a 4401 close frame, got {other:?}"),
    }
}

#[tokio::test]
async fn missing_token_is_closed_with_4401() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state).await;

    let mut ws = connect_remote(&base, "").await;

    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should close within 5s") {
        Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => {
            assert_eq!(
                u16::from(code),
                4401,
                "expected auth-expired close code 4401"
            );
        }
        other => panic!("expected a 4401 close frame, got {other:?}"),
    }
}

#[tokio::test]
async fn valid_browser_token_keeps_the_socket_open() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;

    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let mut ws = connect_remote(&base, &token).await;

    // The socket should stay open (happy path intact): send an application-level
    // ping (`{"type":"ping"}`) and expect the server's `{"type":"pong"}` reply,
    // not a close frame.
    ws.send(Message::Text(r#"{"type":"ping"}"#.to_string()))
        .await
        .unwrap();

    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should respond within 5s") {
        Some(Ok(Message::Text(t))) => {
            assert!(t.contains("\"pong\""), "expected a pong reply, got {t}");
        }
        other => panic!("expected a pong reply (open socket), got {other:?}"),
    }
}

#[tokio::test]
async fn unauthenticated_loopback_ws_closes_with_4401() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state).await;

    // Genuinely loopback (real 127.0.0.1 TCP, no tunnel tag), no token —
    // daemon must not silently upgrade this.
    let mut ws = connect_loopback_no_token(&base).await;

    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should close within 5s") {
        Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => {
            assert_eq!(
                u16::from(code),
                4401,
                "expected auth-expired close code 4401"
            );
        }
        other => panic!("expected a 4401 close frame, got {other:?}"),
    }
}

#[tokio::test]
async fn hostile_origin_refused_with_403() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;
    let token = mint_token(TokenScope::Browser, &auth_state, None);

    let mut req = format!("{base}?token={token}")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        axum::http::header::ORIGIN,
        HeaderValue::from_static("http://evil.com"),
    );

    match connect_async(req).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            assert_eq!(
                resp.status(),
                axum::http::StatusCode::FORBIDDEN,
                "hostile Origin must be rejected with 403 Forbidden"
            );
        }
        other => panic!("expected HTTP 403 Forbidden, got {other:?}"),
    }
}

#[tokio::test]
async fn tauri_localhost_origin_with_token_allowed() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;
    let token = mint_token(TokenScope::Tauri, &auth_state, None);

    let mut req = format!("{base}?token={token}")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        axum::http::header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );

    let (mut ws, _resp) = connect_async(req)
        .await
        .expect("tauri://localhost origin with valid token should connect");

    ws.send(Message::Text(r#"{"type":"ping"}"#.to_string()))
        .await
        .unwrap();

    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should respond within 5s") {
        Some(Ok(Message::Text(t))) => {
            assert!(t.contains("\"pong\""), "expected a pong reply, got {t}");
        }
        other => panic!("expected a pong reply (open socket), got {other:?}"),
    }
}

#[tokio::test]
async fn stale_cookie_does_not_shadow_valid_query_token() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;
    let valid_token = mint_token(TokenScope::Browser, &auth_state, None);

    let mut req = format!("{base}?token={valid_token}")
        .into_client_request()
        .unwrap();
    // Present a stale/invalid cookie along with the valid query token.
    req.headers_mut().insert(
        axum::http::header::COOKIE,
        HeaderValue::from_static("vst_token=stale-expired-invalid-token"),
    );

    let (mut ws, _resp) = connect_async(req)
        .await
        .expect("valid ?token= should not be shadowed by stale cookie");

    ws.send(Message::Text(r#"{"type":"ping"}"#.to_string()))
        .await
        .unwrap();

    let timeout = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    match timeout.expect("server should respond within 5s") {
        Some(Ok(Message::Text(t))) => {
            assert!(t.contains("\"pong\""), "expected a pong reply, got {t}");
        }
        other => panic!("expected a pong reply (open socket), got {other:?}"),
    }
}

async fn serve_no_auth(tmp: &std::path::Path) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut opts = make_opts(tmp, None);
    opts.no_auth = true;
    let router = build_app(opts);
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service())
            .await
            .unwrap();
    });
    format!("ws://{addr}/ws")
}

async fn connect_with_origin(url: &str, query: &str, origin: &str) -> Result<(), u16> {
    let mut req = format!("{url}{query}").into_client_request().unwrap();
    req.headers_mut().insert(
        axum::http::header::ORIGIN,
        HeaderValue::from_str(origin).unwrap(),
    );
    match connect_async(req).await {
        Ok(_) => Ok(()),
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => Err(resp.status().as_u16()),
        Err(e) => panic!("unexpected error: {e:?}"),
    }
}

#[tokio::test]
async fn own_origin_allowed_but_other_localhost_port_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;
    let token = mint_token(TokenScope::Browser, &auth_state, None);
    let authority = base.trim_start_matches("ws://").trim_end_matches("/ws");

    let own = format!("http://{authority}");
    assert_eq!(
        connect_with_origin(&base, &format!("?token={token}"), &own).await,
        Ok(())
    );
    assert_eq!(
        connect_with_origin(&base, &format!("?token={token}"), "http://localhost:3000").await,
        Err(403)
    );
}

#[tokio::test]
async fn no_auth_sandbox_still_refuses_foreign_websites_on_ws() {
    let tmp = tempfile::tempdir().unwrap();
    let base = serve_no_auth(tmp.path()).await;

    assert_eq!(
        connect_with_origin(&base, "", "https://evil.com").await,
        Err(403)
    );
    assert_eq!(
        connect_with_origin(&base, "", "http://localhost:5174").await,
        Ok(())
    );
}

#[tokio::test]
async fn tauri_token_through_a_tunnel_is_closed_with_4401() {
    let tmp = tempfile::tempdir().unwrap();
    let auth_state = AuthState::new("super-secret-token", 0);
    let base = serve(tmp.path(), auth_state.clone()).await;
    let token = mint_token(TokenScope::Tauri, &auth_state, None);

    // `connect_remote` tags the upgrade with `cf-connecting-ip`.
    let mut ws = connect_remote(&base, &token).await;

    match tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("server should close within 5s")
    {
        Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => {
            assert_eq!(u16::from(code), 4401);
        }
        other => panic!("expected a 4401 close frame, got {other:?}"),
    }
}
