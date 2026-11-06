//! Rich Chat delivery of review comments through the chat routes (plan 04,
//! Phase 2): a send moves comments into a hold and queues the turn, the turn
//! observer settles the hold, and every way a queued turn can end (cancel, edit,
//! delete, reset, scheduled fire) leaves the comments in exactly one place.
//!
//! Real `ReviewHandle` + real `JsonAgentSession` (mock plugin) + real store; the
//! two meet only through the `ReviewPort` / `TurnObserver` seams on the registry.

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
use vst_review::ReviewHandle;
use vst_routes::sessions::{ChatRouteError, SessionRoutes};
use vst_store::comment_consumers::{Consumer, ScheduleSpec, TakeLimits};
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::rest::review::{AttachBody, CreateCommentBody};
use vst_types::rest::sessions::{ChatBody, QueuedPolicy, ResetBody, ResubmitBody};
use vst_types::review::{
    CommentSurface, PathKind, PayloadState, RestoreReason, ReviewComment, ReviewError,
};
use vst_types::{
    Broadcaster, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind,
    NormalizedEventProvider, ProjectRecord, ServerEvent, SessionLifecycle, SessionNameSource,
    SessionRecord, SessionType,
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

/// One `comments:changed`: upserted ids and `(deleted id, reason)`.
type SeenEvent = (Vec<String>, Vec<(String, String)>);

struct Env {
    _home_dir: TempDir,
    _guard: HomeGuard,
    _db_dir: TempDir,
    store: StoreHandle,
    broadcaster: Broadcaster,
    rx: broadcast::Receiver<ServerEvent>,
    review: ReviewHandle,
    routes: SessionRoutes,
    scope: ScopeKey,
    agent: JsonAgentSession,
    messages: Arc<Mutex<Vec<String>>>,
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
}

impl Env {
    async fn new(block: bool) -> Self {
        let home_dir = tempdir().unwrap();
        write_modes(home_dir.path());
        let guard = with_home(home_dir.path().to_path_buf());
        let db_dir = tempdir().unwrap();
        let store = StoreHandle::open(db_dir.path().join("vibe-station.db")).unwrap();
        store.add_project(project()).await.unwrap();
        let broadcaster = Broadcaster::new(256);
        let rx = broadcaster.subscribe();
        let artifacts = vst_artifacts::ArtifactsHandle::new(
            store.clone(),
            broadcaster.clone(),
            Arc::new(vst_artifacts::StoreResolver::new(
                store.clone(),
                home_dir.path().join(".vibe-station"),
            )),
        );
        let review = ReviewHandle::new(store.clone(), broadcaster.clone(), artifacts);
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
        };
        // The daemon's wiring (`build_state`): the owner behind both seams.
        let (port, observer) = vst_review::hooks(&review);
        routes.json_registry.set_review_hooks(port, observer);
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
            store,
            broadcaster,
            rx,
            review,
            routes,
            scope: ScopeKey::project("p1"),
            agent,
            messages,
        }
    }

    /// Start one running (never-ending) turn so later sends stay queued.
    async fn park_active(&self) {
        self.agent.enqueue("active".into(), vec![], None, None);
        wait_until("active turn starts", || {
            self.agent.get_meta().active_turn_id.is_some()
        })
        .await;
    }

    async fn comment(&self, id: &str, line: u32) -> ReviewComment {
        let (c, _) = self
            .review
            .create(
                &self.scope,
                CreateCommentBody {
                    id: id.into(),
                    path: "src/f.rs".into(),
                    path_kind: PathKind::Repo,
                    surface: CommentSurface::File,
                    diff_scope: None,
                    base_sha: None,
                    side: None,
                    line_start: Some(line),
                    line_end: Some(line),
                    old_start: None,
                    old_end: None,
                    new_start: None,
                    new_end: None,
                    quote: format!("quote of {id}"),
                    prefix: String::new(),
                    suffix: String::new(),
                    occurrence: 0,
                    text: format!("text of {id}"),
                    restore_pin: None,
                },
            )
            .await
            .unwrap();
        c
    }

    async fn panel(&self) -> Vec<ReviewComment> {
        self.review
            .list(&self.scope, None, false)
            .await
            .unwrap()
            .comments
    }

    async fn send(
        &self,
        message: &str,
        ids: &[&str],
    ) -> Result<vst_types::rest::sessions::EnqueueChatResult, ChatRouteError> {
        self.routes
            .chat_session(
                "s1",
                ChatBody {
                    message: message.into(),
                    attachment_ids: None,
                    queue: None,
                    mentions: None,
                    review_comment_ids: Some(ids.iter().map(|s| s.to_string()).collect()),
                },
            )
            .await
    }

    /// `comments:changed` events seen so far: `(upserted ids, (deleted id, reason))`.
    fn comment_events(&mut self) -> Vec<SeenEvent> {
        self.review.flush_events();
        let mut out = Vec::new();
        while let Ok(ev) = self.rx.try_recv() {
            if let ServerEvent::CommentsChanged {
                upserted, deleted, ..
            } = ev
            {
                out.push((
                    upserted.into_iter().map(|c| c.id).collect(),
                    deleted
                        .into_iter()
                        .map(|d| (d.id, d.reason.as_str().to_string()))
                        .collect(),
                ));
            }
        }
        out
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

/// Poll the panel until it has `n` comments (a restore is spawned off the cancel).
async fn wait_panel(env: &Env, n: usize) -> Vec<ReviewComment> {
    for _ in 0..400 {
        let p = env.panel().await;
        if p.len() >= n {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("panel never reached {n} comments: {:?}", env.panel().await);
}

// ── 2.T1: send ────────────────────────────────────────────────────────────────

/// Ids only (empty message): comments leave the panel, a hold records the turn id,
/// the turn is queued (never steered) and `session:meta` summarises it.
#[tokio::test]
async fn ids_only_send_holds_the_comments_and_queues_the_turn() {
    let mut env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    env.comment_events();

    let res = env.send("", &["c1", "c2"]).await.unwrap();
    assert!(res.queue_position >= 1);
    assert_eq!(
        res.delivery,
        Some(vst_types::rest::sessions::Delivery::Queued)
    );

    assert!(env.panel().await.is_empty(), "rows deleted on send");
    let holds = env.store.list_holds(Some("s1")).await.unwrap();
    assert_eq!(holds.len(), 1);
    assert_eq!(
        holds[0].turn_id, res.turn_id,
        "the hold records the minted turn id"
    );
    assert_eq!(holds[0].record.comments.len(), 2);
    assert_eq!(holds[0].scope, env.scope);

    let q = env.agent.get_meta().queued_turns;
    let q = q.iter().find(|t| t.turn_id == res.turn_id).expect("queued");
    assert_eq!((q.review.unwrap().count, q.message.as_str()), (2, ""));

    let ev = env.comment_events();
    let mut gone: Vec<_> = ev.iter().flat_map(|e| e.1.clone()).collect();
    gone.sort();
    assert_eq!(
        gone,
        vec![("c1".into(), "sent".into()), ("c2".into(), "sent".into())]
    );
    env.agent.abort_and_drain();
}

/// The turn runs: the block reaches the agent, the user row carries the snapshot,
/// the hold is gone, and the comments stay gone.
#[tokio::test]
async fn the_turn_delivers_the_block_persists_the_snapshot_and_deletes_the_hold() {
    let env = Env::new(false).await;
    env.comment("c1", 7).await;
    let res = env.send("see these", &["c1"]).await.unwrap();

    wait_until("turn delivered", || {
        !env.messages.lock().unwrap().is_empty()
    })
    .await;
    for _ in 0..400 {
        if env.store.list_holds(None).await.unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        env.store.list_holds(None).await.unwrap().is_empty(),
        "hold settled"
    );
    let msg = env.messages.lock().unwrap()[0].clone();
    assert!(
        msg.starts_with("see these\n\nReview comments (1) · p1\n"),
        "{msg}"
    );
    assert!(msg.contains("text of c1"));

    let dir = AgentPaths::default().direct_session_data_dir("p1", "s1");
    let rows: Vec<_> = read_transcript_from_data_dir(&dir, "s1")
        .into_iter()
        .filter(|e| {
            e.kind == NormalizedEventKind::User
                && e.turn_id.as_deref() == Some(res.turn_id.as_str())
        })
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].review.as_ref().unwrap().comments[0].id, "c1");
    assert_eq!(rows[0].text.as_deref(), Some("see these"));
    assert!(env.panel().await.is_empty());
}

/// A send to an `exited` Rich Chat agent resumes it and carries the review.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_to_an_exited_session_resumes_it_with_the_review() {
    let env = Env::new(false).await;
    env.store
        .update_session_lifecycle(
            "p1",
            "s1",
            SessionLifecycle {
                state: LifecycleState::Exited,
                reason: None,
                last_transition_at: "2026-01-02T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    env.comment("c1", 1).await;
    env.send("resume", &["c1"]).await.unwrap();
    wait_until("delivered", || !env.messages.lock().unwrap().is_empty()).await;
    assert!(env.messages.lock().unwrap()[0].contains("1) File: src/f.rs"));
    let lc = env.store.get_all_projects().await[0].direct_sessions[0]
        .lifecycle
        .state;
    assert_eq!(lc, LifecycleState::Working, "the session is marked working");
}

// ── 2.T2 / 2.T3 / 2.T4 / 2.T6: refusals and cancel ───────────────────────────

#[tokio::test]
async fn cancelling_the_queued_turn_restores_the_comments_in_one_event() {
    let mut env = Env::new(true).await;
    env.park_active().await;
    for (i, id) in ["c1", "c2", "c3"].iter().enumerate() {
        env.comment(id, i as u32 + 1).await;
    }
    let pins: Vec<u32> = env.panel().await.iter().map(|c| c.pin).collect();
    let res = env.send("", &["c1", "c2", "c3"]).await.unwrap();
    env.comment_events();

    env.routes
        .cancel_queued_turn("s1", &res.turn_id)
        .await
        .unwrap();
    let back = wait_panel(&env, 3).await;
    assert_eq!(
        back.iter().map(|c| c.pin).collect::<Vec<_>>(),
        pins,
        "original pins"
    );
    assert!(back
        .iter()
        .all(|c| c.restored_reason == Some(RestoreReason::TurnCancelled)));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
    let ev = env.comment_events();
    assert_eq!(ev.len(), 1, "one comments:changed: {ev:?}");
    assert_eq!(ev[0].0.len(), 3);
    env.agent.abort_and_drain();
}

#[tokio::test]
async fn a_second_send_of_the_same_ids_is_comments_changed_and_queues_no_second_turn() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.send("", &["c1"]).await.unwrap();
    let depth = env.agent.get_meta().queue_depth;

    let err = env.send("again", &["c1"]).await.unwrap_err();
    match err {
        ChatRouteError::Review(ReviewError::Changed { remaining }) => assert_eq!(remaining, 0),
        other => panic!("expected comments_changed, got {other:?}"),
    }
    assert_eq!(env.agent.get_meta().queue_depth, depth, "no second turn");
    env.agent.abort_and_drain();
}

#[tokio::test]
async fn ids_attached_to_another_composer_are_not_attached_but_unattached_ids_pass() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    env.comment("c3", 3).await;
    env.review
        .attach(
            &env.scope,
            AttachBody {
                composer_key: "session:other".into(),
                comment_ids: Some(vec!["c1".into()]),
                refresh_only: None,
            },
        )
        .await
        .unwrap();
    env.review
        .attach(
            &env.scope,
            AttachBody {
                composer_key: "session:s1".into(),
                comment_ids: Some(vec!["c3".into()]),
                refresh_only: None,
            },
        )
        .await
        .unwrap();

    assert!(matches!(
        env.send("", &["c1"]).await.unwrap_err(),
        ChatRouteError::Review(ReviewError::NotAttached)
    ));
    env.send("", &["c2"]).await.expect("unattached picker send");
    env.send("", &["c3"])
        .await
        .expect("this composer's own chip");
    let left: Vec<String> = env.panel().await.into_iter().map(|c| c.id).collect();
    assert_eq!(left, vec!["c1"]);
    env.agent.abort_and_drain();
}

#[tokio::test]
async fn over_the_limits_is_too_large_and_nothing_is_deleted() {
    let env = Env::new(true).await;
    env.park_active().await;
    let mut all = Vec::new();
    for i in 1..=201u32 {
        let id = format!("c{i}");
        env.comment(&id, i).await;
        all.push(id);
    }
    let refs: Vec<&str> = all.iter().map(String::as_str).collect();
    match env.send("", &refs).await.unwrap_err() {
        ChatRouteError::Review(ReviewError::TooLarge { limit, unit }) => {
            assert_eq!((limit, unit), (200, "comments"))
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(env.panel().await.len(), 201);
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
    env.agent.abort_and_drain();
}

#[tokio::test]
async fn a_non_json_session_is_refused_before_any_comment_moves() {
    let env = Env::new(true).await;
    env.comment("c1", 1).await;
    env.store
        .mutate_project("p1", |p| {
            p.direct_sessions.push({
                let mut s = json_session("t1");
                s.channel = Some(Channel::Tmux);
                s.use_tmux = true;
                s
            });
            Ok(p.clone())
        })
        .await
        .unwrap();
    let err = env
        .routes
        .chat_session(
            "t1",
            ChatBody {
                message: "x".into(),
                attachment_ids: None,
                queue: None,
                mentions: None,
                review_comment_ids: Some(vec!["c1".into()]),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ChatRouteError::NotJson(_)), "{err:?}");
    assert_eq!(env.panel().await.len(), 1);
}

#[test]
fn review_refusals_map_to_their_status_and_code() {
    use vst_routes::review_http::review_error_parts;
    let p = review_error_parts(&ReviewError::Changed { remaining: 2 });
    assert_eq!((p.status, p.extra["remaining"].as_u64()), (409, Some(2)));
    let p = review_error_parts(&ReviewError::TooLarge {
        limit: 200,
        unit: "comments",
    });
    assert_eq!((p.status, p.extra["limit"].as_u64()), (413, Some(200)));
    assert_eq!(review_error_parts(&ReviewError::NotAttached).status, 403);
    assert_eq!(
        ChatRouteError::Review(ReviewError::Changed { remaining: 0 }).code(),
        "comments_changed"
    );
    assert_eq!(
        ChatRouteError::Review(ReviewError::TooLarge {
            limit: 1,
            unit: "bytes"
        })
        .code(),
        "review_too_large"
    );
    assert_eq!(
        ChatRouteError::Review(ReviewError::NotAttached).code(),
        "not_attached"
    );
}

// ── 2.T5: edit / resubmit ─────────────────────────────────────────────────────

#[tokio::test]
async fn edit_reports_the_review_and_resubmit_keeps_or_restores_it() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    let a = env.send("keep", &["c1"]).await.unwrap();
    let b = env.send("drop", &["c2"]).await.unwrap();

    let edit = env.routes.edit_queued_turn("s1", &a.turn_id).await.unwrap();
    assert_eq!(edit.review.map(|r| (r.count, r.files)), Some((1, 1)));
    // Empty edited text is allowed with a review; the default keeps the hold.
    env.routes
        .resubmit_queued_turn(
            "s1",
            &a.turn_id,
            ResubmitBody {
                edited: true,
                message: Some(String::new()),
                attachment_ids: None,
                mentions: None,
                keep_review: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        env.store.list_holds(None).await.unwrap().len(),
        2,
        "holds kept"
    );
    assert!(env.panel().await.is_empty());

    env.routes.edit_queued_turn("s1", &b.turn_id).await.unwrap();
    env.routes
        .resubmit_queued_turn(
            "s1",
            &b.turn_id,
            ResubmitBody {
                edited: true,
                message: Some("drop".into()),
                attachment_ids: None,
                mentions: None,
                keep_review: Some(false),
            },
        )
        .await
        .unwrap();
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].id, "c2");
    assert_eq!(back[0].restored_reason, Some(RestoreReason::TurnCancelled));
    let holds = env.store.list_holds(None).await.unwrap();
    assert_eq!(holds.len(), 1);
    assert_eq!(holds[0].turn_id, a.turn_id);
    env.agent.abort_and_drain();
}

// ── 2.T7 / 2.T14: delete and double release ──────────────────────────────────

#[tokio::test]
async fn deleting_the_session_restores_the_queued_comments_as_session_removed() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.send("", &["c1"]).await.unwrap();

    env.routes.delete_session("s1").await.unwrap();
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].restored_reason, Some(RestoreReason::SessionRemoved));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// `release()` can run the cancel sweep twice (and concurrently): each comment is
/// restored exactly once, and announced once.
#[tokio::test]
async fn a_double_release_restores_each_hold_once() {
    let mut env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    let queued = env.send("", &["c1"]).await.unwrap();
    let held = env.send("", &["c2"]).await.unwrap();
    let _ = queued;
    env.agent.begin_edit_queued_turn(&held.turn_id).unwrap();
    env.comment_events();

    tokio::join!(env.agent.release(), env.agent.release());
    env.agent.release().await;
    let back = wait_panel(&env, 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(env.panel().await.len(), 2);
    assert!(back
        .iter()
        .all(|c| c.restored_reason == Some(RestoreReason::SessionRemoved)));
    let upserts: usize = env.comment_events().iter().map(|e| e.0.len()).sum();
    assert_eq!(upserts, 2, "one upsert per restored comment");
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

// ── 2.T8b: reset ──────────────────────────────────────────────────────────────

/// Reset with `Carry` to Rich Chat: the comments stay out of the panel, the hold
/// follows the carried message to a NEW turn id on the new session, and the
/// delivered turn deletes it (exactly one copy of the comments).
#[tokio::test]
async fn reset_carry_rehomes_the_hold_to_the_carried_turn() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    let a = env.send("first", &["c1"]).await.unwrap();
    let b = env.send("second", &["c2"]).await.unwrap();

    let res = env
        .routes
        .reset_session("s1", &ResetBody::default())
        .await
        .unwrap();
    // The replacement agent must be registered before the detached spawn runs.
    let fresh_msgs = Arc::new(Mutex::new(Vec::new()));
    let fresh = agent_for(
        &env.store,
        &env.routes,
        &res.new_session_id,
        Arc::new(RecPlugin {
            messages: fresh_msgs.clone(),
            block: true,
            cancelled: Arc::new(AtomicBool::new(false)),
        }),
    );
    // First carried turn runs (blocking), the second waits in the queue.
    wait_until("carried turns arrive", || {
        fresh.get_meta().queued_turn_ids.len() == 1 && fresh.get_meta().active_turn_id.is_some()
    })
    .await;

    assert!(
        env.panel().await.is_empty(),
        "carried comments are not in the panel"
    );
    let holds = env.store.list_holds(None).await.unwrap();
    assert_eq!(
        holds.len(),
        1,
        "only the still-queued turn holds: {holds:?}"
    );
    let queued_id = fresh.get_meta().queued_turn_ids[0].clone();
    assert_eq!(holds[0].session_id, res.new_session_id);
    assert_eq!(holds[0].turn_id, queued_id, "rehomed to the new turn id");
    assert!(
        ![a.turn_id.clone(), b.turn_id.clone()].contains(&holds[0].turn_id),
        "the old turn id is never reused"
    );
    assert_eq!(holds[0].record.comments[0].id, "c2");
    assert!(
        fresh_msgs.lock().unwrap()[0].contains("text of c1"),
        "the first carried turn delivered its block"
    );

    // Finishing the queue deletes the last hold; nothing ever returns to the panel.
    fresh.release().await;
    let back = wait_panel(&env, 1).await;
    assert_eq!(
        back.len(),
        1,
        "only the never-delivered one is restored on release"
    );
    assert_eq!(back[0].id, "c2");
}

#[tokio::test]
async fn reset_drop_restores_the_comments_to_the_panel() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.send("queued", &["c1"]).await.unwrap();

    env.routes
        .reset_session(
            "s1",
            &ResetBody {
                queued: Some(QueuedPolicy::Drop),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].restored_reason, Some(RestoreReason::TurnCancelled));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// A turn the user was already editing is not withdrawn by the reset: the release
/// restores its comments through the observer.
#[tokio::test]
async fn reset_restores_the_comments_of_a_turn_already_being_edited() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    let t = env.send("editing", &["c1"]).await.unwrap();
    env.agent.begin_edit_queued_turn(&t.turn_id).unwrap();

    env.routes
        .reset_session("s1", &ResetBody::default())
        .await
        .unwrap();
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].restored_reason, Some(RestoreReason::SessionRemoved));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// A carried enqueue that fails restores the hold (it is not just logged).
#[tokio::test]
async fn a_failed_carry_enqueue_restores_the_hold() {
    let env = Env::new(true).await;
    env.comment("c1", 1).await;
    let hold = vst_types::review::ReviewPort::hold_for_turn(
        &env.review,
        vst_types::review::HoldRequest {
            hold_id: "h1".into(),
            scope: env.scope.clone(),
            session_id: "s1".into(),
            turn_id: "old-turn".into(),
            comment_ids: vec!["c1".into()],
            composer_key: None,
        },
    )
    .await
    .unwrap();
    vst_routes::reset_carry::carry_to_json(
        &env.routes,
        "ghost-session",
        0,
        vec![(
            "carried".into(),
            vec![],
            Some(vst_agents::json_agent_session::ReviewTurn {
                hold_id: hold.hold_id,
                record: hold.record,
            }),
        )],
    )
    .await;
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].restored_reason, Some(RestoreReason::SendFailed));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

/// Terminal target: the block rides the LAUNCH prompt (escaped, never stored),
/// the hold is consumed after a successful launch and restored after a failed one.
#[tokio::test]
async fn terminal_carry_embeds_the_block_and_settles_the_hold_by_launch_outcome() {
    let env = Env::new(true).await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    let mk = |hold: &str, id: &str| vst_types::review::HoldRequest {
        hold_id: hold.into(),
        scope: env.scope.clone(),
        session_id: "s1".into(),
        turn_id: format!("t-{hold}"),
        comment_ids: vec![id.into()],
        composer_key: None,
    };
    let h_ok = vst_types::review::ReviewPort::hold_for_turn(&env.review, mk("h-ok", "c1"))
        .await
        .unwrap();
    let h_bad = vst_types::review::ReviewPort::hold_for_turn(&env.review, mk("h-bad", "c2"))
        .await
        .unwrap();

    let text = vst_routes::reset_carry::carried_message_with_review(
        "do {it}",
        &vst_agents::json_agent_session::ReviewTurn {
            hold_id: h_ok.hold_id.clone(),
            record: h_ok.record.clone(),
        },
    );
    assert!(
        text.starts_with("do {it}\n\nReview comments (1) · p1\n"),
        "{text}"
    );
    let empty = vst_routes::reset_carry::carried_message_with_review(
        "",
        &vst_agents::json_agent_session::ReviewTurn {
            hold_id: "x".into(),
            record: h_ok.record.clone(),
        },
    );
    assert!(empty.starts_with("Review comments (1)"), "{empty}");

    vst_routes::reset_carry::rehome_terminal_holds(
        &env.routes,
        &["h-ok".to_string(), "h-bad".to_string()],
        "new-sess",
    )
    .await;
    let rehomed = env.store.get_hold("h-ok").await.unwrap().unwrap();
    assert_eq!(rehomed.session_id, "new-sess");
    assert_ne!(rehomed.turn_id, "t-h-ok");

    vst_routes::reset_carry::settle_terminal_holds(&env.routes, &["h-ok".to_string()], &Ok(()))
        .await;
    vst_routes::reset_carry::settle_terminal_holds(
        &env.routes,
        &["h-bad".to_string()],
        &Err("spawn failed".to_string()),
    )
    .await;
    let _ = h_bad;
    let back = env.panel().await;
    assert_eq!(back.len(), 1, "only the failed launch's comment returns");
    assert_eq!(back[0].id, "c2");
    assert_eq!(back[0].restored_reason, Some(RestoreReason::SendFailed));
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

// ── 2.T8b: a failed reset gives the original turn its review back ────────────

/// Plugin that ignores cancellation (the first turn blocks `run_turn` itself) so
/// stop-first times out.
struct StuckPlugin {
    gate: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
}

impl AgentPlugin for StuckPlugin {
    fn name(&self) -> &str {
        "stuck"
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
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        if let Some(gate) = self.gate.lock().unwrap().take() {
            let _ = gate.recv();
        }
        let (_tx, rx) = mpsc::unbounded_channel();
        rx
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reset_leaves_the_review_on_the_original_turn() {
    let env = Env::new(true).await;
    // Replace the harness agent with one that cannot be stopped.
    env.routes.json_registry.remove("s1");
    let (gate_tx, gate_rx) = std::sync::mpsc::channel();
    let stuck = agent_for(
        &env.store,
        &env.routes,
        "s1",
        Arc::new(StuckPlugin {
            gate: Arc::new(Mutex::new(Some(gate_rx))),
        }),
    );
    stuck.enqueue("active".into(), vec![], None, None);
    wait_until("active turn", || stuck.get_meta().active_turn_id.is_some()).await;
    env.comment("c1", 1).await;
    let t = env.send("queued", &["c1"]).await.unwrap();

    let err = env
        .routes
        .reset_session("s1", &ResetBody::default())
        .await
        .unwrap_err();
    assert!(
        matches!(err, vst_routes::sessions::ResetError::BusyTimeout(_)),
        "{err:?}"
    );
    let _ = gate_tx.send(());

    // The turn is back in the queue WITH its review; the hold is intact and the
    // comments are still not in the panel.
    let q = stuck.get_meta().queued_turns;
    let q = q
        .iter()
        .find(|x| x.turn_id == t.turn_id)
        .expect("turn restored");
    assert_eq!(q.review.map(|r| r.count), Some(1));
    assert_eq!(env.store.list_holds(None).await.unwrap().len(), 1);
    assert!(env.panel().await.is_empty());
    stuck.release().await;
}

/// A reset whose archive step fails (a concurrent archive won) must give the
/// comments of the carried (withdrawn) turns back to the panel: nothing else will.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_that_fails_at_the_archive_step_restores_carried_holds() {
    let mut env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.send("queued", &["c1"]).await.unwrap();
    assert_eq!(env.store.list_holds(None).await.unwrap().len(), 1);

    // An immediate Terminal row held `waiting` on this session: failing it (the
    // reset's `stop_for_reset`, just before the archive) notifies, and the
    // notifier archives the session, so the locked archive then finds it gone.
    env.store
        .insert_scheduled_message(
            "imm",
            "s1",
            "now",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            Some("tmux"),
            None,
            Some("immediate"),
        )
        .await
        .unwrap();
    env.store
        .claim_scheduled_message("imm", "s1", "2026-01-01T00:00:01Z")
        .await
        .unwrap()
        .unwrap();
    assert!(env
        .store
        .mark_scheduled_phase("imm", None, "waiting", "2026-01-01T00:00:02Z")
        .await
        .unwrap());
    let store = env.store.clone();
    let notify: vst_review::NotifyScheduled = Arc::new(move |_sid| {
        let store = store.clone();
        Box::pin(async move {
            let _ = store
                .mutate_project("p1", |p| {
                    for s in &mut p.direct_sessions {
                        if s.id == "s1" {
                            s.archived_at = Some("2026-01-01T00:00:03Z".into());
                        }
                    }
                    Ok(p.clone())
                })
                .await;
        })
    });
    env.routes.terminal_delivery = vst_review::TerminalDeliveryHandle::new(
        env.store.clone(),
        Arc::new(vst_proc::test_support::isolated_tmux()),
        vst_routes::terminal_delivery::target_resolver(env.store.clone()),
        notify,
        None,
    );

    let err = env
        .routes
        .reset_session("s1", &ResetBody::default())
        .await
        .unwrap_err();
    assert!(
        matches!(err, vst_routes::sessions::ResetError::Archived(_)),
        "{err:?}"
    );
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].id, "c1");
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

// ── Scheduled Rich Chat fire ──────────────────────────────────────────────────

async fn scheduled_row(
    env: &Env,
    row: &str,
    ids: &[&str],
) -> vst_types::rest::sessions::ScheduledMessageRow {
    env.store
        .take_for_consumer(
            &env.scope,
            &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            None,
            "p1",
            TakeLimits {
                max_comments: 200,
                max_bytes: 131_072,
            },
            Consumer::Schedule(ScheduleSpec {
                id: row.into(),
                session_id: "s1".into(),
                message: "later".into(),
                fire_at: "2026-02-01T00:00:00Z".into(),
                now: "2026-01-01T00:00:00Z".into(),
                channel: Some("json".into()),
                attachments: None,
            }),
        )
        .await
        .unwrap()
        .unwrap();
    env.store.get_scheduled_message(row).await.unwrap().unwrap()
}

fn state_of(row: &vst_types::rest::sessions::ScheduledMessageRow) -> PayloadState {
    let raw = row.comments_snapshot.as_deref().unwrap();
    PayloadState::ALL
        .iter()
        .copied()
        .find(|s| raw.contains(&format!("\"state\":\"{}\"", s.as_str())))
        .unwrap()
}

#[tokio::test]
async fn a_scheduled_row_fires_into_a_queued_review_turn() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    let row = scheduled_row(&env, "row1", &["c1", "c2"]).await;
    assert!(env.panel().await.is_empty());

    let res = vst_agents::json_agent_chat::deliver_scheduled_message(
        &row,
        0,
        &env.store,
        &env.broadcaster,
        &env.routes.json_registry,
    )
    .await
    .unwrap();

    let holds = env.store.list_holds(Some("s1")).await.unwrap();
    assert_eq!(holds.len(), 1);
    assert_eq!(holds[0].turn_id, res.turn_id);
    assert_eq!(holds[0].record.comments.len(), 2);
    let q = env.agent.get_meta().queued_turns;
    assert_eq!(
        q.iter()
            .find(|t| t.turn_id == res.turn_id)
            .unwrap()
            .review
            .map(|r| r.count),
        Some(2)
    );
    let after = env
        .store
        .get_scheduled_message("row1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state_of(&after), PayloadState::Adopted);
    env.agent.abort_and_drain();
}

#[tokio::test]
async fn a_failed_scheduled_fire_restores_once_and_flips_the_payload() {
    let mut env = Env::new(true).await;
    env.comment("c1", 1).await;
    let row = scheduled_row(&env, "row1", &["c1"]).await;
    env.store
        .mutate_project("p1", |p| {
            p.direct_sessions[0].archived_at = Some("2026-01-03T00:00:00.000Z".into());
            Ok(p.clone())
        })
        .await
        .unwrap();
    env.comment_events();

    for _ in 0..2 {
        let err = vst_agents::json_agent_chat::deliver_scheduled_message(
            &row,
            0,
            &env.store,
            &env.broadcaster,
            &env.routes.json_registry,
        )
        .await
        .unwrap_err();
        assert!(err.contains("archived"), "{err}");
    }
    let back = env.panel().await;
    assert_eq!(back.len(), 1, "restored once, not twice");
    assert_eq!(back[0].restored_reason, Some(RestoreReason::ScheduleFailed));
    let after = env
        .store
        .get_scheduled_message("row1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state_of(&after), PayloadState::Restored);
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
    let upserts: usize = env.comment_events().iter().map(|e| e.0.len()).sum();
    assert_eq!(upserts, 1);
}

/// A json fire of a Terminal send is a bug: it fails, restores once, enqueues nothing.
#[tokio::test]
async fn a_json_fire_of_an_immediate_row_fails_restores_and_enqueues_nothing() {
    let env = Env::new(true).await;
    env.park_active().await;
    env.comment("c1", 1).await;
    let depth = env.agent.get_meta().queue_depth;
    env.store
        .take_for_terminal_row(
            &env.scope,
            &["c1".to_string()],
            None,
            "p1",
            TakeLimits {
                max_comments: 200,
                max_bytes: 131_072,
            },
            ScheduleSpec {
                id: "imm1".into(),
                session_id: "s1".into(),
                message: String::new(),
                fire_at: "2026-01-01T00:00:00Z".into(),
                now: "2026-01-01T00:00:00Z".into(),
                channel: Some("json".into()),
                attachments: None,
            },
        )
        .await
        .unwrap()
        .unwrap();
    let row = env
        .store
        .get_scheduled_message("imm1")
        .await
        .unwrap()
        .unwrap();

    let err = vst_agents::json_agent_chat::deliver_scheduled_message(
        &row,
        0,
        &env.store,
        &env.broadcaster,
        &env.routes.json_registry,
    )
    .await
    .unwrap_err();
    assert!(err.contains("Terminal"), "{err}");
    assert_eq!(env.agent.get_meta().queue_depth, depth, "nothing enqueued");
    assert_eq!(env.panel().await.len(), 1, "comments restored once");
    env.agent.abort_and_drain();
}

/// Rows without a snapshot take the old path untouched.
#[tokio::test]
async fn a_plain_scheduled_row_still_delivers_without_a_review() {
    let env = Env::new(false).await;
    let mut row = scheduled_row(&env, "row0", &[]).await;
    row.comments_snapshot = None;
    row.message = "plain".into();
    vst_agents::json_agent_chat::deliver_scheduled_message(
        &row,
        0,
        &env.store,
        &env.broadcaster,
        &env.routes.json_registry,
    )
    .await
    .unwrap();
    wait_until("delivered", || !env.messages.lock().unwrap().is_empty()).await;
    assert_eq!(env.messages.lock().unwrap()[0], "plain");
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_dropped_scheduled_delivery_puts_the_adopted_comments_back() {
    let env = Env::new(true).await;
    env.comment("c1", 1).await;
    let row = scheduled_row(&env, "row-drop", &["c1"]).await;
    assert!(env.panel().await.is_empty());

    // The delivery adopted the snapshot, then its caller's timeout dropped it
    // before the enqueue finished: the guard must restore the hold.
    let port = env.routes.json_registry.review_port().expect("review port");
    let payload: vst_types::review::ScheduledReviewPayload =
        serde_json::from_str(row.comments_snapshot.as_deref().unwrap()).unwrap();
    let hold = port
        .adopt_snapshot(
            &row.id,
            vst_types::review::ReviewRecord {
                name: payload.name,
                comments: payload.comments,
            },
            ScopeKey {
                scope_kind: payload.scope_kind,
                scope_id: payload.scope_id,
            },
            "s1",
            "turn-dropped",
        )
        .await
        .unwrap();
    assert!(env.panel().await.is_empty(), "held by the adopted turn");
    let guard = vst_agents::json_agent_chat::AdoptedHoldGuard::new(port.clone(), hold.hold_id);
    drop(guard);
    let back = wait_panel(&env, 1).await;
    assert_eq!(back[0].id, "c1");
    assert!(env.store.list_holds(None).await.unwrap().is_empty());

    // A disarmed guard (the delivery finished) leaves the hold to its result handling.
    env.comment("c2", 2).await;
    let row2 = scheduled_row(&env, "row-ok", &["c2"]).await;
    let payload: vst_types::review::ScheduledReviewPayload =
        serde_json::from_str(row2.comments_snapshot.as_deref().unwrap()).unwrap();
    let hold = port
        .adopt_snapshot(
            &row2.id,
            vst_types::review::ReviewRecord {
                name: payload.name,
                comments: payload.comments,
            },
            ScopeKey {
                scope_kind: payload.scope_kind,
                scope_id: payload.scope_id,
            },
            "s1",
            "turn-ok",
        )
        .await
        .unwrap();
    let mut guard = vst_agents::json_agent_chat::AdoptedHoldGuard::new(port, hold.hold_id);
    guard.disarm();
    drop(guard);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let ids: Vec<String> = env.panel().await.into_iter().map(|c| c.id).collect();
    assert_eq!(ids, vec!["c1".to_string()], "c2 stays held");
    assert_eq!(env.store.list_holds(None).await.unwrap().len(), 1);
}
