//! Lifecycle writer contract for JSON sessions (task-tray 1a): the notice turn
//! writes `working`, out-of-band content opens/settles a background window,
//! and every write is serialised through `lifecycle_lock`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, SessionUpdate, TextContent, ToolCallId, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields,
};
use tokio::sync::{broadcast, mpsc, Notify};
use tokio_util::sync::CancellationToken;
use vst_agents::json_agent_chat::{
    BACKGROUND_REASON, BACKGROUND_SETTLED_REASON, SUBAGENT_NOTICE_REASON,
};
use vst_agents::json_agent_session::boot_sweep::sweep_stale_background_working;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_store::StoreHandle;
use vst_types::{
    Broadcaster, Channel, LifecycleState, NormalizedEvent, NormalizedEventKind, ServerEvent,
    SessionLifecycle, SessionRecord,
};

const PROJECT_ID: &str = "p1";
const SESSION_ID: &str = "s1";

/// Plugin whose turn waits for `gate` before emitting `result`.
struct GatedPlugin {
    gate: Arc<Notify>,
}

impl AgentPlugin for GatedPlugin {
    fn name(&self) -> &str {
        "gated"
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
    fn run_turn(
        &self,
        _input: TurnInput,
        _ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let gate = self.gate.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = gate.notified() => {
                    let mut ev = NormalizedEvent::default();
                    ev.kind = NormalizedEventKind::Result;
                    let _ = tx.send(ev);
                }
            }
        });
        rx
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    _home: vst_agents::home::HomeGuard,
    session: JsonAgentSession,
    store: StoreHandle,
    broadcaster: Broadcaster,
    rx: broadcast::Receiver<ServerEvent>,
    gate: Arc<Notify>,
}

fn direct_session(id: &str, state: LifecycleState, reason: Option<&str>) -> SessionRecord {
    let mut s = common::make_session(id);
    s.project_id = PROJECT_ID.into();
    s.lifecycle = SessionLifecycle {
        state,
        reason: reason.map(str::to_string),
        last_transition_at: "2026-01-01T00:00:00.000Z".into(),
    };
    s
}

async fn harness(initial: LifecycleState) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut project = common::make_project(PROJECT_ID);
    let session_rec = direct_session(SESSION_ID, initial, None);
    project.direct_sessions.push(session_rec.clone());
    store.add_project(project.clone()).await.unwrap();
    let (tx, rx) = broadcast::channel(256);
    let broadcaster = Broadcaster(tx);
    let gate = Arc::new(Notify::new());
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(GatedPlugin { gate: gate.clone() }),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle: store.clone(),
        broadcaster: broadcaster.clone(),
    });
    Harness {
        _dir: dir,
        _home: home,
        session,
        store,
        broadcaster,
        rx,
        gate,
    }
}

type StateEvent = (LifecycleState, Option<String>);

impl Harness {
    /// Drain every `SessionState` broadcast so far (this session only).
    fn states(&mut self) -> Vec<StateEvent> {
        let mut out = vec![];
        while let Ok(ev) = self.rx.try_recv() {
            if let ServerEvent::SessionState {
                session_id,
                state,
                reason,
            } = ev
            {
                if session_id == SESSION_ID {
                    out.push((state, reason));
                }
            }
        }
        out
    }

    async fn stored(&self) -> (LifecycleState, Option<String>) {
        let (_, s) = self.store.find_session(SESSION_ID).await.unwrap();
        (s.lifecycle.state, s.lifecycle.reason)
    }
}

fn st(state: LifecycleState, reason: Option<&str>) -> StateEvent {
    (state, reason.map(str::to_string))
}

fn chunk(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        text,
    ))))
}

fn heartbeat() -> SessionUpdate {
    SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
        ToolCallId::new("t1"),
        ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
    ))
}

/// Give spawned writes (blocking SQLite) time to land without advancing the
/// virtual clock by more than a few ms.
async fn io() {
    for _ in 0..40 {
        tokio::time::advance(Duration::from_millis(1)).await;
        std::thread::sleep(Duration::from_millis(2));
    }
}

async fn advance_secs(s: u64) {
    tokio::time::advance(Duration::from_secs(s)).await;
    io().await;
}

async fn real_wait_idle(session: &JsonAgentSession) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            session.settled().await;
            if session.get_meta().active_turn_id.is_none() {
                tokio::time::sleep(Duration::from_millis(30)).await;
                if session.is_settled() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("settle");
}

/// 1.T1 — a notice turn writes `working(subagent-notice)`, the store row is
/// `working` mid-turn, and the drain's final write is `waiting_for_human`.
#[tokio::test]
async fn notice_turn_writes_working_then_waiting() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .populate_notice_slot("child-1".into(), "Child 1".into());
    h.session.kick_drain();

    tokio::time::timeout(Duration::from_secs(3), async {
        while h.session.get_meta().active_turn_id.is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("notice turn active");
    assert_eq!(
        h.stored().await,
        (
            LifecycleState::Working,
            Some(SUBAGENT_NOTICE_REASON.to_string())
        )
    );

    h.gate.notify_one();
    real_wait_idle(&h.session).await;
    assert_eq!(
        h.states(),
        vec![
            st(LifecycleState::Working, Some(SUBAGENT_NOTICE_REASON)),
            st(LifecycleState::WaitingForHuman, None),
        ]
    );
    assert_eq!(h.stored().await, (LifecycleState::WaitingForHuman, None));
}

/// 1.T2 — OOB text opens a background window; 59 s still working; 61 s quiet
/// settles; new content extends; heartbeats extend only within the cap.
#[tokio::test(start_paused = true)]
async fn out_of_band_window_opens_extends_and_settles() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .ingest_out_of_band_update(&chunk("a"), "acp", None);
    io().await;
    assert_eq!(
        h.states(),
        vec![st(LifecycleState::Working, Some(BACKGROUND_REASON))]
    );
    assert_eq!(
        h.stored().await,
        (LifecycleState::Working, Some(BACKGROUND_REASON.into()))
    );
    // turn_state is never touched by the background window.
    assert_eq!(h.session.get_meta().turn_state, vst_types::TurnState::Idle);

    advance_secs(50).await;
    assert!(h.states().is_empty(), "still working at ~50 s");
    // New content at ~50 s re-arms: would otherwise settle at 60 s.
    h.session
        .ingest_out_of_band_update(&chunk("b"), "acp", None);
    advance_secs(55).await;
    assert!(h.states().is_empty(), "re-armed: still working at ~105 s");
    advance_secs(10).await;
    assert_eq!(
        h.states(),
        vec![st(
            LifecycleState::WaitingForHuman,
            Some(BACKGROUND_SETTLED_REASON)
        )]
    );
    assert_eq!(
        h.stored().await,
        (
            LifecycleState::WaitingForHuman,
            Some(BACKGROUND_SETTLED_REASON.into())
        )
    );
}

#[tokio::test(start_paused = true)]
async fn heartbeats_extend_until_cap_then_settle() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .ingest_out_of_band_update(&chunk("a"), "acp", None);
    io().await;
    h.states();
    // Heartbeat every 30 s for 9 minutes: window stays open (cap is 10 min).
    for _ in 0..18 {
        advance_secs(30).await;
        h.session
            .ingest_out_of_band_update(&heartbeat(), "acp", None);
    }
    io().await;
    assert!(h.states().is_empty(), "heartbeats keep the window open");
    // Past the cap, heartbeats no longer extend: settles one quiet gap later.
    for _ in 0..4 {
        advance_secs(30).await;
        h.session
            .ingest_out_of_band_update(&heartbeat(), "acp", None);
    }
    advance_secs(61).await;
    assert_eq!(
        h.states(),
        vec![st(
            LifecycleState::WaitingForHuman,
            Some(BACKGROUND_SETTLED_REASON)
        )]
    );
}

/// 1.T3 — a drain starting mid-window invalidates the timer: nothing is
/// written by the timer while running, and exactly one Waiting follows.
#[tokio::test]
async fn kick_drain_mid_background_invalidates_timer() {
    tokio::time::pause();
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .ingest_out_of_band_update(&chunk("a"), "acp", None);
    io().await;
    h.states();

    h.session.enqueue("hello".into(), vec![], None, None);
    io().await;
    h.session.write_working_for_human_turn().await;
    assert_eq!(h.states(), vec![st(LifecycleState::Working, None)]);

    // Timer deadline passes while the turn is still running.
    advance_secs(90).await;
    assert!(h.states().is_empty(), "timer must not write while running");

    h.gate.notify_one();
    io().await;
    tokio::time::resume();
    real_wait_idle(&h.session).await;
    assert_eq!(h.states(), vec![st(LifecycleState::WaitingForHuman, None)]);
}

/// 1.T4 — events 45 s apart share one burst (gap is now 90 s).
#[tokio::test]
async fn burst_gap_is_90s() {
    let h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .ingest_out_of_band_update(&chunk("a"), "acp", None);
    // Pretend the last event was 45 s ago (wall clock).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    h.session.set_out_of_band_last_at_ms_for_test(now - 45_000);
    h.session
        .ingest_out_of_band_update(&chunk("b"), "acp", None);
    let rows = h.session.read_transcript();
    let statuses = rows
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Status)
        .count();
    assert_eq!(statuses, 1, "one burst marker for events 45 s apart");
    let turns: std::collections::HashSet<_> =
        rows.iter().filter_map(|e| e.turn_id.clone()).collect();
    assert_eq!(turns.len(), 1);
    // And >90 s starts a new burst.
    h.session.set_out_of_band_last_at_ms_for_test(now - 100_000);
    h.session
        .ingest_out_of_band_update(&chunk("c"), "acp", None);
    let statuses = h
        .session
        .read_transcript()
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Status)
        .count();
    assert_eq!(statuses, 2);
}

/// 1.T7 — OOB content between `running=false` and the drain's final write
/// keeps `working(background)`; the quiet timer then settles.
#[tokio::test(start_paused = true)]
async fn oob_during_drain_tail_keeps_background_working() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session.enqueue("hi".into(), vec![], None, None);
    io().await;
    h.session.write_working_for_human_turn().await;
    h.states();
    // Finish the turn; OOB content lands right as the drain unwinds. Because
    // the OOB handler ignores events while `running`, emulate the window by
    // sending content immediately after the gate opens and after io().
    h.gate.notify_one();
    io().await;
    h.session
        .ingest_out_of_band_update(&chunk("late"), "acp", None);
    io().await;
    let seen = h.states();
    // Whatever interleaving happened, the LAST word must be working(background)
    // or the drain's Waiting followed by a re-written Working(background).
    // (The deterministic tail-window sequence, plain waiting BEFORE
    // working(background), is pinned in `drain.rs`'s unit test, R1F-12.)
    assert_eq!(
        seen.last(),
        Some(&st(LifecycleState::Working, Some(BACKGROUND_REASON))),
        "got {seen:?}"
    );
    advance_secs(61).await;
    assert_eq!(
        h.states().last(),
        Some(&st(
            LifecycleState::WaitingForHuman,
            Some(BACKGROUND_SETTLED_REASON)
        ))
    );
}

/// 1.T8a — OOB racing a mark-done (`release()` then a Done write) never
/// resurrects the session: nothing is written after release.
#[tokio::test(start_paused = true)]
async fn release_beats_background_writes() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.session
        .ingest_out_of_band_update(&chunk("a"), "acp", None);
    h.session.release().await;
    io().await;
    h.states();
    // mark-done writes straight to the store after release.
    h.store
        .update_session_lifecycle(
            PROJECT_ID,
            SESSION_ID,
            SessionLifecycle {
                state: LifecycleState::Done,
                reason: None,
                last_transition_at: "2026-01-02T00:00:00.000Z".into(),
            },
        )
        .await
        .unwrap();
    h.session
        .ingest_out_of_band_update(&chunk("b"), "acp", None);
    advance_secs(120).await;
    assert!(h.states().is_empty(), "released session writes nothing");
    assert_eq!(h.stored().await.0, LifecycleState::Done);
}

/// 1.T8b — a turn that already finished before the caller's
/// `write_working_for_human_turn` keeps `waiting_for_human`.
#[tokio::test]
async fn late_human_working_is_skipped_after_turn_finished() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.gate.notify_one(); // turn completes immediately
    h.session.enqueue("fast".into(), vec![], None, None);
    real_wait_idle(&h.session).await;
    h.states();
    h.session.write_working_for_human_turn().await;
    assert!(h.states().is_empty(), "late Working must be skipped");
    assert_eq!(h.stored().await.0, LifecycleState::WaitingForHuman);
}

/// 1.T9 — boot sweep settles background / notice `working` rows only.
#[tokio::test]
async fn boot_sweep_settles_stale_background_working() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("t.db")).unwrap();
    let mut project = common::make_project(PROJECT_ID);
    project.direct_sessions = vec![
        direct_session("bg", LifecycleState::Working, Some("background")),
        direct_session("notice", LifecycleState::Working, Some("subagent-notice")),
        direct_session("plain", LifecycleState::Working, None),
        direct_session(
            "waiting",
            LifecycleState::WaitingForHuman,
            Some("background-settled"),
        ),
        {
            let mut s = direct_session("tmux", LifecycleState::Working, Some("background"));
            s.channel = Some(Channel::Tmux);
            s
        },
    ];
    store.add_project(project).await.unwrap();
    let (tx, mut rx) = broadcast::channel(64);
    let n = sweep_stale_background_working(&store, &Broadcaster(tx)).await;
    assert_eq!(n, 2);

    let state_of = |id: &str| {
        let store = store.clone();
        let id = id.to_string();
        async move {
            let (_, s) = store.find_session(&id).await.unwrap();
            (s.lifecycle.state, s.lifecycle.reason)
        }
    };
    for id in ["bg", "notice"] {
        assert_eq!(
            state_of(id).await,
            (
                LifecycleState::WaitingForHuman,
                Some(BACKGROUND_SETTLED_REASON.into())
            )
        );
    }
    assert_eq!(state_of("plain").await, (LifecycleState::Working, None));
    assert_eq!(
        state_of("tmux").await,
        (LifecycleState::Working, Some("background".into()))
    );
    let mut ids = vec![];
    while let Ok(ServerEvent::SessionState { session_id, .. }) = rx.try_recv() {
        ids.push(session_id);
    }
    ids.sort();
    assert_eq!(ids, vec!["bg".to_string(), "notice".to_string()]);
}

/// 1.T17 — a straggler update after a turn ended looks like an OOB cycle:
/// `working(background)` then a settle after the quiet gap (pins K12).
#[tokio::test(start_paused = true)]
async fn straggler_after_turn_end_settles_after_quiet_gap() {
    let mut h = harness(LifecycleState::WaitingForHuman).await;
    h.gate.notify_one();
    h.session.enqueue("t".into(), vec![], None, None);
    h.session.write_working_for_human_turn().await;
    io().await;
    h.states();
    h.session
        .ingest_out_of_band_update(&chunk("straggler"), "acp", None);
    io().await;
    assert_eq!(
        h.states().last(),
        Some(&st(LifecycleState::Working, Some(BACKGROUND_REASON)))
    );
    advance_secs(61).await;
    assert_eq!(
        h.states(),
        vec![st(
            LifecycleState::WaitingForHuman,
            Some(BACKGROUND_SETTLED_REASON)
        )]
    );
    let _ = &h.broadcaster;
}

/// 1.T6 — R9 prune at notice-turn run time: a child in `working(background)`
/// still counts as waiting; a child in plain `working` is dropped.
#[tokio::test]
async fn notice_prune_keeps_background_working_child_only() {
    let h = harness(LifecycleState::WaitingForHuman).await;
    h.store
        .mutate_project(PROJECT_ID, |p| {
            p.direct_sessions.push(direct_session(
                "kid1",
                LifecycleState::Working,
                Some(BACKGROUND_REASON),
            ));
            p.direct_sessions
                .push(direct_session("kid2", LifecycleState::Working, None));
            Ok(p.clone())
        })
        .await
        .unwrap();
    h.session
        .populate_notice_slot("kid1".into(), "Kid One".into());
    h.session
        .populate_notice_slot("kid2".into(), "Kid Two".into());
    h.session.kick_drain();
    tokio::time::timeout(Duration::from_secs(3), async {
        while h.session.get_meta().active_turn_id.is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("notice turn active");
    let row = h
        .session
        .read_transcript()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.silent == Some(true))
        .expect("silent notice row");
    assert_eq!(
        row.text.as_deref(),
        Some("Kid One is waiting for your reply")
    );
    h.gate.notify_one();
    real_wait_idle(&h.session).await;
}
