//! User-facing operations of [`ArtifactsHandle`]: pin, remove, the CLI add
//! path, purges and the scope helpers for sibling crates.

use std::path::PathBuf;

use vst_store::artifacts::PinOutcome;
use vst_types::artifacts::{AddedVia, ArtifactRemoveReason, ArtifactRow, ScopeKey};
use vst_types::rest::artifacts::{
    AddArtifactResult, AddArtifactsResponse, ArtifactErrorCode, ArtifactPathError,
};

use crate::intake::{Item, PendingOp};
use crate::paths::is_sane_path;
use crate::pipeline::ItemResult;
use crate::{AddError, ArtifactChange, ArtifactError, ArtifactsHandle};

/// Most paths one `vst artifact add` request may carry.
pub const MAX_ADD_PATHS: usize = 50;

fn path_error(path: String, code: ArtifactErrorCode, message: &str) -> AddArtifactResult {
    AddArtifactResult {
        path,
        artifact: None,
        outside_worktree: None,
        error: Some(ArtifactPathError {
            code,
            message: message.to_string(),
        }),
    }
}

impl ArtifactsHandle {
    /// Pin or unpin a live row (cap 50 per scope).
    pub async fn pin(&self, id: &str, pinned: bool) -> Result<ArtifactRow, ArtifactError> {
        let inner = &self.0;
        match inner
            .store
            .set_pinned(id, pinned, &crate::now_iso())
            .await?
        {
            PinOutcome::Updated(rec) => {
                let ctxs = inner.scope_ctxs(vec![rec.scope.clone()]).await;
                let row = inner.row_of(&rec, ctxs.get(&rec.scope));
                inner.batcher.upsert(row.clone(), false);
                Ok(row)
            }
            PinOutcome::NotFound => Err(ArtifactError::NotFound),
            PinOutcome::PinLimit => Err(ArtifactError::PinLimit),
        }
    }

    /// User "Remove": hide the row (and drop its pin) until written again.
    pub async fn remove(&self, id: &str) -> Result<(), ArtifactError> {
        let inner = &self.0;
        let rec = inner
            .store
            .hide_artifact(id)
            .await?
            .ok_or(ArtifactError::NotFound)?;
        inner.batcher.remove(
            &rec.scope,
            vec![rec.id.clone()],
            ArtifactRemoveReason::Removed,
        );
        inner.emit_change(ArtifactChange::Removed {
            scope: rec.scope,
            id: rec.id,
        });
        Ok(())
    }

    /// `vst artifact add`: the scope comes from the session behind the spawn
    /// token (an identity, not a secret), never from the request body. One
    /// request costs ONE rate-limit token however many paths it carries.
    pub async fn add_by_token(
        &self,
        token: &str,
        paths: Vec<String>,
    ) -> Result<AddArtifactsResponse, AddError> {
        let inner = &self.0;
        if paths.is_empty() || paths.len() > MAX_ADD_PATHS {
            return Err(AddError::InvalidRequest(format!(
                "paths must hold 1..={MAX_ADD_PATHS} entries"
            )));
        }
        let session = inner
            .resolver
            .session_scope(token)
            .await
            .ok_or(AddError::UnknownSession)?;
        if session.archived {
            return Err(AddError::SessionArchived);
        }
        if !inner.limiter.try_acquire(token) {
            return Err(AddError::RateLimited);
        }

        let mut results: Vec<Option<AddArtifactResult>> = vec![None; paths.len()];
        let mut items = Vec::new();
        let mut origin = Vec::new();
        for (i, p) in paths.iter().enumerate() {
            if !is_sane_path(p) {
                results[i] = Some(path_error(
                    p.clone(),
                    ArtifactErrorCode::ValidationError,
                    "path is empty, too long or contains control characters",
                ));
            } else if !PathBuf::from(p).is_absolute() {
                results[i] = Some(path_error(
                    p.clone(),
                    ArtifactErrorCode::ValidationError,
                    "path must be absolute",
                ));
            } else {
                items.push(Item {
                    scope: session.scope.clone(),
                    path: PathBuf::from(p),
                    writers: vec![token.to_string()],
                    op: PendingOp::Write,
                    moved_from: None,
                    seq: i as u64,
                });
                origin.push(i);
            }
        }
        // Serialise with the intake drain so arrival order is preserved.
        let outcomes = {
            let _guard = inner.drain_lock.lock().await;
            inner.process(items, AddedVia::Cli).await
        };
        let ctxs = inner.scope_ctxs(vec![session.scope.clone()]).await;
        let ctx = ctxs.get(&session.scope);
        for (i, outcome) in origin.into_iter().zip(outcomes) {
            let path = paths[i].clone();
            results[i] = Some(match outcome {
                ItemResult::Applied(rec) => AddArtifactResult {
                    path,
                    outside_worktree: Some(!rec.in_repo),
                    artifact: Some(inner.row_of(&rec, ctx)),
                    error: None,
                },
                ItemResult::NotFound | ItemResult::Dropped => {
                    path_error(path, ArtifactErrorCode::NotFound, "file not found")
                }
                ItemResult::Denied => path_error(
                    path,
                    ArtifactErrorCode::ArtifactDenied,
                    "this path can never be an artifact",
                ),
                ItemResult::Ineligible(why) => {
                    path_error(path, ArtifactErrorCode::ArtifactIneligible, why)
                }
            });
        }
        Ok(AddArtifactsResponse {
            results: results.into_iter().flatten().collect(),
        })
    }

    /// Delete every row of a scope (worktree/project deleted).
    pub async fn purge_scope(&self, scope: &ScopeKey) -> Result<usize, ArtifactError> {
        let n = self.0.store.purge_scope(scope).await?;
        self.0.batcher.forget_scope(scope);
        self.0.rehash.lock().unwrap().remove(scope);
        Ok(n)
    }

    /// Boot purge of rows whose scope no longer exists. The store REFUSES when
    /// the `projects` table is empty; the caller must also only call this when
    /// the manifest migration succeeded on this boot.
    pub async fn purge_orphans(&self) -> Result<usize, ArtifactError> {
        Ok(self.0.store.purge_orphan_artifacts().await?)
    }

    /// Paths of the scope's live rows (for part 04's bounded watcher).
    pub async fn paths_for_scope(&self, scope: &ScopeKey) -> Vec<PathBuf> {
        self.0
            .store
            .list_artifacts(scope)
            .await
            .map(|rows| {
                rows.into_iter()
                    .filter(|r| !r.hidden && !r.missing)
                    .map(|r| PathBuf::from(r.path))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn scope_exists(&self, scope: &ScopeKey) -> bool {
        self.0.resolver.scope_exists(scope).await
    }
}
