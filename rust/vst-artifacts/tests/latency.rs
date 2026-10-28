//! 2.T13: list latency with changed files — revalidation is stat-only and the
//! hashes land afterwards as ONE batched event.

mod common;

use std::time::{Duration, Instant};

use common::Env;
use vst_types::ServerEvent;

const BODY: usize = 2 * 1024 * 1024;

#[tokio::test]
async fn list_never_hashes_inline_and_hashes_arrive_batched() {
    let mut env = Env::new().await;
    let big: Vec<_> = (0..50)
        .map(|i| env.file(&env.out(&format!("big{i:02}.md")), &"x".repeat(BODY)))
        .collect();
    let small: Vec<_> = (0..450)
        .map(|i| env.file(&env.out(&format!("s{i:03}.md")), &format!("small {i}")))
        .collect();
    for f in big.iter().chain(&small) {
        env.record("sess-a", f);
    }
    env.handle.drain_now().await;
    let before = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(before.total, 500);
    let order_before: Vec<String> = before.items.iter().map(|r| r.id.clone()).collect();
    let edits_before: Vec<u32> = before.items.iter().map(|r| r.edit_count).collect();
    let _ = env.events();

    // Change size + mtime of the 50 big files (still ~2 MiB bodies).
    std::thread::sleep(Duration::from_millis(20));
    for f in &big {
        std::fs::write(f, "y".repeat(BODY + 1)).unwrap();
    }

    env.handle.clear_revalidation_debounce();
    let stats_before = env.handle.revalidation_stat_count();
    let t = Instant::now();
    let first = env.handle.list(&env.scope).await.unwrap();
    let first_ms = t.elapsed();
    assert_eq!(first.items.len(), 500);
    assert_eq!(env.handle.revalidation_stat_count() - stats_before, 500);

    // A second list inside the 2 s debounce does no lstat at all.
    let stats = env.handle.revalidation_stat_count();
    let _ = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(env.handle.revalidation_stat_count(), stats);

    // p95 over 20 runs (the first run is the one with 50 changed rows).
    let mut times = vec![first_ms];
    for _ in 0..19 {
        env.handle.clear_revalidation_debounce();
        let t = Instant::now();
        env.handle.list(&env.scope).await.unwrap();
        times.push(t.elapsed());
    }
    times.sort();
    let p95 = times[18];
    // A wall-clock budget depends on the machine: enforced only when asked for
    // (`VST_PERF_TESTS=1`); the behavioural assertions below always run.
    if std::env::var_os("VST_PERF_TESTS").is_some() {
        assert!(
            p95 < Duration::from_millis(150),
            "p95 {p95:?} (first {first_ms:?})"
        );
    } else {
        eprintln!("p95 {p95:?} (first {first_ms:?}); budget not enforced without VST_PERF_TESTS");
    }

    // The background pool lands the new measurements: wait for them.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = env.store.list_artifacts(&env.scope).await.unwrap();
        if rows
            .iter()
            .filter(|r| r.size == Some(BODY as u64 + 1))
            .count()
            == 50
        {
            break;
        }
        assert!(Instant::now() < deadline, "rehash never finished");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Let the last job's follow-up (scope merge pass) finish too.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let ev = env.events();
    let batches: Vec<usize> = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactUpserted { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .collect();
    assert_eq!(
        batches,
        vec![50],
        "one batched event with the 50 refreshed rows: {batches:?}"
    );

    env.handle.clear_revalidation_debounce();
    let after = env.handle.list(&env.scope).await.unwrap();
    let order_after: Vec<String> = after.items.iter().map(|r| r.id.clone()).collect();
    assert_eq!(
        order_before, order_after,
        "a background rehash never reorders"
    );
    let edits_after: Vec<u32> = after.items.iter().map(|r| r.edit_count).collect();
    assert_eq!(edits_before, edits_after, "nor does it bump editCount");
    let grown = after
        .items
        .iter()
        .filter(|r| r.size == Some(BODY as u64 + 1))
        .count();
    assert_eq!(grown, 50);
}
