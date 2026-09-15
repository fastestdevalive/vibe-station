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
