//! Lock-split contract for the transcript store (worktree-switch-latency item 8).
//!
//! `persist_event` used to hold the session `state` mutex — which guards the
//! turn queue, running flag, cancel token, live PIDs and the ACP connection —
//! across `TranscriptStore::append`, a synchronous SQLite write. Every
//! concurrent WS handler that touched any of that blocked for the write's
//! duration; the reproducible symptom was `chat:open`'s snapshot
//! (`read_session_tail` → `tail()`) stalling during a worktree switch while an
//! agent in that worktree was streaming.
//!
//! The store now lives in its own lock (`Inner::store`), a sibling of `state`,
//! and the release latch is an `AtomicBool` read/written under the store lock
//! so "is released, then append" stays atomic across the split. These tests
//! pin all three properties: no contention with `state`, append ordering /
//! `next_seq` monotonicity under concurrency, and the release latch.

mod common;

use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use vst_agents::json_agent_session::{
    read_transcript_from_data_dir, JsonAgentSession, JsonAgentSessionOptions,
};
use vst_agents::paths::Paths;
use vst_types::{Broadcaster, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

const PROJECT_ID: &str = "p1";
const SESSION_ID: &str = "sess-locks-1";

fn ev(n: usize) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{n}"),
        "sessionId": SESSION_ID,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(NormalizedEventKind::Text).unwrap(),
    }))
    .unwrap();
    e.role = Some(vst_types::Role::Assistant);
    e.text = Some(format!("chunk-{n}"));
    e.turn_id = Some("t1".to_string());
    e
}

/// A live session rooted in a temp home. Returns the session plus its
/// on-disk data dir (for reading the transcript back after `release()` has
/// closed the live store).
fn live_session(home: &std::path::Path) -> (JsonAgentSession, std::path::PathBuf) {
    let store_handle =
        vst_store::StoreHandle::open(home.join("vibe-station.db")).expect("open store");
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let mut session = common::make_session(SESSION_ID);
    session.project_id = PROJECT_ID.into();
    let project = common::make_project(PROJECT_ID);

    // The session derives its own data dir from `Paths::default()`, i.e.
    // `home_dir()/.vibe-station` — mirror that, not the bare temp home.
    let data_dir = Paths::with_home(home.join(".vibe-station"))
        .direct_session_data_dir(PROJECT_ID, SESSION_ID);

    let s = JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session,
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    });
    (s, data_dir)
}

/// The point of the lock hoist: a transcript append AND a transcript read both
/// complete while the session-`state` mutex is held by someone else. Before
/// the split, both took `state` and would have blocked for the holder's whole
/// critical section.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transcript_append_and_read_do_not_wait_on_the_state_lock() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let (session, _data_dir) = live_session(dir.path());

    const HOLD: Duration = Duration::from_millis(600);
    let holder_entered = Arc::new(Barrier::new(2));

    let held = session.clone();
    let entered = holder_entered.clone();
    let holder = std::thread::spawn(move || {
        held.with_state_locked_for_test(|| {
            entered.wait();
            std::thread::sleep(HOLD);
        });
    });

    // Don't start timing until the state lock is definitely held.
    holder_entered.wait();
    let started = Instant::now();
    session.persist_event_for_test(&ev(0));
    let page = session.tail(5);
    let elapsed = started.elapsed();

    assert_eq!(page.events.len(), 1, "the append is visible to the reader");
    assert!(
        elapsed < HOLD / 2,
        "append+read must not block on the session-state lock; took {elapsed:?} \
         while the state lock was held for {HOLD:?}"
    );

    holder.join().unwrap();
}

/// Concurrent appends and reads against the one store lock: nothing is lost,
/// nothing deadlocks, and `log_seq` stays strictly monotonic (the property the
/// store's in-memory `next_seq` provides, which the split had to preserve).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_appends_and_reads_preserve_order_and_lose_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let (session, _data_dir) = live_session(dir.path());

    const WRITERS: usize = 4;
    const PER_WRITER: usize = 40;
    const READERS: usize = 2;

    let start = Arc::new(Barrier::new(WRITERS + READERS));
    let mut handles = Vec::new();

    for w in 0..WRITERS {
        let s = session.clone();
        let b = start.clone();
        handles.push(std::thread::spawn(move || {
            b.wait();
            for i in 0..PER_WRITER {
                s.persist_event_for_test(&ev(w * PER_WRITER + i));
            }
        }));
    }
    for _ in 0..READERS {
        let s = session.clone();
        let b = start.clone();
        handles.push(std::thread::spawn(move || {
            b.wait();
            for _ in 0..PER_WRITER {
                // Interleaved reads through both reader shapes.
                let _ = s.tail(3);
                let _ = s.since(0, Some(10));
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let all = session.read_transcript();
    assert_eq!(
        all.len(),
        WRITERS * PER_WRITER,
        "every concurrent append landed exactly once"
    );
    let seqs: Vec<i64> = all.iter().filter_map(|e| e.log_seq).collect();
    assert_eq!(seqs.len(), all.len(), "every stored event has a log_seq");
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "log_seq must be strictly increasing (next_seq monotonicity), got {seqs:?}"
    );
}

/// The invariant the lock split had to preserve explicitly: `persist_event`
/// checks `released` and appends atomically, so no straggler event from an
/// unwinding turn can land after `release()`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn release_latches_appends_off_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let (session, data_dir) = live_session(dir.path());

    for i in 0..5 {
        session.persist_event_for_test(&ev(i));
    }
    assert_eq!(session.read_transcript().len(), 5);

    // Stragglers racing the release: whatever they manage to append must land
    // BEFORE the latch, never after it.
    let straggler = session.clone();
    let stragglers = std::thread::spawn(move || {
        for i in 100..400 {
            straggler.persist_event_for_test(&ev(i));
        }
    });

    session.release().await;
    let after_release = read_transcript_from_data_dir(&data_dir, SESSION_ID).len();

    stragglers.join().unwrap();

    // Post-release appends are no-ops (the latch is set under the store lock,
    // and `release()` closed the store), so the on-disk transcript cannot grow
    // once `release()` has returned.
    let settled = read_transcript_from_data_dir(&data_dir, SESSION_ID).len();
    assert_eq!(
        settled, after_release,
        "no event may be appended after release() returned"
    );
    assert!(settled >= 5, "the pre-release events are still persisted");

    // And an explicit post-release append is a no-op rather than a panic.
    session.persist_event_for_test(&ev(999));
    assert_eq!(
        read_transcript_from_data_dir(&data_dir, SESSION_ID).len(),
        settled
    );
}
