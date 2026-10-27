use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

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

fn json_post_request(uri: &str, body: &serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap()
}

#[tokio::test]
async fn post_api_sessions_chat_with_mentions_route_checks() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("vibe-station.db");
    let store = StoreHandle::open(&db_path).unwrap();
    let opts = make_opts(tmp.path(), store);
    let app = build_app(opts);

    // 1. Valid mentions on missing session -> 404 JSON (not SPA 200)
    let valid_body = json!({
        "message": "hello",
        "mentions": [
            {
                "kind": "file",
                "id": "a/b.ts",
                "label": "b.ts"
            }
        ]
    });
    let req = json_post_request("/api/sessions/nope/chat", &valid_body);
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.contains("application/json"),
        "expected json content-type, got: {content_type}"
    );
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body_json: serde_json::Value =
        serde_json::from_slice(&body_bytes).expect("response should be valid JSON");
    assert!(body_json.get("error").is_some());

    // 2. unknown "kind" (deserializes as Unknown) -> 400 "unknown mention kind"
    let artifact_body = json!({
        "message": "hello",
        "mentions": [
            {
                "kind": "artifact",
                "id": "art-1",
                "label": "Artifact"
            }
        ]
    });
    let req = json_post_request("/api/sessions/nope/chat", &artifact_body);
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body_bytes).contains("unknown mention kind"));

    // 3. 51 mentions -> 400 Bad Request
    let too_many_mentions: Vec<_> = (0..51)
        .map(|i| {
            json!({
                "kind": "file",
                "id": format!("f{i}.ts"),
                "label": format!("f{i}.ts")
            })
        })
        .collect();
    let too_many_body = json!({
        "message": "hello",
        "mentions": too_many_mentions
    });
    let req = json_post_request("/api/sessions/nope/chat", &too_many_body);
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
