//! Integration tests for the `LimitsHandle` scheduler: fake probes (canned
//! `LimitsResult`s behind an `AtomicUsize` call counter), millisecond timing,
//! and a `Broadcaster` to observe broadcasts.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use vst_harness_limits::{
    ClientCountFn, HarnessProbe, LimitsDeps, LimitsHandle, LimitsTiming, RefreshOutcome,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{LifecycleState, LimitSlotRef, LimitStatus, LimitsResult, LimitsSnapshot};

fn timing(interval_ms: u64) -> LimitsTiming {
    LimitsTiming {
        interval: Duration::from_millis(interval_ms),
        stale_after: Duration::from_millis(1000),
        turn_debounce: Duration::from_millis(50),
        manual_cooldown: Duration::from_millis(50),
        backoff_initial: Duration::from_millis(30),
        backoff_cap: Duration::from_millis(300),
        rebroadcast_after: Duration::from_secs(3600),
        probe_timeout: Duration::from_secs(5),
    }
}

fn clients_one() -> ClientCountFn {
    Arc::new(|| 1usize)
}

/// A canned probe for a harness that returns `result` and bumps `calls`.
fn canned_probe(harness: &str, result: LimitsResult, calls: Arc<AtomicUsize>) -> HarnessProbe {
    HarnessProbe {
        harness: harness.to_string(),
        probe: Arc::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            let r = result.clone();
            Box::pin(async move { r })
        }),
    }
}

fn ok_result(harness: &str) -> LimitsResult {
    LimitsResult {
        harness: harness.to_string(),
        status: LimitStatus::Ok,
        message: None,
        as_of: "2026-10-11T00:00:00.000Z".to_string(),
        windows: vec![vst_types::LimitWindow::placeholder(
            harness,
            "five_hour",
            Some(300),
            LimitStatus::Ok,
            "2026-10-11T00:00:00.000Z",
        )],
    }
}

fn error_result(harness: &str) -> LimitsResult {
    LimitsResult {
        harness: harness.to_string(),
        status: LimitStatus::Error,
        message: Some("boom".to_string()),
        as_of: "2026-10-11T00:00:00.000Z".to_string(),
        windows: vec![],
    }
}

async fn next_limits(rx: &mut broadcast::Receiver<ServerEvent>) -> LimitsSnapshot {
    loop {
        match rx.recv().await {
            Ok(ServerEvent::LimitsUpdated { limits }) => return limits,
            Ok(_) => continue,
            Err(_) => panic!("broadcast closed"),
        }
    }
}

fn handle_with(probes: Vec<HarnessProbe>, timing: LimitsTiming) -> (Broadcaster, LimitsHandle) {
    let broadcaster = Broadcaster::new(64);
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        probes,
        session_harness: Arc::new(|_| Box::pin(async { None })),
        host: "flat-box".to_string(),
        initial_slots: vst_types::limits::default_slots(),
        timing,
    });
    (broadcaster, handle)
}

#[tokio::test]
async fn fetch_probes_stale_harness_and_broadcasts_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        timing(300),
    );
    let mut rx = broadcaster.subscribe();

    handle.note_client_fetch();
    let snap = tokio::time::timeout(Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("an initial fetch should probe and broadcast");
    assert_eq!(snap.host, "flat-box");
    assert_eq!(snap.harnesses.len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unchanged_result_not_rebroadcast() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        timing(300),
    );
    let mut rx = broadcaster.subscribe();

    // First manual refresh probes and broadcasts.
    let out = handle.refresh_manual().await;
    assert!(out.started);
    let _snap = tokio::time::timeout(Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("first refresh broadcasts");
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Second refresh with identical values after cooldown: no new broadcast.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let out = handle.refresh_manual().await;
    assert!(out.started);
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let nothing = tokio::time::timeout(Duration::from_millis(150), next_limits(&mut rx)).await;
    assert!(
        nothing.is_err(),
        "identical results must not rebroadcast before the freshness window"
    );
}

#[tokio::test(start_paused = true)]
async fn interval_probes_only_with_clients() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        timing(100),
    );
    let counter_fn: ClientCountFn = {
        let counter = counter.clone();
        Arc::new(move || counter.load(Ordering::SeqCst))
    };
    handle.bind_client_counter(counter_fn);
    let _jh = handle.start();

    // Three intervals with zero clients -> no probes.
    for _ in 0..3 {
        tokio::time::advance(Duration::from_millis(100)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no clients -> no probes");

    // A client appears -> the next interval probes.
    counter.store(1, Ordering::SeqCst);
    tokio::time::advance(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "client present -> probe");

    let _ = broadcaster;
}

#[tokio::test(start_paused = true)]
async fn turn_finished_probes_resolved_harness_debounced() {
    let calls = Arc::new(AtomicUsize::new(0));
    let broadcaster = Broadcaster::new(64);
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        probes: vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        session_harness: Arc::new(|id| {
            let id = id.clone();
            Box::pin(async move {
                if id == "s1" {
                    Some("claude".to_string())
                } else {
                    None
                }
            })
        }),
        host: "flat-box".to_string(),
        initial_slots: vst_types::limits::default_slots(),
        timing: timing(300),
    });
    handle.bind_client_counter(clients_one());
    let _jh = handle.start();

    let turn = |id: &str, state: LifecycleState| {
        broadcaster.send(ServerEvent::SessionState {
            session_id: id.to_string(),
            state,
            reason: None,
        });
    };

    // Working -> Idle for a session resolving to claude: probes once.
    turn("s1", LifecycleState::Working);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    turn("s1", LifecycleState::Idle);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Another Working -> Idle within the debounce window: suppressed.
    turn("s1", LifecycleState::Working);
    tokio::time::advance(Duration::from_millis(1)).await;
    turn("s1", LifecycleState::Idle);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "debounced within window");

    // A session resolving to None: no probe.
    turn("s2", LifecycleState::Working);
    tokio::time::advance(Duration::from_millis(1)).await;
    turn("s2", LifecycleState::Idle);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "None harness -> no probe");
}

#[tokio::test]
async fn manual_refresh_cooldown() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        timing(300),
    );
    let _ = broadcaster;

    let first = handle.refresh_manual().await;
    assert_eq!(
        first,
        RefreshOutcome {
            started: true,
            retry_after_secs: None
        }
    );

    // Second call inside the cooldown: rejected.
    let second = handle.refresh_manual().await;
    assert_eq!(second.started, false);
    assert!(second.retry_after_secs.is_some());
}

#[tokio::test(start_paused = true)]
async fn error_enters_backoff_and_manual_ignores_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe(
            "claude",
            error_result("claude"),
            calls.clone(),
        )],
        timing(100),
    );
    handle.bind_client_counter(clients_one());
    let _jh = handle.start();
    tokio::task::yield_now().await;

    // First real interval tick probes -> error, backoff armed.
    tokio::time::advance(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // A couple more intervals are suppressed by backoff.
    for _ in 0..3 {
        tokio::time::advance(Duration::from_millis(100)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "interval suppressed by backoff"
    );

    // Manual refresh ignores backoff.
    let out = handle.refresh_manual().await;
    assert!(out.started);
    assert_eq!(calls.load(Ordering::SeqCst), 2, "manual ignores backoff");

    let _ = broadcaster;
}

#[tokio::test]
async fn unsupported_harness_hidden_from_snapshot() {
    let unsupported = LimitsResult {
        harness: "codex".to_string(),
        status: LimitStatus::Unsupported,
        message: None,
        as_of: "2026-10-11T00:00:00.000Z".to_string(),
        windows: vec![],
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("codex", unsupported, calls.clone())],
        timing(300),
    );
    let _ = broadcaster;

    handle.note_client_fetch();
    // Give the spawned probe a moment to apply.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let snap = handle.snapshot();
    assert_eq!(
        snap.harnesses.len(),
        0,
        "unsupported harness must never appear in a snapshot"
    );
}

#[tokio::test]
async fn set_slots_broadcasts_and_snapshot_reflects() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![canned_probe("claude", ok_result("claude"), calls.clone())],
        timing(300),
    );
    let mut rx = broadcaster.subscribe();

    let new_slots = [
        LimitSlotRef::new("claude", "five_hour"),
        LimitSlotRef::new("codex", "primary"),
    ];
    let snap = handle.set_slots(new_slots.clone());
    assert_eq!(snap.slots, new_slots);

    let broadcast = tokio::time::timeout(Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("set_slots broadcasts limits:updated");
    assert_eq!(broadcast.slots, new_slots);

    // And the store reflects it on a fresh snapshot.
    assert_eq!(handle.snapshot().slots, new_slots);
}
