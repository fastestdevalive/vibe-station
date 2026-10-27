//! Task tray wiring at the `JsonAgentSession` handle (task-tray 1d): in-band
//! and out-of-band observation, turn end, rebuild from the transcript, and the
//! broadcast of coalesced snapshots. Detection is the real Claude plugin's.

mod common;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use vst_agents::claude_tasks::claude_task_observations;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{
    get_or_create_json_agent_session, JsonAgentSession, JsonAgentSessionOptions,
};
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_store::StoreHandle;
use vst_tasks::TaskObservation;
use vst_types::{
    Broadcaster, Channel, NormalizedEvent, NormalizedEventKind, ServerEvent, TaskKind, TaskState,
    TaskSummary,
};

const SID: &str = "s1";

/// Claude's detection, but a scripted turn: `script` events then `result`.
struct ScriptedClaudeLike {
    script: Vec<NormalizedEvent>,
}

impl AgentPlugin for ScriptedClaudeLike {
    fn name(&self) -> &str {
        "scripted"
    }
    fn default_model(&self) -> &str {
        "m"
    }
    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "m"
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
    fn task_observations(&self, ev: &NormalizedEvent) -> Vec<TaskObservation> {
        claude_task_observations(ev)
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        for ev in &self.script {
            let _ = tx.send(ev.clone());
        }
        let mut result = NormalizedEvent::default();
        result.kind = NormalizedEventKind::Result;
        let _ = tx.send(result);
        rx
    }
}

struct Fx {
    dir: tempfile::TempDir,
    _home: vst_agents::home::HomeGuard,
    store: StoreHandle,
    broadcaster: Broadcaster,
    rx: broadcast::Receiver<ServerEvent>,
}

async fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut project = common::make_project("p1");
    project.direct_sessions.push(common::make_session(SID));
    store.add_project(project).await.unwrap();
    let (tx, rx) = broadcast::channel(256);
    Fx {
        dir,
        _home: home,
        store,
        broadcaster: Broadcaster(tx),
        rx,
    }
}

impl Fx {
    fn opts(&self, plugin: Arc<dyn AgentPlugin>) -> JsonAgentSessionOptions {
        let mut project = common::make_project("p1");
        let session = common::make_session(SID);
        project.direct_sessions.push(session.clone());
        JsonAgentSessionOptions {
            project,
            worktree: None,
            session,
            plugin,
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle: self.store.clone(),
            broadcaster: self.broadcaster.clone(),
        }
    }

    fn session(&self, plugin: Arc<dyn AgentPlugin>) -> JsonAgentSession {
        JsonAgentSession::new(self.opts(plugin))
    }

    /// Wait (real time) for a `SessionTasksChanged` matching `pred`.
    async fn tasks_event(
        &mut self,
        pred: impl Fn(&[TaskSummary]) -> bool,
    ) -> (u64, Vec<TaskSummary>) {
        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                match self.rx.recv().await {
                    Ok(ServerEvent::SessionTasksChanged {
                        session_id,
                        rev,
                        tasks,
                    }) if session_id == SID && pred(&tasks) => return (rev, tasks),
                    Ok(_) => {}
                    Err(_) => panic!("broadcast closed"),
                }
            }
        })
        .await
        .expect("expected SessionTasksChanged")
    }
}

fn tool_event(
    id: &str,
    ts: &str,
    kind: NormalizedEventKind,
    f: impl FnOnce(&mut NormalizedEvent),
) -> NormalizedEvent {
    let mut ev = NormalizedEvent::default();
    ev.id = id.into();
    ev.session_id = SID.into();
    ev.ts = ts.into();
    ev.kind = kind;
    f(&mut ev);
    ev
}

fn launch(id: &str, ts: &str, tool: &str) -> NormalizedEvent {
    tool_event(id, ts, NormalizedEventKind::ToolResult, |e| {
        e.tool_id = Some(tool.into());
        e.tool_kind = Some(vst_types::AcpToolKind::Execute);
        e.tool_input = Some(serde_json::json!({"command": "sleep 90", "run_in_background": true}));
    })
}

fn backgrounded(id: &str, ts: &str, tool: &str, task: &str, path: &str) -> NormalizedEvent {
    tool_event(id, ts, NormalizedEventKind::ToolResult, |e| {
        e.tool_id = Some(tool.into());
        e.tool_status = Some(vst_types::ToolStatus::Completed);
        e.tool_result = Some(vst_types::ToolResult {
            content: Some(format!(
                "Command running in background with ID: {task}. Output is being written to: {path}. You will be notified when it completes."
            )),
            is_error: Some(false),
        });
    })
}

fn subagent_start(id: &str, ts: &str, tool: &str) -> NormalizedEvent {
    tool_event(id, ts, NormalizedEventKind::ToolUse, |e| {
        e.tool_id = Some(tool.into());
        e.tool_name = Some("Investigate".into());
        e.tool_input = Some(serde_json::json!({
            "description": "Investigate", "prompt": "p", "subagent_type": "general-purpose"
        }));
    })
}

fn now_iso() -> String {
    vst_tasks::format_ms(
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap(),
    )
}

fn output_path(fx: &Fx, task: &str) -> String {
    let canon = fx.dir.path().canonicalize().unwrap();
    let d = canon.join("claude-1000/p/u/tasks");
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join(format!("{task}.output"));
    std::fs::write(&f, "hello\nworld\n").unwrap();
    f.display().to_string()
}

#[tokio::test]
async fn in_band_background_command_appears_broadcasts_and_serves_output() {
    let mut fx = fx().await;
    let s = fx.session(Arc::new(ScriptedClaudeLike { script: vec![] }));
    let path = output_path(&fx, "be00epro0");
    let ts = now_iso();
    s.handle_event(&mut launch("a", &ts, "tool-1")).await;
    s.handle_event(&mut backgrounded("b", &ts, "tool-1", "be00epro0", &path))
        .await;

    let (_, snap) = s.task_snapshot().unwrap();
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].id, "be00epro0");
    assert_eq!(snap[0].kind, TaskKind::Command);
    assert_eq!(snap[0].state, TaskState::Running);
    assert_eq!(snap[0].label, "sleep 90");

    let (rev, tasks) = fx.tasks_event(|t| t.len() == 1).await;
    assert_eq!(tasks[0].id, "be00epro0");
    assert!(rev > 0);

    let out = s.task_output("be00epro0", 200).await.unwrap();
    assert_eq!(out.lines, vec!["hello".to_string(), "world".to_string()]);
    assert_eq!(
        s.task_output("nope", 200).await.unwrap_err(),
        vst_tasks::TaskOutputError::NotFound
    );
}

#[tokio::test]
async fn out_of_band_events_reach_the_registry() {
    let mut fx = fx().await;
    let s = fx.session(Arc::new(ScriptedClaudeLike { script: vec![] }));
    let path = output_path(&fx, "oob1");
    let ts = now_iso();
    s.handle_out_of_band_event(launch("a", &ts, "tool-oob"));
    s.handle_out_of_band_event(backgrounded("b", &ts, "tool-oob", "oob1", &path));
    let (_, tasks) = fx.tasks_event(|t| !t.is_empty()).await;
    assert_eq!(tasks[0].id, "oob1");
}

#[tokio::test]
async fn unfinished_sync_subagent_is_stopped_when_its_turn_ends() {
    let mut fx = fx().await;
    let ts = now_iso();
    let plugin = Arc::new(ScriptedClaudeLike {
        script: vec![subagent_start("sa", &ts, "toolu_sub")],
    });
    let s = fx.session(plugin);
    s.enqueue("go".into(), vec![], None, None);

    let (_, tasks) = fx
        .tasks_event(|t| t.iter().any(|x| x.state == TaskState::Stopped))
        .await;
    assert_eq!(tasks[0].kind, TaskKind::Subagent);
    assert_eq!(tasks[0].reason.as_deref(), Some("Turn ended"));
}

#[tokio::test]
async fn registry_is_rebuilt_from_the_transcript_and_running_goes_stale() {
    let mut fx = fx().await;
    let ts = now_iso();
    let path = output_path(&fx, "rb1");
    // A first life of the session persists the launch + receipt, then ends.
    {
        let first = fx.session(Arc::new(ScriptedClaudeLike { script: vec![] }));
        first.persist_event_for_test(&launch("a", &ts, "tool-r"));
        first.persist_event_for_test(&backgrounded("b", &ts, "tool-r", "rb1", &path));
        first.dispose();
    }
    // A fresh one, created lazily through the registry (as in production).
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();
    let second = get_or_create_json_agent_session(
        &registry,
        fx.opts(Arc::new(ScriptedClaudeLike { script: vec![] })),
    );
    let (_, tasks) = fx.tasks_event(|t| !t.is_empty()).await;
    assert_eq!(tasks[0].id, "rb1");
    assert_eq!(tasks[0].state, TaskState::Stale);
    assert_eq!(tasks[0].reason.as_deref(), Some("Agent restarted"));
    assert_eq!(second.task_snapshot().unwrap().1.len(), 1);
}

#[tokio::test]
async fn release_stops_further_task_broadcasts() {
    let mut fx = fx().await;
    let s = fx.session(Arc::new(ScriptedClaudeLike { script: vec![] }));
    s.release().await;
    // Release sends exactly one final empty snapshot so clients drop the rows.
    let mut final_empty = 0;
    while let Ok(ev) = fx.rx.try_recv() {
        if let ServerEvent::SessionTasksChanged { tasks, .. } = ev {
            assert!(tasks.is_empty(), "release snapshot is empty");
            final_empty += 1;
        }
    }
    assert_eq!(final_empty, 1);
    let ts = now_iso();
    s.handle_event(&mut subagent_start("sa", &ts, "late")).await;
    tokio::time::sleep(Duration::from_millis(1_300)).await;
    while let Ok(ev) = fx.rx.try_recv() {
        assert!(
            !matches!(ev, ServerEvent::SessionTasksChanged { .. }),
            "no task broadcast after release"
        );
    }
}
