//! Boot-time orphan purge for the `artifacts` table.
//!
//! `artifacts` has no foreign keys (a project save re-inserts worktrees and
//! sessions), so rows of deleted worktrees/projects are swept at boot. The
//! sweep is only safe when the `projects`/`worktrees` tables are complete, and
//! `migrate_manifests` failure is non-fatal in `run.rs`: a partial migration
//! leaves projects absent that return on the next good boot. So the purge runs
//! ONLY when migration succeeded on THIS boot (and the store additionally
//! refuses when `projects` is empty).

use std::fmt::Display;

use vst_store::StoreHandle;

/// Purge artifact rows of unknown worktrees/projects, gated on the manifest
/// migration outcome of this boot. Returns the number of rows removed, or
/// `None` when the purge was skipped (migration failed) or itself failed.
pub async fn purge_orphan_artifacts_after_migration<T, E: Display>(
    store: &StoreHandle,
    migration: &Result<T, E>,
) -> Option<usize> {
    if let Err(e) = migration {
        tracing::warn!(
            "[vst] artifact orphan purge skipped: manifest migration failed this boot: {e}"
        );
        return None;
    }
    match store.purge_orphan_artifacts().await {
        Ok(n) => {
            if n > 0 {
                tracing::info!("[vst] purged {n} orphaned artifact row(s)");
            }
            Some(n)
        }
        Err(e) => {
            tracing::warn!("[vst] artifact orphan purge failed (non-fatal): {e}");
            None
        }
    }
}
