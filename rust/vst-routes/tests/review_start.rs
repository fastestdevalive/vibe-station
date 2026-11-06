//! Draft promotion with review comments (plan 04, Phase 3.4): the comments ride
//! the first turn of a started draft (Rich Chat) or its launch prompt (Terminal),
//! stay inside their scope, and come back when the start cannot deliver them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::{tempdir, TempDir};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use vst_agents::home::{with_home, HomeGuard};
use vst_agents::json_agent_session::{
    get_or_create_json_agent_session, JsonAgentSession, JsonAgentSessionOptions,
};
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_review::ReviewHandle;
use vst_routes::sessions::{SessionRoutes, StartError};
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::rest::review::CreateCommentBody;
use vst_types::rest::sessions::StartDraftBody;
use vst_types::review::{CommentSurface, PathKind, ReviewComment, ReviewError};
use vst_types::{
    Broadcaster, Channel, DraftConfig, DraftEntryPoint, LifecycleState, NormalizedEvent,
    NormalizedEventKind, NormalizedEventProvider, ProjectRecord, SessionLifecycle,
    SessionNameSource, SessionRecord, SessionType, WorktreeChoice,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

fn draft(id: &str, channel: Channel) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("my-mode".into()),
        mode_icon: None,
        name: Some("Draft".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: format!("vst-{id}"),
        use_tmux: channel == Channel::Tmux,
        channel: Some(channel),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Drafting,
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
        direct_sessions: vec![
            draft("d1", Channel::Json),
            draft("d2", Channel::Tmux),
            draft("d3", Channel::Json),
        ],
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

struct Env {
    _home: TempDir,
    _guard: HomeGuard,
    _db: TempDir,
    store: StoreHandle,
    review: ReviewHandle,
    routes: SessionRoutes,
    scope: ScopeKey,
    messages: Arc<Mutex<Vec<String>>>,
    _agents: Vec<JsonAgentSession>,
}

async fn env() -> Env {
    let home = tempdir().unwrap();
    let dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&dir).unwrap();
    let modes = serde_json::json!([{
        "id": "my-mode", "name": "My Mode", "cli": "claude", "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z", "model": null
    }]);
    std::fs::write(dir.join("modes.json"), modes.to_string()).unwrap();
    let guard = with_home(home.path().to_path_buf());
    let db = tempdir().unwrap();
    let store = StoreHandle::open(db.path().join("vibe-station.db")).unwrap();
    store.add_project(project()).await.unwrap();
    let bc = Broadcaster::new(256);
    let artifacts = vst_artifacts::ArtifactsHandle::new(
        store.clone(),
        bc.clone(),
        Arc::new(vst_artifacts::StoreResolver::new(
            store.clone(),
            dir.clone(),
        )),
    );
    let review = ReviewHandle::new(store.clone(), bc.clone(), artifacts);
    let routes = SessionRoutes {
        store: store.clone(),
        broadcaster: bc.clone(),
        json_registry: Arc::new(vst_agents::json_agent_registry::JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: Arc::new(Mutex::new(std::collections::HashMap::new())),
        tmux: vst_proc::tmux::Tmux::with_socket(&format!("vst-start-test-{}", std::process::id())),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
        reset_cancels: Default::default(),
        terminal_delivery: vst_routes::terminal_delivery::build_terminal_delivery(
            store.clone(),
            bc.clone(),
            Arc::new(vst_proc::test_support::isolated_tmux()),
            None,
        ),
    };
    let (port, observer) = vst_review::hooks(&review);
    routes.json_registry.set_review_hooks(port, observer);
    let messages = Arc::new(Mutex::new(Vec::new()));
    let mut agents = Vec::new();
    for id in ["d1", "d3"] {
        agents.push(get_or_create_json_agent_session(
            &routes.json_registry,
            JsonAgentSessionOptions {
                project: project(),
                worktree: None,
                session: draft(id, Channel::Json),
                plugin: Arc::new(RecPlugin {
                    messages: messages.clone(),
                    block: false,
                    cancelled: Arc::new(AtomicBool::new(false)),
                }),
                daemon_port: 0,
                cli: NormalizedEventProvider::Claude,
                model: None,
                mode_id: Some("my-mode".into()),
                mode_name: Some("My Mode".into()),
                store_handle: store.clone(),
                broadcaster: Broadcaster(broadcast::channel(64).0),
            },
        ));
    }
    Env {
        _home: home,
        _guard: guard,
        _db: db,
        store,
        review,
        routes,
        scope: ScopeKey::project("p1"),
        messages,
        _agents: agents,
    }
}

impl Env {
    async fn comment(&self, id: &str, line: u32) {
        self.review
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
    }

    async fn panel(&self) -> Vec<ReviewComment> {
        self.review
            .list(&self.scope, None, false)
            .await
            .unwrap()
            .comments
    }

    async fn wait(&self, what: &str, mut cond: impl FnMut(&Env) -> bool) {
        for _ in 0..500 {
            if cond(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for: {what}");
    }
}

fn config(channel: Channel, mode: &str, entry: DraftEntryPoint) -> DraftConfig {
    DraftConfig {
        entry_point: entry,
        mode_id: Some(mode.into()),
        channel: Some(channel),
        channel_explicit: Some(true),
        worktree_choice: None,
        existing_worktree_id: None,
        branch: None,
        base_branch: None,
        use_tmux: None,
        use_worktree: Some(false),
    }
}

fn start_body(prompt: &str, ids: &[&str], cfg: DraftConfig) -> StartDraftBody {
    StartDraftBody {
        draft_prompt: prompt.into(),
        draft_config: cfg,
        skip_auto_turn: None,
        review_comment_ids: Some(ids.iter().map(|s| s.to_string()).collect()),
    }
}

// ── 3.T8 ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_rich_chat_draft_starts_with_comments_only_and_the_block_is_its_first_turn() {
    let env = env().await;
    env.comment("c1", 1).await;
    env.comment("c2", 2).await;
    env.routes
        .start_session(
            "d1",
            &start_body(
                "",
                &["c1", "c2"],
                config(Channel::Json, "my-mode", DraftEntryPoint::Direct),
            ),
        )
        .await
        .unwrap();
    assert!(env.panel().await.is_empty(), "comments left the panel");
    env.wait("first turn runs", |e| {
        !e.messages.lock().unwrap().is_empty()
    })
    .await;
    let first = env.messages.lock().unwrap()[0].clone();
    assert!(first.starts_with("Review comments (2) · p1"), "{first}");
    for _ in 0..500 {
        if env.store.list_holds(None).await.unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        env.store.list_holds(None).await.unwrap().is_empty(),
        "the hold is deleted once the user row is persisted"
    );
    assert!(env.panel().await.is_empty(), "delivered, not restored");
}

#[tokio::test]
async fn a_new_worktree_start_is_409_scope_changed_and_touches_nothing() {
    let env = env().await;
    env.comment("c1", 1).await;
    let mut cfg = config(Channel::Json, "my-mode", DraftEntryPoint::Worktree);
    cfg.worktree_choice = Some(WorktreeChoice::New);
    cfg.branch = Some("feat/x".into());
    let err = env
        .routes
        .start_session("d3", &start_body("go", &["c1"], cfg))
        .await
        .unwrap_err();
    assert!(matches!(err, StartError::ScopeChanged(_)), "{err:?}");
    assert_eq!(env.panel().await.len(), 1);
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_start_refuses_stale_ids_and_a_skipped_first_turn() {
    let env = env().await;
    env.comment("c1", 1).await;
    let err = env
        .routes
        .start_session(
            "d3",
            &start_body(
                "go",
                &["c1", "ghost"],
                config(Channel::Json, "my-mode", DraftEntryPoint::Direct),
            ),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            StartError::Review(ReviewError::Changed { remaining: 1 })
        ),
        "{err:?}"
    );
    assert_eq!(env.panel().await.len(), 1, "nothing moved");

    let mut body = start_body(
        "go",
        &["c1"],
        config(Channel::Json, "my-mode", DraftEntryPoint::Direct),
    );
    body.skip_auto_turn = Some(true);
    let err = env.routes.start_session("d3", &body).await.unwrap_err();
    assert!(matches!(err, StartError::Validation(_)), "{err:?}");
    assert_eq!(env.panel().await.len(), 1);
}

#[tokio::test]
async fn a_terminal_start_whose_launch_fails_restores_the_comments() {
    let env = env().await;
    env.comment("c1", 1).await;
    // The mode does not exist, so the launch fails after the comments were held.
    env.routes
        .start_session(
            "d2",
            &start_body(
                "",
                &["c1"],
                config(Channel::Tmux, "ghost-mode", DraftEntryPoint::Direct),
            ),
        )
        .await
        .unwrap();
    for _ in 0..500 {
        if !env.panel().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let back = env.panel().await;
    assert_eq!(
        back[0].restored_reason.map(|r| r.as_str()),
        Some("send_failed")
    );
    assert!(env.store.list_holds(None).await.unwrap().is_empty());
}
