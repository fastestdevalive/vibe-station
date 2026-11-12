//! Integration tests for the `LimitsHandle` scheduler: fake probes (canned
//! `LimitsResult`s behind an `AtomicUsize` call counter), millisecond timing,
//! and a `Broadcaster` to observe broadcasts.
//!
//! Per-account (Decision 9): a probe is one `ProbeTarget` (harness + optional
//! account), all cache slots are keyed by `ProbeTarget::key()`, and the targets
//! are read from the injected closure at call time.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::broadcast;
use vst_harness_limits::{
    ClientCountFn, LimitsDeps, LimitsHandle, LimitsTiming, ProbeFn, ProbeTarget, RefreshOutcome,
    SessionTargetFn,
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

/// A canned probe: returns `result` (stamped with the probed target's account)
/// and bumps `calls`. Records every target it was asked about.
fn canned_probe(
    result: LimitsResult,
    calls: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<ProbeTarget>>>,
) -> ProbeFn {
    Arc::new(move |target: ProbeTarget| {
        calls.fetch_add(1, Ordering::SeqCst);
        seen.lock().unwrap().push(target.clone());
        let mut r = result.clone();
        r.account_id = target.account_id;
        Box::pin(async move { r })
    })
}

fn ok_result(harness: &str) -> LimitsResult {
    LimitsResult {
        harness: harness.to_string(),
        account_id: None,
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
        account_id: None,
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

fn no_session_target() -> SessionTargetFn {
    Arc::new(|_| Box::pin(async { None }))
}

fn handle_with(
    targets: Vec<ProbeTarget>,
    probe: ProbeFn,
    timing: LimitsTiming,
) -> (Broadcaster, LimitsHandle) {
    handle_with_resolver(targets, probe, no_session_target(), timing)
}

fn handle_with_resolver(
    targets: Vec<ProbeTarget>,
    probe: ProbeFn,
    session_target: SessionTargetFn,
    timing: LimitsTiming,
) -> (Broadcaster, LimitsHandle) {
    let broadcaster = Broadcaster::new(64);
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        targets: Arc::new(move || targets.clone()),
        probe,
        session_target,
        host: "flat-box".to_string(),
        initial_slots: vst_types::limits::default_slots(),
        timing,
    });
    (broadcaster, handle)
}

fn counters() -> (Arc<AtomicUsize>, Arc<Mutex<Vec<ProbeTarget>>>) {
    (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(Mutex::new(Vec::new())),
    )
}

#[tokio::test]
async fn fetch_probes_stale_harness_and_broadcasts_once() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls.clone(), seen),
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
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls.clone(), seen),
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
    let (calls, seen) = counters();
    let counter = Arc::new(AtomicUsize::new(0));
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls.clone(), seen),
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
    let (calls, seen) = counters();
    let broadcaster = Broadcaster::new(64);
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        targets: Arc::new(|| vec![ProbeTarget::system("claude")]),
        probe: canned_probe(ok_result("claude"), calls.clone(), seen),
        session_target: Arc::new(|id| {
            let id = id.clone();
            Box::pin(async move {
                if id == "s1" {
                    Some(ProbeTarget::system("claude"))
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
    assert_eq!(calls.load(Ordering::SeqCst), 1, "None target -> no probe");
}

#[tokio::test(start_paused = true)]
async fn turn_finished_probes_session_account() {
    let (calls, seen) = counters();
    let broadcaster = Broadcaster::new(64);
    let seen_for_assert = seen.clone();
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        targets: Arc::new(|| {
            vec![
                ProbeTarget::system("claude"),
                ProbeTarget {
                    harness: "claude".into(),
                    account_id: Some("acc_00000001".into()),
                },
            ]
        }),
        probe: canned_probe(ok_result("claude"), calls.clone(), seen),
        // The session runs under a named account: the post-turn probe must hit
        // THAT target, not the System one.
        session_target: Arc::new(|_| {
            Box::pin(async {
                Some(ProbeTarget {
                    harness: "claude".into(),
                    account_id: Some("acc_00000001".into()),
                })
            })
        }),
        host: "flat-box".to_string(),
        initial_slots: vst_types::limits::default_slots(),
        timing: timing(300),
    });
    handle.bind_client_counter(clients_one());
    let _jh = handle.start();

    broadcaster.send(ServerEvent::SessionState {
        session_id: "s1".into(),
        state: LifecycleState::Working,
        reason: None,
    });
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    broadcaster.send(ServerEvent::SessionState {
        session_id: "s1".into(),
        state: LifecycleState::Idle,
        reason: None,
    });
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let probed = seen_for_assert.lock().unwrap().clone();
    assert_eq!(probed.len(), 1);
    assert_eq!(probed[0].account_id.as_deref(), Some("acc_00000001"));
}

#[tokio::test]
async fn probes_each_account_separately() {
    let (calls, seen) = counters();
    let targets = vec![
        ProbeTarget::system("claude"),
        ProbeTarget {
            harness: "claude".into(),
            account_id: Some("acc_00000001".into()),
        },
        ProbeTarget {
            harness: "claude".into(),
            account_id: Some("acc_00000002".into()),
        },
    ];
    let (broadcaster, handle) = handle_with(
        targets,
        canned_probe(ok_result("claude"), calls.clone(), seen.clone()),
        timing(300),
    );
    let _ = broadcaster.subscribe();

    handle.refresh_manual().await;
    assert_eq!(calls.load(Ordering::SeqCst), 3, "one probe per account");

    // `refresh_manual` awaits every probe; each one broadcasts, so the final
    // cache (not the first partial broadcast) is what must carry all three.
    let snap = handle.snapshot();
    assert_eq!(snap.harnesses.len(), 3);
    let accounts: Vec<Option<String>> = snap
        .harnesses
        .iter()
        .map(|r| r.account_id.clone())
        .collect();
    assert_eq!(
        accounts,
        vec![
            None,
            Some("acc_00000001".into()),
            Some("acc_00000002".into())
        ],
        "each account keeps its own slot"
    );
    // And the probe saw each target exactly once.
    let mut probed = seen.lock().unwrap().clone();
    probed.sort_by_key(|t| t.account_id.clone());
    assert_eq!(probed.len(), 3);
}

#[tokio::test]
async fn removed_account_prunes_result() {
    let (calls, seen) = counters();
    let targets = Arc::new(Mutex::new(vec![
        ProbeTarget::system("claude"),
        ProbeTarget {
            harness: "claude".into(),
            account_id: Some("acc_00000001".into()),
        },
    ]));
    let broadcaster = Broadcaster::new(64);
    let targets_for_fn = targets.clone();
    let handle = LimitsHandle::new(LimitsDeps {
        broadcaster: broadcaster.clone(),
        targets: Arc::new(move || targets_for_fn.lock().unwrap().clone()),
        probe: canned_probe(ok_result("claude"), calls.clone(), seen),
        session_target: no_session_target(),
        host: "flat-box".to_string(),
        initial_slots: vst_types::limits::default_slots(),
        timing: timing(300),
    });
    handle.bind_client_counter(clients_one());

    handle.refresh_manual().await;
    assert_eq!(handle.snapshot().harnesses.len(), 2);

    // Subscribe only now, so the prune's rebroadcast is the next event seen.
    let mut rx = broadcaster.subscribe();
    let _jh = handle.start();
    // The account is removed: the daemon broadcasts it and stops targeting it.
    broadcaster.send(ServerEvent::AccountRemoved {
        cli: "claude".into(),
        account_id: "acc_00000001".into(),
    });
    let snap = tokio::time::timeout(Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("prune rebroadcasts");
    assert_eq!(snap.harnesses.len(), 1);
    assert_eq!(snap.harnesses[0].account_id, None);

    // The account also leaves the daemon's target list (accounts_wiring owns
    // that); from then on only the System target is probed.
    targets
        .lock()
        .unwrap()
        .retain(|t| t.account_id.as_deref() != Some("acc_00000001"));
    // Past the manual-refresh cooldown (a real clock, so a real sleep).
    tokio::time::sleep(Duration::from_millis(60)).await;
    let before = calls.load(Ordering::SeqCst);
    handle.refresh_manual().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        before + 1,
        "only the surviving System target is probed"
    );
}

#[tokio::test]
async fn unsupported_harness_skips_all_accounts() {
    let (calls, seen) = counters();
    let unsupported = LimitsResult {
        harness: "codex".to_string(),
        account_id: None,
        status: LimitStatus::Unsupported,
        message: None,
        as_of: "2026-10-11T00:00:00.000Z".to_string(),
        windows: vec![],
    };
    let (broadcaster, handle) = handle_with(
        vec![
            ProbeTarget::system("codex"),
            ProbeTarget {
                harness: "codex".into(),
                account_id: Some("acc_00000001".into()),
            },
        ],
        canned_probe(unsupported, calls.clone(), seen),
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

    // The harness-wide flag skips every account of it on the next fetch.
    let before = calls.load(Ordering::SeqCst);
    handle.note_client_fetch();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        before,
        "no account of an unsupported harness is probed"
    );
}

#[tokio::test]
async fn snapshot_lists_system_result_first() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![
            ProbeTarget {
                harness: "claude".into(),
                account_id: Some("acc_00000001".into()),
            },
            ProbeTarget::system("claude"),
        ],
        canned_probe(ok_result("claude"), calls.clone(), seen),
        timing(300),
    );
    let _ = broadcaster;

    handle.refresh_manual().await;
    let snap = handle.snapshot();
    assert_eq!(snap.harnesses.len(), 2);
    assert_eq!(
        snap.harnesses[0].account_id, None,
        "old clients do results.find(harness) and must get System"
    );
    assert_eq!(
        snap.harnesses[1].account_id.as_deref(),
        Some("acc_00000001")
    );
}

#[tokio::test]
async fn manual_refresh_cooldown() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls.clone(), seen),
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
    assert!(!second.started);
    assert!(second.retry_after_secs.is_some());
}

#[tokio::test(start_paused = true)]
async fn error_enters_backoff_and_manual_ignores_it() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(error_result("claude"), calls.clone(), seen),
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
async fn set_slots_broadcasts_and_snapshot_reflects() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls.clone(), seen),
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

fn account_event(id: &str, pending: bool) -> ServerEvent {
    use vst_types::{AccountAuth, AccountMethod, AccountSummary};
    ServerEvent::AccountUpdated {
        account: AccountSummary {
            id: id.to_string(),
            cli: "claude".to_string(),
            label: None,
            display_name: "Work".to_string(),
            email: None,
            plan: None,
            method: AccountMethod::SignIn,
            auth: AccountAuth::SignedIn,
            is_default: false,
            limited: None,
            created_at: None,
            dir: None,
            created_by_us: false,
            pending,
            sign_in: None,
        },
    }
}

#[tokio::test]
async fn account_updated_probes_a_new_account_once() {
    let (calls, seen) = counters();
    // A long interval: only the event can trigger a probe.
    let (broadcaster, handle) = handle_with(
        vec![],
        canned_probe(ok_result("claude"), calls.clone(), seen.clone()),
        timing(3_600_000),
    );
    let _jh = handle.start();

    // A pending account is not probed.
    broadcaster.send(account_event("acc_pending", true));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    // The first announcement of a usable account probes it, once.
    broadcaster.send(account_event("acc_00000002", false));
    broadcaster.send(account_event("acc_00000002", false));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        seen.lock().unwrap()[0].account_id.as_deref(),
        Some("acc_00000002")
    );

    // A later update (rename, default change) does not probe again.
    broadcaster.send(account_event("acc_00000002", false));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn snapshot_serves_a_removed_accounts_pin_as_the_system_login() {
    let (calls, seen) = counters();
    let (_b, handle) = handle_with(
        vec![
            ProbeTarget::system("claude"),
            ProbeTarget {
                harness: "claude".into(),
                account_id: Some("acc_live".into()),
            },
        ],
        canned_probe(ok_result("claude"), calls, seen),
        timing(300),
    );
    let mut gone = LimitSlotRef::new("claude", "five_hour");
    gone.account_id = Some("acc_gone".into());
    let mut live = LimitSlotRef::new("claude", "seven_day");
    live.account_id = Some("acc_live".into());
    let snap = handle.set_slots([gone, live.clone()]);
    assert_eq!(snap.slots[0].account_id, None);
    assert_eq!(snap.slots[0].harness, "claude");
    assert_eq!(snap.slots[0].window_id, "five_hour");
    assert_eq!(snap.slots[1], live);
}

#[tokio::test]
async fn account_removed_broadcasts_even_without_a_cached_result() {
    let (calls, seen) = counters();
    let (broadcaster, handle) = handle_with(
        vec![ProbeTarget::system("claude")],
        canned_probe(ok_result("claude"), calls, seen),
        timing(300),
    );
    let mut rx = broadcaster.subscribe();
    let _jh = handle.start();
    broadcaster.send(ServerEvent::AccountRemoved {
        cli: "claude".into(),
        account_id: "acc_never_probed".into(),
    });
    tokio::time::timeout(Duration::from_secs(2), next_limits(&mut rx))
        .await
        .expect("a removal always rebroadcasts");
}
