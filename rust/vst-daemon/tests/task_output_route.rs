//! `GET /api/sessions/:id/tasks/:taskId/output` (task-tray 1.T16), mounted
//! exactly as in production under `/api`.

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::tempdir;
use tower::ServiceExt;

use vst_agents::claude::create_claude_plugin;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_daemon::network::NetworkControl;
use vst_daemon::server::{build_app, BuildServerOptions};
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::{
    AcpToolKind, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, ProjectRecord,
    SessionLifecycle, SessionRecord, SessionType, ToolResult, ToolStatus,
};

const PID: &str = "p-1";
const SID: &str = "s-live";

fn session_record(id: &str, state: LifecycleState) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: PID.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: false,
        channel: Some(Channel::Json),
        pinned_at: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        draft_prompt: None,
        draft_config: None,
        initial_prompt: None,
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        lifecycle: SessionLifecycle {
            state,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn project(sessions: Vec<SessionRecord>) -> ProjectRecord {
    ProjectRecord {
        id: PID.into(),
        absolute_path: "/repos/p1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: sessions,
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

async fn json_of(resp: axum::response::Response) -> (StatusCode, String, Value) {
    let status = resp.status();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, ct, v)
}

fn ev(
    id: &str,
    kind: NormalizedEventKind,
    f: impl FnOnce(&mut NormalizedEvent),
) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = id.into();
    e.session_id = SID.into();
    e.ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    e.kind = kind;
    f(&mut e);
    e
}

async fn background_command(
    session: &JsonAgentSession,
    tool: &str,
    task: &str,
    path: Option<&str>,
) {
    session
        .handle_event(&mut ev(
            &format!("l-{task}"),
            NormalizedEventKind::ToolResult,
            |e| {
                e.tool_id = Some(tool.into());
                e.tool_kind = Some(AcpToolKind::Execute);
                e.tool_input =
                    Some(serde_json::json!({"command": "tail -f x", "run_in_background": true}));
            },
        ))
        .await;
    let text = match path {
        Some(p) => format!(
            "Command running in background with ID: {task}. Output is being written to: {p}. You will be notified when it completes."
        ),
        None => format!("Command running in background with ID: {task}. You will be notified."),
    };
    session
        .handle_event(&mut ev(
            &format!("b-{task}"),
            NormalizedEventKind::ToolResult,
            |e| {
                e.tool_id = Some(tool.into());
                e.tool_status = Some(ToolStatus::Completed);
                e.tool_result = Some(ToolResult {
                    content: Some(text),
                    is_error: Some(false),
                });
            },
        ))
        .await;
}

#[tokio::test]
async fn task_output_route_200_404_409_under_api() {
    let tmp = tempdir().unwrap();
    let _home = vst_agents::home::with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("vibe-station.db")).unwrap();
    let live = session_record(SID, LifecycleState::Working);
    let done = session_record("s-done", LifecycleState::Done);
    store
        .add_project(project(vec![live.clone(), done]))
        .await
        .unwrap();

    let broadcaster = Broadcaster::new(64);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    let app = build_app(BuildServerOptions {
        network: NetworkControl::fixed(false),
        port: 0,
        auth_state: None,
        no_auth: true,
        stop_requested: Arc::new(tokio::sync::Notify::new()),
        dist_path: None,
        persist_epoch: None,
        store: store.clone(),
        broadcaster: broadcaster.clone(),
        json_registry: json_registry.clone(),
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.path().to_path_buf()),
        limits: vst_harness_limits::LimitsHandle::inert(Broadcaster::new(16), "test".to_string()),
    });

    // 404: session not resident (never created) — and NOT created by the GET.
    let (st, ct, body) = json_of(
        app.clone()
            .oneshot(get("/api/sessions/s-done/tasks/b1/output"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(ct.contains("application/json"), "{ct}");
    assert_eq!(body["code"], "TASK_NOT_FOUND");
    assert!(
        json_registry.get("s-done").is_none(),
        "a released Done session must not be re-created by an output read"
    );

    // A live session with two background commands: one with a file, one without.
    let session = Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project: project(vec![live.clone()]),
        worktree: None,
        session: live,
        plugin: Arc::new(create_claude_plugin()),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store.clone(),
        broadcaster,
    }));
    json_registry.set(SID.to_string(), session.clone());

    let out_dir = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("claude-1000/p/u/tasks");
    std::fs::create_dir_all(&out_dir).unwrap();
    let file = out_dir.join("be00epro0.output");
    std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
    background_command(
        &session,
        "tool-1",
        "be00epro0",
        Some(&file.display().to_string()),
    )
    .await;
    background_command(&session, "tool-2", "nopath1", None).await;

    // 200: tail of the file.
    let (st, ct, body) = json_of(
        app.clone()
            .oneshot(get("/api/sessions/s-live/tasks/be00epro0/output?tail=2"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert!(ct.contains("application/json"));
    assert_eq!(body["lines"], serde_json::json!(["two", "three"]));
    assert_eq!(body["truncated"], true);
    assert_eq!(body["totalBytes"], 14);
    assert_eq!(body["outputKind"], "file");
    assert_eq!(body["path"], file.display().to_string());

    // Default tail returns everything that exists.
    let (_, _, body) = json_of(
        app.clone()
            .oneshot(get("/api/sessions/s-live/tasks/be00epro0/output"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(body["lines"], serde_json::json!(["one", "two", "three"]));
    assert_eq!(body["truncated"], false);

    // 404: unknown task on a resident session.
    let (st, _, body) = json_of(
        app.clone()
            .oneshot(get("/api/sessions/s-live/tasks/zzz/output"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "TASK_NOT_FOUND");

    // 409: known task, no readable output.
    let (st, _, body) = json_of(
        app.clone()
            .oneshot(get("/api/sessions/s-live/tasks/nopath1/output"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body["code"], "OUTPUT_UNAVAILABLE");

    // 409: the file vanished after being tracked.
    std::fs::remove_file(&file).unwrap();
    let (st, _, body) = json_of(
        app.oneshot(get("/api/sessions/s-live/tasks/be00epro0/output"))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body["code"], "OUTPUT_UNAVAILABLE");
}
