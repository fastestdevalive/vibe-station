//! Boot-time orphan purge for review comments.
//!
//! `comments` (held rows included) has no foreign keys (a
//! project save re-inserts worktrees and sessions), so rows of deleted
//! worktrees / projects are swept at boot. Same safety rule as
//! [`crate::artifact_boot`]: only when the manifest migration succeeded on THIS
//! boot (a partial migration looks like "the user deleted everything"), and the
//! store additionally refuses when `projects` is empty.

use std::fmt::Display;

use vst_store::StoreHandle;

/// Purge comment rows of unknown worktrees / projects, gated on the manifest
/// migration outcome of this boot. Returns the number of comments removed, or
/// `None` when the purge was skipped (migration failed) or itself failed.
pub async fn purge_orphan_comments_after_migration<T, E: Display>(
    store: &StoreHandle,
    migration: &Result<T, E>,
) -> Option<usize> {
    if let Err(e) = migration {
        tracing::warn!(
            "[vst] comment orphan purge skipped: manifest migration failed this boot: {e}"
        );
        return None;
    }
    match store.purge_orphan_comments().await {
        Ok(n) => {
            if n > 0 {
                tracing::info!("[vst] purged {n} orphaned comment(s)");
            }
            Some(n)
        }
        Err(e) => {
            tracing::warn!("[vst] comment orphan purge failed (non-fatal): {e}");
            None
        }
    }
}
