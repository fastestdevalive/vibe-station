//! Scheduled-message HTTP surface: every error is `{ error, code }` with the
//! documented status, and `GET /api/sessions/:id/schedule` returns the snapshot.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
};

fn session(id: &str, channel: Channel, mode: &str, state: LifecycleState) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some(mode.into()),
        mode_icon: None,
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: channel == Channel::Tmux,
        channel: Some(channel),
        lifecycle: SessionLifecycle {
            state,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
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
        carry_over: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&v).unwrap())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn schedule_errors_are_error_and_code_and_get_returns_the_snapshot() {
    let home = tempdir().unwrap();
    let dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("modes.json"),
        json!([{ "id": "m-claude", "name": "m-claude", "cli": "claude", "context": "",
                 "createdAt": "2026-01-01T00:00:00.000Z", "model": null, "icon": "claude" }])
        .to_string(),
    )
    .unwrap();
    let _guard = with_home(home.path().to_path_buf());

    let tmp = tempdir().unwrap();
    let store = StoreHandle::open(tmp.path().join("vibe-station.db")).unwrap();
    store
        .add_project(ProjectRecord {
            id: "p1".into(),
            absolute_path: "/repos/p1".into(),
            prefix: "vs".into(),
            is_git: true,
            default_branch: Some("main".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            hidden: None,
            direct_sessions: vec![
                session("tty", Channel::Tmux, "m-claude", LifecycleState::Working),
                session("exited", Channel::Tmux, "m-claude", LifecycleState::Exited),
                session("done", Channel::Tmux, "m-claude", LifecycleState::Done),
                session("pty", Channel::Pty, "m-claude", LifecycleState::Working),
            ],
            direct_session_seq: Some(1),
            worktrees: vec![],
            next_worktree_num: Some(1),
            lsp_enabled: None,
            open_files: vec![],
        })
        .await
        .unwrap();
    let app = build_app(BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::<JsonAgentSession>::new()),
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.path().to_path_buf()),
        limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".to_string()),
    });

    let body = |msg: &str| json!({ "message": msg, "fireAt": "2099-01-01T00:00:00Z" });
    let expect = |(status, v): (StatusCode, Value), want: StatusCode, code: &str| {
        assert_eq!(status, want, "{v}");
        assert_eq!(v["code"], code, "{v}");
        assert!(v["error"].as_str().is_some_and(|m| !m.is_empty()), "{v}");
    };

    expect(
        call(&app, "POST", "/api/sessions/nope/schedule", Some(body("x"))).await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    );
    expect(
        call(&app, "POST", "/api/sessions/pty/schedule", Some(body("x"))).await,
        StatusCode::BAD_REQUEST,
        "NOT_SCHEDULABLE",
    );
    expect(
        call(
            &app,
            "POST",
            "/api/sessions/exited/schedule",
            Some(body("x")),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "AGENT_EXITED",
    );
    expect(
        call(&app, "POST", "/api/sessions/done/schedule", Some(body("x"))).await,
        StatusCode::CONFLICT,
        "DONE",
    );
    expect(
        call(&app, "POST", "/api/sessions/tty/schedule", Some(body("  "))).await,
        StatusCode::BAD_REQUEST,
        "BAD_REQUEST",
    );
    expect(
        call(&app, "DELETE", "/api/sessions/tty/schedule/missing", None).await,
        StatusCode::NOT_FOUND,
        "TURN_NOT_FOUND",
    );

    // Success stays 202 { id, fireAt }.
    let (status, created) = call(
        &app,
        "POST",
        "/api/sessions/tty/schedule",
        Some(body("hello")),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let id = created["id"].as_str().unwrap().to_string();

    // GET: the snapshot with the three lists.
    let (status, snap) = call(&app, "GET", "/api/sessions/tty/schedule", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snap["scheduledSends"][0]["id"], id.as_str());
    assert_eq!(snap["scheduledSends"][0]["phase"], "scheduled");
    assert_eq!(snap["scheduledSends"][0]["channel"], "tmux");
    assert_eq!(snap["scheduledFailed"], json!([]));
    assert_eq!(snap["scheduledSent"], json!([]));
    expect(
        call(&app, "GET", "/api/sessions/nope/schedule", None).await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    );

    // Cancel is 200 { ok } and the row is gone.
    let (status, ok) = call(
        &app,
        "DELETE",
        &format!("/api/sessions/tty/schedule/{id}"),
        None,
    )
    .await;
    assert_eq!((status, ok), (StatusCode::OK, json!({ "ok": true })));
    let (_, snap) = call(&app, "GET", "/api/sessions/tty/schedule", None).await;
    assert_eq!(snap["scheduledSends"], json!([]));
}
