//! `DiffStat` poller handle tests (plan Phase 4.T2).
//!
//! Paused tokio time tests exercising `DiffStatPollerHandle` at its public handle
//! with an injected compute function and fake store.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::broadcast::error::TryRecvError;
use vst_diffstat::compute::{git_file_stamp, ComputeInput, ComputeOutcome};
use vst_diffstat::{
    sweep_period_for, DiffStatPollerHandle, DIFFSTAT_DEBOUNCE_MS, DIFFSTAT_IN_FLIGHT,
    DIFFSTAT_MIN_SPACING_MS, DIFFSTAT_SWEEP_SECS,
};
use vst_git::Paths;
use vst_store::StoreHandle;
use vst_types::domain::{
    LifecycleState, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::worktrees::DiffStatState;
use vst_types::ProjectRecord;

// ---- test helpers ---------------------------------------------------------

fn session(id: &str, worktree_id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: Some(worktree_id.into()),
        project_id: project_id.into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn project(id: &str, worktree_ids: &[&str]) -> ProjectRecord {
    let wts = worktree_ids
        .iter()
        .map(|wt_id| {
            let session_id = format!("{wt_id}-s1");
            WorktreeRecord {
                id: (*wt_id).to_string(),
                name: None,
                branch: "feat".to_string(),
                branch_is_placeholder: None,
                base_branch: "main".into(),
                base_sha: "a".repeat(40),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                pinned_at: None,
                hidden_at: None,
                sort_order: 0.0,
                terminal_seq: Some(0),
                agent_seq: Some(1),
                lsp_enabled: None,
                sessions: vec![session(&session_id, wt_id, id)],
                open_files: vec![],
            }
        })
        .collect();

    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/tmp/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(1),
        worktrees: wts,
        next_worktree_num: Some(2),
        lsp_enabled: None,
        open_files: vec![],
    }
}

async fn seed_store(projects: Vec<ProjectRecord>) -> (tempfile::TempDir, StoreHandle, Paths) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = StoreHandle::open(dir.path().join("test.db")).expect("store");
    for project in projects {
        store.add_project(project).await.expect("add project");
    }
    let paths = Paths::with_home(dir.path().join("home"));
    (dir, store, paths)
}

/// Yield repeatedly to allow spawned async tasks and notifications to settle.
async fn settle() {
    for _ in 0..25 {
        tokio::task::yield_now().await;
    }
}

// ---- 1. gate closed ⇒ zero compute ----------------------------------------

#[tokio::test(start_paused = true)]
async fn gate_closed_means_zero_compute() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);

    let compute_calls = Arc::new(AtomicUsize::new(0));
    let calls = compute_calls.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { ComputeOutcome::ok(10, 2) }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 0))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;

    // Advance past the 2s debounce window.
    tokio::time::advance(Duration::from_secs(10)).await;
    settle().await;

    assert_eq!(
        compute_calls.load(Ordering::SeqCst),
        0,
        "gate closed must not compute any diffstat"
    );
    assert!(
        poller.has_pending("wt-1"),
        "key remains pending in the backlog"
    );

    handle.abort();
}

// ---- 2. 60 s grace period -------------------------------------------------

#[tokio::test(start_paused = true)]
async fn sixty_second_grace_allows_compute_after_disconnect_then_closes() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1", "wt-2"])]).await;
    let broadcaster = Broadcaster::new(64);

    let compute_calls = Arc::new(AtomicUsize::new(0));
    let calls = compute_calls.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { ComputeOutcome::ok(1, 0) }) as _
    });

    let clients = Arc::new(AtomicUsize::new(1));
    let client_fn = {
        let clients = clients.clone();
        Arc::new(move || clients.load(Ordering::SeqCst))
    };

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(client_fn)
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // Client was connected; let initial boot backlog finish.
    poller.note_clients_changed(1);
    settle().await;
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;
    compute_calls.store(0, Ordering::SeqCst);

    // Now client disconnects (starts 60 s grace).
    clients.store(0, Ordering::SeqCst);
    poller.note_clients_changed(0);
    settle().await;

    // Within 60 s grace (at t = 10s): compute still proceeds.
    tokio::time::advance(Duration::from_secs(10)).await;
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;

    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS + 100)).await;
    settle().await;

    assert_eq!(
        compute_calls.load(Ordering::SeqCst),
        1,
        "compute must proceed within the 60 s grace period"
    );

    // Advance beyond the 60 s grace window (from t = 12s to t = 75s).
    tokio::time::advance(Duration::from_secs(65)).await;
    settle().await;

    poller.mark_dirty("wt-2");
    settle().await;

    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS + 100)).await;
    settle().await;

    assert_eq!(
        compute_calls.load(Ordering::SeqCst),
        1,
        "compute must be suppressed after grace period expires"
    );

    handle.abort();
}

// ---- 3. first connect drains backlog most-recent-first ---------------------

#[tokio::test(start_paused = true)]
async fn first_connect_drains_backlog_most_recent_first() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1", "wt-2", "wt-3"])]).await;
    let broadcaster = Broadcaster::new(64);

    let execution_order = Arc::new(Mutex::new(Vec::new()));
    let order_clone = execution_order.clone();
    let compute = Arc::new(move |input: ComputeInput| {
        order_clone.lock().unwrap().push(input.worktree_id);
        Box::pin(async move { ComputeOutcome::ok(1, 0) }) as _
    });

    let clients = Arc::new(AtomicUsize::new(0));
    let client_fn = {
        let clients = clients.clone();
        Arc::new(move || clients.load(Ordering::SeqCst))
    };

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(client_fn)
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // Gate is closed. Mark wt-1, then wt-2, then wt-3 with distinct wall-clock ms
    // so wt-3 has the highest priority.
    poller.mark_dirty("wt-1");
    std::thread::sleep(Duration::from_millis(5));
    poller.mark_dirty("wt-2");
    std::thread::sleep(Duration::from_millis(5));
    poller.mark_dirty("wt-3");
    settle().await;

    // Connect first client.
    clients.store(1, Ordering::SeqCst);
    poller.note_clients_changed(1);
    settle().await;

    // Advance past debounce.
    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS + 100)).await;
    settle().await;

    let order = execution_order.lock().unwrap().clone();
    assert_eq!(order.len(), 3);
    assert_eq!(
        order[0], "wt-3",
        "most recently active worktree drains first"
    );
    assert_eq!(order[1], "wt-2");
    assert_eq!(order[2], "wt-1");

    handle.abort();
}

// ---- 4. focus hint first --------------------------------------------------

#[tokio::test(start_paused = true)]
async fn focus_hint_is_computed_first() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1", "wt-2"])]).await;
    let broadcaster = Broadcaster::new(64);

    let execution_order = Arc::new(Mutex::new(Vec::new()));
    let order_clone = execution_order.clone();
    let compute = Arc::new(move |input: ComputeInput| {
        order_clone.lock().unwrap().push(input.worktree_id);
        Box::pin(async move { ComputeOutcome::ok(1, 0) }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // Mark wt-2 recently active, but hint_focus on wt-1.
    poller.mark_dirty("wt-2");
    poller.hint_focus("wt-1");
    settle().await;

    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS + 100)).await;
    settle().await;

    let order = execution_order.lock().unwrap().clone();
    assert!(!order.is_empty());
    assert_eq!(
        order[0], "wt-1",
        "focused worktree (priority u64::MAX) must be computed first"
    );

    handle.abort();
}

// ---- 5. spacing 5 s + trailing run ----------------------------------------

#[tokio::test(start_paused = true)]
async fn spacing_five_seconds_and_trailing_run() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);

    let compute_starts = Arc::new(Mutex::new(Vec::new()));
    let starts = compute_starts.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        starts.lock().unwrap().push(tokio::time::Instant::now());
        Box::pin(async move {
            // Compute takes 500ms.
            tokio::time::sleep(Duration::from_millis(500)).await;
            ComputeOutcome::ok(1, 0)
        }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;

    // Advance 2s past debounce. First compute starts at t = 2s.
    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS)).await;
    settle().await;

    assert_eq!(compute_starts.lock().unwrap().len(), 1);

    // While first compute is in-flight, mark dirty again.
    poller.mark_dirty("wt-1");
    settle().await;

    // Advance 500ms: first compute finishes at t = 2.5s.
    tokio::time::advance(Duration::from_millis(500)).await;
    settle().await;

    // Advance 2s more (at t = 4.5s): spacing of 5s from start (t = 2s) has NOT elapsed.
    tokio::time::advance(Duration::from_secs(2)).await;
    settle().await;
    assert_eq!(
        compute_starts.lock().unwrap().len(),
        1,
        "trailing run must not start before the 5 s spacing floor"
    );

    // Advance 3s more (now t = 7.5s, past t = 2s + 5s = 7s).
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    assert_eq!(
        compute_starts.lock().unwrap().len(),
        2,
        "trailing run must execute once min spacing is satisfied"
    );

    let starts = compute_starts.lock().unwrap().clone();
    assert!(
        starts[1].duration_since(starts[0]) >= Duration::from_millis(DIFFSTAT_MIN_SPACING_MS),
        "starts must be at least 5 s apart"
    );

    handle.abort();
}

// ---- 6. semaphore cap observed --------------------------------------------

#[tokio::test(start_paused = true)]
async fn semaphore_cap_observed_under_burst() {
    let (_dir, store, paths) =
        seed_store(vec![project("p1", &["wt-1", "wt-2", "wt-3", "wt-4"])]).await;
    let broadcaster = Broadcaster::new(64);

    let active_computes = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));

    let active = active_computes.clone();
    let max = max_active.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        let active = active.clone();
        let max = max.clone();
        Box::pin(async move {
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            max.fetch_max(current, Ordering::SeqCst);
            // Hold permit briefly.
            tokio::time::sleep(Duration::from_millis(300)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            ComputeOutcome::ok(1, 0)
        }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // Trigger all 4 worktrees.
    for id in ["wt-1", "wt-2", "wt-3", "wt-4"] {
        poller.mark_dirty(id);
    }
    settle().await;

    // Advance through the whole process.
    tokio::time::advance(Duration::from_secs(5)).await;
    settle().await;

    assert!(
        max_active.load(Ordering::SeqCst) <= DIFFSTAT_IN_FLIGHT,
        "concurrent compute tasks must never exceed DIFFSTAT_IN_FLIGHT ({DIFFSTAT_IN_FLIGHT}), saw {}",
        max_active.load(Ordering::SeqCst)
    );

    handle.abort();
}

// ---- 7. unchanged result ⇒ no event ---------------------------------------

#[tokio::test(start_paused = true)]
async fn unchanged_result_emits_no_event() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let compute = Arc::new(move |_input: ComputeInput| {
        Box::pin(async move { ComputeOutcome::ok(7, 3) }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;

    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    // First run emits one WorktreeDiffStat event.
    let ev1 = rx.try_recv().expect("first event");
    assert!(matches!(
        ev1,
        ServerEvent::WorktreeDiffStat {
            insertions: 7,
            deletions: 3,
            ..
        }
    ));

    // Second run with identical outcome.
    tokio::time::advance(Duration::from_secs(6)).await;
    poller.mark_dirty("wt-1");
    settle().await;

    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    assert!(
        matches!(rx.try_recv(), Err(TryRecvError::Empty)),
        "unchanged compute outcome must not broadcast a second event"
    );

    handle.abort();
}

// ---- 8. changed result ⇒ event with higher rev ----------------------------

#[tokio::test(start_paused = true)]
async fn changed_result_emits_event_with_higher_rev() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let call_count = Arc::new(AtomicUsize::new(0));
    let calls = call_count.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if n == 0 {
                ComputeOutcome::ok(7, 3)
            } else {
                ComputeOutcome::ok(10, 4)
            }
        }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    let (rev1, ins1) = match rx.try_recv().expect("first event") {
        ServerEvent::WorktreeDiffStat {
            insertions, rev, ..
        } => (rev, insertions),
        other => panic!("expected WorktreeDiffStat, got {other:?}"),
    };
    assert_eq!(ins1, 7);

    // Second run with changed numbers.
    tokio::time::advance(Duration::from_secs(6)).await;
    poller.mark_dirty("wt-1");
    settle().await;
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    let (rev2, ins2) = match rx.try_recv().expect("second event") {
        ServerEvent::WorktreeDiffStat {
            insertions, rev, ..
        } => (rev, insertions),
        other => panic!("expected WorktreeDiffStat, got {other:?}"),
    };
    assert_eq!(ins2, 10);
    assert!(
        rev2 > rev1,
        "changed outcome must have a higher monotonic rev (rev2={rev2} > rev1={rev1})"
    );

    handle.abort();
}

// ---- 9. eviction on worktree deleted --------------------------------------

#[tokio::test(start_paused = true)]
async fn eviction_removes_deleted_worktree_from_cache_and_state() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1", "wt-2"])]).await;
    let broadcaster = Broadcaster::new(64);

    let compute = Arc::new(move |_input: ComputeInput| {
        Box::pin(async move { ComputeOutcome::ok(1, 1) }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store.clone(), broadcaster.clone(), paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    poller.mark_dirty("wt-2");
    settle().await;
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    let snap_before = poller.snapshot().await;
    assert!(snap_before.stats.contains_key("wt-1"));
    assert!(snap_before.stats.contains_key("wt-2"));

    // Remove from store and broadcast event.
    store
        .mutate_project("p1", |p| {
            p.worktrees.retain(|w| w.id != "wt-1");
            Ok(p.clone())
        })
        .await
        .unwrap();
    broadcaster.send(ServerEvent::WorktreeDeleted {
        worktree_id: "wt-1".into(),
    });
    // Allow spawn_blocking in store handle to finish and poller to process.
    tokio::time::sleep(Duration::from_millis(50)).await;
    settle().await;

    let snap_after = poller.snapshot().await;
    assert!(
        !snap_after.stats.contains_key("wt-1"),
        "wt-1 must be evicted after deletion"
    );
    assert!(snap_after.stats.contains_key("wt-2"));
    assert!(!poller.has_pending("wt-1"));

    handle.abort();
}

// ---- 10. sweep cycle length asserted --------------------------------------

#[test]
fn sweep_cycle_length_is_approx_300_seconds() {
    assert_eq!(
        sweep_period_for(0),
        Duration::from_secs(DIFFSTAT_SWEEP_SECS)
    );
    assert_eq!(sweep_period_for(1), Duration::from_secs(300));
    assert_eq!(sweep_period_for(10), Duration::from_secs(30));
    assert_eq!(sweep_period_for(50), Duration::from_secs(6));
    assert_eq!(sweep_period_for(100), Duration::from_secs(3));
    assert_eq!(sweep_period_for(300), Duration::from_secs(1));
    assert_eq!(sweep_period_for(600), Duration::from_secs(1));

    // Full cycle for N worktrees (up to 300) is ~300 s.
    for n in [1, 5, 10, 20, 50, 60, 100, 150, 300] {
        let period = sweep_period_for(n);
        let total = period.as_secs() * n as u64;
        assert!(
            (290..=310).contains(&total),
            "N={n} cycle should be approx 300s, got {total}s"
        );
    }
}

// ---- 11. sweep skips broken worktree ---------------------------------------

#[tokio::test(start_paused = true)]
async fn sweep_skips_broken_worktree_unless_stamp_changes() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-broken", "wt-live"])]).await;
    let broadcaster = Broadcaster::new(64);

    let broken_path = paths.worktree_path("p1", "wt-broken");
    std::fs::create_dir_all(&broken_path).expect("create broken wt dir");
    std::fs::write(broken_path.join(".git"), "gitdir: /nonexistent/path\n").expect("write .git");
    let stamp = git_file_stamp(&broken_path);
    assert!(stamp.is_some());

    let swept_worktrees = Arc::new(Mutex::new(Vec::new()));
    let swept = swept_worktrees.clone();
    let compute = Arc::new(move |input: ComputeInput| {
        swept.lock().unwrap().push(input.worktree_id.clone());
        Box::pin(async move {
            if input.worktree_id == "wt-broken" {
                ComputeOutcome::broken(stamp)
            } else {
                ComputeOutcome::ok(2, 1)
            }
        }) as _
    });

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths.clone())
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // First mark wt-broken so it computes and enters Broken state in cache.
    poller.mark_dirty("wt-broken");
    settle().await;
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    let snap = poller.snapshot().await;
    assert_eq!(snap.stats["wt-broken"].state, DiffStatState::Broken);

    swept_worktrees.lock().unwrap().clear();

    // Advance 6s so wt-live is well past its initial boot min spacing (5s).
    tokio::time::advance(Duration::from_secs(6)).await;
    settle().await;

    // Now run sweep_once(): wt-broken must be skipped because its .git is unchanged,
    // so wt-live is marked instead!
    poller.sweep_once().await;
    settle().await;

    // Advance past debounce so the swept worktree computes.
    tokio::time::advance(Duration::from_secs(3)).await;
    settle().await;

    let computed = swept_worktrees.lock().unwrap().clone();
    assert_eq!(
        computed,
        vec!["wt-live"],
        "sweep must skip unchanged broken worktree and compute wt-live"
    );

    handle.abort();
}

// ---- R1F-10: the driver acquires permits; a backlog is never over-taken -----

#[tokio::test(start_paused = true)]
async fn focus_hint_during_a_blocked_backlog_is_computed_next() {
    let ids = ["wt-1", "wt-2", "wt-3", "wt-4", "wt-5", "wt-6"];
    let (_dir, store, paths) = seed_store(vec![project("p1", &ids)]).await;
    let broadcaster = Broadcaster::new(64);

    let started = Arc::new(Mutex::new(Vec::<String>::new()));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let compute = {
        let started = started.clone();
        let release = release.clone();
        Arc::new(move |input: ComputeInput| {
            let started = started.clone();
            let release = release.clone();
            Box::pin(async move {
                started.lock().unwrap().push(input.worktree_id);
                release.acquire().await.expect("open").forget();
                ComputeOutcome::ok(1, 0)
            }) as _
        })
    };

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;

    // Let the boot backlog (all 6, debounce 2 s) come due. Every compute is
    // blocked, so exactly DIFFSTAT_IN_FLIGHT may have started: the rest must
    // stay in the coalescer, not queue on the semaphore.
    tokio::time::advance(Duration::from_millis(DIFFSTAT_DEBOUNCE_MS + 100)).await;
    settle().await;
    let first_wave = started.lock().unwrap().clone();
    assert_eq!(first_wave.len(), DIFFSTAT_IN_FLIGHT, "no over-take");

    let focused = ids
        .iter()
        .find(|id| !first_wave.iter().any(|s| s == *id))
        .copied()
        .expect("a worktree that has not started");
    poller.hint_focus(focused);
    settle().await;
    assert_eq!(started.lock().unwrap().len(), DIFFSTAT_IN_FLIGHT);

    // One compute finishes: the focused worktree is the next one to start,
    // ahead of the other already-due backlog keys.
    release.add_permits(1);
    settle().await;
    let after = started.lock().unwrap().clone();
    assert_eq!(after.len(), DIFFSTAT_IN_FLIGHT + 1);
    assert_eq!(after[DIFFSTAT_IN_FLIGHT], focused);

    handle.abort();
}

// ---- R1F-11: eviction reaches the computer's caches -------------------------

fn git_in(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn forget_evicts_the_computers_choice_cache() {
    let (dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let repo = paths.worktree_path("p1", "wt-1");
    std::fs::create_dir_all(&repo).expect("repo dir");
    git_in(&repo, &["init", "-q", "-b", "main"]);
    git_in(&repo, &["config", "user.email", "t@example.com"]);
    git_in(&repo, &["config", "user.name", "T"]);
    std::fs::write(repo.join("f"), "a\n").expect("write");
    git_in(&repo, &["add", "f"]);
    git_in(&repo, &["commit", "-qm", "c1"]);

    let computer = Arc::new(vst_diffstat::compute::DiffStatComputer::new());
    let poller = Arc::new(
        DiffStatPollerHandle::new(store, Broadcaster::new(64), paths)
            .with_client_count(Arc::new(|| 1))
            .with_computer(computer.clone()),
    );
    let handle = poller.clone().start();
    // Zero-debounce focus hint: no 2 s wait on the real clock.
    tokio::time::sleep(Duration::from_millis(50)).await;
    poller.hint_focus("wt-1");
    for _ in 0..200 {
        if computer.cached_choices() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(computer.cached_choices(), 1);

    poller.forget("wt-1");
    assert_eq!(computer.cached_choices(), 0);

    handle.abort();
    drop(dir);
}

#[tokio::test(start_paused = true)]
async fn a_compute_finishing_after_forget_does_not_resurrect_the_entry() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let compute = {
        let entered = entered.clone();
        let release = release.clone();
        Arc::new(move |_input: ComputeInput| {
            let entered = entered.clone();
            let release = release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                ComputeOutcome::ok(3, 1)
            }) as _
        })
    };

    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );
    let handle = poller.clone().start();
    settle().await;
    poller.hint_focus("wt-1");
    settle().await;
    entered.notified().await;

    poller.forget("wt-1");
    release.notify_one();
    settle().await;

    loop {
        match rx.try_recv() {
            Ok(ServerEvent::WorktreeDiffStat { .. }) => {
                panic!("no diffstat broadcast for a forgotten worktree")
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    // The worktree is still in the store, so the snapshot lists it as a
    // never-computed `unknown` (rev 0) - never the late compute's value.
    let snap = poller.snapshot().await;
    assert!(snap
        .stats
        .get("wt-1")
        .is_none_or(|e| e.state == DiffStatState::Unknown && e.rev == 0));

    handle.abort();
}

// ---- R1F-14: event right after start() is not missed -----------------------

#[tokio::test(start_paused = true)]
async fn event_sent_right_after_start_is_not_missed() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);
    let computed = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = computed.clone();
    let compute = Arc::new(move |input: ComputeInput| {
        log.lock().unwrap().push(input.worktree_id.clone());
        Box::pin(async move { ComputeOutcome::ok(1, 1) }) as _
    });
    let clients = Arc::new(AtomicUsize::new(0));
    let c = clients.clone();
    let poller = Arc::new(
        DiffStatPollerHandle::new(store.clone(), broadcaster.clone(), paths)
            .with_client_count(Arc::new(move || c.load(Ordering::SeqCst)))
            .with_compute(compute),
    );
    let handle = poller.clone().start();

    let new_wt = project("p1", &["wt-2"]).worktrees.remove(0);
    store
        .mutate_project("p1", |p| {
            p.worktrees.push(new_wt);
            Ok(p.clone())
        })
        .await
        .unwrap();
    let mut payload = serde_json::Map::new();
    payload.insert("id".into(), serde_json::json!("wt-2"));
    broadcaster.send(ServerEvent::WorktreeCreated { worktree: payload });

    clients.store(1, Ordering::SeqCst);
    poller.hint_focus("wt-2");
    settle().await;
    tokio::time::advance(Duration::from_secs(10)).await;
    settle().await;

    assert!(
        computed.lock().unwrap().iter().any(|id| id == "wt-2"),
        "worktree announced right after start must compute"
    );
    handle.abort();
}

// ---- R1F-15: never-computed worktree is a visible `unknown` ----------------

#[tokio::test(start_paused = true)]
async fn snapshot_reports_unknown_for_never_computed_worktree() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1"])]).await;
    let broadcaster = Broadcaster::new(64);
    let mut rx = broadcaster.subscribe();
    let clients = Arc::new(AtomicUsize::new(0));
    let c = clients.clone();
    let compute = Arc::new(move |_input: ComputeInput| {
        Box::pin(async move { ComputeOutcome::ok(3, 4) }) as _
    });
    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(move || c.load(Ordering::SeqCst)))
            .with_compute(compute),
    );

    let snap = poller.snapshot().await;
    let entry = snap.stats.get("wt-1").expect("known worktree is listed");
    assert_eq!(entry.state, DiffStatState::Unknown);
    assert_eq!(entry.rev, 0);

    let handle = poller.clone().start();
    clients.store(1, Ordering::SeqCst);
    settle().await;
    tokio::time::advance(Duration::from_secs(10)).await;
    settle().await;

    let mut rev = 0;
    while let Ok(event) = rx.try_recv() {
        if let ServerEvent::WorktreeDiffStat { rev: r, .. } = event {
            rev = r;
        }
    }
    assert!(rev > 0, "first real result must broadcast with rev > 0");
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn sweep_ticks_do_not_call_store_after_first() {
    let (_dir, store, paths) = seed_store(vec![project("p1", &["wt-1", "wt-2"])]).await;
    let broadcaster = Broadcaster::new(64);
    let compute = Arc::new(move |_input: ComputeInput| {
        Box::pin(async move { ComputeOutcome::ok(1, 1) }) as _
    });
    let poller = Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute),
    );

    assert_eq!(poller.store_refreshes(), 0);

    // First sweep refreshes because index is empty
    poller.sweep_once().await;
    assert_eq!(poller.store_refreshes(), 1);

    // Subsequent N sweep ticks do not call store
    for _ in 0..10 {
        poller.sweep_once().await;
        assert_eq!(
            poller.store_refreshes(),
            1,
            "sweep ticks must read from cached index and not re-query store"
        );
    }
}
