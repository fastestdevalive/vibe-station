//! `spawn_subagent_notify_listener` must treat `background`/`background-settled`
//! lifecycle writes as invisible, but `subagent-notice` ones as real transitions.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vst_lifecycle::subagent_notify::{
    NotifyDeps, PillPayload, SessionLookup, SubagentNotifyHandle,
};
use vst_types::domain::{Channel, LifecycleState};
use vst_types::events::ServerEvent;
use vst_types::Broadcaster;

use super::spawn_subagent_notify_listener;

#[derive(Default)]
struct FakeDeps {
    populated: AtomicUsize,
    pruned: AtomicUsize,
}

impl NotifyDeps for FakeDeps {
    fn lookup(&self, id: &str) -> Option<SessionLookup> {
        Some(SessionLookup {
            id: id.to_string(),
            channel: Channel::Json,
            parent_session_id: (id == "child").then(|| "parent".to_string()),
            name: Some(id.to_string()),
            archived_at: None,
            superseded_by: None,
            lifecycle_state: None,
        })
    }
    fn populate_notice_slot(&self, _parent: &str, _child_id: &str, _child_name: &str) -> bool {
        self.populated.fetch_add(1, Ordering::SeqCst);
        true
    }
    fn emit_pill(
        &self,
        _parent: &str,
        _payload: PillPayload,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
    fn prune_notice_slot_child(&self, _parent: &str, _child: &str) {
        self.pruned.fetch_add(1, Ordering::SeqCst);
    }
}

fn state(state: LifecycleState, reason: Option<&str>) -> ServerEvent {
    ServerEvent::SessionState {
        session_id: "child".into(),
        state,
        reason: reason.map(str::to_string),
    }
}

/// Let the listener task and the 4 s coalescer run (paused clock).
async fn flush() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(4_500)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

fn start() -> (Broadcaster, Arc<FakeDeps>) {
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let broadcaster = Broadcaster(tx);
    let deps = Arc::new(FakeDeps::default());
    let handle = SubagentNotifyHandle::new();
    handle.set_deps(deps.clone());
    spawn_subagent_notify_listener(handle, broadcaster.clone(), deps.clone());
    (broadcaster, deps)
}

#[tokio::test(start_paused = true)]
async fn background_working_and_settle_yield_exactly_one_parent_notice() {
    let (b, deps) = start();
    tokio::task::yield_now().await;
    b.send(state(LifecycleState::WaitingForHuman, None));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 1);

    b.send(state(LifecycleState::Working, Some("background")));
    b.send(state(
        LifecycleState::WaitingForHuman,
        Some("background-settled"),
    ));
    flush().await;
    assert_eq!(
        deps.populated.load(Ordering::SeqCst),
        1,
        "background window must not produce a second notice"
    );
    assert_eq!(
        deps.pruned.load(Ordering::SeqCst),
        0,
        "background working must not prune the child from the parent's slot"
    );
}

#[tokio::test(start_paused = true)]
async fn subagent_notice_working_is_visible_and_next_waiting_notifies_again() {
    let (b, deps) = start();
    tokio::task::yield_now().await;
    b.send(state(LifecycleState::WaitingForHuman, None));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 1);

    b.send(state(LifecycleState::Working, Some("subagent-notice")));
    flush().await;
    assert_eq!(deps.pruned.load(Ordering::SeqCst), 1);

    b.send(state(LifecycleState::WaitingForHuman, None));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 2);
}

/// R1F-12: a drain whose tail opens a background window emits the plain
/// `waiting_for_human` (visible) before `working(background)`; the whole
/// sequence yields exactly ONE parent notice.
#[tokio::test(start_paused = true)]
async fn turn_end_then_background_window_yields_exactly_one_parent_notice() {
    let (b, deps) = start();
    tokio::task::yield_now().await;
    b.send(state(LifecycleState::Working, None));
    b.send(state(LifecycleState::WaitingForHuman, None));
    b.send(state(LifecycleState::Working, Some("background")));
    b.send(state(
        LifecycleState::WaitingForHuman,
        Some("background-settled"),
    ));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 1);
    assert_eq!(deps.pruned.load(Ordering::SeqCst), 0);
}

/// A turn ended while a task held the session: `working(background-turn-ended)`
/// is invisible, and the eventual `waiting_for_human(None)` (also what the boot
/// sweep writes for that reason) is the single parent notice.
#[tokio::test(start_paused = true)]
async fn background_turn_ended_working_is_silent_and_settle_notifies_once() {
    let (b, deps) = start();
    tokio::task::yield_now().await;
    b.send(state(
        LifecycleState::Working,
        Some("background-turn-ended"),
    ));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 0);
    assert_eq!(deps.pruned.load(Ordering::SeqCst), 0);
    b.send(state(LifecycleState::WaitingForHuman, None));
    flush().await;
    assert_eq!(deps.populated.load(Ordering::SeqCst), 1);
}
