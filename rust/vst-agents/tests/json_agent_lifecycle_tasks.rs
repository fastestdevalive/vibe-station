//! Task-held lifecycle (lifecycle-from-tasks, phase 3): a Rich Chat session
//! stays `working(background)` while a background command provably lives, and
//! settles with a single visible `waiting_for_human(None)` once it does not.
//! Detection is Claude's; liveness is a fake probe; time is paused.

mod common;

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, SessionUpdate, TextContent};
use tokio::sync::{broadcast, mpsc, Notify};
use tokio_util::sync::CancellationToken;
use vst_agents::acp_connection::AcpExtNotification;
use vst_agents::claude_tasks::{claude_task_observations, claude_task_signal_event};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::{
    get_or_create_json_agent_session, JsonAgentSession, JsonAgentSessionOptions,
};
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_store::StoreHandle;
use vst_tasks::{Liveness, LivenessProbe, TaskObservation, TASK_END_GRACE_MS};
use vst_types::{
    Broadcaster, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, ServerEvent,
    TaskState, ToolResult, ToolStatus,
};

const SID: &str = "s1";
const TASK: &str = "be00lifec";
/// After a turn ended its `waiting_for_human(None)` is still owed, so held
/// `working` carries the persisted `background-turn-ended` reason.
const WORKING_BG: (LifecycleState, Option<&str>) =
    (LifecycleState::Working, Some("background-turn-ended"));
const WORKING_BG_PLAIN: (LifecycleState, Option<&str>) =
    (LifecycleState::Working, Some("background"));
const WAITING_NONE: (LifecycleState, Option<&str>) = (LifecycleState::WaitingForHuman, None);

/// Claude detection; the turn emits `script`, then (after `gate`, if any) `result`.
struct Scripted {
    script: Vec<NormalizedEvent>,
    gate: Option<Arc<Notify>>,
}

impl AgentPlugin for Scripted {
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
    fn acp_ext_notification_event(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> Option<NormalizedEvent> {
        claude_task_signal_event(method, params)
    }
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        for ev in &self.script {
            let _ = tx.send(ev.clone());
        }
        let mut result = NormalizedEvent::default();
        result.kind = NormalizedEventKind::Result;
        match self.gate.clone() {
            None => {
                let _ = tx.send(result);
            }
            Some(gate) => {
                tokio::spawn(async move {
                    tokio::select! {
                        _ = cancel.cancelled() => {}
                        _ = gate.notified() => { let _ = tx.send(result); }
                    }
                });
            }
        }
        rx
    }
}

struct FakeProbe(Mutex<Liveness>);

impl FakeProbe {
    fn set(&self, l: Liveness) {
        *self.0.lock().unwrap() = l;
    }
}

impl LivenessProbe for FakeProbe {
    fn probe<'a>(&'a self, _p: &'a Path) -> Pin<Box<dyn Future<Output = Liveness> + Send + 'a>> {
        Box::pin(async move { *self.0.lock().unwrap() })
    }
}

struct H {
    s: JsonAgentSession,
    probe: Arc<FakeProbe>,
    gate: Arc<Notify>,
    rx: broadcast::Receiver<ServerEvent>,
    seen: Vec<(LifecycleState, Option<String>)>,
    _registry: JsonAgentRegistry<JsonAgentSession>,
    _dir: tempfile::TempDir,
    _home: vst_agents::home::HomeGuard,
}

fn ev(id: &str, f: impl FnOnce(&mut NormalizedEvent)) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = id.into();
    e.session_id = SID.into();
    e.ts = vst_tasks::format_ms(
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap(),
    );
    e.kind = NormalizedEventKind::ToolResult;
    f(&mut e);
    e
}

fn script(path: &str) -> Vec<NormalizedEvent> {
    vec![
        ev("a", |e| {
            e.tool_id = Some("tool-1".into());
            e.tool_kind = Some(vst_types::AcpToolKind::Execute);
            e.tool_input =
                Some(serde_json::json!({"command": "docker build .", "run_in_background": true}));
        }),
        ev("b", |e| {
            e.tool_id = Some("tool-1".into());
            e.tool_status = Some(ToolStatus::Completed);
            e.tool_result = Some(ToolResult {
                content: Some(format!(
                    "Command running in background with ID: {TASK}. Output is being written to: {path}. You will be notified when it completes."
                )),
                is_error: Some(false),
            });
        }),
    ]
}

/// Build a session through the production factory (rebuild + hold follower).
/// `gated`: the turn stays running until `h.gate` fires.
async fn harness(gated: bool, probe: Liveness) -> H {
    harness_with(gated, probe, None).await
}

/// As [`harness`] with a custom turn script (default: the background command).
async fn harness_with(
    gated: bool,
    probe: Liveness,
    custom_script: Option<Vec<NormalizedEvent>>,
) -> H {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut project = common::make_project("p1");
    let mut session = common::make_session(SID);
    session.lifecycle.state = LifecycleState::WaitingForHuman;
    project.direct_sessions.push(session.clone());
    store.add_project(project.clone()).await.unwrap();
    let (tx, rx) = broadcast::channel(512);

    let canon = dir.path().canonicalize().unwrap();
    let d = canon.join("claude-1000/p/u/tasks");
    std::fs::create_dir_all(&d).unwrap();
    let out = d.join(format!("{TASK}.output"));
    std::fs::write(&out, "x\n").unwrap();

    let gate = Arc::new(Notify::new());
    let plugin = Arc::new(Scripted {
        script: custom_script.unwrap_or_else(|| script(&out.display().to_string())),
        gate: gated.then(|| gate.clone()),
    });
    let registry = JsonAgentRegistry::<JsonAgentSession>::new();
    let s = get_or_create_json_agent_session(
        &registry,
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
            store_handle: store,
            broadcaster: Broadcaster(tx),
        },
    );
    let probe_arc = Arc::new(FakeProbe(Mutex::new(probe)));
    s.set_task_probe_for_test(probe_arc.clone());
    let mut h = H {
        s,
        probe: probe_arc,
        gate,
        rx,
        seen: vec![],
        _registry: registry,
        _dir: dir,
        _home: home,
    };
    io().await; // let the initial rebuild finish
    h.pump();
    h
}

impl H {
    fn pump(&mut self) {
        while let Ok(e) = self.rx.try_recv() {
            if let ServerEvent::SessionState {
                session_id,
                state,
                reason,
            } = e
            {
                if session_id == SID {
                    self.seen.push((state, reason));
                }
            }
        }
    }

    /// Every lifecycle write seen so far.
    fn states(&mut self) -> Vec<(LifecycleState, Option<String>)> {
        self.pump();
        self.seen.clone()
    }

    fn last(&mut self) -> (LifecycleState, Option<String>) {
        self.states().last().cloned().expect("a lifecycle write")
    }

    fn count(&mut self, st: (LifecycleState, Option<&str>)) -> usize {
        let want = (st.0, st.1.map(str::to_string));
        self.states().iter().filter(|e| **e == want).count()
    }

    async fn start_turn(&self) {
        self.s.enqueue("go".into(), vec![], None, None);
        self.s.write_working_for_human_turn().await;
        io().await;
    }

    fn statuses(&self) -> Vec<String> {
        self.s
            .read_transcript()
            .into_iter()
            .filter(|e| e.kind == NormalizedEventKind::Status)
            .filter_map(|e| e.text)
            .collect()
    }
}

fn is(e: &(LifecycleState, Option<String>), want: (LifecycleState, Option<&str>)) -> bool {
    e.0 == want.0 && e.1.as_deref() == want.1
}

async fn io() {
    for _ in 0..40 {
        tokio::time::advance(Duration::from_millis(1)).await;
        std::thread::sleep(Duration::from_millis(2));
    }
}

async fn adv(d: Duration) {
    tokio::time::advance(d).await;
    io().await;
}

/// Advance so two NoWriter probes land (first ~+2s, then one interval later);
/// the registry timer wakes once per advance, so step it.
async fn until_dead() {
    adv(Duration::from_secs(3)).await;
    adv(Duration::from_secs(10)).await;
}

fn chunk(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        text,
    ))))
}

/// 3.T2 (row 4) — a turn ending with a live command never writes waiting.
#[tokio::test(start_paused = true)]
async fn turn_end_with_live_command_stays_working_background() {
    let mut h = harness(false, Liveness::Alive).await;
    h.start_turn().await;
    adv(Duration::from_secs(30)).await;
    let seen = h.states();
    assert!(
        seen.iter().all(|e| e.0 == LifecycleState::Working),
        "never waiting while alive: {seen:?}"
    );
    assert!(is(seen.last().unwrap(), WORKING_BG), "{seen:?}");
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Running);
}

/// 3.T3 (rows 8-9) — probe death, then grace, then exactly one visible settle.
#[tokio::test(start_paused = true)]
async fn dead_command_settles_after_grace_exactly_once() {
    let mut h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    until_dead().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Done);
    assert!(
        is(&h.last(), WORKING_BG),
        "grace keeps working: {:?}",
        h.states()
    );
    assert_eq!(h.count(WAITING_NONE), 0);
    adv(Duration::from_millis(
        u64::try_from(TASK_END_GRACE_MS).unwrap() + 500,
    ))
    .await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    adv(Duration::from_secs(120)).await;
    assert_eq!(h.count(WAITING_NONE), 1, "{:?}", h.states());
}

/// 3.T3b (row 29) — the hold ends while the turn still runs; no waiting/working flap.
#[tokio::test(start_paused = true)]
async fn hold_ending_before_turn_end_does_not_flap() {
    let mut h = harness(true, Liveness::NoWriter).await;
    h.start_turn().await;
    until_dead().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Done, "hold ended mid-turn");
    h.gate.notify_one();
    io().await;
    adv(Duration::from_millis(
        u64::try_from(TASK_END_GRACE_MS).unwrap() + 500,
    ))
    .await;
    let seen = h.states();
    let wait = seen
        .iter()
        .position(|e| is(e, WAITING_NONE))
        .expect("settles");
    let bg = seen
        .iter()
        .position(|e| is(e, WORKING_BG))
        .expect("grace working");
    assert!(
        bg < wait,
        "no waiting(None) before working(background): {seen:?}"
    );
    assert_eq!(h.count(WAITING_NONE), 1, "{seen:?}");
    assert!(is(seen.last().unwrap(), WAITING_NONE));
}

fn subagent_start(id: &str, background: bool) -> NormalizedEvent {
    ev(&format!("sub-{id}"), |e| {
        e.kind = NormalizedEventKind::ToolUse;
        e.tool_id = Some(id.into());
        e.tool_input = Some(serde_json::json!({
            "subagent_type": "general-purpose",
            "description": "work",
            "run_in_background": background,
        }));
    })
}

fn subagent_done(id: &str) -> NormalizedEvent {
    ev(&format!("done-{id}"), |e| {
        e.tool_id = Some(id.into());
        e.tool_status = Some(ToolStatus::Completed);
        e.tool_result = Some(ToolResult {
            content: Some("done".into()),
            is_error: Some(false),
        });
    })
}

/// F1 — a synchronous subagent finishing inside the turn is not a background
/// task end: no grace, so no phantom `working(background)` after the turn.
#[tokio::test(start_paused = true)]
async fn sync_subagent_ending_in_turn_leaves_no_phantom_background() {
    let mut h = harness_with(
        true,
        Liveness::Alive,
        Some(vec![subagent_start("sa1", false), subagent_done("sa1")]),
    )
    .await;
    h.start_turn().await;
    adv(Duration::from_secs(1)).await;
    h.gate.notify_one();
    io().await;
    adv(Duration::from_secs(15)).await;
    let seen = h.states();
    assert_eq!(
        h.count(WORKING_BG) + h.count(WORKING_BG_PLAIN),
        0,
        "{seen:?}"
    );
    assert_eq!(h.count(WAITING_NONE), 1, "{seen:?}");
    assert!(is(&seen[0], (LifecycleState::Working, None)), "{seen:?}");
    assert!(is(seen.last().unwrap(), WAITING_NONE), "{seen:?}");
}

/// F1 — the turn's `Result` settling a background subagent (`TurnSettled`) is
/// already the end of the work: the parent is notified right away.
#[tokio::test(start_paused = true)]
async fn turn_settled_background_subagent_settles_without_grace() {
    let mut h = harness_with(
        true,
        Liveness::Alive,
        Some(vec![subagent_start("sa2", true)]),
    )
    .await;
    h.start_turn().await;
    adv(Duration::from_secs(1)).await;
    h.gate.notify_one();
    io().await;
    let seen = h.states();
    assert_eq!(
        h.count(WORKING_BG) + h.count(WORKING_BG_PLAIN),
        0,
        "{seen:?}"
    );
    assert!(is(seen.last().unwrap(), WAITING_NONE), "{seen:?}");
    adv(Duration::from_secs(15)).await;
    assert_eq!(
        h.count(WORKING_BG) + h.count(WORKING_BG_PLAIN),
        0,
        "{:?}",
        h.states()
    );
    assert_eq!(h.count(WAITING_NONE), 1);
}

/// 3.T4 — an out-of-band cycle during grace keeps working; the quiet settle is the
/// visible waiting.
#[tokio::test(start_paused = true)]
async fn oob_cycle_during_grace_then_quiet_settle() {
    let mut h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    until_dead().await; // command dead, in grace
    h.s.ingest_out_of_band_update(&chunk("task finished"), "acp", None);
    io().await;
    adv(Duration::from_secs(10)).await; // grace expired, cycle still open
    assert!(is(&h.last(), WORKING_BG), "{:?}", h.states());
    assert_eq!(h.count(WAITING_NONE), 0);
    adv(Duration::from_secs(61)).await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    assert_eq!(h.count(WAITING_NONE), 1);
}

/// 3.T5 (row 11) — alive past 60 min lapses: one Status row, tray reason, then settle.
#[tokio::test(start_paused = true)]
async fn alive_past_cap_lapses_visibly_once() {
    let mut h = harness(false, Liveness::Alive).await;
    h.start_turn().await;
    for _ in 0..12 {
        adv(Duration::from_secs(300)).await;
    }
    assert!(
        is(&h.last(), WORKING_BG),
        "still held at 60 min: {:?}",
        h.states()
    );
    adv(Duration::from_secs(120)).await;
    let rows = h.statuses();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].contains("still running after 60 min"), "{rows:?}");
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Running);
    assert_eq!(tasks[0].reason.as_deref(), Some(vst_tasks::REASON_HOLD_CAP));
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    // A further hold publish does not announce again.
    h.probe.set(Liveness::Unknown);
    adv(Duration::from_secs(300)).await;
    assert_eq!(h.statuses().len(), 1);
}

/// 3.T6 (row 21) — an adapter epoch bump drops the hold; settles after grace.
#[tokio::test(start_paused = true)]
async fn epoch_bump_settles_after_grace() {
    let mut h = harness(false, Liveness::Alive).await;
    h.start_turn().await;
    adv(Duration::from_secs(5)).await;
    assert!(is(&h.last(), WORKING_BG));
    h.s.bump_task_epoch_for_test();
    io().await;
    assert!(is(&h.last(), WORKING_BG), "grace: {:?}", h.states());
    adv(Duration::from_millis(
        u64::try_from(TASK_END_GRACE_MS).unwrap() + 500,
    ))
    .await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Stale);
}

/// 3.T7 (row 20) — Stop does not release a live command's hold.
#[tokio::test(start_paused = true)]
async fn stop_turn_keeps_live_command_working() {
    let mut h = harness(true, Liveness::Alive).await;
    h.start_turn().await;
    adv(Duration::from_secs(3)).await;
    assert!(h.s.stop_active_turn(None));
    io().await;
    adv(Duration::from_secs(30)).await;
    assert!(is(&h.last(), WORKING_BG), "{:?}", h.states());
    assert_eq!(h.count(WAITING_NONE), 0);
}

/// 3.T8 (row 24) — nothing is written after release, and the follower is gone.
#[tokio::test(start_paused = true)]
async fn release_during_hold_writes_nothing_more() {
    let mut h = harness(false, Liveness::Alive).await;
    h.start_turn().await;
    adv(Duration::from_secs(3)).await;
    h.s.release().await;
    io().await;
    let before = h.states().len();
    h.probe.set(Liveness::NoWriter);
    adv(Duration::from_secs(120)).await;
    assert_eq!(h.states().len(), before, "{:?}", h.states());
}

/// 3.T9 (row 27, Risk 5) — a turn ending mid-rebuild settles briefly, then the
/// rebuild publish re-derives `working(background)`.
#[tokio::test(start_paused = true)]
async fn turn_end_before_rebuild_completes_recovers_working() {
    let mut h = harness(false, Liveness::Alive).await;
    h.s.begin_task_rebuild_for_test();
    h.start_turn().await;
    adv(Duration::from_secs(1)).await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    h.s.finish_task_rebuild_for_test();
    io().await;
    adv(Duration::from_secs(1)).await;
    // The settle already announced the turn end: plain `background`.
    assert!(is(&h.last(), WORKING_BG_PLAIN), "{:?}", h.states());
}

// --- structured task signals (adapter 0.98.0 raw SDK `task_*` messages) ---

/// A `_claude/sdkMessage` ext notification shaped like the adapter's (see
/// `tests/fixtures/claude_tasks/raw_adapter_capture.json`).
fn raw(message: serde_json::Value) -> AcpExtNotification {
    let mut m = serde_json::json!({
        "session_id": "11111111-1111-4111-8111-111111111111",
        "uuid": "00000000-0000-4000-8000-000000000001",
        "type": "system",
    });
    m.as_object_mut()
        .unwrap()
        .extend(message.as_object().unwrap().clone());
    AcpExtNotification {
        method: "_claude/sdkMessage".into(),
        params: serde_json::json!({"sessionId": "acp-sid", "message": m}),
    }
}

fn task_started() -> AcpExtNotification {
    raw(serde_json::json!({
        "subtype": "task_started", "task_id": TASK, "tool_use_id": "tool-1",
        "description": "docker build .", "task_type": "local_bash", "is_backgrounded": true,
    }))
}

fn task_completed() -> AcpExtNotification {
    raw(serde_json::json!({
        "subtype": "task_notification", "task_id": TASK, "tool_use_id": "tool-1",
        "status": "completed", "output_file": "/tmp/x.output", "summary": "done",
    }))
}

fn signal_rows(h: &H) -> Vec<NormalizedEvent> {
    h.s.read_transcript()
        .into_iter()
        .filter(|e| e.kind == NormalizedEventKind::TaskSignal)
        .collect()
}

/// 10.T1 — a confirmed command holds although the probe says "no writer".
#[tokio::test(start_paused = true)]
async fn confirmed_command_stays_working_past_the_probe_horizon() {
    let mut h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    h.s.ingest_ext_notification_for_test(&task_started());
    io().await;
    adv(Duration::from_secs(40)).await;
    let seen = h.states();
    assert!(
        seen.iter().all(|e| e.0 == LifecycleState::Working),
        "never waiting while the adapter says running: {seen:?}"
    );
    assert!(is(seen.last().unwrap(), WORKING_BG), "{seen:?}");
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Running);
}

/// 10.T2 — the structured end gives grace, then exactly one visible settle.
#[tokio::test(start_paused = true)]
async fn structured_end_settles_after_grace_exactly_once() {
    let mut h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    h.s.ingest_ext_notification_for_test(&task_started());
    io().await;
    adv(Duration::from_secs(40)).await;
    h.s.ingest_ext_notification_for_test(&task_completed());
    io().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Done);
    assert!(is(&h.last(), WORKING_BG), "grace: {:?}", h.states());
    assert_eq!(h.count(WAITING_NONE), 0);
    adv(Duration::from_millis(
        u64::try_from(TASK_END_GRACE_MS).unwrap() + 500,
    ))
    .await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
    adv(Duration::from_secs(120)).await;
    assert_eq!(h.count(WAITING_NONE), 1, "{:?}", h.states());
}

/// 10.T3 — rows are persisted with the running turn's id (None when idle) and stay
/// inert: no OOB burst Status row, no lifecycle write, no `turn_state` change.
#[tokio::test(start_paused = true)]
async fn signal_rows_are_persisted_and_inert() {
    let mut h = harness(true, Liveness::Alive).await;
    // Idle ingest.
    let before = h.s.get_meta().turn_state;
    h.s.ingest_ext_notification_for_test(&raw(serde_json::json!({
        "subtype": "task_updated", "task_id": "other", "patch": {"status": "running"},
    })));
    io().await;
    let rows = signal_rows(&h);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].turn_id, None);
    assert_eq!(rows[0].task_signal.as_ref().unwrap()["task_id"], "other");
    assert!(
        !h.statuses().iter().any(|t| t.contains("resumed work")),
        "no OOB burst: {:?}",
        h.statuses()
    );
    assert_eq!(h.s.get_meta().turn_state, before);
    assert!(
        h.states().is_empty(),
        "no lifecycle write: {:?}",
        h.states()
    );

    // Mid-turn ingest carries the running turn id.
    h.start_turn().await;
    let state_mid_turn = h.s.get_meta().turn_state;
    h.s.ingest_ext_notification_for_test(&task_started());
    io().await;
    let rows = signal_rows(&h);
    assert_eq!(rows.len(), 2);
    assert!(rows[1].turn_id.is_some(), "{:?}", rows[1]);
    assert_eq!(h.s.get_meta().turn_state, state_mid_turn);

    // A foreign method / non-task message is dropped, not persisted.
    h.s.ingest_ext_notification_for_test(&AcpExtNotification {
        method: "_other/thing".into(),
        params: serde_json::json!({"sessionId": "acp-sid"}),
    });
    assert_eq!(signal_rows(&h).len(), 2);
}

/// 10.T4 — a restart rebuild over the persisted rows equals live observation
/// for a finished task; an unfinished one goes `Stale("Agent restarted")`.
#[tokio::test(start_paused = true)]
async fn rebuild_from_persisted_signal_rows_matches_live() {
    let h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    h.s.ingest_ext_notification_for_test(&task_started());
    io().await;
    adv(Duration::from_secs(40)).await;
    h.s.rebuild_tasks_from_transcript_for_test();
    io().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Stale, "no end row: {tasks:?}");
    assert_eq!(tasks[0].reason.as_deref(), Some("Agent restarted"));

    h.s.ingest_ext_notification_for_test(&task_completed());
    io().await;
    let (_, live) = h.s.task_snapshot().unwrap();
    assert_eq!(live[0].state, TaskState::Done, "{live:?}");
    h.s.rebuild_tasks_from_transcript_for_test();
    io().await;
    let (_, rebuilt) = h.s.task_snapshot().unwrap();
    assert_eq!(rebuilt[0].state, TaskState::Done, "{rebuilt:?}");
    // Live == rebuilt for a finished task (everything but the broadcast rev).
    assert_eq!(live.len(), rebuilt.len());
    assert_eq!(live[0].state, rebuilt[0].state);
    assert_eq!(live[0].reason, rebuilt[0].reason);
    assert_eq!(live[0].label, rebuilt[0].label);
    assert_eq!(live[0].kind, rebuilt[0].kind);
}

/// F1 — the adapter dying while the session is idle: its confirmed task is
/// staled (no probe ever would) and the session settles after grace.
#[tokio::test(start_paused = true)]
async fn adapter_exit_stales_confirmed_task_and_settles() {
    let mut h = harness(false, Liveness::NoWriter).await;
    h.start_turn().await;
    let ext = h.s.attach_ext_sink_for_test();
    ext.send(task_started()).unwrap();
    io().await;
    adv(Duration::from_secs(40)).await;
    assert!(is(&h.last(), WORKING_BG), "{:?}", h.states());
    drop(ext);
    io().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Stale, "{tasks:?}");
    assert_eq!(tasks[0].reason.as_deref(), Some("Agent restarted"));
    adv(Duration::from_millis(
        u64::try_from(TASK_END_GRACE_MS).unwrap() + 500,
    ))
    .await;
    assert!(is(&h.last(), WAITING_NONE), "{:?}", h.states());
}

/// F1 — a replaced connection's late close must not stale the new adapter's tasks.
#[tokio::test(start_paused = true)]
async fn replaced_connection_close_does_not_stale_new_adapters_tasks() {
    let mut h = harness(false, Liveness::NoWriter).await;
    let old = h.s.attach_ext_sink_for_test();
    h.s.bump_task_epoch_for_test();
    let new = h.s.attach_ext_sink_for_test();
    h.start_turn().await;
    new.send(task_started()).unwrap();
    io().await;
    drop(old);
    io().await;
    adv(Duration::from_secs(40)).await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Running, "{tasks:?}");
    assert!(is(&h.last(), WORKING_BG), "{:?}", h.states());
    drop(new);
    io().await;
    let (_, tasks) = h.s.task_snapshot().unwrap();
    assert_eq!(tasks[0].state, TaskState::Stale);
}
