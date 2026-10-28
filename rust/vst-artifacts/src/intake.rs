//! Coalescing capture intake (plan Decision 10).
//!
//! `record()` runs on the agent's hot path: it only takes a short lock and
//! inserts into a bounded map; a worker drains the map every 100 ms. Keys are
//! the lexical absolute path (the hot path does no file-system I/O), the DB
//! upsert dedupes spellings that canonicalize to one file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use vst_types::artifacts::{FileEffect, FileOp, ScopeKey, ScopeKind, WriteContext};

/// Drain interval.
pub const DRAIN_INTERVAL: Duration = Duration::from_millis(100);
/// Distinct (scope, path) entries held between drains.
pub const MAX_PENDING: usize = 4096;

/// What is pending for one path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingOp {
    Write,
    Delete,
    /// The entry's path is the destination.
    Move {
        from: PathBuf,
    },
}

/// One drained entry, ready for the pipeline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub scope: ScopeKey,
    pub path: PathBuf,
    /// Oldest first; the last element is the newest writer.
    pub writers: Vec<String>,
    pub op: PendingOp,
    /// A Move that was followed by a Write/Delete of its destination in the
    /// same window: both ops are applied (move first).
    pub moved_from: Option<PathBuf>,
    pub seq: u64,
}

#[derive(Default)]
pub struct Intake {
    map: Mutex<HashMap<(ScopeKey, PathBuf), Item>>,
    seq: AtomicU64,
    dropped: AtomicU64,
}

fn scope_of(ctx: &WriteContext) -> ScopeKey {
    match &ctx.worktree_id {
        Some(w) => ScopeKey {
            scope_kind: ScopeKind::Worktree,
            scope_id: w.clone(),
        },
        None => ScopeKey::project(ctx.project_id.clone()),
    }
}

fn absolute(ctx: &WriteContext, p: &str) -> Option<PathBuf> {
    // The same rule as an explicit `vst artifact add`, for every producer
    // (Write-tool capture and shell capture alike).
    if !crate::paths::is_sane_path(p) {
        return None;
    }
    let path = PathBuf::from(p);
    let path = if path.is_absolute() {
        path
    } else {
        ctx.cwd.join(path)
    };
    crate::paths::is_sane_path(&path.to_string_lossy()).then_some(path)
}

impl Intake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Effects dropped because the map was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Insert effects, merging with what is already pending for the same path.
    pub fn record(&self, ctx: &WriteContext, effects: Vec<FileEffect>) {
        let scope = scope_of(ctx);
        let mut map = self.map.lock().unwrap();
        for e in effects {
            let Some(path) = absolute(ctx, &e.path) else {
                continue;
            };
            let op = match e.op {
                FileOp::Write => PendingOp::Write,
                FileOp::Delete => PendingOp::Delete,
                FileOp::Move { from } => match absolute(ctx, &from) {
                    Some(f) => PendingOp::Move { from: f },
                    None => continue,
                },
            };
            let seq = self.seq.fetch_add(1, Ordering::Relaxed);
            let key = (scope.clone(), path.clone());
            if let Some(it) = map.get_mut(&key) {
                it.writers.retain(|w| *w != ctx.session_id);
                it.writers.push(ctx.session_id.clone());
                it.seq = seq;
                it.moved_from = match (&it.op, &op) {
                    (_, PendingOp::Move { .. }) => None,
                    (PendingOp::Move { from }, _) => Some(from.clone()),
                    _ => it.moved_from.take(),
                };
                it.op = op;
                continue;
            }
            if map.len() >= MAX_PENDING {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n == 1 || n % 1000 == 0 {
                    tracing::warn!(dropped = n, "artifact intake full; dropping effects");
                }
                continue;
            }
            map.insert(
                key,
                Item {
                    scope: scope.clone(),
                    path,
                    writers: vec![ctx.session_id.clone()],
                    op,
                    moved_from: None,
                    seq,
                },
            );
        }
    }

    /// Take everything pending, in arrival order.
    pub fn take(&self) -> Vec<Item> {
        let mut items: Vec<Item> = std::mem::take(&mut *self.map.lock().unwrap())
            .into_values()
            .collect();
        items.sort_by_key(|i| i.seq);
        items
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> WriteContext {
        WriteContext {
            project_id: "p".into(),
            worktree_id: None,
            session_id: "s".into(),
            cwd: PathBuf::from("/w"),
        }
    }

    #[test]
    fn insane_paths_are_dropped_for_every_producer() {
        let intake = Intake::new();
        let long = format!("/tmp/{}", "a".repeat(4100));
        intake.record(
            &ctx(),
            vec![
                FileEffect::write("/tmp/a\nb.md"),
                FileEffect::write("/tmp/esc\u{1b}[31m.md"),
                FileEffect::write("/tmp/tab\there.md"),
                FileEffect::write(long),
                FileEffect::write("rel\nx.md"),
                FileEffect::moved("/tmp/ok-from.md", "/tmp/bad\nto.md"),
                FileEffect::moved("/tmp/bad\nfrom.md", "/tmp/ok-to.md"),
                FileEffect::write("/tmp/fine.md"),
                FileEffect::write("rel.md"),
            ],
        );
        let mut paths: Vec<_> = intake
            .take()
            .into_iter()
            .map(|i| i.path.display().to_string())
            .collect();
        paths.sort();
        assert_eq!(paths, ["/tmp/fine.md", "/w/rel.md"]);
    }
}
