//! HTTP-level tests for the harness-limits routes under `/api`.
//!
//! Follows `doctor_routes_http.rs` pattern: `build_app` + `tower::ServiceExt::oneshot`,
//! `tempfile::tempdir()` for isolation, no real TCP port. `no_auth = true` so no
//! token is needed. A canned `claude` probe is injected via `LimitsHandle::new`.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_harness_limits::{HarnessProbe, LimitsDeps, LimitsHandle, LimitsTiming};
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::limits::{
    default_slots, LimitSlotRef, LimitStatus, LimitWindow, LimitsRefreshResult, LimitsResult,
    LimitsSnapshot, PutLimitSlotsBody,
};

use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};

fn ok_claude_result() -> LimitsResult {
    LimitsResult {
        harness: "claude".to_string(),
        status: LimitStatus::Ok,
        message: None,
        as_of: "2026-10-11T00:00:00.000Z".to_string(),
        windows: vec![
            LimitWindow::placeholder(
                "claude",
                "five_hour",
                Some(300),
                LimitStatus::Ok,
                "2026-10-11T00:00:00.000Z",
            ),
            LimitWindow::placeholder(
                "claude",
                "seven_day",
                Some(10080),
                LimitStatus::Ok,
                "2026-10-11T00:00:00.000Z",
            ),
        ],
    }
}

fn claude_handle() -> LimitsHandle {
    let broadcaster = Broadcaster::new(16);
    let probe = HarnessProbe {
        harness: "claude".to_string(),
        probe: Arc::new(|| {
            let r = ok_claude_result();
            Box::pin(async move { r })
        }),
    };
    LimitsHandle::new(LimitsDeps {
        broadcaster,
        probes: vec![probe],
        session_harness: Arc::new(|_| Box::pin(async { None })),
        host: "test".to_string(),
        initial_slots: default_slots(),
        timing: LimitsTiming::default(),
    })
}

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
        limits: claude_handle(),
    }
}

#[tokio::test]
async fn get_limits_returns_default_slots() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/limits")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let snap: LimitsSnapshot = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(snap.slots, default_slots());
}

#[tokio::test]
async fn get_limits_without_api_prefix_is_not_the_json_route() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/limits")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let content_type = resp
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert_ne!(
        content_type, "application/json",
        "root-level /limits must not resolve to the JSON limits route"
    );
}

#[tokio::test]
async fn put_slots_then_get_reflects() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let new_slots = vec![
        LimitSlotRef::new("claude", "five_hour"),
        LimitSlotRef::new("codex", "primary"),
    ];
    let body = serde_json::to_string(&PutLimitSlotsBody {
        slots: new_slots.clone(),
    })
    .unwrap();

    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/limits/slots")
                .method("PUT")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/limits")
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let snap: LimitsSnapshot = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(snap.slots, [new_slots[0].clone(), new_slots[1].clone()]);
}

#[tokio::test]
async fn put_slots_with_three_returns_400() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let body = serde_json::to_string(&PutLimitSlotsBody {
        slots: vec![
            LimitSlotRef::new("claude", "five_hour"),
            LimitSlotRef::new("codex", "primary"),
            LimitSlotRef::new("claude", "seven_day"),
        ],
    })
    .unwrap();

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/limits/slots")
                .method("PUT")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn refresh_then_immediate_second_returns_started_false() {
    let tmp = tempdir().unwrap();
    let _guard = with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(&tmp.path().join("test.db")).unwrap();
    let router = build_app(make_opts(tmp.path(), store));

    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/limits/refresh")
                .method("POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let first: LimitsRefreshResult = serde_json::from_slice(&bytes).unwrap();
    assert!(first.started, "first refresh should start");

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/api/limits/refresh")
                .method("POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let second: LimitsRefreshResult = serde_json::from_slice(&bytes).unwrap();
    assert!(
        !second.started,
        "second refresh inside cooldown must not start"
    );
    assert!(second.retry_after_secs.is_some());
}
