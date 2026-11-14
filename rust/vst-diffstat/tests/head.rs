//! `worktree:head` observation and the bounded background base refresh
//! (plan `tools-pane-rework` A3.T3). Paused tokio time; the compute and the
//! base fetch are injected, so no `git` process runs. Head and base are read
//! from a fake `.git` layout written under the worktree path.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast::Receiver;
use tokio::sync::Notify;
use vst_diffstat::compute::{ComputeInput, ComputeOutcome};
use vst_diffstat::head::FetchFn;
use vst_diffstat::{BoxFuture, DiffStatPollerHandle};
use vst_git::Paths;
use vst_store::StoreHandle;
use vst_types::domain::{
    LifecycleState, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::ProjectRecord;

// ---- helpers ---------------------------------------------------------------

fn sha(c: char) -> String {
    c.to_string().repeat(40)
}

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

fn project(id: &str, worktree_id: &str) -> ProjectRecord {
    let session_id = format!("{worktree_id}-s1");
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
        worktrees: vec![WorktreeRecord {
            id: worktree_id.into(),
            name: None,
            branch: "feat".into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: sha('0'),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(1),
            lsp_enabled: None,
            sessions: vec![session(&session_id, worktree_id, id)],
            open_files: vec![],
        }],
        next_worktree_num: Some(2),
        lsp_enabled: None,
        open_files: vec![],
    }
}

async fn seed_store() -> (tempfile::TempDir, StoreHandle, Paths) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = StoreHandle::open(dir.path().join("test.db")).expect("store");
    store
        .add_project(project("p1", "wt-1"))
        .await
        .expect("add project");
    let paths = Paths::with_home(dir.path().join("home"));
    (dir, store, paths)
}

/// A fake checkout: `.git/HEAD` -> `refs/heads/feat`, plus the loose refs.
fn write_checkout(paths: &Paths, head: &str, base: &str) -> PathBuf {
    let wt = paths.worktree_path("p1", "wt-1");
    let git = wt.join(".git");
    std::fs::create_dir_all(git.join("refs/heads")).unwrap();
    std::fs::create_dir_all(git.join("refs/remotes/origin")).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/feat\n").unwrap();
    write_ref(&wt, "refs/heads/feat", head);
    write_ref(&wt, "refs/remotes/origin/main", base);
    wt
}

fn write_ref(wt: &Path, name: &str, value: &str) {
    std::fs::write(wt.join(".git").join(name), format!("{value}\n")).unwrap();
}

/// Yield repeatedly to let spawned tasks run.
async fn settle() {
    for _ in 0..25 {
        tokio::task::yield_now().await;
    }
}

/// Mark the worktree dirty and advance past the debounce so one compute runs.
async fn tick(poller: &DiffStatPollerHandle) {
    poller.mark_dirty("wt-1");
    settle().await;
    tokio::time::advance(Duration::from_secs(6)).await;
    settle().await;
}

/// `(headSha, baseSha, rev)` of every `worktree:head` event received so far.
fn head_events(rx: &mut Receiver<ServerEvent>) -> Vec<(Option<String>, Option<String>, u64)> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let ServerEvent::WorktreeHead {
            head_sha,
            base_sha,
            rev,
            ..
        } = event
        {
            out.push((head_sha, base_sha, rev));
        }
    }
    out
}

fn ok_compute() -> vst_diffstat::ComputeFn {
    Arc::new(move |_input: ComputeInput| {
        Box::pin(async move { ComputeOutcome::ok(1, 0) }) as BoxFuture<'static, _>
    })
}

fn inert_fetch() -> FetchFn {
    Arc::new(|_repo: String, _base: String| Box::pin(async { false }) as BoxFuture<'static, bool>)
}

fn build(
    store: StoreHandle,
    broadcaster: Broadcaster,
    paths: Paths,
    compute: vst_diffstat::ComputeFn,
    fetch: FetchFn,
) -> Arc<DiffStatPollerHandle> {
    Arc::new(
        DiffStatPollerHandle::new(store, broadcaster, paths)
            .with_client_count(Arc::new(|| 1))
            .with_compute(compute)
            .with_fetch(fetch),
    )
}

// ---- tests -----------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn first_observation_emits_exactly_one_head_event() {
    let (_dir, store, paths) = seed_store().await;
    let wt = write_checkout(&paths, &sha('a'), &sha('b'));
    assert!(wt.join(".git").is_dir());
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let poller = build(store, broadcaster, paths, ok_compute(), inert_fetch());
    let handle = poller.clone().start();
    settle().await;

    tick(&poller).await;
    let events = head_events(&mut rx);
    assert_eq!(events.len(), 1, "first observation: {events:?}");
    let (head, base, rev) = &events[0];
    assert_eq!(head.as_deref(), Some(sha('a').as_str()));
    assert_eq!(base.as_deref(), Some(sha('b').as_str()));
    assert!(*rev > 0);
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn moved_head_emits_one_event_with_higher_rev() {
    let (_dir, store, paths) = seed_store().await;
    let wt = write_checkout(&paths, &sha('a'), &sha('b'));
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let poller = build(store, broadcaster, paths, ok_compute(), inert_fetch());
    let handle = poller.clone().start();
    settle().await;

    tick(&poller).await;
    let first = head_events(&mut rx);
    assert_eq!(first.len(), 1);

    write_ref(&wt, "refs/heads/feat", &sha('c'));
    tick(&poller).await;
    let second = head_events(&mut rx);
    assert_eq!(second.len(), 1, "one event for the moved head: {second:?}");
    assert_eq!(second[0].0.as_deref(), Some(sha('c').as_str()));
    assert!(second[0].2 > first[0].2, "rev must increase");
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn unchanged_compute_emits_no_head_event() {
    let (_dir, store, paths) = seed_store().await;
    let _wt = write_checkout(&paths, &sha('a'), &sha('b'));
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let poller = build(store, broadcaster, paths, ok_compute(), inert_fetch());
    let handle = poller.clone().start();
    settle().await;

    tick(&poller).await;
    assert_eq!(head_events(&mut rx).len(), 1);
    tick(&poller).await;
    tick(&poller).await;
    assert!(head_events(&mut rx).is_empty(), "no change, no event");
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn compute_finishing_after_forget_emits_nothing_and_keeps_no_state() {
    let (_dir, store, paths) = seed_store().await;
    let _wt = write_checkout(&paths, &sha('a'), &sha('b'));
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let blocked: vst_diffstat::ComputeFn = Arc::new(move |_input: ComputeInput| {
        let gate = gate.clone();
        Box::pin(async move {
            gate.notified().await;
            ComputeOutcome::ok(1, 0)
        }) as BoxFuture<'static, _>
    });
    let poller = build(store, broadcaster, paths, blocked, inert_fetch());
    let handle = poller.clone().start();
    settle().await;

    poller.mark_dirty("wt-1");
    settle().await;
    tokio::time::advance(Duration::from_secs(6)).await;
    settle().await;
    // The compute is parked on the gate; the worktree goes away meanwhile.
    poller.forget("wt-1");
    release.notify_one();
    settle().await;

    assert!(
        head_events(&mut rx).is_empty(),
        "forgotten worktree emits nothing"
    );
    assert!(
        !poller.head_state_tracked("wt-1"),
        "no heads entry re-created"
    );
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn failing_fetch_backs_off_30_then_60_seconds_and_keeps_last_base() {
    let (_dir, store, paths) = seed_store().await;
    let _wt = write_checkout(&paths, &sha('a'), &sha('b'));
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let failing: FetchFn = Arc::new(move |_repo: String, _base: String| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { false }) as BoxFuture<'static, bool>
    });
    let poller = build(store, broadcaster, paths, ok_compute(), failing);
    let handle = poller.clone().start();
    settle().await;

    tick(&poller).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1, "first observation fetches");
    let u1 = tokio::time::Instant::now();
    // The first attempt ran at or just before `u1`, so the second is due no
    // earlier than `u1 + 24 s`; hold through `u1 + 18 s`.
    while tokio::time::Instant::now() < u1 + Duration::from_secs(18) {
        tick(&poller).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no retry inside 30 s");
    }
    for _ in 0..10 {
        if calls.load(Ordering::SeqCst) >= 2 {
            break;
        }
        tick(&poller).await;
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "second attempt after ~30 s"
    );
    let u2 = tokio::time::Instant::now();
    // The second attempt is due no earlier than `u2 + 48 s` (60 s minus a tick).
    while tokio::time::Instant::now() < u2 + Duration::from_secs(48) {
        tick(&poller).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "no retry inside 60 s");
    }
    for _ in 0..10 {
        if calls.load(Ordering::SeqCst) >= 3 {
            break;
        }
        tick(&poller).await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 3, "third attempt after ~60 s");

    // The base never moved: the last-known base stays, so only the first
    // observation was announced.
    let events = head_events(&mut rx);
    assert_eq!(
        events.len(),
        1,
        "failed fetches announce nothing: {events:?}"
    );
    assert_eq!(events[0].1.as_deref(), Some(sha('b').as_str()));
    handle.abort();
}

#[tokio::test(start_paused = true)]
async fn base_moved_by_successful_fetch_emits_one_event() {
    let (_dir, store, paths) = seed_store().await;
    let wt = write_checkout(&paths, &sha('a'), &sha('b'));
    let broadcaster = Broadcaster::new(256);
    let mut rx = broadcaster.subscribe();
    let base_ref = wt.join(".git/refs/remotes/origin/main");
    let new_base = sha('d');
    let fetch: FetchFn = Arc::new(move |_repo: String, _base: String| {
        // Stands in for `git fetch origin main` moving the remote-tracking ref.
        std::fs::write(&base_ref, format!("{new_base}\n")).unwrap();
        Box::pin(async { true }) as BoxFuture<'static, bool>
    });
    let poller = build(store, broadcaster, paths, ok_compute(), fetch);
    let handle = poller.clone().start();
    settle().await;

    tick(&poller).await;
    let events = head_events(&mut rx);
    // The first observation (base b), then the post-fetch re-observation (base d).
    assert_eq!(
        events.len(),
        2,
        "initial + one for the moved base: {events:?}"
    );
    assert_eq!(events[0].1.as_deref(), Some(sha('b').as_str()));
    assert_eq!(events[1].1.as_deref(), Some(sha('d').as_str()));
    assert!(events[1].2 > events[0].2);

    // A later compute with nothing moved and the fetch now spaced out: silence.
    tick(&poller).await;
    assert!(head_events(&mut rx).is_empty());
    handle.abort();
}
