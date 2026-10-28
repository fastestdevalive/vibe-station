//! 2.T6: bursts are absorbed by the coalescing intake.

mod common;

use common::Env;
use vst_artifacts::intake::MAX_PENDING;
use vst_types::ServerEvent;

#[tokio::test]
async fn five_thousand_effects_over_a_thousand_paths_make_one_batch() {
    let mut env = Env::new().await;
    let files: Vec<_> = (0..1000)
        .map(|i| env.file(&env.out(&format!("p{i:04}.md")), &format!("c{i}")))
        .collect();
    let start = std::time::Instant::now();
    for round in 0..5 {
        for f in &files {
            env.record(if round % 2 == 0 { "sess-a" } else { "sess-b" }, f);
        }
    }
    // Wall-clock budget only on request (`VST_PERF_TESTS=1`): machine dependent.
    if std::env::var_os("VST_PERF_TESTS").is_some() {
        assert!(start.elapsed().as_millis() < 500, "record() is cheap");
    }
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    // 1000 distinct files exceed the 500-row cap: the oldest 500 are dropped.
    assert_eq!(list.total, 500);
    assert!(list.items.iter().all(|r| r.edit_count == 1));

    let ev = env.events();
    let sizes: Vec<usize> = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactUpserted { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .collect();
    let removed: usize = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactRemoved { ids, .. } => Some(ids.len()),
            _ => None,
        })
        .sum();
    assert_eq!(removed, 500, "evicted rows are reported once as removed");
    // Rows dropped by the cap in the same window are never announced as upserts.
    assert_eq!(sizes, vec![200, 200, 100], "one batch, chunked <= 200 rows");
}

#[tokio::test]
async fn intake_is_bounded_and_counts_overflow() {
    let env = Env::new().await;
    for i in 0..(MAX_PENDING + 904) {
        // Never touches the disk on the hot path: nonexistent paths are fine.
        env.record("sess-a", &env.out(&format!("n{i}.md")));
    }
    assert_eq!(env.handle.intake_dropped(), 904);
    env.handle.drain_now().await;
    assert_eq!(
        env.handle.list(&env.scope).await.unwrap().total,
        0,
        "nothing existed"
    );
    // Space is available again after the drain.
    env.record("sess-a", &env.out("again.md"));
    assert_eq!(env.handle.intake_dropped(), 904);
}
