//! Shared test fixtures for the 04a vst-agents integration tests.
#![allow(dead_code)]

use vst_agents::{LaunchConfig, PluginContext};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

/// Build a minimal session record with the given id.
pub fn make_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        account_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
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

/// Build a minimal worktree record.
pub fn make_worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("branch-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: None,
        agent_seq: None,
        lsp_enabled: None,
        sessions: vec![],
        open_files: vec![],
    }
}

/// Build a minimal project record.
pub fn make_project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/repos/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// A worktree context (cwd is the worktree checkout).
pub fn wt_ctx(project_id: &str, worktree_id: &str, cwd: &str) -> PluginContext {
    PluginContext {
        cwd: cwd.into(),
        project_id: project_id.into(),
        worktree: Some(make_worktree(worktree_id)),
    }
}

/// A direct (project) context — no worktree, cwd is the project checkout.
pub fn proj_ctx(project_id: &str, cwd: &str) -> PluginContext {
    PluginContext {
        cwd: cwd.into(),
        project_id: project_id.into(),
        worktree: None,
    }
}

/// A launch config for a worktree context.
pub fn wt_launch(project_id: &str, session: SessionRecord, cwd: &str) -> LaunchConfig {
    LaunchConfig {
        project: make_project(project_id),
        ctx: wt_ctx(project_id, "w1", cwd),
        session,
        daemon_port: 7421,
        model: None,
        account_dir: None,
    }
}

/// A launch config for a direct (project) context.
pub fn proj_launch(project_id: &str, session: SessionRecord, cwd: &str) -> LaunchConfig {
    LaunchConfig {
        project: make_project(project_id),
        ctx: proj_ctx(project_id, cwd),
        session,
        daemon_port: 7421,
        model: None,
        account_dir: None,
    }
}

/// A text event for session `sid` (turn `t1`), numbered `n`.
pub fn text_event(sid: &str, n: usize) -> vst_types::NormalizedEvent {
    let mut e: vst_types::NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{n}"),
        "sessionId": sid,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "text",
    }))
    .unwrap();
    e.role = Some(vst_types::Role::Assistant);
    e.text = Some(format!("chunk-{n}"));
    e.turn_id = Some("t1".to_string());
    e
}

/// Seed `rows` events into direct session `sid`'s on-disk transcript (needs an
/// active `with_home` guard), then build its live session object with `plugin`.
/// No turn runs, so the object holds no store and no child.
pub fn seeded_session(
    store_handle: &vst_store::StoreHandle,
    sid: &str,
    rows: usize,
    plugin: std::sync::Arc<dyn vst_agents::plugin::AgentPlugin>,
) -> vst_agents::json_agent_session::JsonAgentSession {
    let data_dir = vst_agents::paths::Paths::default().direct_session_data_dir("p1", sid);
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut store = vst_store::transcript::open_transcript_store(&data_dir, sid).unwrap();
    for n in 0..rows {
        store.append(&mut text_event(sid, n));
    }
    store.close();
    let (tx, _rx) = tokio::sync::broadcast::channel(16);
    vst_agents::json_agent_session::JsonAgentSession::new(
        vst_agents::json_agent_session::JsonAgentSessionOptions {
            project: make_project("p1"),
            worktree: None,
            session: make_session(sid),
            plugin,
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle: store_handle.clone(),
            broadcaster: vst_types::Broadcaster(tx),
        },
    )
}

/// Launch spec for the fake ACP adapter (`tests/fixtures/fakeAcpAgent.mjs`).
pub fn fake_acp_spec() -> vst_agents::acp_connection::AcpLaunchSpec {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    vst_agents::acp_connection::AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![manifest
            .join("tests/fixtures/fakeAcpAgent.mjs")
            .to_string_lossy()
            .into_owned()],
        cwd: manifest,
        env: std::collections::HashMap::new(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
        open_tool_idle_timeout_ms: None,
    }
}

/// A plugin whose turn needs the session's ACP child (spawned lazily, as in
/// production), then answers `pong` and ends. Counts finished turns and keeps
/// the connection errors it saw.
#[derive(Clone, Default)]
pub struct FakeAcpPlugin {
    pub completed: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub errors: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl vst_agents::plugin::AgentPlugin for FakeAcpPlugin {
    fn name(&self) -> &str {
        "fake-acp"
    }
    fn default_model(&self) -> &str {
        ""
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "fake"
    }
    fn prompt_delivery(&self) -> vst_agents::plugin::PromptDelivery {
        vst_agents::plugin::PromptDelivery::Inline
    }
    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec![]
    }
    fn get_environment(&self, _cfg: &LaunchConfig) -> std::collections::BTreeMap<String, String> {
        std::collections::BTreeMap::new()
    }
    fn get_ready_signal(&self) -> vst_agents::plugin::ReadySignal {
        vst_agents::plugin::ReadySignal {
            sentinel: None,
            fallback_ms: 0,
        }
    }
    fn compose_launch_prompt(
        &self,
        _input: vst_agents::plugin::ComposePromptInput,
    ) -> vst_agents::plugin::ComposePromptResult {
        vst_agents::plugin::ComposePromptResult::default()
    }
    fn default_channel(&self) -> vst_types::Channel {
        vst_types::Channel::Json
    }
    fn list_models(&self) -> vst_agents::plugin::AsyncResult<vst_agents::plugin::ListModelsResult> {
        Box::pin(async { vst_agents::plugin::ListModelsResult::default() })
    }
    fn supports_json(&self) -> bool {
        true
    }
    fn supports_acp(&self) -> bool {
        true
    }
    fn run_turn(
        &self,
        _input: vst_agents::plugin::TurnInput,
        ctx: vst_agents::plugin::TurnContext,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> tokio::sync::mpsc::UnboundedReceiver<vst_types::NormalizedEvent> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (completed, errors) = (self.completed.clone(), self.errors.clone());
        tokio::spawn(async move {
            match (ctx.get_acp_connection)(fake_acp_spec(), None).await {
                Ok(_) => {
                    let mut text = vst_types::NormalizedEvent::default();
                    text.kind = vst_types::NormalizedEventKind::Text;
                    text.text = Some("pong".into());
                    let _ = tx.send(text);
                }
                Err(e) => errors.lock().unwrap().push(format!("{e:?}")),
            }
            let mut done = vst_types::NormalizedEvent::default();
            done.kind = vst_types::NormalizedEventKind::Result;
            let _ = tx.send(done);
            completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        rx
    }
}

/// Wait (bounded) until `completed` reaches `n` and the session's drain is idle.
pub async fn wait_turns(
    completed: &std::sync::atomic::AtomicUsize,
    n: usize,
    session: &vst_agents::json_agent_session::JsonAgentSession,
) {
    for _ in 0..1000 {
        if completed.load(std::sync::atomic::Ordering::SeqCst) >= n {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        completed.load(std::sync::atomic::Ordering::SeqCst) >= n,
        "turns did not finish"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), session.settled())
        .await
        .expect("drain settles");
}
