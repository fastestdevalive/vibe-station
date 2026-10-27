//! `session:tasks` delivery (task-tray 1.T14): routed only to session
//! subscribers, and `chat:open` sends a snapshot on every branch.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use vst_agents::claude::create_claude_plugin;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_store::StoreHandle;
use vst_types::{
    Broadcaster, Channel, ClientMessage, LifecycleState, NormalizedEvent, NormalizedEventKind,
    ProjectRecord, ServerEvent, SessionLifecycle, SessionRecord, SessionType, TaskKind,
    TaskOutputKind, TaskState, TaskSummary, ToolResult, ToolStatus,
};
use vst_ws::broadcaster::{spawn_event_fanout, WsHub};
use vst_ws::connection::{WsConnection, WsSinkHandle};
use vst_ws::handlers::chat_open::handle_chat_open;

const PID: &str = "p1";

fn session_record(id: &str, state: LifecycleState, mode: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: PID.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: mode.map(str::to_string),
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

fn conn() -> (WsConnection, Arc<Mutex<Vec<Value>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let sink = WsSinkHandle::from_parts(
        sent.clone(),
        Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        Arc::new(Mutex::new(None)),
    );
    (WsConnection::new(sink), sent)
}

fn tasks_msgs(sent: &Arc<Mutex<Vec<Value>>>, sid: &str) -> Vec<Value> {
    sent.lock()
        .unwrap()
        .iter()
        .filter(|m| m["type"] == "session:tasks" && m["sessionId"] == sid)
        .cloned()
        .collect()
}

fn summary(id: &str) -> TaskSummary {
    TaskSummary {
        id: id.into(),
        tool_id: "t".into(),
        kind: TaskKind::Command,
        label: "x".into(),
        state: TaskState::Running,
        reason: None,
        started_at: "2026-10-27T10:00:00.000Z".into(),
        ended_at: None,
        last_activity_at: None,
        output_kind: TaskOutputKind::None,
        output_rev: 0,
        output_path: None,
        can_stop: false,
    }
}

#[tokio::test]
async fn session_tasks_reach_only_connections_looking_at_that_session() {
    let hub = Arc::new(WsHub::new());
    let (a, a_sent) = conn();
    let (b, b_sent) = conn();
    hub.register_connection(&a);
    hub.register_connection(&b);
    a.subscribe_chat("s1");
    b.subscribe_chat("other");

    let broadcaster = Broadcaster::new(16);
    let _fanout = spawn_event_fanout(hub, broadcaster.clone());
    tokio::task::yield_now().await;
    broadcaster.send(ServerEvent::SessionTasksChanged {
        session_id: "s1".into(),
        rev: 5,
        tasks: vec![summary("b1")],
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    let got = tasks_msgs(&a_sent, "s1");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["rev"], 5);
    assert_eq!(got[0]["tasks"][0]["id"], "b1");
    assert!(
        b_sent
            .lock()
            .unwrap()
            .iter()
            .all(|m| m["type"] != "session:tasks"),
        "not fanned out to unrelated connections"
    );
}

async fn open(
    conn: &WsConnection,
    store: &StoreHandle,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    broadcaster: &Broadcaster,
    sid: &str,
) {
    handle_chat_open(
        conn,
        store,
        registry,
        broadcaster.clone(),
        0,
        &ClientMessage::ChatOpen {
            session_id: sid.into(),
            since_seq: None,
        },
    )
    .await;
}

fn ev(id: &str, f: impl FnOnce(&mut NormalizedEvent)) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = id.into();
    e.session_id = "live".into();
    // Must be "now": the registry expires old commands, so a fixed date rots the test.
    e.ts = vst_agents::util::now_iso_8601();
    e.kind = NormalizedEventKind::ToolResult;
    f(&mut e);
    e
}

#[tokio::test]
async fn chat_open_sends_a_tasks_snapshot_on_every_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    store
        .add_project(project(vec![
            session_record("done", LifecycleState::Done, Some("m")),
            // JSON channel but no mode: resolve_json_agent fails -> unresolved branch.
            session_record("nomode", LifecycleState::WaitingForHuman, None),
            session_record("live", LifecycleState::WaitingForHuman, Some("m")),
        ]))
        .await
        .unwrap();
    let broadcaster = Broadcaster::new(64);
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();

    // Done branch: empty snapshot, and the released session is not re-created.
    let (c, sent) = conn();
    open(&c, &store, &registry, &broadcaster, "done").await;
    let m = tasks_msgs(&sent, "done");
    assert_eq!(m.len(), 1, "{:?}", sent.lock().unwrap());
    assert_eq!(m[0]["tasks"], serde_json::json!([]));
    assert!(m[0]["rev"].as_u64().unwrap() > 0);
    assert!(registry.get("done").is_none());

    // Unresolved branch: NO tasks snapshot (failing to resolve is not proof of "no tasks"; an empty
    // one would wipe the client's tray).
    let (c, sent) = conn();
    open(&c, &store, &registry, &broadcaster, "nomode").await;
    assert!(tasks_msgs(&sent, "nomode").is_empty());

    // Live branch: the resident session's registry, with a Claude plugin so
    // the background command is detected.
    let live_rec = session_record("live", LifecycleState::WaitingForHuman, Some("m"));
    let session = Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project: project(vec![live_rec.clone()]),
        worktree: None,
        session: live_rec,
        plugin: Arc::new(create_claude_plugin()),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: Some("m".into()),
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: broadcaster.clone(),
    }));
    registry.set("live".to_string(), session.clone());

    let (c, sent) = conn();
    open(&c, &store, &registry, &broadcaster, "live").await;
    let first = tasks_msgs(&sent, "live");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["tasks"], serde_json::json!([]));
    let rev0 = first[0]["rev"].as_u64().unwrap();

    // A background command appears; the live broadcast carries a NEWER rev
    // than the snapshot the client already holds (so an older snapshot
    // arriving later is detectably stale).
    let mut rx = broadcaster.subscribe();
    session
        .handle_event(&mut ev("l", |e| {
            e.tool_id = Some("tool-1".into());
            e.tool_kind = Some(vst_types::AcpToolKind::Execute);
            e.tool_input =
                Some(serde_json::json!({"command": "sleep 5", "run_in_background": true}));
        }))
        .await;
    session
        .handle_event(&mut ev("b", |e| {
            e.tool_id = Some("tool-1".into());
            e.tool_status = Some(ToolStatus::Completed);
            e.tool_result = Some(ToolResult {
                content: Some("Command running in background with ID: bx1. Output is being written to: /tmp/claude-1/p/u/tasks/bx1.output.".into()),
                is_error: Some(false),
            });
        }))
        .await;
    let (live_rev, live_tasks) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(ServerEvent::SessionTasksChanged { rev, tasks, .. }) = rx.recv().await {
                if !tasks.is_empty() {
                    return (rev, tasks);
                }
            }
        }
    })
    .await
    .expect("live broadcast");
    assert!(
        live_rev > rev0,
        "live rev {live_rev} must beat snapshot rev {rev0}"
    );
    assert_eq!(live_tasks[0].id, "bx1");

    // Re-opening now yields a snapshot with the task and a rev that is not
    // older than the broadcast one.
    let (c2, sent2) = conn();
    open(&c2, &store, &registry, &broadcaster, "live").await;
    let again = tasks_msgs(&sent2, "live");
    assert_eq!(again.len(), 1);
    assert_eq!(again[0]["tasks"][0]["id"], "bx1");
    assert!(again[0]["rev"].as_u64().unwrap() >= live_rev);
}
