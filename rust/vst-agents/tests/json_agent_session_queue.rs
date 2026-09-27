use std::collections::VecDeque;

use vst_agents::json_agent_session::{
    read_transcript_from_data_dir, JsonAgentSession, QueuedTurn,
};
use vst_agents::json_agent_session::queue::ForkResult;
use vst_agents::paths::Paths;

fn make_turn(id: &str, order: u64) -> QueuedTurn {
    QueuedTurn {
        turn_id: id.to_string(),
        enqueue_order: order,
        raw_message: format!("msg-{id}"),
        attachments: vec![],
        fork_from_chat_id: None,
    }
}

#[test]
fn insert_position_empty_ahead_ids_yields_zero() {
    let queue: VecDeque<QueuedTurn> = [make_turn("a", 1), make_turn("b", 2)].into_iter().collect();
    let pos = JsonAgentSession::insert_position_after_ahead_ids(&queue, &[]);
    assert_eq!(pos, 0);
}

#[test]
fn insert_position_all_ahead_yields_end() {
    let queue: VecDeque<QueuedTurn> = [make_turn("a", 1), make_turn("b", 2)].into_iter().collect();
    let pos = JsonAgentSession::insert_position_after_ahead_ids(
        &queue,
        &["a".to_string(), "b".to_string()],
    );
    assert_eq!(pos, 2);
}

#[test]
fn insert_position_partial_ahead_yields_after_last() {
    let queue: VecDeque<QueuedTurn> = [make_turn("a", 1), make_turn("b", 2), make_turn("c", 3)]
        .into_iter()
        .collect();
    // Only "b" was ahead → insert after position 1 (index 2)
    let pos = JsonAgentSession::insert_position_after_ahead_ids(&queue, &["b".to_string()]);
    assert_eq!(pos, 2);
}

#[test]
fn insert_position_stale_ahead_id_ignored() {
    // ahead_ids refers to a turn no longer in the queue → inserts at head
    let queue: VecDeque<QueuedTurn> = [make_turn("c", 3)].into_iter().collect();
    let pos = JsonAgentSession::insert_position_after_ahead_ids(&queue, &["gone".to_string()]);
    assert_eq!(pos, 0);
}

mod common;

use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_agents::json_agent_session::JsonAgentSessionOptions;
use vst_agents::plugin::{
    AgentPlugin, ComposePromptInput, ComposePromptResult, LaunchConfig, ListModelsResult,
    PromptDelivery, ReadySignal, TurnContext, TurnInput,
};
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind, TurnState};

struct MockTurnPlugin;

impl AgentPlugin for MockTurnPlugin {
    fn name(&self) -> &str {
        "mock"
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
        std::collections::BTreeMap::new()
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
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                    let mut ev = NormalizedEvent::default();
                    ev.kind = NormalizedEventKind::Result;
                    let _ = tx.send(ev);
                }
            }
        });
        rx
    }
}

/// A live `MockTurnPlugin` session rooted in a temp home. Returns the temp
/// home guard (kept alive for the test's duration) plus the session.
fn make_mock_session() -> (tempfile::TempDir, vst_agents::home::HomeGuard, JsonAgentSession) {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);

    let session_rec = common::make_session("s1");
    let project_rec = common::make_project("p1");

    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: project_rec,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(MockTurnPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });
    (dir, home, session)
}

#[tokio::test]
async fn test_stop_active_turn_then_enqueue_runs_turn_and_sets_log_seq() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);

    let session_rec = common::make_session("s1");
    let project_rec = common::make_project("p1");

    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: project_rec,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(MockTurnPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });

    let emitted_events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ee = Arc::clone(&emitted_events);
    session.stream().on_message(Box::new(move |ev| {
        ee.lock().unwrap().push(ev.clone());
    }));

    // 1. Enqueue turn 1
    let res1 = session.enqueue("Turn 1".into(), vec![], None, None);
    assert_eq!(res1.queue_position, 0);

    // Wait until turn 1 is active
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;

    // 2. Stop turn 1
    let stopped = session.stop_active_turn(None);
    assert!(stopped);

    // 3. Immediately enqueue turn 2
    let res2 = session.enqueue("Turn 2".into(), vec![], None, None);

    // 4. Wait for session to settle
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.queue_depth == 0 && meta.turn_state != TurnState::Thinking && meta.turn_state != TurnState::Responding {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await;

    let meta = session.get_meta();
    assert_eq!(meta.queue_depth, 0, "Queue must be drained");
    assert_eq!(meta.turn_state, TurnState::Idle);

    // 5. Verify turn 2's user event was persisted with log_seq
    let events = emitted_events.lock().unwrap().clone();
    let turn2_user_ev = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res2.turn_id));
    assert!(turn2_user_ev.is_some(), "Turn 2 user event must be emitted");
    assert!(
        turn2_user_ev.unwrap().log_seq.is_some(),
        "Turn 2 user event MUST have log_seq populated"
    );
}

struct HangingTurnPlugin;

impl AgentPlugin for HangingTurnPlugin {
    fn name(&self) -> &str {
        "hanging-mock"
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
        std::collections::BTreeMap::new()
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
        let (tx, rx) = mpsc::unbounded_channel();
        let message = input.message.clone();
        tokio::spawn(async move {
            if message.starts_with("complete") {
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = tokio::time::sleep(std::time::Duration::from_millis(30)) => {
                        let mut ev = NormalizedEvent::default();
                        ev.kind = NormalizedEventKind::Result;
                        let _ = tx.send(ev);
                    }
                }
            } else {
                // By default, turns only end when cancelled.
                cancel.cancelled().await;
            }
        });
        rx
    }
}

fn make_hanging_session() -> (
    tempfile::TempDir,
    vst_agents::home::HomeGuard,
    JsonAgentSession,
    Arc<std::sync::Mutex<Vec<NormalizedEvent>>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);

    let session_rec = common::make_session("s1");
    let project_rec = common::make_project("p1");

    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: project_rec,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(HangingTurnPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });

    let emitted_events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ee = Arc::clone(&emitted_events);
    session.stream().on_message(Box::new(move |ev| {
        ee.lock().unwrap().push(ev.clone());
    }));

    (dir, home, session, emitted_events)
}

#[tokio::test]
async fn test_stop_specific_turn_writes_turn_stopped() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res = session.enqueue("hanging A".into(), vec![], None, None);

    // Wait until A is running
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    let stopped = session.stop_active_turn(Some(&res.turn_id));
    assert!(stopped);

    // Wait for session to settle
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.active_turn_id.is_none() && meta.turn_state == TurnState::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("session should settle");

    let events = emitted.lock().unwrap().clone();
    let stopped_ev = events.iter().find(|e| {
        e.kind == NormalizedEventKind::Status
            && e.text.as_deref() == Some("Turn stopped")
            && e.turn_id.as_deref() == Some(&res.turn_id)
    });
    assert!(stopped_ev.is_some(), "Must write 'Turn stopped' for A");
}

#[tokio::test]
async fn test_queue_a_and_b_stale_stop_does_not_stop_b() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res_a = session.enqueue("hanging A".into(), vec![], None, None);
    let res_b = session.enqueue("hanging B".into(), vec![], None, None);

    // Wait until A is active
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_a.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    // Stop A
    let stopped_a = session.stop_active_turn(Some(&res_a.turn_id));
    assert!(stopped_a);

    // Wait until activeTurnId == B
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_b.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn B should become active");

    // Stop A again (stale stop click) -> must return false
    let stopped_again = session.stop_active_turn(Some(&res_a.turn_id));
    assert!(!stopped_again, "Stopping A when B is active must return false");

    // B must still be running
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        session.get_meta().active_turn_id.as_deref(),
        Some(res_b.turn_id.as_str()),
        "B must keep running"
    );

    // Verify emitted events: only A has "Turn stopped", B does not
    let events = emitted.lock().unwrap().clone();
    let b_stopped = events.iter().any(|e| {
        e.text.as_deref() == Some("Turn stopped") && e.turn_id.as_deref() == Some(&res_b.turn_id)
    });
    assert!(!b_stopped, "No 'Turn stopped' event should exist for B");

    // Clean up B
    session.stop_active_turn(Some(&res_b.turn_id));
}

#[tokio::test]
async fn test_stop_none_stops_whatever_is_running() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res = session.enqueue("hanging turn".into(), vec![], None, None);

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn should become active");

    let stopped = session.stop_active_turn(None);
    assert!(stopped, "stop(None) must stop active turn");

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            session.settled().await;
            if session.get_meta().active_turn_id.is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn should settle after stop");

    let events = emitted.lock().unwrap().clone();
    assert!(events.iter().any(|e| e.text.as_deref() == Some("Turn stopped")));
}

#[tokio::test]
async fn test_stop_unknown_id_or_idle_returns_false() {
    let (_dir, _home, session, _emitted) = make_hanging_session();

    // Idle
    assert!(!session.stop_active_turn(None));
    assert!(!session.stop_active_turn(Some("unknown-id")));

    // Running turn
    let res = session.enqueue("hanging turn".into(), vec![], None, None);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn should become active");

    assert!(!session.stop_active_turn(Some("nonexistent-turn-id")));
    assert_eq!(session.get_meta().active_turn_id.as_deref(), Some(res.turn_id.as_str()));

    // Cleanup
    session.stop_active_turn(None);
}

#[tokio::test]
async fn test_promote_stops_active_and_runs_promoted_to_completion() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res_a = session.enqueue("hanging A".into(), vec![], None, None);
    let res_x = session.enqueue("complete X".into(), vec![], None, None);

    // Wait until A is active
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_a.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    let promoted = session.promote_queued_turn(&res_x.turn_id);
    assert!(promoted);

    // Wait for session to settle completely
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.queue_depth == 0 && meta.active_turn_id.is_none() && meta.turn_state == TurnState::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("session should settle after promotion");

    let events = emitted.lock().unwrap().clone();
    let a_stopped = events.iter().any(|e| {
        e.text.as_deref() == Some("Turn stopped") && e.turn_id.as_deref() == Some(&res_a.turn_id)
    });
    assert!(a_stopped, "A should have been stopped");

    let x_result = events.iter().any(|e| {
        e.kind == NormalizedEventKind::Result
    });
    assert!(x_result, "X should run to completion and emit Result");
}

#[tokio::test]
async fn test_active_turn_id_lifecycle_and_notice_turn() {
    let (_dir, _home, session, emitted) = make_hanging_session();

    // Idle before run -> active_turn_id is None
    assert_eq!(session.get_meta().active_turn_id, None);

    // During normal run -> active_turn_id is set
    let res = session.enqueue("complete turn".into(), vec![], None, None);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let meta = session.get_meta();
            if meta.active_turn_id.as_deref() == Some(&res.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("active_turn_id should equal turn_id during run");

    // Settled -> active_turn_id is None
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.active_turn_id.is_none() && meta.turn_state == TurnState::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("session should settle");
    assert_eq!(session.get_meta().active_turn_id, None);

    // Notice turn
    let notice_active_id = Arc::new(std::sync::Mutex::new(None));
    let nai = Arc::clone(&notice_active_id);
    let s_clone = session.clone();
    tokio::spawn(async move {
        loop {
            let meta = s_clone.get_meta();
            if let Some(ns) = &meta.notice_slot {
                if ns.running {
                    if let Some(act) = meta.active_turn_id {
                        *nai.lock().unwrap() = Some(act);
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    });

    session.populate_notice_slot("child-1".into(), "Child 1".into());
    session.kick_drain();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if notice_active_id.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("notice turn should become active with active_turn_id");

    let observed_notice_id = notice_active_id.lock().unwrap().clone().unwrap();
    let stopped = session.stop_active_turn(Some(&observed_notice_id));
    assert!(stopped);

    // Verify the synthetic user event emitted for the notice turn has the same turn id
    let events = emitted.lock().unwrap().clone();
    let notice_user_ev = events.iter().find(|e| {
        e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&observed_notice_id)
    });
    assert!(notice_user_ev.is_some(), "Notice turn user event must match active_turn_id");
}

/// Wait (with a bounded timeout) until the session is fully idle: no active
/// turn, empty queue, and turn state Idle. Mirrors the poll-loop pattern the
/// existing tests in this file use — a bare `settled()` can return before the
/// drain has actually flushed all its events, so callers must poll.
async fn wait_idle(session: &JsonAgentSession) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.queue_depth == 0 && meta.active_turn_id.is_none() && meta.turn_state == TurnState::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("session should settle");
}

/// 1.T2 — enqueue one turn, let it drain, and assert the transcript has exactly
/// one `user` event for that turn, with the right text, no edited/cancelled/
/// silent flags, and a real log_seq.
#[tokio::test]
async fn enqueue_then_drain_persists_user_event_after_running_turn() {
    let (_dir, _home, session) = make_mock_session();
    let res = session.enqueue("hello world".into(), vec![], None, None);

    wait_idle(&session).await;

    let events = session.read_transcript();
    let user_events: Vec<&NormalizedEvent> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res.turn_id))
        .collect();
    assert_eq!(
        user_events.len(),
        1,
        "exactly one user event for the turn, got {}",
        user_events.len()
    );
    let ev = user_events[0];
    assert_eq!(ev.text.as_deref(), Some("hello world"), "user event text matches");
    assert_eq!(ev.edited, None, "not an edit");
    assert_eq!(ev.cancelled, None, "not cancelled");
    assert_eq!(ev.silent, None, "not silent");
    assert!(ev.log_seq.is_some(), "user event must have a log_seq");
}

/// 1.T3 — a queued turn's user event log_seq must trail EVERY event of the turn
/// it queued behind (including that turn's "Turn stopped" row).
#[tokio::test]
async fn queued_turn_logseq_trails_active_turns_output() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res_a = session.enqueue("complete A".into(), vec![], None, None);

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_a.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    let res_b = session.enqueue("complete B".into(), vec![], None, None);
    let stopped = session.stop_active_turn(None);
    assert!(stopped, "stop(None) should stop the active turn A");

    wait_idle(&session).await;

    let events = emitted.lock().unwrap().clone();
    let b_user = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_b.turn_id))
        .expect("B must have a user event");
    let b_seq = b_user.log_seq.expect("B user event must have a log_seq");

    let a_events: Vec<&NormalizedEvent> = events
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some(&res_a.turn_id))
        .collect();
    assert!(!a_events.is_empty(), "A must have emitted events");
    for e in &a_events {
        let seq = e.log_seq.expect("every A event must have a log_seq");
        assert!(
            b_seq > seq,
            "B's user log_seq ({b_seq}) must trail every A event's log_seq ({seq})"
        );
    }
}

/// 1.T3b — plain drain-on-idle path (no stop): B's user log_seq must be greater
/// than A's `Result` event log_seq.
#[tokio::test]
async fn queued_turn_logseq_trails_completed_turn_result() {
    let (_dir, _home, session) = make_mock_session();
    let res_a = session.enqueue("complete A".into(), vec![], None, None);

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_a.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    let res_b = session.enqueue("complete B".into(), vec![], None, None);

    wait_idle(&session).await;

    let events = session.read_transcript();
    let a_result = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::Result && e.turn_id.as_deref() == Some(&res_a.turn_id))
        .expect("A must emit a Result event");
    let b_user = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_b.turn_id))
        .expect("B must emit a user event");
    let a_seq = a_result.log_seq.expect("A Result event must have a log_seq");
    let b_seq = b_user.log_seq.expect("B user event must have a log_seq");
    assert!(
        b_seq > a_seq,
        "B's user log_seq ({b_seq}) must be greater than A's Result log_seq ({a_seq})"
    );
}

/// 1.T4 — a promoted turn's user log_seq must be greater than the stopped turn's
/// "Turn stopped" row log_seq.
#[tokio::test]
async fn promoted_turn_logseq_trails_stopped_active_turn() {
    let (_dir, _home, session, emitted) = make_hanging_session();
    let res_a = session.enqueue("hanging A".into(), vec![], None, None);
    let res_x = session.enqueue("complete X".into(), vec![], None, None);

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if session.get_meta().active_turn_id.as_deref() == Some(&res_a.turn_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn A should become active");

    let promoted = session.promote_queued_turn(&res_x.turn_id);
    assert!(promoted, "promote should succeed");

    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            session.settled().await;
            let meta = session.get_meta();
            if meta.queue_depth == 0 && meta.active_turn_id.is_none() && meta.turn_state == TurnState::Idle {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("session should settle after promotion");

    let events = emitted.lock().unwrap().clone();
    let a_stopped = events
        .iter()
        .find(|e| {
            e.kind == NormalizedEventKind::Status
                && e.text.as_deref() == Some("Turn stopped")
                && e.turn_id.as_deref() == Some(&res_a.turn_id)
        })
        .expect("A must have a 'Turn stopped' event");
    let a_seq = a_stopped.log_seq.expect("A stopped event must have a log_seq");

    let x_user = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_x.turn_id))
        .expect("X must have a user event");
    let x_seq = x_user.log_seq.expect("X user event must have a log_seq");
    assert!(
        x_seq > a_seq,
        "X's user log_seq ({x_seq}) must be greater than A's 'Turn stopped' log_seq ({a_seq})"
    );
}

/// 1.T8 — forking a completed turn defers the forked turn's persistence until it
/// runs, like a normal queued turn.
#[tokio::test]
async fn fork_turn_inherits_deferred_persistence() {
    let (_dir, _home, session) = make_mock_session();
    let res = session.enqueue("turn 1".into(), vec![], None, None);

    wait_idle(&session).await;

    let ForkResult::Ok { turn_id: fork_id, .. } = session.fork_turn(&res.turn_id, "forked msg".into(), vec![])
    else {
        panic!("fork_turn should succeed on a completed turn");
    };

    let before = session.read_transcript();
    assert!(
        !before
            .iter()
            .any(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&fork_id)),
        "forked turn must not be persisted immediately after fork_turn returns"
    );

    wait_idle(&session).await;

    let after = session.read_transcript();
    assert!(
        after
            .iter()
            .any(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&fork_id)),
        "forked turn must be persisted once it runs"
    );
}

/// 1.T9 — release() persists a `cancelled` user event (with original text and a
/// real log_seq) for every still-queued/held turn BEFORE the released latch goes
/// up. Goes through the real `release()` path so a latch-ordering regression
/// would be caught.
#[tokio::test]
async fn release_persists_cancelled_for_dropped_queue_and_holds() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);

    let session_rec = common::make_session("s1");
    let project_rec = common::make_project("p1");
    let data_dir = Paths::default().direct_session_data_dir("p1", "s1");

    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: project_rec,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(MockTurnPlugin),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });

    // Enqueue A and B with nothing running and no `.await` between the two calls,
    // so both land in `s.queue` before the drain task ever gets scheduled.
    let res_a = session.enqueue("msg A".into(), vec![], None, None);
    let res_b = session.enqueue("msg B".into(), vec![], None, None);

    assert!(
        session.get_meta().queued_turn_ids.contains(&res_a.turn_id),
        "A must be queued"
    );
    assert!(
        session.get_meta().queued_turn_ids.contains(&res_b.turn_id),
        "B must be queued"
    );

    // Move B into the edit hold.
    session.begin_edit_queued_turn(&res_b.turn_id);

    session.release().await;

    let events = read_transcript_from_data_dir(&data_dir, "s1");
    for (turn_id, text) in [(&res_a.turn_id, "msg A"), (&res_b.turn_id, "msg B")] {
        let ev = events
            .iter()
            .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(turn_id))
            .unwrap_or_else(|| panic!("turn {text} should have a persisted user event"));
        assert_eq!(ev.text.as_deref(), Some(text), "text must survive for {text}");
        assert_eq!(ev.cancelled, Some(true), "{text} must be cancelled");
        assert!(ev.log_seq.is_some(), "{text} must have a log_seq");
    }
}

/// 1.T10 — forking a completed turn must NOT drop an unrun turn that's parked in
/// the edit hold.
#[tokio::test]
async fn fork_while_held_turn_survives() {
    let (_dir, _home, session) = make_mock_session();
    let first = session.enqueue("first".into(), vec![], None, None);

    wait_idle(&session).await;

    // Enqueue a second turn and immediately (no `.await`) park it in the hold.
    let held = session.enqueue("held".into(), vec![], None, None);
    session.begin_edit_queued_turn(&held.turn_id);

    assert!(
        session.get_meta().editing_turn_ids.contains(&held.turn_id),
        "held turn must be in the edit hold before forking"
    );

    let ForkResult::Ok { .. } = session.fork_turn(&first.turn_id, "forked".into(), vec![]) else {
        panic!("fork_turn should succeed on the completed first turn");
    };

    assert!(
        session.get_meta().editing_turn_ids.contains(&held.turn_id),
        "held turn must survive the fork (a fork must not drop an unrun held turn)"
    );
}
