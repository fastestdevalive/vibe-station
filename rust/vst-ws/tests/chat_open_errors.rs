//! `chat:open` must always answer. A transcript that cannot be opened used to
//! panic inside the `JsonAgentRegistry` lock: the handler died without a reply
//! (infinite "Loading history…") and the poisoned registry killed Rich Chat for
//! every other session until a daemon restart.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_agents::paths::Paths;
use vst_store::StoreHandle;
use vst_types::{
    Broadcaster, Channel, ClientMessage, LifecycleState, ProjectRecord, SessionLifecycle,
    SessionRecord, SessionType,
};
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

fn of_type(sent: &Arc<Mutex<Vec<Value>>>, ty: &str, sid: &str) -> Vec<Value> {
    sent.lock()
        .unwrap()
        .iter()
        .filter(|m| m["type"] == ty && m["sessionId"] == sid)
        .cloned()
        .collect()
}

async fn open(
    store: &StoreHandle,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    broadcaster: &Broadcaster,
    sid: &str,
) -> Arc<Mutex<Vec<Value>>> {
    open_since(store, registry, broadcaster, sid, None).await
}

/// `since_seq: Some(_)` is what a client restoring a cached snapshot sends.
async fn open_since(
    store: &StoreHandle,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    broadcaster: &Broadcaster,
    sid: &str,
    since_seq: Option<i64>,
) -> Arc<Mutex<Vec<Value>>> {
    let (c, sent) = conn();
    handle_chat_open(
        &c,
        store,
        registry,
        broadcaster.clone(),
        0,
        &ClientMessage::ChatOpen {
            session_id: sid.into(),
            since_seq,
        },
    )
    .await;
    sent
}

/// Make `sid`'s transcript unopenable: `messages.db` is a directory.
fn break_transcript(sid: &str) -> std::path::PathBuf {
    let db = Paths::default()
        .direct_session_data_dir(PID, sid)
        .join("messages.db");
    std::fs::create_dir_all(&db).unwrap();
    db
}

fn assert_history_error(sent: &Arc<Mutex<Vec<Value>>>, sid: &str) {
    let errs = of_type(sent, "session:error", sid);
    assert_eq!(
        errs.len(),
        1,
        "exactly one session:error: {:?}",
        sent.lock().unwrap()
    );
    assert_eq!(errs[0]["reason"], "transient");
    assert!(errs[0]["message"].as_str().unwrap().contains("history"));
    assert!(
        of_type(sent, "chat:replay", sid).is_empty(),
        "no empty replay masking the failure"
    );
}

#[tokio::test]
async fn unopenable_history_answers_with_session_error_and_others_keep_working() {
    let tmp = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(tmp.path().to_path_buf());
    let store = StoreHandle::open(tmp.path().join("t.db")).unwrap();
    store
        .add_project(project(vec![
            session_record("broken", LifecycleState::WaitingForHuman, Some("m")),
            session_record("done-broken", LifecycleState::Done, Some("m")),
            session_record("nomode-broken", LifecycleState::WaitingForHuman, None),
            session_record("ok", LifecycleState::WaitingForHuman, Some("m")),
        ]))
        .await
        .unwrap();
    let broadcaster = Broadcaster::new(64);
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();

    // Live path: the lazy create fails -> session:error, nothing registered.
    let db = break_transcript("broken");
    let sent = open(&store, &registry, &broadcaster, "broken").await;
    assert_history_error(&sent, "broken");
    assert!(registry.get("broken").is_none());
    // Same answer for a cached-snapshot client's delta request.
    let sent = open_since(&store, &registry, &broadcaster, "broken", Some(5)).await;
    assert_history_error(&sent, "broken");

    // Disk-snapshot paths (done session; unresolvable mode) error too instead
    // of replaying an empty history.
    break_transcript("done-broken");
    assert_history_error(
        &open(&store, &registry, &broadcaster, "done-broken").await,
        "done-broken",
    );
    break_transcript("nomode-broken");
    assert_history_error(
        &open(&store, &registry, &broadcaster, "nomode-broken").await,
        "nomode-broken",
    );

    // A panicking construction for one session does not take chat:open down
    // for the others.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        registry.get_or_insert_with("ghost", || panic!("constructor blew up"))
    }));
    assert!(r.is_err());
    let sent = open(&store, &registry, &broadcaster, "ok").await;
    assert_eq!(
        of_type(&sent, "chat:replay", "ok").len(),
        1,
        "{:?}",
        sent.lock().unwrap()
    );
    assert!(of_type(&sent, "session:error", "ok").is_empty());

    // Retry after the store recovers succeeds.
    std::fs::remove_dir_all(&db).unwrap();
    let sent = open(&store, &registry, &broadcaster, "broken").await;
    assert_eq!(of_type(&sent, "chat:replay", "broken").len(), 1);
    assert!(registry.get("broken").is_some());

    for sid in ["ok", "broken"] {
        if let Some(s) = registry.remove(sid) {
            s.release().await;
        }
    }
}
