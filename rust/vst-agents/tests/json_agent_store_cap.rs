//! cap + 20 sessions keep the open-store count and the fd count bounded.
//!
//! ONE test fn on purpose: it asserts the process-global open-store gauge, which
//! any parallel test in the same binary would disturb.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use vst_agents::create_claude_plugin;
use vst_agents::json_agent_session::{carry_session_transcript, SessionBreakMarker};
use vst_store::store_budget::{open_transcript_stores, MAX_OPEN_TRANSCRIPT_STORES};
use vst_types::{CarryOver, NormalizedEventProvider, SessionBreakKind};

const SESSIONS: usize = MAX_OPEN_TRANSCRIPT_STORES + 20;

fn open_fds() -> Option<usize> {
    std::fs::read_dir("/dev/fd").ok().map(|d| d.count())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cap_plus_twenty_sessions_stay_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let store = vst_store::StoreHandle::open(dir.path().join("test.db")).unwrap();
    let sessions: Vec<_> = (0..SESSIONS)
        .map(|i| {
            Arc::new(common::seeded_session(
                &store,
                &format!("s-cap-{i}"),
                3,
                Arc::new(create_claude_plugin()),
            ))
        })
        .collect();
    assert_eq!(open_transcript_stores(), 0);
    let fds_before = open_fds();

    // (a) sequential reads: every one returns its rows and nothing stays open.
    for s in &sessions {
        assert_eq!(s.read_transcript().len(), 3);
    }
    assert_eq!(open_transcript_stores(), 0);
    if let (Some(before), Some(after)) = (fds_before, open_fds()) {
        assert!(after <= before + 10, "fd leak: {before} -> {after}");
    }

    // (b) concurrent reads that hold the store open: never above the cap.
    let max_seen = Arc::new(AtomicUsize::new(0));
    let handles: Vec<_> = sessions
        .iter()
        .cloned()
        .map(|s| {
            let max_seen = max_seen.clone();
            std::thread::spawn(move || {
                let lease = s.lease_store().unwrap();
                std::thread::sleep(Duration::from_millis(20));
                max_seen.fetch_max(open_transcript_stores(), Ordering::SeqCst);
                drop(lease);
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert!(
        max_seen.load(Ordering::SeqCst) <= MAX_OPEN_TRANSCRIPT_STORES,
        "open stores peaked at {}",
        max_seen.load(Ordering::SeqCst)
    );
    assert_eq!(open_transcript_stores(), 0);

    // (c) a carry between two sessions while one holds a lease frees everything after.
    let paths = vst_agents::paths::Paths::default();
    let lease = sessions[0].lease_store().unwrap();
    let carried = carry_session_transcript(
        &paths.direct_session_data_dir("p1", "s-cap-0"),
        "s-cap-0",
        &paths.direct_session_data_dir("p1", "s-cap-1"),
        "s-cap-1",
        SessionBreakMarker {
            kind: SessionBreakKind::Reset,
            from_provider: None,
            to_provider: None,
            provider: NormalizedEventProvider::Claude,
            summary: None,
            carry_over: Some(CarryOver::Summary),
            from_mode: None,
            to_mode: None,
            from_account: None,
            to_account: None,
            ts: "2026-01-02T00:00:00Z".into(),
        },
        &[],
    );
    assert!(carried > 0);
    drop(lease);
    assert_eq!(open_transcript_stores(), 0);
}
