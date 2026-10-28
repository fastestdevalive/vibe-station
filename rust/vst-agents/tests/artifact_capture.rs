//! Artifact capture through a real `JsonAgentSession`: tool calls (in-band and
//! out-of-band) and `fs/write_text_file` reach the injected `ArtifactSink`
//! with the right context; failed writes, reads and replays record nothing
//! (plan 03, 3.T4 - 3.T8).

mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionUpdate;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_agents::acp_connection::AcpLaunchSpec;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::plugin::{
    AgentPlugin, AsyncResult, ComposePromptInput, ComposePromptResult, LaunchConfig,
    ListModelsResult, PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_types::artifacts::{ArtifactSink, FileEffect, WriteContext};
use vst_types::{Broadcaster, Channel, NormalizedEvent, NormalizedEventProvider};

#[derive(Default)]
struct RecordingSink(Mutex<Vec<(WriteContext, Vec<FileEffect>)>>);

impl ArtifactSink for RecordingSink {
    fn record(&self, ctx: WriteContext, effects: Vec<FileEffect>) {
        self.0.lock().unwrap().push((ctx, effects));
    }
}

impl RecordingSink {
    fn calls(&self) -> Vec<(WriteContext, Vec<FileEffect>)> {
        self.0.lock().unwrap().clone()
    }
    fn all_effects(&self) -> Vec<FileEffect> {
        self.calls().into_iter().flat_map(|(_, e)| e).collect()
    }
}

/// Plugin driving the REAL `run_turn_acp` against `fakeAcpAgent.mjs` in `mode`.
struct FakeAgentPlugin {
    mode: &'static str,
    env: HashMap<String, String>,
}

impl AgentPlugin for FakeAgentPlugin {
    fn name(&self) -> &str {
        "fake-artifacts"
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
    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
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
    fn list_models(&self) -> AsyncResult<ListModelsResult> {
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
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut env = self.env.clone();
        env.insert("FAKE_ACP_MODE".into(), self.mode.into());
        let spec = AcpLaunchSpec {
            command: "node".to_string(),
            args: vec![format!(
                "{}/tests/fixtures/fakeAcpAgent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            env,
            initialize_timeout_ms: None,
            prompt_timeout_ms: None,
            open_tool_idle_timeout_ms: None,
            reap_detached_descendants: false,
        };
        let params = vst_agents::acp_run_turn::RunTurnAcpParams {
            provider: NormalizedEventProvider::Claude,
            build_spec: Box::new(move |_| spec.clone()),
            enrich: None,
            first_turn_session_init: None,
            build_prompt_blocks: Box::new(|_c, input, _sys| {
                vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                    agent_client_protocol::schema::v1::TextContent::new(input.message.clone()),
                )]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(vst_agents::acp_run_turn::run_turn_acp(
            tx, input, ctx, cancel, params,
        ));
        rx
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    _home: vst_agents::home::HomeGuard,
    session: JsonAgentSession,
    sink: Arc<RecordingSink>,
}

fn session_with(
    dir: &std::path::Path,
    plugin: Arc<dyn AgentPlugin>,
    worktree: Option<vst_types::WorktreeRecord>,
    session_id: &str,
) -> JsonAgentSession {
    let store_handle = vst_store::StoreHandle::open(dir.join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree,
        session: common::make_session(session_id),
        plugin,
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    })
}

impl Harness {
    fn new(plugin: Arc<dyn AgentPlugin>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = vst_agents::home::with_home(dir.path().to_path_buf());
        let session = session_with(dir.path(), plugin, None, "s1");
        let sink = Arc::new(RecordingSink::default());
        session.attach_artifact_sink(sink.clone());
        Self {
            _dir: dir,
            _home: home,
            session,
            sink,
        }
    }

    fn claude() -> Self {
        Self::new(Arc::new(vst_agents::claude::create_claude_plugin()))
    }

    fn fake(mode: &'static str, env: &[(&str, &str)]) -> Self {
        Self::new(Arc::new(FakeAgentPlugin {
            mode,
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }))
    }

    async fn run_turn(&self) {
        self.session.enqueue("go".into(), vec![], None, None);
        wait_idle(&self.session).await;
    }
}

async fn wait_idle(session: &JsonAgentSession) {
    // The turn is enqueued synchronously; give the drain a moment to start,
    // then wait until nothing runs or is queued.
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let m = session.get_meta();
            if m.queue_depth == 0 && m.active_turn_id.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("turn should finish");
}

fn tool_event(kind: &str, id: &str, extra: serde_json::Value) -> NormalizedEvent {
    let mut v = serde_json::json!({
        "id": format!("e-{kind}-{id}-{}", extra),
        "sessionId": "s1",
        "ts": "2026-10-21T00:00:00.000Z",
        "provider": "claude",
        "kind": kind,
        "role": "assistant",
        "toolId": id,
        "turnId": "t1",
    });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn edit_started(id: &str, path: &str) -> NormalizedEvent {
    tool_event(
        "tool_use",
        id,
        serde_json::json!({
            "toolName": "Write", "toolKind": "edit", "toolStatus": "in_progress",
            "toolLocations": [{"path": path}],
        }),
    )
}

fn completed(id: &str) -> NormalizedEvent {
    tool_event(
        "tool_result",
        id,
        serde_json::json!({"toolStatus": "completed"}),
    )
}

fn update(json: serde_json::Value) -> SessionUpdate {
    serde_json::from_value(json).expect("valid session/update")
}

/// 3.T4 — a completed write calls the sink once with the session id and cwd; a
/// failed write and a read do not; a relative path stays relative (the daemon
/// resolves it). Driven by a real turn through `fakeAcpAgent.mjs`.
#[tokio::test]
async fn real_turn_records_completed_write_only() {
    let h = Harness::fake("artifact_writes", &[]);
    h.run_turn().await;
    let calls = h.sink.calls();
    assert_eq!(calls.len(), 1, "only the completed write: {calls:?}");
    let (ctx, effects) = &calls[0];
    assert_eq!(effects, &vec![FileEffect::write("docs/plan.md")]);
    assert_eq!(ctx.session_id, "s1");
    assert_eq!(ctx.project_id, "p1");
    assert_eq!(ctx.worktree_id, None);
    assert_eq!(ctx.cwd, PathBuf::from("/repos/p1"));
}

/// 3.T4 (no sink) / 3.T8 — without a sink installed everything is a no-op.
#[tokio::test]
async fn no_sink_means_no_capture_and_no_panic() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = session_with(
        dir.path(),
        Arc::new(vst_agents::claude::create_claude_plugin()),
        None,
        "s1",
    );
    session
        .handle_event(&mut edit_started("t1", "/a/x.md"))
        .await;
    session.handle_event(&mut completed("t1")).await;
}

/// 3.T5 — in-band: start + completed records once; a repeated completion does not.
#[tokio::test]
async fn in_band_completed_call_records_once() {
    let h = Harness::claude();
    h.session
        .handle_event(&mut edit_started("t1", "/a/x.md"))
        .await;
    assert!(h.sink.calls().is_empty(), "nothing before completion");
    h.session.handle_event(&mut completed("t1")).await;
    h.session.handle_event(&mut completed("t1")).await;
    assert_eq!(h.sink.all_effects(), vec![FileEffect::write("/a/x.md")]);
}

/// 3.T5 — a subagent child call arriving out-of-band records once, attributed
/// to the emitting session; a failed one records nothing.
#[tokio::test]
async fn out_of_band_completed_call_records_once() {
    let h = Harness::claude();
    let started = update(serde_json::json!({
        "sessionUpdate": "tool_call", "toolCallId": "oob-1", "title": "Write",
        "kind": "edit", "status": "in_progress",
        "locations": [{"path": "/sub/out.md"}],
        "_meta": {"claudeCode": {"parentToolUseId": "parent-1"}},
    }));
    let done = update(serde_json::json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "oob-1", "status": "completed",
    }));
    h.session.ingest_out_of_band_update(&started, "acp-x", None);
    assert!(h.sink.calls().is_empty());
    h.session.ingest_out_of_band_update(&done, "acp-x", None);
    let calls = h.sink.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].0.session_id, "s1",
        "attributed to the emitting session"
    );
    assert_eq!(calls[0].1, vec![FileEffect::write("/sub/out.md")]);

    let failed_start = update(serde_json::json!({
        "sessionUpdate": "tool_call", "toolCallId": "oob-2", "title": "Write",
        "kind": "edit", "status": "in_progress", "locations": [{"path": "/sub/bad.md"}],
    }));
    let failed = update(serde_json::json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "oob-2", "status": "failed",
    }));
    h.session
        .ingest_out_of_band_update(&failed_start, "acp-x", None);
    h.session.ingest_out_of_band_update(&failed, "acp-x", None);
    assert_eq!(h.sink.calls().len(), 1);
}

/// 3.T5 — a child call carrying `parentToolUseId` delivered via `handle_event`
/// records once too: both entry points share one tracker keyed by tool id, so
/// a call started on one path and completed on the other still records once.
#[tokio::test]
async fn both_entry_points_share_one_tracker() {
    let h = Harness::claude();
    h.session
        .handle_event(&mut edit_started("child-1", "/sub/in.md"))
        .await;
    let done = update(serde_json::json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "child-1", "status": "completed",
        "_meta": {"claudeCode": {"parentToolUseId": "parent-1"}},
    }));
    h.session.ingest_out_of_band_update(&done, "acp-x", None);
    assert_eq!(h.sink.all_effects(), vec![FileEffect::write("/sub/in.md")]);
    assert_eq!(h.sink.calls().len(), 1);
}

/// 3.5 — a subagent is its own session: its writes carry ITS session id and
/// worktree, never the parent's.
#[tokio::test]
async fn subagent_writes_carry_the_subagents_own_context() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let sink = Arc::new(RecordingSink::default());
    let parent = session_with(
        dir.path(),
        Arc::new(vst_agents::claude::create_claude_plugin()),
        Some(common::make_worktree("w1")),
        "parent",
    );
    let child = session_with(
        dir.path(),
        Arc::new(vst_agents::claude::create_claude_plugin()),
        Some(common::make_worktree("w2")),
        "child",
    );
    parent.attach_artifact_sink(sink.clone());
    child.attach_artifact_sink(sink.clone());
    child.handle_event(&mut edit_started("c1", "x.md")).await;
    child.handle_event(&mut completed("c1")).await;
    let calls = sink.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0.session_id, "child");
    assert_eq!(calls[0].0.worktree_id.as_deref(), Some("w2"));
    assert!(calls[0].0.cwd.ends_with("worktrees/w2"));
}

/// 3.T6 — `session/load` replay never reaches the sink: a replayed history of
/// completed writes is delivered as notifications BEFORE the observers/sinks
/// are attached, so nothing is recorded on resume.
#[tokio::test]
async fn session_load_replay_records_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let mut record = common::make_session("s1");
    // A stored ACP id makes the connection take the `session/load` path.
    record.acp_session_id = Some("prior".into());
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: record,
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    });
    let sink = Arc::new(RecordingSink::default());
    session.attach_artifact_sink(sink.clone());
    let spec = AcpLaunchSpec {
        command: "node".to_string(),
        args: vec![format!(
            "{}/tests/fixtures/fakeAcpAgent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        env: HashMap::from([("FAKE_ACP_MODE".to_string(), "replay_on_load".to_string())]),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        open_tool_idle_timeout_ms: None,
        reap_detached_descendants: false,
    };
    let conn = session
        .get_or_create_connection(spec, None)
        .await
        .expect("connection");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(sink.calls().is_empty(), "replay recorded nothing");
    use vst_agents::acp_transport::AcpTransport;
    conn.dispose().await;
}

/// 3.T7 — secondary path: an `fs/write_text_file` write reaches the sink once
/// with the resolved absolute path; the same file reported again as a tool call
/// in the same turn is a second, identical effect (the daemon-side upsert
/// dedupes it, `vst-artifacts` 2.T4), never a different path.
#[tokio::test]
async fn fs_write_text_file_reaches_the_sink() {
    let out = tempfile::tempdir().unwrap();
    let target = out.path().join("via-fs.md");
    let h = Harness::fake(
        "fs_write",
        &[("FAKE_FS_WRITE_PATH", target.to_str().unwrap())],
    );
    h.run_turn().await;
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "hello fs\n",
        "the adapter's write really happened"
    );
    assert_eq!(
        h.sink.all_effects(),
        vec![FileEffect::write(target.display().to_string())]
    );

    // `with_home` is process-global: release the first harness's guard first.
    drop(h);
    let h2 = Harness::fake(
        "fs_write",
        &[
            ("FAKE_FS_WRITE_PATH", target.to_str().unwrap()),
            ("FAKE_FS_WRITE_TOOLCALL", "1"),
        ],
    );
    h2.run_turn().await;
    let effects = h2.sink.all_effects();
    assert_eq!(effects.len(), 2, "fs write + tool call: {effects:?}");
    assert!(
        effects
            .iter()
            .all(|e| e == &FileEffect::write(target.display().to_string())),
        "both sources name the same path (upsert dedupes): {effects:?}"
    );
}
