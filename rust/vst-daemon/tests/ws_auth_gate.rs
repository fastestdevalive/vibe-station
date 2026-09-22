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

use vst_daemon::server::{build_app, BuildServerOptions};

fn make_opts(
    tmp: &std::path::Path,
    auth_state: Option<AuthState>,
) -> BuildServerOptions {
    let db_path = tmp.join("test.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let paths = Paths::with_home(tmp.to_path_buf());
    BuildServerOptions {
        port: 0,
        auth_state,
        no_auth: false,
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
async fn serve(
    tmp: &std::path::Path,
    auth_state: AuthState,
) -> String {
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
async fn connect_remote(
    url: &str,
    token: &str,
) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let mut req = format!("{url}?token={token}").into_client_request().unwrap();
    req.headers_mut()
        .insert("cf-connecting-ip", HeaderValue::from_static("1.2.3.4"));
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
