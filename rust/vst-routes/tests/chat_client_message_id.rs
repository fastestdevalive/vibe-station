//! `clientMessageId` on `POST /sessions/:id/chat`: idempotent send, echo on the
//! live + persisted `user` row and on `queuedTurns[]`, validation, and the
//! absent-field path staying byte-identical.
//!
//! Real `JsonAgentSession` (recording mock plugin) + real store, driven through
//! `SessionRoutes::chat_session_outcome` (the 200-vs-202 decision the HTTP
//! handler maps).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::{tempdir, TempDir};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use vst_agents::home::{with_home, HomeGuard};
use vst_agents::json_agent_session::{
    get_or_create_json_agent_session, read_transcript_from_data_dir, JsonAgentSession,
    JsonAgentSessionOptions,
};
use vst_agents::paths::Paths as AgentPaths;
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{ChatOutcome, ChatRouteError, SessionRoutes};
use vst_store::StoreHandle;
use vst_types::rest::sessions::{ChatBody, Delivery};
use vst_types::{
    Broadcaster, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind,
    NormalizedEventProvider, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

// ── Fixtures ──────────────────────────────────────────────────────────────────

fn json_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("my-mode".into()),
        mode_icon: None,
        account_id: None,
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: false,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
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

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/repos/p1".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![json_session("s1")],
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// Records every turn's message; with `block` a turn lasts until it is cancelled.
struct RecPlugin {
    messages: Arc<Mutex<Vec<String>>>,
    block: bool,
    cancelled: Arc<AtomicBool>,
}

impl AgentPlugin for RecPlugin {
    fn name(&self) -> &str {
        "rec"
    }
    fn default_model(&self) -> &str {
        "mock-model"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "mock"
    }
    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        Default::default()
    }
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(&self, _input: ComposePromptInput) -> ComposePromptResult {
        ComposePromptResult::default()
    }
    fn default_channel(&self) -> Channel {
        Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<ListModelsResult> {
        Box::pin(async { ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        input: TurnInput,
        _ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        self.messages.lock().unwrap().push(input.message);
        let (tx, rx) = mpsc::unbounded_channel();
        let (block, flag) = (self.block, self.cancelled.clone());
        tokio::spawn(async move {
            if block {
                cancel.cancelled().await;
                flag.store(true, Ordering::SeqCst);
                return;
            }
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_millis(10)) => {
                    let mut ev = NormalizedEvent::default();
                    ev.kind = NormalizedEventKind::Result;
                    let _ = tx.send(ev);
                }
            }
        });
        rx
    }
}

fn write_modes(home: &std::path::Path) {
    let modes_dir = home.join(".vibe-station");
    std::fs::create_dir_all(&modes_dir).unwrap();
    let modes = serde_json::json!([{
        "id": "my-mode", "name": "My Mode", "cli": "claude", "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z", "model": null
    }]);
    std::fs::write(modes_dir.join("modes.json"), modes.to_string()).unwrap();
}

fn agent_for(
    env_store: &StoreHandle,
    routes: &SessionRoutes,
    session_id: &str,
    plugin: Arc<dyn AgentPlugin>,
) -> JsonAgentSession {
    get_or_create_json_agent_session(
        &routes.json_registry,
        JsonAgentSessionOptions {
            project: project(),
            worktree: None,
            session: json_session(session_id),
            plugin,
            daemon_port: 0,
            cli: NormalizedEventProvider::Claude,
            model: None,
            mode_id: Some("my-mode".into()),
            mode_name: Some("My Mode".into()),
            store_handle: env_store.clone(),
            broadcaster: Broadcaster(broadcast::channel(64).0),
        },
    )
    .unwrap()
}

struct Env {
    _home_dir: TempDir,
    _guard: HomeGuard,
    _db_dir: TempDir,
    routes: SessionRoutes,
    agent: JsonAgentSession,
    messages: Arc<Mutex<Vec<String>>>,
}

impl Env {
    /// `block`: a turn lasts until cancelled, so later sends stay queued.
    async fn new(block: bool) -> Self {
        let home_dir = tempdir().unwrap();
        write_modes(home_dir.path());
        let guard = with_home(home_dir.path().to_path_buf());
        let db_dir = tempdir().unwrap();
        let store = StoreHandle::open(db_dir.path().join("vibe-station.db")).unwrap();
        store.add_project(project()).await.unwrap();
        let broadcaster = Broadcaster::new(256);
        let routes = SessionRoutes {
            store: store.clone(),
            broadcaster: broadcaster.clone(),
            json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::new()),
            direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
            direct_streams: Arc::new(Mutex::new(std::collections::HashMap::new())),
            tmux: vst_proc::test_support::isolated_tmux(),
            daemon_port: 3999,
            json_unsupported: Arc::new(|_| None),
            subagent_notify: SubagentNotifyHandle::new(),
            attachment_registry: AttachmentRegistry::new(),
            model_catalog: Default::default(),
            handoff_timeout: Duration::from_secs(120),
            reset_cancels: Default::default(),
            terminal_delivery: vst_routes::terminal_delivery::build_terminal_delivery(
                store.clone(),
                broadcaster.clone(),
                Arc::new(vst_proc::test_support::isolated_tmux()),
                None,
            ),
            accounts: None,
        };
        let messages = Arc::new(Mutex::new(Vec::new()));
        let agent = agent_for(
            &store,
            &routes,
            "s1",
            Arc::new(RecPlugin {
                messages: messages.clone(),
                block,
                cancelled: Arc::new(AtomicBool::new(false)),
            }),
        );
        Env {
            _home_dir: home_dir,
            _guard: guard,
            _db_dir: db_dir,
            routes,
            agent,
            messages,
        }
    }

    async fn park_active(&self) {
        self.agent.enqueue("active".into(), vec![], None, None);
        wait_until("active turn starts", || {
            self.agent.get_meta().active_turn_id.is_some()
        })
        .await;
    }

    async fn send(&self, message: &str, cmid: Option<&str>) -> Result<ChatOutcome, ChatRouteError> {
        self.routes
            .chat_session_outcome(
                "s1",
                ChatBody {
                    message: message.into(),
                    attachment_ids: None,
                    queue: Some(true),
                    mentions: None,
                    review_comment_ids: None,
                    client_message_id: cmid.map(str::to_string),
                },
            )
            .await
    }

    fn user_rows(&self) -> Vec<NormalizedEvent> {
        let dir = AgentPaths::default().direct_session_data_dir("p1", "s1");
        read_transcript_from_data_dir(&dir, "s1")
            .into_iter()
            .filter(|e| e.kind == NormalizedEventKind::User)
            .collect()
    }
}

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn bad_request(e: &ChatRouteError) -> bool {
    matches!(e, ChatRouteError::BadRequest(_))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn absent_field_is_unchanged_and_unrecorded() {
    let env = Env::new(false).await;
    let a = env.send("hello", None).await.unwrap();
    let b = env.send("hello", None).await.unwrap();
    assert!(!a.duplicate && !b.duplicate);
    assert_ne!(a.result.turn_id, b.result.turn_id);
    wait_until("both ran", || env.messages.lock().unwrap().len() == 2).await;
    wait_until("rows", || env.user_rows().len() == 2).await;
    for row in env.user_rows() {
        let v = serde_json::to_value(&row).unwrap();
        assert!(
            v.get("clientMessageId").is_none(),
            "key must be omitted: {v}"
        );
    }
    let wire = serde_json::to_value(&a.result).unwrap();
    assert!(wire.get("clientMessageId").is_none());
}

#[tokio::test]
async fn first_send_is_fresh_and_echoed_live_and_replayed() {
    let env = Env::new(false).await;
    let live: Arc<Mutex<Vec<NormalizedEvent>>> = Arc::default();
    let sink = live.clone();
    let _guard = env.agent.stream().subscribe_message(Box::new(move |ev| {
        if ev.kind == NormalizedEventKind::User {
            sink.lock().unwrap().push(ev.clone());
        }
    }));
    let out = env.send("hi", Some("cm-1")).await.unwrap();
    assert!(!out.duplicate);
    wait_until("live user event", || !live.lock().unwrap().is_empty()).await;
    assert_eq!(
        live.lock().unwrap()[0].client_message_id.as_deref(),
        Some("cm-1")
    );
    wait_until("persisted row", || !env.user_rows().is_empty()).await;
    let rows = env.user_rows();
    assert_eq!(
        rows[0].turn_id.as_deref(),
        Some(out.result.turn_id.as_str())
    );
    assert_eq!(rows[0].client_message_id.as_deref(), Some("cm-1"));
    // On the wire: camelCase key.
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap()["clientMessageId"],
        "cm-1"
    );
}

#[tokio::test]
async fn duplicate_returns_same_turn_and_does_not_enqueue_again() {
    let env = Env::new(false).await;
    let first = env.send("once", Some("cm-1")).await.unwrap();
    wait_until("ran", || env.messages.lock().unwrap().len() == 1).await;
    wait_until("row", || env.user_rows().len() == 1).await;
    let dup = env
        .send("once (retry, different body ignored)", Some("cm-1"))
        .await
        .unwrap();
    assert!(dup.duplicate);
    assert_eq!(dup.result.turn_id, first.result.turn_id);
    assert_eq!(dup.result.delivery, first.result.delivery);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(env.messages.lock().unwrap().len(), 1, "no second run");
    assert_eq!(env.user_rows().len(), 1, "no second user row");
}

#[tokio::test]
async fn duplicate_while_queued_reports_current_position() {
    let env = Env::new(true).await;
    env.park_active().await;
    let a = env.send("a", Some("cm-a")).await.unwrap();
    let b = env.send("b", Some("cm-b")).await.unwrap();
    assert_eq!((a.result.queue_position, b.result.queue_position), (1, 2));
    assert_eq!(a.result.delivery, Some(Delivery::Queued));
    // Drop `a`: `b` moves up, and the duplicate of `b` shows its CURRENT place.
    assert!(env.agent.cancel_queued_turn(&a.result.turn_id));
    let dup = env.send("b", Some("cm-b")).await.unwrap();
    assert!(dup.duplicate);
    assert_eq!(dup.result.turn_id, b.result.turn_id);
    assert_eq!(dup.result.queue_position, 1);
    assert_eq!(env.agent.get_meta().queue_depth, 1, "not enqueued twice");
}

#[tokio::test]
async fn concurrent_duplicates_enqueue_once() {
    let env = Env::new(true).await;
    env.park_active().await;
    let (a, b, c) = tokio::join!(
        env.send("x", Some("cm-x")),
        env.send("x", Some("cm-x")),
        env.send("x", Some("cm-x")),
    );
    let outs = [a.unwrap(), b.unwrap(), c.unwrap()];
    assert_eq!(outs.iter().filter(|o| !o.duplicate).count(), 1);
    assert!(outs
        .iter()
        .all(|o| o.result.turn_id == outs[0].result.turn_id));
    assert_eq!(env.agent.get_meta().queue_depth, 1);
}

#[tokio::test]
async fn failed_send_is_not_recorded() {
    let env = Env::new(false).await;
    // Unknown session: 404, and nothing is recorded for the id.
    let err = env
        .routes
        .chat_session_outcome(
            "nope",
            ChatBody {
                message: "x".into(),
                attachment_ids: None,
                queue: None,
                mentions: None,
                review_comment_ids: None,
                client_message_id: Some("cm-1".into()),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::NotFound(_)));
    // A bad attachment fails the first send after the claim: id stays free.
    let mut body = ChatBody {
        message: "x".into(),
        attachment_ids: Some(vec!["missing".into()]),
        queue: None,
        mentions: None,
        review_comment_ids: None,
        client_message_id: Some("cm-1".into()),
    };
    assert!(env
        .routes
        .chat_session_outcome("s1", body.clone())
        .await
        .is_err());
    body.attachment_ids = None;
    let ok = env.routes.chat_session_outcome("s1", body).await.unwrap();
    assert!(!ok.duplicate, "failed first send must not be remembered");
}

#[tokio::test]
async fn invalid_ids_are_400() {
    let env = Env::new(false).await;
    for bad in ["".to_string(), "x".repeat(65)] {
        let err = env.send("hi", Some(&bad)).await.unwrap_err();
        assert!(bad_request(&err), "{bad:?}");
    }
    // Boundaries are accepted (64 chars, counted as characters not bytes).
    assert!(env.send("hi", Some(&"x".repeat(64))).await.is_ok());
    assert!(env.send("hi", Some(&"é".repeat(64))).await.is_ok());
}

#[tokio::test]
async fn queued_turns_meta_and_cancelled_row_carry_the_id() {
    let env = Env::new(true).await;
    env.park_active().await;
    let a = env.send("a", Some("cm-a")).await.unwrap();
    let plain = env.send("p", None).await.unwrap();
    let meta = env.agent.get_meta();
    let find = |t: &str| {
        meta.queued_turns
            .iter()
            .find(|q| q.turn_id == t)
            .unwrap()
            .clone()
    };
    assert_eq!(
        find(&a.result.turn_id).client_message_id.as_deref(),
        Some("cm-a")
    );
    let plain_wire = serde_json::to_value(find(&plain.result.turn_id)).unwrap();
    assert!(plain_wire.get("clientMessageId").is_none());
    assert_eq!(
        serde_json::to_value(find(&a.result.turn_id)).unwrap()["clientMessageId"],
        "cm-a"
    );
    // Held for editing: still matchable by id.
    env.agent.begin_edit_queued_turn(&a.result.turn_id).unwrap();
    assert_eq!(
        env.agent
            .get_meta()
            .queued_turns
            .iter()
            .find(|q| q.turn_id == a.result.turn_id)
            .unwrap()
            .client_message_id
            .as_deref(),
        Some("cm-a")
    );
    // Cancelling emits the `cancelled` row with the id.
    assert!(env.agent.cancel_queued_turn(&a.result.turn_id));
    let rows = env.user_rows();
    let cancelled = rows
        .iter()
        .find(|r| r.cancelled == Some(true))
        .expect("cancelled row");
    assert_eq!(cancelled.client_message_id.as_deref(), Some("cm-a"));
}
