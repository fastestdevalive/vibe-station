//! `stat_content`: metadata through the hardened open, scope-checked, never bytes.

mod common;

use common::Env;
use vst_artifacts::ArtifactStatOutcome;
use vst_types::artifacts::ScopeKey;

async fn written_row(env: &Env, name: &str, body: &str) -> (std::path::PathBuf, String) {
    let p = env.file(&env.out(name), body);
    env.write_now("sess-a", &p).await;
    let id = env.handle.list(&env.scope).await.unwrap().items[0]
        .id
        .clone();
    (p, id)
}

#[tokio::test]
async fn written_file_stats_with_size_mtime_and_canonical_path() {
    let env = Env::new().await;
    let (p, id) = written_row(&env, "a.md", "hello stat").await;

    match env.handle.stat_content(&env.scope, &id).await {
        ArtifactStatOutcome::Found {
            size,
            modified_ms,
            path,
            in_repo,
        } => {
            assert_eq!(size, "hello stat".len() as u64);
            assert!(
                modified_ms > 0,
                "mtime must be a real unix ms: {modified_ms}"
            );
            assert_eq!(path, p.to_string_lossy());
            assert!(!in_repo, "written outside the repo root");
        }
        other => panic!("expected Found, got {other:?}"),
    }
}

#[tokio::test]
async fn same_id_under_another_scope_is_not_found() {
    let env = Env::new().await;
    let (_p, id) = written_row(&env, "a.md", "x").await;
    let other = ScopeKey::worktree("wt-2");
    assert_eq!(
        env.handle.stat_content(&other, &id).await,
        ArtifactStatOutcome::NotFound
    );
}

#[tokio::test]
async fn deleted_file_is_missing() {
    let env = Env::new().await;
    let (p, id) = written_row(&env, "a.md", "gone soon").await;
    std::fs::remove_file(&p).unwrap();
    assert_eq!(
        env.handle.stat_content(&env.scope, &id).await,
        ArtifactStatOutcome::Missing
    );
}

#[tokio::test]
async fn unknown_id_is_not_found() {
    let env = Env::new().await;
    assert_eq!(
        env.handle.stat_content(&env.scope, "no-such-id").await,
        ArtifactStatOutcome::NotFound
    );
}

#[tokio::test]
async fn denylisted_row_is_denied() {
    let env = Env::new().await;
    let (p, id) = written_row(&env, "a.md", "private").await;
    // Re-point the row at a denylisted name (`*.pem`) through the store, so
    // the intake denylist is not what is being exercised; the stat gate is.
    let pem = env.out("secret.pem");
    std::fs::rename(&p, &pem).unwrap();
    let pem_str = pem.to_string_lossy().to_string();
    env.store
        .update_path(&id, &pem_str, &pem_str, false)
        .await
        .unwrap()
        .expect("row re-pointed");
    assert_eq!(
        env.handle.stat_content(&env.scope, &id).await,
        ArtifactStatOutcome::Denied
    );
}
