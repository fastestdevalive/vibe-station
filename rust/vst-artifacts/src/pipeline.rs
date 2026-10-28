//! The single upsert pipeline (plan Decision 4): every producer (tool-call
//! effects, `vst artifact add`, the fs-write observer) funnels through
//! [`Inner::process`], so duplicates from overlapping sources cannot inflate
//! edit counts or reorder rows.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use vst_store::artifacts::{ArtifactRecord, ArtifactWrite, UpsertOutcome};
use vst_types::artifacts::{AddedVia, ArtifactRemoveReason, ArtifactRow, ScopeKey};

use crate::eligibility::{classify, EffectOp, Eligibility};
use crate::hashing::sha256_file;
use crate::intake::{Item, PendingOp};
use crate::paths::{display_path, is_denied, PathKeyer};
use crate::reader::{open_artifact, DenyCtx, ReadError};
use crate::{ArtifactChange, Inner};

/// Per-scope facts needed to turn records into rows.
#[derive(Clone, Debug)]
pub(crate) struct ScopeCtx {
    /// Canonical scope root.
    pub root: PathBuf,
    pub home: Option<PathBuf>,
}

/// Outcome of one pipeline item.
#[derive(Clone, Debug)]
pub(crate) enum ItemResult {
    Applied(Box<ArtifactRecord>),
    /// Unknown scope, or an effect that changes nothing (e.g. delete of a row
    /// that does not exist).
    Dropped,
    NotFound,
    Denied,
    Ineligible(&'static str),
}

enum Skip {
    NotFound,
    Denied,
    Ineligible(&'static str),
}

impl Skip {
    fn into_result(self) -> ItemResult {
        match self {
            Skip::NotFound => ItemResult::NotFound,
            Skip::Denied => ItemResult::Denied,
            Skip::Ineligible(m) => ItemResult::Ineligible(m),
        }
    }
}

struct Measured {
    canonical: PathBuf,
    key: String,
    in_repo: bool,
    hash: Option<String>,
    size: u64,
    mtime_ms: i64,
}

enum Prepared {
    Write(Result<Measured, Skip>),
    Delete(Option<String>),
    Move {
        from_key: Option<String>,
        to: Result<Measured, Skip>,
    },
    Unknown,
}

pub(crate) fn mtime_ms_of(m: &std::fs::Metadata) -> i64 {
    m.mtime() * 1000 + m.mtime_nsec() / 1_000_000
}

fn measure(keyer: &PathKeyer, path: &Path, root: &Path, deny: &DenyCtx) -> Result<Measured, Skip> {
    let ck = keyer.canonicalize_key(path).map_err(|e| {
        if crate::paths::is_not_found(&e) {
            Skip::NotFound
        } else {
            Skip::Denied
        }
    })?;
    let meta = std::fs::metadata(&ck.canonical).map_err(|e| {
        if crate::paths::is_not_found(&e) {
            Skip::NotFound
        } else {
            Skip::Denied
        }
    })?;
    if is_denied(&ck.canonical, &deny.vst_home, &deny.registered_roots) {
        return Err(Skip::Denied);
    }
    if !meta.is_file() {
        return Err(Skip::Ineligible("not a regular file"));
    }
    if let Eligibility::Ineligible(why) = classify(&ck.canonical, root, EffectOp::Write) {
        return Err(Skip::Ineligible(why.message()));
    }
    let in_repo = ck.canonical.starts_with(root);
    let (hash, size, mtime_ms) = match open_artifact(&ck.canonical, in_repo, deny) {
        Ok((mut file, m)) => {
            let hash = sha256_file(&mut file).ok().flatten();
            (hash, m.len(), mtime_ms_of(&m))
        }
        Err(ReadError::NotFound) => return Err(Skip::NotFound),
        Err(ReadError::Unreadable(_)) | Err(ReadError::Io(_)) => {
            (None, meta.len(), mtime_ms_of(&meta))
        }
        Err(ReadError::Denied | ReadError::PathChanged) => return Err(Skip::Denied),
    };
    Ok(Measured {
        canonical: ck.canonical,
        key: ck.key,
        in_repo,
        hash,
        size,
        mtime_ms,
    })
}

fn prepare(keyer: &PathKeyer, item: &Item, root: &Path, deny: &DenyCtx) -> Prepared {
    match &item.op {
        PendingOp::Write => Prepared::Write(measure(keyer, &item.path, root, deny)),
        PendingOp::Delete => Prepared::Delete(gone_key(keyer, &item.path)),
        PendingOp::Move { from } => Prepared::Move {
            from_key: keyer.canonicalize_key(from).ok().map(|c| c.key),
            to: measure(keyer, &item.path, root, deny),
        },
    }
}

/// Split an entry that is "Move, then Write/Delete of the destination" (kept
/// together by the intake) into the move followed by the follow-up op, so both
/// are applied in order. Each element carries the index of its origin item.
fn expand_moves(items: &[Item]) -> Vec<(usize, Item)> {
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        if let Some(from) = &it.moved_from {
            out.push((
                i,
                Item {
                    op: PendingOp::Move { from: from.clone() },
                    moved_from: None,
                    ..it.clone()
                },
            ));
            out.push((
                i,
                Item {
                    moved_from: None,
                    ..it.clone()
                },
            ));
        } else {
            out.push((i, it.clone()));
        }
    }
    out
}

/// Key of a path only when the file is really gone (a delete effect for a file
/// that still exists changes nothing).
fn gone_key(keyer: &PathKeyer, path: &Path) -> Option<String> {
    let ck = keyer.canonicalize_key(path).ok()?;
    match std::fs::symlink_metadata(&ck.canonical) {
        Err(e) if crate::paths::is_not_found(&e) => Some(ck.key),
        _ => None,
    }
}

impl Inner {
    /// Context (canonical root + home) of each distinct scope; unknown scopes
    /// are absent.
    pub(crate) async fn scope_ctxs(&self, scopes: Vec<ScopeKey>) -> HashMap<ScopeKey, ScopeCtx> {
        let home = self
            .resolver
            .vst_home()
            .parent()
            .map(Path::to_path_buf)
            .and_then(|h| std::fs::canonicalize(&h).ok().or(Some(h)));
        let mut out = HashMap::new();
        for scope in scopes {
            if out.contains_key(&scope) {
                continue;
            }
            let Some(root) = self.resolver.scope_root(&scope).await else {
                continue;
            };
            let canon =
                tokio::task::spawn_blocking(move || std::fs::canonicalize(&root).unwrap_or(root))
                    .await
                    .ok();
            if let Some(root) = canon {
                out.insert(
                    scope,
                    ScopeCtx {
                        root,
                        home: home.clone(),
                    },
                );
            }
        }
        out
    }

    pub(crate) fn row_of(&self, rec: &ArtifactRecord, ctx: Option<&ScopeCtx>) -> ArtifactRow {
        let display = display_path(
            ctx.map(|c| c.root.as_path()),
            Path::new(&rec.path),
            ctx.and_then(|c| c.home.as_deref()),
        );
        rec.to_row(display)
    }

    fn note_outcome(&self, out: &UpsertOutcome, ctx: &ScopeCtx) {
        if !out.visible_changed {
            return;
        }
        let rec = &out.row;
        self.batcher
            .upsert(self.row_of(rec, Some(ctx)), out.created || out.revived);
        self.emit_change(ArtifactChange::Written {
            scope: rec.scope.clone(),
            id: rec.id.clone(),
            path: PathBuf::from(&rec.path),
        });
    }

    /// Apply a batch of items (arrival order). Results are index-aligned with
    /// `items`.
    pub(crate) async fn process(&self, items: Vec<Item>, added_via: AddedVia) -> Vec<ItemResult> {
        let mut results: Vec<ItemResult> = vec![ItemResult::Dropped; items.len()];
        if items.is_empty() {
            return results;
        }
        let work = expand_moves(&items);
        let ctxs = self
            .scope_ctxs(items.iter().map(|i| i.scope.clone()).collect())
            .await;
        let deny = self.deny_ctx().await;

        // Phase A: file-system work (canonicalize, eligibility, hash) in
        // parallel, hashing bounded by the 4-permit semaphore.
        let mut handles = Vec::with_capacity(work.len());
        for (_, item) in &work {
            let Some(ctx) = ctxs.get(&item.scope) else {
                handles.push(None);
                continue;
            };
            let permit = self.hash_sem.clone().acquire_owned().await.ok();
            let keyer = self.keyer.clone();
            let item = item.clone();
            let root = ctx.root.clone();
            let deny = deny.clone();
            handles.push(Some(tokio::task::spawn_blocking(move || {
                let _permit = permit;
                prepare(&keyer, &item, &root, &deny)
            })));
        }
        let mut prepared = Vec::with_capacity(work.len());
        for h in handles {
            prepared.push(match h {
                Some(h) => h.await.unwrap_or(Prepared::Unknown),
                None => Prepared::Unknown,
            });
        }

        // Phase B: DB writes in arrival order; consecutive writes share one
        // transaction.
        let mut batch: Vec<(usize, ArtifactWrite)> = Vec::new();
        let mut created_scopes: HashSet<ScopeKey> = HashSet::new();
        for ((idx, item), prep) in work.iter().map(|(i, it)| (*i, it)).zip(prepared) {
            let Some(ctx) = ctxs.get(&item.scope) else {
                continue;
            };
            match prep {
                Prepared::Unknown => {}
                Prepared::Write(Err(skip)) => results[idx] = skip.into_result(),
                Prepared::Write(Ok(m)) => {
                    self.push_writes(&mut batch, idx, item, &m, added_via);
                }
                Prepared::Delete(None) => {}
                Prepared::Delete(Some(key)) => {
                    self.flush_writes(&mut batch, &ctxs, &mut results, &mut created_scopes)
                        .await;
                    self.apply_delete(&item.scope, &key, ctx).await;
                }
                Prepared::Move { from_key, to } => {
                    self.flush_writes(&mut batch, &ctxs, &mut results, &mut created_scopes)
                        .await;
                    let from_row = match &from_key {
                        Some(k) => self
                            .store
                            .find_by_path_key(&item.scope, k)
                            .await
                            .ok()
                            .flatten(),
                        None => None,
                    };
                    match (from_row, to) {
                        (Some(old), Ok(m)) => {
                            let moved = match self
                                .store
                                .update_path(
                                    &old.id,
                                    &m.canonical.to_string_lossy(),
                                    &m.key,
                                    m.in_repo,
                                )
                                .await
                            {
                                Ok(moved) => moved,
                                Err(e) => {
                                    // A store error is not "the destination has its own
                                    // row": leave the old row untouched (no `missing`, no
                                    // second row) rather than lose its pin and writers.
                                    tracing::warn!(artifact_id = %old.id, "[vst] artifact move failed, row left as is: {e}");
                                    continue;
                                }
                            };
                            if moved.is_some() {
                                self.emit_change(ArtifactChange::Moved {
                                    scope: item.scope.clone(),
                                    id: old.id.clone(),
                                    from: PathBuf::from(&old.path),
                                    to: m.canonical.clone(),
                                });
                            } else {
                                // Destination already has its own row: the old one is gone.
                                self.mark_missing(&old, true, ctx).await;
                            }
                            self.push_writes(&mut batch, idx, item, &m, added_via);
                        }
                        (Some(old), Err(skip)) => {
                            self.mark_missing(&old, true, ctx).await;
                            results[idx] = skip.into_result();
                        }
                        (None, Ok(m)) => self.push_writes(&mut batch, idx, item, &m, added_via),
                        (None, Err(skip)) => results[idx] = skip.into_result(),
                    }
                }
            }
        }
        self.flush_writes(&mut batch, &ctxs, &mut results, &mut created_scopes)
            .await;

        for scope in created_scopes {
            match self.store.evict_over_cap(&scope).await {
                Ok(ids) if !ids.is_empty() => {
                    for id in &ids {
                        self.emit_change(ArtifactChange::Removed {
                            scope: scope.clone(),
                            id: id.clone(),
                        });
                    }
                    self.batcher.remove(&scope, ids, ArtifactRemoveReason::Cap);
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "artifact cap eviction failed"),
            }
        }
        results
    }

    fn push_writes(
        &self,
        batch: &mut Vec<(usize, ArtifactWrite)>,
        idx: usize,
        item: &Item,
        m: &Measured,
        added_via: AddedVia,
    ) {
        let writers: Vec<Option<&String>> = if item.writers.is_empty() {
            vec![None]
        } else {
            item.writers.iter().map(Some).collect()
        };
        for w in writers {
            batch.push((
                idx,
                ArtifactWrite {
                    id: uuid::Uuid::new_v4().to_string(),
                    scope: item.scope.clone(),
                    path: m.canonical.to_string_lossy().into_owned(),
                    path_key: m.key.clone(),
                    in_repo: m.in_repo,
                    hash: m.hash.clone(),
                    size: Some(m.size),
                    mtime_ms: Some(m.mtime_ms),
                    writer: w.cloned(),
                    added_via,
                    now: crate::now_iso(),
                },
            ));
        }
    }

    async fn flush_writes(
        &self,
        batch: &mut Vec<(usize, ArtifactWrite)>,
        ctxs: &HashMap<ScopeKey, ScopeCtx>,
        results: &mut [ItemResult],
        created_scopes: &mut HashSet<ScopeKey>,
    ) {
        if batch.is_empty() {
            return;
        }
        let pending = std::mem::take(batch);
        let idxs: Vec<usize> = pending.iter().map(|(i, _)| *i).collect();
        let writes: Vec<ArtifactWrite> = pending.into_iter().map(|(_, w)| w).collect();
        match self.store.apply_artifact_batch(writes).await {
            Ok(outcomes) => {
                for (idx, out) in idxs.into_iter().zip(outcomes) {
                    if let Some(ctx) = ctxs.get(&out.row.scope) {
                        self.note_outcome(&out, ctx);
                    }
                    if out.created || out.revived {
                        created_scopes.insert(out.row.scope.clone());
                    }
                    results[idx] = ItemResult::Applied(Box::new(out.row));
                }
            }
            Err(e) => tracing::warn!(error = %e, "artifact batch failed; rolled back"),
        }
    }

    async fn apply_delete(&self, scope: &ScopeKey, key: &str, ctx: &ScopeCtx) {
        if let Ok(Some(row)) = self.store.find_by_path_key(scope, key).await {
            if !row.hidden {
                self.mark_missing(&row, true, ctx).await;
            }
        }
    }

    /// Flip a row's `missing` flag, announcing the change.
    pub(crate) async fn mark_missing(&self, row: &ArtifactRecord, missing: bool, ctx: &ScopeCtx) {
        match self
            .store
            .set_missing(&row.id, missing, &crate::now_iso())
            .await
        {
            Ok(Some(rec)) => {
                if !rec.hidden {
                    self.batcher.upsert(self.row_of(&rec, Some(ctx)), false);
                }
                if missing {
                    self.emit_change(ArtifactChange::Missing {
                        scope: rec.scope.clone(),
                        id: rec.id.clone(),
                        path: PathBuf::from(&rec.path),
                    });
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "set_missing failed"),
        }
    }
}
