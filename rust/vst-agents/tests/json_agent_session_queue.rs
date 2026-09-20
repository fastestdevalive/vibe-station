use std::collections::VecDeque;

use vst_agents::json_agent_session::{JsonAgentSession, QueuedTurn};

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
use vst_types::{NormalizedEvent, NormalizedEventKind, TurnState};

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
    let stopped = session.stop_active_turn();
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
