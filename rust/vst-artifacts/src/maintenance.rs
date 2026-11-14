//! Lazy revalidation, hash-based move merging, background rehash and the
//! content read path (plan Decisions 5, 7, 8).
//!
//! There is no artifact file watcher: missing/moved rows are noticed on list
//! and content reads. List revalidation is `lstat`-only and never hashes;
//! changed rows go to a bounded background pool whose results arrive as
//! batched `artifact:upserted` events with no edit bump and no reorder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Semaphore;
use vst_store::artifacts::ArtifactRecord;
use vst_types::artifacts::{ArtifactRemoveReason, ScopeKey};

use crate::hashing::{find_move_target, sha256_file};
use crate::pipeline::{mtime_ms_of, ScopeCtx};
use crate::reader::{
    open_artifact, outcome_for_error, read_opened, unreadable_internal, ArtifactStatOutcome,
    ReadError, ReadOutcome,
};
use crate::{
    ArtifactChange, ArtifactError, ArtifactId, ArtifactsHandle, Inner, ListResult,
    REVALIDATE_DEBOUNCE,
};

/// Rows allowed to wait for / run in the background hash pool.
const MAX_REHASH_QUEUE: usize = 1024;
/// Concurrent `lstat`s during list revalidation.
const STAT_CONCURRENCY: usize = 8;

enum Stat {
    Gone,
    Same,
    Changed,
}

fn stat_row(row: &ArtifactRecord) -> Stat {
    match std::fs::symlink_metadata(&row.path) {
        Err(e) if crate::paths::is_not_found(&e) => Stat::Gone,
        Err(_) => Stat::Changed,
        Ok(m) => {
            if m.file_type().is_symlink()
                || Some(m.len()) != row.size
                || Some(mtime_ms_of(&m)) != row.mtime_ms
            {
                Stat::Changed
            } else {
                Stat::Same
            }
        }
    }
}

impl Inner {
    /// Fold a "new" row into the missing row it replaces: the OLD row survives
    /// (id, pin, edits, writers) with the new path; the new row is deleted.
    pub(crate) async fn merge_pair(
        &self,
        old: &ArtifactRecord,
        new: &ArtifactRecord,
        ctx: Option<&ScopeCtx>,
    ) -> Option<ArtifactRecord> {
        // One transaction: delete `new`, re-point `old`, refresh the
        // measurement. Either it all applies or nothing changed, so an intake
        // write racing the merge can never leave a deleted `new` with `old`
        // still missing.
        let rec = match self
            .store
            .merge_artifact_into(&old.id, new.clone(), &crate::now_iso())
            .await
        {
            Ok(Some(r)) => r,
            other => {
                tracing::warn!(?other, "artifact merge: not applied");
                return None;
            }
        };
        self.batcher.remove(
            &old.scope,
            vec![new.id.clone()],
            ArtifactRemoveReason::Merged,
        );
        self.batcher.upsert(self.row_of(&rec, ctx), false);
        self.emit_change(ArtifactChange::Moved {
            scope: old.scope.clone(),
            id: old.id.clone(),
            from: PathBuf::from(&old.path),
            to: PathBuf::from(&new.path),
        });
        Some(rec)
    }

    /// Run the Decision 8 merge over `rows` (stored hashes only, no hashing).
    /// `rows` is updated in place.
    pub(crate) async fn merge_missing(
        &self,
        rows: &mut Vec<ArtifactRecord>,
        ctx: Option<&ScopeCtx>,
    ) {
        let missing_ids: Vec<String> = rows
            .iter()
            .filter(|r| r.missing && !r.hidden && r.hash.is_some())
            .map(|r| r.id.clone())
            .collect();
        for id in missing_ids {
            let Some(old) = rows.iter().find(|r| r.id == id).cloned() else {
                continue;
            };
            let Some(new) = find_move_target(&old, rows).cloned() else {
                continue;
            };
            if let Some(updated) = self.merge_pair(&old, &new, ctx).await {
                rows.retain(|r| r.id != new.id);
                if let Some(slot) = rows.iter_mut().find(|r| r.id == old.id) {
                    *slot = updated;
                }
            }
        }
    }

    /// Stat the rows not checked within the debounce window and apply the
    /// result; changed rows are queued for the background hash pool.
    async fn revalidate_rows(
        self: &Arc<Self>,
        scope: &ScopeKey,
        rows: &[ArtifactRecord],
        ctx: Option<&ScopeCtx>,
    ) {
        let now = Instant::now();
        let stale: Vec<ArtifactRecord> = {
            let mut checked = self.checked.lock().unwrap();
            // Entries older than the window are useless; dropping them here
            // keeps the map from growing with every id ever listed (deleted,
            // merged and evicted rows never come back to be overwritten).
            checked.retain(|_, t| now.duration_since(*t) < REVALIDATE_DEBOUNCE);
            let mut out = Vec::new();
            for r in rows.iter().filter(|r| !r.hidden) {
                let fresh = checked
                    .get(&r.id)
                    .is_some_and(|t| now.duration_since(*t) < REVALIDATE_DEBOUNCE);
                if !fresh {
                    checked.insert(r.id.clone(), now);
                    out.push(r.clone());
                }
            }
            out
        };
        if stale.is_empty() {
            return;
        }
        let sem = Arc::new(Semaphore::new(STAT_CONCURRENCY));
        let mut tasks = Vec::with_capacity(stale.len());
        for row in stale {
            let permit = sem.clone().acquire_owned().await.ok();
            self.stat_count.fetch_add(1, Ordering::Relaxed);
            tasks.push(tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let st = stat_row(&row);
                (row, st)
            }));
        }
        for t in tasks {
            let Ok((row, st)) = t.await else { continue };
            match st {
                Stat::Gone if !row.missing => {
                    if let Some(c) = ctx {
                        self.mark_missing(&row, true, c).await;
                    }
                }
                Stat::Same if row.missing => {
                    if let Some(c) = ctx {
                        self.mark_missing(&row, false, c).await;
                    }
                }
                Stat::Changed => self.queue_rehash(scope, &row),
                _ => {}
            }
        }
    }

    fn queue_rehash(self: &Arc<Self>, scope: &ScopeKey, row: &ArtifactRecord) {
        {
            let mut q = self.rehash.lock().unwrap();
            let total: usize = q.values().map(HashSet::len).sum();
            if total >= MAX_REHASH_QUEUE {
                return;
            }
            if !q.entry(scope.clone()).or_default().insert(row.id.clone()) {
                return;
            }
        }
        let inner = self.clone();
        let scope = scope.clone();
        let row = row.clone();
        tokio::spawn(async move {
            inner.rehash_row(&scope, &row).await;
            let scope_idle = {
                let mut q = inner.rehash.lock().unwrap();
                let set = q.entry(scope.clone()).or_default();
                set.remove(&row.id);
                let idle = set.is_empty();
                if idle {
                    q.remove(&scope);
                }
                idle
            };
            if scope_idle {
                inner.merge_scope(&scope).await;
            }
        });
    }

    /// Background measurement of one row (hash pool; never bumps `editCount`).
    async fn rehash_row(&self, scope: &ScopeKey, row: &ArtifactRecord) {
        let Ok(permit) = self.hash_sem.clone().acquire_owned().await else {
            return;
        };
        let deny = self.deny_ctx().await;
        let stored = PathBuf::from(&row.path);
        let in_repo = row.in_repo;
        let measured = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            match open_artifact(&stored, in_repo, &deny) {
                Ok((mut f, m)) => {
                    Ok((sha256_file(&mut f).ok().flatten(), m.len(), mtime_ms_of(&m)))
                }
                Err(e) => Err(e),
            }
        })
        .await;
        let ctxs = self.scope_ctxs(vec![scope.clone()]).await;
        let ctx = ctxs.get(scope);
        match measured {
            Ok(Ok((hash, size, mtime))) => {
                if let Ok(Some(rec)) = self
                    .store
                    .refresh_measurement(&row.id, hash, Some(size), Some(mtime), &crate::now_iso())
                    .await
                {
                    if !rec.hidden {
                        self.batcher.upsert(self.row_of(&rec, ctx), false);
                    }
                }
            }
            Ok(Err(ReadError::NotFound)) => {
                if let Some(c) = ctx {
                    self.mark_missing(row, true, c).await;
                }
            }
            // Denied / path changed / unreadable: keep the stored values; the
            // reader refuses to serve it anyway.
            Ok(Err(_)) | Err(_) => {}
        }
    }

    /// Merge pass over a whole scope (after a rehash wave).
    pub(crate) async fn merge_scope(&self, scope: &ScopeKey) {
        let Ok(mut rows) = self.store.list_artifacts(scope).await else {
            return;
        };
        let ctxs = self.scope_ctxs(vec![scope.clone()]).await;
        self.merge_missing(&mut rows, ctxs.get(scope)).await;
    }

    pub(crate) async fn read_by_id(self: &Arc<Self>, id: &str, allow_retry: bool) -> ReadOutcome {
        let rec = match self.store.get_artifact(id).await {
            Ok(Some(r)) if !r.hidden => r,
            Ok(_) => return ReadOutcome::NotFound,
            Err(e) => return unreadable_internal("artifact store read failed", &e, "store error"),
        };
        let deny = self.deny_ctx().await;
        let stored = PathBuf::from(&rec.path);
        let allow_hardlink = rec.in_repo;
        let opened = tokio::task::spawn_blocking(move || {
            let (file, meta) = open_artifact(&stored, allow_hardlink, &deny)?;
            read_opened(file, &meta, &stored)
        })
        .await;
        match opened {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(ReadError::NotFound)) => self.on_enoent(&rec, allow_retry).await,
            Ok(Err(e)) => outcome_for_error(e),
            Err(e) => unreadable_internal("artifact read task failed", &e, "read task failed"),
        }
    }

    /// ENOENT on content GET: serve the moved file when exactly one live row
    /// shares the hash, else mark the row missing.
    async fn on_enoent(self: &Arc<Self>, rec: &ArtifactRecord, allow_retry: bool) -> ReadOutcome {
        let ctxs = self.scope_ctxs(vec![rec.scope.clone()]).await;
        let ctx = ctxs.get(&rec.scope);
        if allow_retry {
            if let Ok(rows) = self.store.list_artifacts(&rec.scope).await {
                if let Some(new) = find_move_target(rec, &rows).cloned() {
                    if self.merge_pair(rec, &new, ctx).await.is_some() {
                        return Box::pin(self.read_by_id(&rec.id, false)).await;
                    }
                }
            }
        }
        if let Some(c) = ctx {
            self.mark_missing(rec, true, c).await;
        }
        ReadOutcome::Missing
    }
}

impl ArtifactsHandle {
    /// Visible rows of a scope, newest first, after lazy revalidation and the
    /// hash-move merge. `rev` is read BEFORE the rows.
    pub async fn list(&self, scope: &ScopeKey) -> Result<ListResult, ArtifactError> {
        let inner = &self.0;
        let rev = inner.batcher.rev(scope);
        let rows = inner.store.list_artifacts(scope).await?;
        let ctxs = inner.scope_ctxs(vec![scope.clone()]).await;
        let ctx = ctxs.get(scope);
        inner.revalidate_rows(scope, &rows, ctx).await;
        let mut rows = inner.store.list_artifacts(scope).await?;
        inner.merge_missing(&mut rows, ctx).await;
        let total = rows.len() as u32;
        let items = rows
            .iter()
            .filter(|r| !r.hidden)
            .map(|r| inner.row_of(r, ctx))
            .collect();
        Ok(ListResult { rev, total, items })
    }

    /// The only artifact byte reader (plan Decision 5): hardened open, branch
    /// order image -> binary -> text, move detection on ENOENT.
    pub async fn read_content(&self, id: &str) -> ReadOutcome {
        self.0.read_by_id(id, true).await
    }

    /// Metadata of an artifact's file through the SAME hardened open as
    /// `read_content` (denylist, O_NOFOLLOW, path equality, hard-link rule);
    /// never reads bytes. The row must be a live row of `scope`.
    pub async fn stat_content(&self, scope: &ScopeKey, id: &str) -> ArtifactStatOutcome {
        let inner = &self.0;
        let rec = match inner.store.get_artifact(id).await {
            Ok(Some(r)) if !r.hidden && r.scope == *scope => r,
            Ok(_) => return ArtifactStatOutcome::NotFound,
            Err(e) => {
                tracing::warn!(error = %e, "artifact store read failed (stat)");
                return ArtifactStatOutcome::Unreadable;
            }
        };
        let deny = inner.deny_ctx().await;
        let stored = PathBuf::from(&rec.path);
        let allow_hardlink = rec.in_repo;
        let opened = tokio::task::spawn_blocking(move || {
            open_artifact(&stored, allow_hardlink, &deny).map(|(_file, meta)| meta)
        })
        .await;
        match opened {
            Ok(Ok(meta)) => ArtifactStatOutcome::Found {
                size: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as i64),
                path: rec.path.clone(),
                in_repo: rec.in_repo,
            },
            Ok(Err(ReadError::NotFound)) => ArtifactStatOutcome::Missing,
            Ok(Err(ReadError::PathChanged | ReadError::Denied)) => ArtifactStatOutcome::Denied,
            Ok(Err(ReadError::Unreadable(_))) => ArtifactStatOutcome::Unreadable,
            Ok(Err(ReadError::Io(e))) => {
                tracing::warn!(error = %e, "artifact stat io error");
                ArtifactStatOutcome::Unreadable
            }
            Err(e) => {
                tracing::warn!(error = %e, "artifact stat task failed");
                ArtifactStatOutcome::Unreadable
            }
        }
    }

    /// Is `canonical` a live (non-hidden) artifact of `scope`? Returns its id.
    /// The stored path must equal the canonical path exactly (R111).
    pub async fn authorize_read(&self, scope: &ScopeKey, canonical: &Path) -> Option<ArtifactId> {
        let key = self.0.keyer.key_for(canonical);
        let row = self.0.store.find_by_path_key(scope, &key).await.ok()??;
        (!row.hidden && Path::new(&row.path) == canonical).then_some(row.id)
    }

    /// Re-stat the rows for `paths` (hook for part 04's bounded comment
    /// watcher, R114): set/clear `missing` and emit `artifact:upserted`.
    /// Returns how many rows changed state.
    pub async fn revalidate_paths(&self, scope: &ScopeKey, paths: &[PathBuf]) -> usize {
        let inner = &self.0;
        let ctxs = inner.scope_ctxs(vec![scope.clone()]).await;
        let Some(ctx) = ctxs.get(scope) else { return 0 };
        let mut changed = 0;
        for p in paths {
            let Ok(ck) = inner.keyer.canonicalize_key(p) else {
                continue;
            };
            let Ok(Some(row)) = inner.store.find_by_path_key(scope, &ck.key).await else {
                continue;
            };
            if row.hidden {
                continue;
            }
            inner.stat_count.fetch_add(1, Ordering::Relaxed);
            let stored = row.path.clone();
            let gone = tokio::task::spawn_blocking(move || {
                matches!(std::fs::symlink_metadata(stored), Err(e) if crate::paths::is_not_found(&e))
            })
            .await
            .unwrap_or(false);
            if gone != row.missing {
                inner.mark_missing(&row, gone, ctx).await;
                changed += 1;
            }
        }
        changed
    }
}
