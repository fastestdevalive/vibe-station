use std::collections::VecDeque;

use vst_agents::json_agent_session::queue::ForkResult;
use vst_agents::json_agent_session::{read_transcript_from_data_dir, JsonAgentSession, QueuedTurn};
use vst_agents::paths::Paths;

fn make_turn(id: &str, order: u64) -> QueuedTurn {
    QueuedTurn {
        turn_id: id.to_string(),
        enqueue_order: order,
        raw_message: format!("msg-{id}"),
        attachments: vec![],
        fork_from_chat_id: None,
        silent: false,
        mentions: vec![],
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
fn make_mock_session() -> (
    tempfile::TempDir,
    vst_agents::home::HomeGuard,
    JsonAgentSession,
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
            if meta.queue_depth == 0
                && meta.turn_state != TurnState::Thinking
                && meta.turn_state != TurnState::Responding
            {
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
    let turn2_user_ev = events.iter().find(|e| {
        e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res2.turn_id)
    });
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
    assert!(
        !stopped_again,
        "Stopping A when B is active must return false"
    );

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
    assert!(events
        .iter()
        .any(|e| e.text.as_deref() == Some("Turn stopped")));
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
    assert_eq!(
        session.get_meta().active_turn_id.as_deref(),
        Some(res.turn_id.as_str())
    );

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
            if meta.queue_depth == 0
                && meta.active_turn_id.is_none()
                && meta.turn_state == TurnState::Idle
            {
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

    let x_result = events.iter().any(|e| e.kind == NormalizedEventKind::Result);
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
    assert!(
        notice_user_ev.is_some(),
        "Notice turn user event must match active_turn_id"
    );
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
            if meta.queue_depth == 0
                && meta.active_turn_id.is_none()
                && meta.turn_state == TurnState::Idle
            {
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
        .filter(|e| {
            e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res.turn_id)
        })
        .collect();
    assert_eq!(
        user_events.len(),
        1,
        "exactly one user event for the turn, got {}",
        user_events.len()
    );
    let ev = user_events[0];
    assert_eq!(
        ev.text.as_deref(),
        Some("hello world"),
        "user event text matches"
    );
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
        .find(|e| {
            e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_b.turn_id)
        })
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
        .find(|e| {
            e.kind == NormalizedEventKind::Result && e.turn_id.as_deref() == Some(&res_a.turn_id)
        })
        .expect("A must emit a Result event");
    let b_user = events
        .iter()
        .find(|e| {
            e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_b.turn_id)
        })
        .expect("B must emit a user event");
    let a_seq = a_result
        .log_seq
        .expect("A Result event must have a log_seq");
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
            if meta.queue_depth == 0
                && meta.active_turn_id.is_none()
                && meta.turn_state == TurnState::Idle
            {
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
    let a_seq = a_stopped
        .log_seq
        .expect("A stopped event must have a log_seq");

    let x_user = events
        .iter()
        .find(|e| {
            e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res_x.turn_id)
        })
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

    let ForkResult::Ok {
        turn_id: fork_id, ..
    } = session.fork_turn(&res.turn_id, "forked msg".into(), vec![])
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
        assert_eq!(
            ev.text.as_deref(),
            Some(text),
            "text must survive for {text}"
        );
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

// ---------------------------------------------------------------------------
// Steer-on-ready: a queued turn is steered once the running turn's prompt is
// dispatched (real `run_turn_acp` + `fakeAcpAgent.mjs` `steering_strict`).
// ---------------------------------------------------------------------------

/// Plugin driving the REAL shared `run_turn_acp` against the fake agent, with
/// steering trusted. `env` configures the fixture's `steering_strict` mode.
struct SteerPlugin {
    env: std::collections::HashMap<String, String>,
}

impl AgentPlugin for SteerPlugin {
    fn name(&self) -> &str {
        "steer-mock"
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
    fn supports_mid_turn_steering(&self) -> bool {
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
        env.insert("FAKE_ACP_MODE".into(), "steering_strict".into());
        let spec = vst_agents::acp_connection::AcpLaunchSpec {
            command: "node".to_string(),
            args: vec![format!(
                "{}/tests/fixtures/fakeAcpAgent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            cwd: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            env,
            initialize_timeout_ms: None,
            prompt_timeout_ms: None,
            reap_detached_descendants: false,
            open_tool_idle_timeout_ms: None,
        };
        let params = vst_agents::acp_run_turn::RunTurnAcpParams {
            provider: vst_types::NormalizedEventProvider::Claude,
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

struct SteerHarness {
    _dir: tempfile::TempDir,
    _home: vst_agents::home::HomeGuard,
    session: JsonAgentSession,
    steer_log: std::path::PathBuf,
}

impl SteerHarness {
    fn new(extra_env: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = vst_agents::home::with_home(dir.path().to_path_buf());
        let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let steer_log = dir.path().join("steer.log");
        let mut env: std::collections::HashMap<String, String> = extra_env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        env.insert("STEER_OUT_FILE".into(), steer_log.display().to_string());
        let session = JsonAgentSession::new(JsonAgentSessionOptions {
            project: common::make_project("p1"),
            worktree: None,
            session: common::make_session("s1"),
            plugin: Arc::new(SteerPlugin { env }),
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle,
            broadcaster: vst_types::Broadcaster(tx),
        });
        Self {
            _dir: dir,
            _home: home,
            session,
            steer_log,
        }
    }

    fn steered(&self) -> Vec<String> {
        std::fs::read_to_string(&self.steer_log)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Run a first (fast) turn to completion so later turns may steer.
    async fn finish_first_turn(&self) {
        self.session.enqueue("first".into(), vec![], None, None);
        wait_idle(&self.session).await;
    }

    /// Wait until the running turn's prompt is in flight (`can_steer`).
    async fn wait_dispatched(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while self.session.get_meta().can_steer != Some(true) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("prompt should be dispatched");
    }

    fn user_events(&self, turn_id: &str) -> Vec<NormalizedEvent> {
        self.session
            .read_transcript()
            .into_iter()
            .filter(|e| {
                e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(turn_id)
            })
            .collect()
    }
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// A message queued behind a running turn is steered right after dispatch (not
/// at turn end), keeps its queued `turn_id`, and gets exactly one user row.
#[tokio::test]
async fn queued_head_is_steered_after_prompt_dispatch() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "1500")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    // Queued before the prompt exists: cannot steer yet.
    let q = h.session.enqueue("three".into(), vec![], None, None);
    assert!(h.session.get_meta().can_steer != Some(true) || h.steered().is_empty());

    h.wait_dispatched().await;
    sleep_ms(300).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    let meta = h.session.get_meta();
    assert_eq!(meta.queue_depth, 0, "head left the queue once injected");
    assert!(meta.active_turn_id.is_some(), "turn two is still running");
    let rows = h.user_events(&q.turn_id);
    assert_eq!(rows.len(), 1, "one user row under the queued turn_id");
    assert_eq!(rows[0].text.as_deref(), Some("three"));
    h.session.abort_and_drain();
}

/// A steered head is delivered as plain text (un-escaped once); the user row
/// keeps the wire form.
#[tokio::test]
async fn steered_head_is_unescaped_but_echo_stays_wire_form() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "1500")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    let wire = r"C:\\temp \{a} \d";
    let q = h.session.enqueue(wire.into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(300).await;
    assert_eq!(h.steered(), vec![r"C:\temp {a} \d".to_string()]);
    let rows = h.user_events(&q.turn_id);
    assert_eq!(rows[0].text.as_deref(), Some(wire));
    h.session.abort_and_drain();
}

/// Instant steer (`submit`, empty queue) delivers plain text; the echoed row
/// stays wire form.
#[tokio::test]
async fn submit_instant_steer_is_unescaped_but_echo_stays_wire_form() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "1500")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    h.wait_dispatched().await;
    let wire = r"C:\\temp \{a}";
    let r = h.session.submit(wire.into(), vec![], None, None).await;
    assert!(matches!(
        r.delivery,
        vst_agents::json_agent_session::queue::SubmitDelivery::Steered
    ));
    assert_eq!(h.steered(), vec![r"C:\temp {a}".to_string()]);
    let rows = h.user_events(&r.turn_id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text.as_deref(), Some(wire));
    h.session.abort_and_drain();
}

/// A message carrying a RESOLVABLE skill token is never steered raw: it falls
/// through to the queue so the drain resolves it.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn submit_with_resolvable_skill_token_is_queued_not_steered_raw() {
    let _catalog = vst_agents::skill_resolution::with_skill_catalog_test_guard();
    let skills = tempfile::tempdir().unwrap();
    let skill_dir = skills.path().join("review");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: review\ndescription: d\n---\nbody\n",
    )
    .unwrap();
    vst_agents::skill_resolution::set_skill_paths(&[skills.path().display().to_string()]).await;

    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "800")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    h.wait_dispatched().await;
    let r = h
        .session
        .submit(r"{/review a\}b}".into(), vec![], None, None)
        .await;
    assert!(matches!(
        r.delivery,
        vst_agents::json_agent_session::queue::SubmitDelivery::Queued
    ));
    sleep_ms(250).await;
    assert!(
        h.steered().is_empty(),
        "skill token must not be steered raw"
    );
    h.session.abort_and_drain();
    drop(h);
    vst_agents::skill_resolution::reset_skill_catalog_for_tests();
}

/// File-only mentions add no `[Mentions:]` block, so they may steer; a
/// non-file mention keeps the head queued.
#[tokio::test]
async fn file_mention_steers_but_agent_mention_stays_queued() {
    let mention = |kind| vst_types::Mention {
        kind,
        id: "x".into(),
        label: "x".into(),
    };
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "1500")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    h.session.enqueue_with(
        "three".into(),
        vec![],
        vec![mention(vst_types::MentionKind::File)],
        None,
        None,
    );
    h.wait_dispatched().await;
    sleep_ms(300).await;
    assert_eq!(h.steered(), vec!["three".to_string()]);
    h.session.abort_and_drain();
    drop(h);

    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "800")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    h.session.enqueue_with(
        "agent".into(),
        vec![],
        vec![mention(vst_types::MentionKind::Agent)],
        None,
        None,
    );
    h.wait_dispatched().await;
    sleep_ms(250).await;
    assert!(h.steered().is_empty());
    assert_eq!(h.session.get_meta().queue_depth, 1);
    h.session.abort_and_drain();
}

/// The very first turn of a session never steers (`first_turn_done` is false;
/// the steer RPC is not even attempted): the queued message stays queued, then
/// runs at turn end exactly once (never lost, never duplicated).
#[tokio::test]
async fn first_ever_turn_never_steers_and_queue_runs_fifo() {
    let h = SteerHarness::new(&[("STEER_FIRST_MS", "300"), ("STEER_PROMPT_MS", "50")]);
    h.session.enqueue("one".into(), vec![], None, None);
    let q = h.session.enqueue("two".into(), vec![], None, None);
    sleep_ms(200).await;
    assert!(h.steered().is_empty(), "first turn must not steer");
    assert_eq!(h.session.get_meta().queue_depth, 1);
    wait_idle(&h.session).await;
    assert!(h.steered().is_empty());
    assert_eq!(h.user_events(&q.turn_id).len(), 1);
}

/// Attachments and fork turns are not text-steerable: the head stays queued.
#[tokio::test]
async fn attachment_and_fork_heads_stay_queued() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "800")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let att = vst_types::Attachment {
        id: "a".into(),
        name: "a.txt".into(),
        path: "/tmp/a.txt".into(),
        size: 1,
        mime: "text/plain".into(),
    };
    h.session.enqueue("with-att".into(), vec![att], None, None);
    h.wait_dispatched().await;
    sleep_ms(250).await;
    assert!(h.steered().is_empty());
    assert_eq!(h.session.get_meta().queue_depth, 1);
    h.session.abort_and_drain();
    // `with_home` is process-global: release the first harness's guard first.
    drop(h);

    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "800")]);
    h.finish_first_turn().await;
    h.session.enqueue("two".into(), vec![], None, None);
    h.session
        .enqueue("fork".into(), vec![], None, Some("chat-x".into()));
    h.wait_dispatched().await;
    sleep_ms(250).await;
    assert!(h.steered().is_empty());
    assert_eq!(h.session.get_meta().queue_depth, 1);
    h.session.abort_and_drain();
}

/// Stop (cancel) while the steer RPC is in flight: the RPC outcome is still
/// awaited, so the message the agent received is delivered exactly once and
/// the head is NOT re-run as a fresh turn.
#[tokio::test]
async fn cancel_during_steer_rpc_delivers_exactly_once() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000"), ("STEER_DELAY_MS", "800")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let q = h.session.enqueue("three".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(100).await; // steer RPC now parked in the fake agent
    assert!(h.session.stop_active_turn(None));
    wait_idle(&h.session).await;
    sleep_ms(300).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    assert_eq!(h.user_events(&q.turn_id).len(), 1, "no fresh re-run");
    assert_eq!(h.session.get_meta().queue_depth, 0);
}

/// Promote (send-now) of the head during the steer RPC: still delivered
/// exactly once, never re-run as its own turn.
#[tokio::test]
async fn promote_during_steer_rpc_delivers_exactly_once() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000"), ("STEER_DELAY_MS", "800")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let q3 = h.session.enqueue("three".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(100).await;
    assert!(h.session.promote_queued_turn(&q3.turn_id));
    wait_idle(&h.session).await;
    sleep_ms(300).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    assert_eq!(h.user_events(&q3.turn_id).len(), 1, "no fresh re-run");
    assert_eq!(h.session.get_meta().queue_depth, 0);
}

/// abort_and_drain during the steer RPC: the agent still got the text, so its
/// user row is emitted after `Injected` and the queue stays empty.
#[tokio::test]
async fn abort_during_steer_rpc_still_emits_delivered_row() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000"), ("STEER_DELAY_MS", "800")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let q = h.session.enqueue("three".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(100).await;
    h.session.abort_and_drain();
    sleep_ms(1200).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    assert_eq!(h.user_events(&q.turn_id).len(), 1);
    assert_eq!(h.session.get_meta().queue_depth, 0);
}

/// Cancel / edit of the head while its steer RPC is in flight are refused
/// (same as an unknown id) — they must not succeed and then be delivered.
#[tokio::test]
async fn cancel_and_edit_of_head_during_steer_rpc_are_not_found() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000"), ("STEER_DELAY_MS", "800")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let q = h.session.enqueue("three".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(100).await;
    assert!(!h.session.cancel_queued_turn(&q.turn_id));
    assert!(h.session.begin_edit_queued_turn(&q.turn_id).is_none());
    assert!(!h
        .session
        .resubmit_queued_turn(&q.turn_id, "x".into(), vec![], vec![], true));
    sleep_ms(1000).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    let rows = h.user_events(&q.turn_id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].text.as_deref(), Some("three"));
    h.session.abort_and_drain();
}

/// A `promptRequired` answer (prompt not yet written) is retried, so the head
/// is still steered rather than waiting for turn end.
#[tokio::test]
async fn steer_retries_prompt_required_then_injects() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000"), ("STEER_REJECT_FIRST", "2")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let q = h.session.enqueue("three".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(600).await;

    assert_eq!(h.steered(), vec!["three".to_string()]);
    assert_eq!(h.session.get_meta().queue_depth, 0);
    assert_eq!(h.user_events(&q.turn_id).len(), 1);
    h.session.abort_and_drain();
}

/// Cancelling an ineligible head (attachment) mid-turn exposes the next
/// message as head; it is steered without waiting for turn end.
#[tokio::test]
async fn cancelling_ineligible_head_steers_the_next_one() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000")]);
    h.finish_first_turn().await;

    h.session.enqueue("two".into(), vec![], None, None);
    let att = vst_types::Attachment {
        id: "a".into(),
        name: "a.txt".into(),
        path: "/tmp/a.txt".into(),
        size: 1,
        mime: "text/plain".into(),
    };
    let blocker = h.session.enqueue("with-att".into(), vec![att], None, None);
    let q = h.session.enqueue("four".into(), vec![], None, None);
    h.wait_dispatched().await;
    sleep_ms(250).await;
    assert!(h.steered().is_empty(), "blocked behind the attachment head");

    assert!(h.session.cancel_queued_turn(&blocker.turn_id));
    sleep_ms(400).await;
    assert_eq!(h.steered(), vec!["four".to_string()]);
    assert_eq!(h.user_events(&q.turn_id).len(), 1);
    h.session.abort_and_drain();
}

#[tokio::test]
async fn enqueue_with_mentions_populates_meta_and_allows_edit_resubmit() {
    let (_dir, _home, session) = make_mock_session();
    let mention = vst_types::Mention {
        kind: vst_types::MentionKind::File,
        id: "src/main.rs".to_string(),
        label: "main.rs".to_string(),
    };
    let res = session.enqueue_with("hello".into(), vec![], vec![mention.clone()], None, None);
    let meta = session.get_meta();
    assert_eq!(meta.queued_turns.len(), 1);
    assert_eq!(meta.queued_turns[0].turn_id, res.turn_id);
    assert_eq!(meta.queued_turns[0].mentions, Some(vec![mention.clone()]));

    // begin_edit_queued_turn returns them
    let held = session.begin_edit_queued_turn(&res.turn_id);
    let (msg, atts, mentions, qi) = held.expect("held turn");
    assert_eq!(msg, "hello");
    assert!(atts.is_empty());
    assert_eq!(mentions, vec![mention.clone()]);
    assert_eq!(qi, 0);

    // resubmit_queued_turn(edited=true) replaces them
    let new_mention = vst_types::Mention {
        kind: vst_types::MentionKind::Agent,
        id: "a1".to_string(),
        label: "Agent 1".to_string(),
    };
    let ok = session.resubmit_queued_turn(
        &res.turn_id,
        "hello edited".into(),
        vec![],
        vec![new_mention.clone()],
        true,
    );
    assert!(ok);
    let meta_after = session.get_meta();
    assert_eq!(
        meta_after.queued_turns[0].mentions,
        Some(vec![new_mention.clone()])
    );
}

#[tokio::test]
async fn emitted_user_event_carries_mentions() {
    let (_dir, _home, session) = make_mock_session();
    let mention = vst_types::Mention {
        kind: vst_types::MentionKind::File,
        id: "lib.rs".to_string(),
        label: "lib.rs".to_string(),
    };
    let res = session.enqueue_with(
        "run with mention".into(),
        vec![],
        vec![mention.clone()],
        None,
        None,
    );
    wait_idle(&session).await;

    let events = session.read_transcript();
    let user_ev = events
        .iter()
        .find(|e| {
            e.kind == vst_types::NormalizedEventKind::User
                && e.turn_id.as_deref() == Some(&res.turn_id)
        })
        .expect("user event found");
    assert_eq!(user_ev.mentions, Some(vec![mention]));
}

#[tokio::test]
async fn submit_with_non_file_mentions_never_steers() {
    let h = SteerHarness::new(&[("STEER_PROMPT_MS", "2000")]);
    h.finish_first_turn().await;

    // Start a running turn
    h.session.enqueue("two".into(), vec![], None, None);
    h.wait_dispatched().await;

    let mention = vst_types::Mention {
        kind: vst_types::MentionKind::Agent,
        id: "a.txt".to_string(),
        label: "a.txt".to_string(),
    };
    let res = h
        .session
        .submit_with("with-mention".into(), vec![], vec![mention], None, None)
        .await;
    assert!(matches!(
        res.delivery,
        vst_agents::json_agent_session::queue::SubmitDelivery::Queued
    ));

    sleep_ms(300).await;
    assert!(
        h.steered().is_empty(),
        "turn with non-file mentions must never be steered"
    );
    h.session.abort_and_drain();
}

// ---------------------------------------------------------------------------
// Skill-grammar: wire text is un-escaped exactly once on delivery to the agent
// ---------------------------------------------------------------------------

/// Like `MockTurnPlugin` but records the `TurnInput.message` each turn receives.
struct CapturePlugin {
    seen: Arc<std::sync::Mutex<Vec<String>>>,
}

impl AgentPlugin for CapturePlugin {
    fn name(&self) -> &str {
        "capture"
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
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        self.seen.lock().unwrap().push(input.message);
        let (tx, rx) = mpsc::unbounded_channel();
        let mut ev = NormalizedEvent::default();
        ev.kind = NormalizedEventKind::Result;
        let _ = tx.send(ev);
        rx
    }
}

fn make_capture_session() -> (
    tempfile::TempDir,
    vst_agents::home::HomeGuard,
    JsonAgentSession,
    Arc<std::sync::Mutex<Vec<String>>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(CapturePlugin { seen: seen.clone() }),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });
    (dir, home, session, seen)
}

/// Drained turn: the agent gets plain text, the transcript keeps wire form.
#[tokio::test]
async fn drained_turn_delivers_unescaped_text_and_keeps_wire_echo() {
    let (_dir, _home, session, seen) = make_capture_session();
    let wire = r"C:\\temp \{a}";
    let res = session.enqueue(wire.into(), vec![], None, None);
    wait_idle(&session).await;
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [r"C:\temp {a}".to_string()]
    );
    let echo = session
        .read_transcript()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res.turn_id))
        .expect("user event");
    assert_eq!(echo.text.as_deref(), Some(wire), "echo stays wire-form");
}

/// Notice turn: daemon-made text embeds user-set child names; a name that looks
/// like a skill token or contains backslashes reaches the agent verbatim.
#[tokio::test]
async fn notice_turn_text_round_trips_special_child_names() {
    let (_dir, _home, session, seen) = make_capture_session();
    session.populate_notice_slot("child-1".into(), r"{/x y} a\\b {c}".into());
    session.kick_drain();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while seen.lock().unwrap().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("notice turn should run");
    assert_eq!(
        seen.lock().unwrap()[0],
        r"{/x y} a\\b {c} is waiting for your reply"
    );
    // Every transcript user row is wire form, including the silent notice row.
    let row = session
        .read_transcript()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.silent == Some(true))
        .expect("silent notice user row");
    assert_eq!(
        row.text.as_deref(),
        Some(r"\{/x y} a\\\\b \{c} is waiting for your reply")
    );
}

/// Chat enqueue with wire text + an attachment: the attachment path appended at
/// enqueue is escaped, so after the single un-escape the agent sees the raw
/// path (and the wire text is un-escaped once).
#[tokio::test]
async fn enqueue_chat_turn_escapes_attachment_path_and_delivers_plain_text() {
    use vst_agents::json_agent_chat::{enqueue_chat_turn, EnqueueChatTurnOpts};
    use vst_agents::json_agent_registry::JsonAgentRegistry;

    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".vibe-station")).unwrap();
    std::fs::write(
        dir.path().join(".vibe-station/modes.json"),
        serde_json::json!([{
            "id": "my-mode", "name": "My Mode", "cli": "claude", "context": "",
            "createdAt": "2026-01-01T00:00:00.000Z", "model": null
        }])
        .to_string(),
    )
    .unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let mut session_rec = common::make_session("s1");
    session_rec.channel = Some(Channel::Json);
    session_rec.use_tmux = false;
    session_rec.mode_id = Some("my-mode".into());
    let mut project = common::make_project("p1");
    project.direct_sessions.push(session_rec.clone());
    store.add_project(project.clone()).await.unwrap();

    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let broadcaster = vst_types::Broadcaster(tx);
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let registry = JsonAgentRegistry::new();
    registry.set(
        "s1".into(),
        Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
            project,
            worktree: None,
            session: session_rec,
            plugin: Arc::new(CapturePlugin { seen: seen.clone() }),
            daemon_port: 0,
            cli: vst_types::NormalizedEventProvider::Claude,
            model: None,
            mode_id: None,
            mode_name: None,
            store_handle: store.clone(),
            broadcaster: broadcaster.clone(),
        })),
    );

    let path = r"/tmp/we\ird {x}/a.txt";
    let att = vst_types::Attachment {
        id: "a".into(),
        name: "a.txt".into(),
        path: path.into(),
        size: 1,
        mime: "text/plain".into(),
    };
    enqueue_chat_turn(
        EnqueueChatTurnOpts {
            session_id: "s1".into(),
            message: r"C:\\temp \{a}".into(),
            attachments: vec![att],
            mentions: vec![],
            daemon_port: 0,
            steer: Some(false),
            silent: false,
            store,
            broadcaster,
        },
        &registry,
    )
    .await
    .unwrap();
    let agent = registry.get("s1").unwrap();
    wait_idle(&agent).await;

    let got = seen.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "one turn delivered");
    assert_eq!(
        got[0].matches("[Attached files:]").count(),
        1,
        "attachment header injected exactly once via enqueue_chat_turn: {}",
        got[0]
    );
    assert!(
        got[0].starts_with(r"C:\temp {a}"),
        "text un-escaped: {}",
        got[0]
    );
    assert!(
        got[0].contains(path),
        "raw attachment path delivered: {}",
        got[0]
    );
    assert!(
        !got[0].contains(r"we\\ird") && !got[0].contains(r"\{x}"),
        "attachment path must not stay escaped: {}",
        got[0]
    );
}

/// Records every `TurnInput.message` the agent would receive.
struct RecordingPlugin {
    seen: Arc<std::sync::Mutex<Vec<String>>>,
}

impl AgentPlugin for RecordingPlugin {
    fn name(&self) -> &str {
        "recording"
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
        _cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        self.seen.lock().unwrap().push(input.message);
        let (tx, rx) = mpsc::unbounded_channel();
        let mut ev = NormalizedEvent::default();
        ev.kind = NormalizedEventKind::Result;
        let _ = tx.send(ev);
        rx
    }
}

/// Decision 5 / A1: attachments are injected exactly once, at run time. The
/// agent sees ONE `[Attached files:]` header (path verbatim, message
/// un-escaped); the stored/echoed transcript text stays raw wire form.
#[tokio::test]
async fn attachment_header_reaches_agent_once_and_is_not_stored() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store_handle = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project: common::make_project("p1"),
        worktree: None,
        session: common::make_session("s1"),
        plugin: Arc::new(RecordingPlugin { seen: seen.clone() }),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });
    let att = vst_types::Attachment {
        id: "a".into(),
        name: "a.txt".into(),
        path: "/tmp/dir {x}\\a.txt".into(),
        size: 1,
        mime: "text/plain".into(),
    };
    let res = session.enqueue(r"see C:\\temp".into(), vec![att], None, None);
    wait_idle(&session).await;

    let msgs = seen.lock().unwrap().clone();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].matches("[Attached files:]").count(), 1, "{msgs:?}");
    assert_eq!(
        msgs[0],
        "see C:\\temp\n\n[Attached files:]\n/tmp/dir {x}\\a.txt"
    );

    let events = session.read_transcript();
    let user = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(&res.turn_id))
        .expect("user event");
    assert_eq!(user.text.as_deref(), Some(r"see C:\\temp"));
}
