//! Boot-time orphan sweep for `draft_texts`.
//!
//! `draft_texts` has no foreign keys (a project save re-inserts worktrees and
//! sessions), so a row can outlive the session/worktree/project it names. Same
//! safety rule as [`crate::review_boot`]: run ONLY when the manifest migration
//! succeeded on THIS boot (a partial migration looks like "the user deleted
//! everything"), and skip when no project is loaded.
//!
//! Empty tombstones whose scope still exists are never purged — deleting one
//! would restart its `revision` at 1 under open clients holding a higher one,
//! making them drop real updates.

use std::fmt::Display;

use vst_store::StoreHandle;

use super::scope_exists;

/// Remove rows whose scope no longer resolves. Returns the number removed, or
/// `None` when the sweep was skipped (migration failed / no projects) or itself
/// failed.
pub async fn sweep_after_migration<T, E: Display>(
    store: &StoreHandle,
    migration: &Result<T, E>,
) -> Option<usize> {
    if let Err(e) = migration {
        tracing::warn!(
            "[vst] draft text orphan sweep skipped: manifest migration failed this boot: {e}"
        );
        return None;
    }
    if store.get_all_projects().await.is_empty() {
        tracing::debug!("[vst] draft text orphan sweep skipped: no projects loaded");
        return None;
    }
    let rows = match store.list_draft_texts().await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[vst] draft text orphan sweep failed (non-fatal): {e}");
            return None;
        }
    };
    let mut removed = 0usize;
    for row in rows {
        if scope_exists(store, &row.scope).await {
            continue;
        }
        match store.delete_draft_text(&row.scope).await {
            Ok(true) => {
                removed += 1;
                tracing::debug!(scope = %row.scope, "[vst] removed orphaned draft text row");
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("[vst] draft text orphan delete failed (non-fatal): {e}");
            }
        }
    }
    if removed > 0 {
        tracing::info!("[vst] purged {removed} orphaned draft text row(s)");
    }
    Some(removed)
}
