//! Review turns (plan 04): the persist helper both persist sites share, and
//! a released session never running (or spawning for) a held review turn.

use super::*;

#[derive(Default)]
struct SeenHolds {
    persisted: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<(String, RestoreReason)>>,
}

impl TurnObserver for SeenHolds {
    fn turn_persisted(&self, hold_id: &str) -> vst_types::review::AsyncResult<()> {
        self.persisted.lock().unwrap().push(hold_id.to_string());
        Box::pin(async {})
    }
    fn turn_cancelled(
        &self,
        hold_id: &str,
        reason: RestoreReason,
    ) -> vst_types::review::AsyncResult<()> {
        self.cancelled
            .lock()
            .unwrap()
            .push((hold_id.to_string(), reason));
        Box::pin(async {})
    }
}

fn review_turn(id: &str) -> QueuedTurn {
    QueuedTurn {
        turn_id: id.into(),
        enqueue_order: 0,
        raw_message: "m".into(),
        attachments: vec![],
        fork_from_chat_id: None,
        silent: false,
        mentions: vec![],
        review: Some(ReviewTurn {
            hold_id: format!("hold-{id}"),
            record: vst_types::review::ReviewRecord {
                name: "feat".into(),
                comments: vec![],
            },
        }),
    }
}

/// 2.T13 (defence) — `steer_queued_head` persists through `persist_turn_row`,
/// which must settle the hold even when `abort_and_drain` emptied `queue`
/// during the steer RPC (the turn is not looked up there).
#[tokio::test]
async fn persist_turn_row_settles_the_hold_without_the_turn_being_queued() {
    let s = session();
    let seen = Arc::new(SeenHolds::default());
    s.attach_review_observer(seen.clone());
    s.abort_and_drain();
    assert!(s.0.state.lock().unwrap().queue.is_empty());

    let turn = review_turn("t1");
    assert!(s.persist_turn_row(&turn).await, "reports the row persisted");

    assert_eq!(*seen.persisted.lock().unwrap(), vec!["hold-t1".to_string()]);
    assert!(seen.cancelled.lock().unwrap().is_empty());
    let row = s
        .read_transcript()
        .into_iter()
        .find(|e| e.turn_id.as_deref() == Some("t1"))
        .expect("user row persisted");
    assert!(row.review.is_some());
}

/// A row that could not be written (the session was released first) must not
/// delete the hold: the comments go back to the panel with the release reason.
#[tokio::test]
async fn unpersisted_review_row_restores_instead_of_deleting_the_hold() {
    let s = session();
    let seen = Arc::new(SeenHolds::default());
    s.attach_review_observer(seen.clone());
    *s.0.release_reason.lock().unwrap() = RestoreReason::ChannelChanged;
    s.0.released.store(true, Ordering::SeqCst);

    assert!(
        !s.persist_turn_row(&review_turn("t2")).await,
        "reports the row NOT persisted so the drain skips the turn"
    );

    assert!(seen.persisted.lock().unwrap().is_empty());
    assert_eq!(
        *seen.cancelled.lock().unwrap(),
        vec![("hold-t2".to_string(), RestoreReason::ChannelChanged)]
    );
}

/// A released session never runs a turn it still holds: the comments were
/// restored (or will be), so running it would deliver them twice.
#[tokio::test]
async fn a_released_session_drain_does_not_run_a_queued_review_turn() {
    let s = session();
    let seen = Arc::new(SeenHolds::default());
    s.attach_review_observer(seen.clone());
    s.0.state.lock().unwrap().queue.push_back(review_turn("t3"));
    s.0.released.store(true, Ordering::SeqCst);
    s.0.state.lock().unwrap().running = true;
    s.drain_loop().await;
    // `run_one_turn` on this (non-ACP) plugin would flip the state to Error.
    assert_ne!(s.0.state.lock().unwrap().turn_state, TurnState::Error);
    assert!(seen.persisted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_released_session_never_starts_an_agent_process() {
    let s = session();
    s.0.released.store(true, Ordering::SeqCst);
    let spec = crate::acp_connection::AcpLaunchSpec {
        command: "definitely-not-a-real-agent-binary".into(),
        args: vec![],
        cwd: std::env::temp_dir(),
        env: Default::default(),
        initialize_timeout_ms: Some(50),
        prompt_timeout_ms: None,
        open_tool_idle_timeout_ms: None,
        reap_detached_descendants: false,
    };
    assert!(matches!(
        s.get_or_create_connection(spec, None).await,
        Err(crate::acp_transport::AcpTransportError::RequestFailed(m)) if m.contains("released")
    ));
}

/// L2-03 — the drain's persist must not wait on the observer's store write:
/// no await between pop and `run_one_turn`, so Stop cannot miss the turn.
#[tokio::test]
async fn popped_turn_persist_does_not_wait_for_the_hold_settle() {
    struct Blocked(Arc<tokio::sync::Notify>);
    impl TurnObserver for Blocked {
        fn turn_persisted(&self, _: &str) -> vst_types::review::AsyncResult<()> {
            let n = self.0.clone();
            Box::pin(async move { n.notified().await })
        }
        fn turn_cancelled(&self, _: &str, _: RestoreReason) -> vst_types::review::AsyncResult<()> {
            Box::pin(async {})
        }
    }
    let s = session();
    let gate = Arc::new(tokio::sync::Notify::new());
    s.attach_review_observer(Arc::new(Blocked(gate.clone())));
    let persisted = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        s.persist_popped_turn_row(&review_turn("t1")),
    )
    .await
    .expect("persist must not block on turn_persisted");
    assert!(persisted);
    gate.notify_one();
}
