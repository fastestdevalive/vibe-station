//! SQL for the `artifacts` table (agent-written files per worktree/project).
//!
//! `vst-artifacts` is the single writer; this module only owns the statements.
//! There is NO foreign key on the table (a project save re-inserts worktrees
//! and sessions), so rows of deleted scopes are purged explicitly
//! ([`StoreHandle::purge_scope`], [`StoreHandle::purge_orphan_artifacts`]).
//!
//! Every method runs its SQL inside `spawn_blocking`; the `*_in` helpers take
//! a `&Connection` so single calls and the batch share one implementation.

use rusqlite::{params, Connection, OptionalExtension, Row};
use vst_types::artifacts::{
    AddedVia, ArtifactKind, ArtifactRow, ArtifactState, ScopeKey, ScopeKind, ARTIFACT_CAP,
    ARTIFACT_MAX_WRITERS, ARTIFACT_PIN_CAP,
};

use crate::{StoreError, StoreHandle, StoreResult};

/// A stored artifact row (every column). The wire [`ArtifactRow`] is derived
/// with [`ArtifactRecord::to_row`] once the owner knows the scope root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRecord {
    pub id: String,
    pub scope: ScopeKey,
    /// Canonical absolute path at record time.
    pub path: String,
    /// Dedupe key (canonical, NFC, case-folded only on case-insensitive volumes).
    pub path_key: String,
    pub in_repo: bool,
    pub hash: Option<String>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    pub hidden: bool,
    pub missing: bool,
    pub edit_count: u32,
    /// Newest first, at most [`ARTIFACT_MAX_WRITERS`].
    pub writers: Vec<String>,
    pub added_via: AddedVia,
    pub created_at: String,
    pub last_written_at: String,
    pub checked_at: Option<String>,
}

impl ArtifactRecord {
    /// The wire row. `display_path` is repo-relative (or absolute when not in
    /// the repo); only the owner knows the scope root, so it is passed in.
    pub fn to_row(&self, display_path: String) -> ArtifactRow {
        ArtifactRow {
            id: self.id.clone(),
            scope_kind: self.scope.scope_kind,
            scope_id: self.scope.scope_id.clone(),
            path: self.path.clone(),
            display_path,
            in_repo: self.in_repo,
            kind: ArtifactKind::from_path(&self.path),
            size: self.size,
            state: if self.missing {
                ArtifactState::Missing
            } else {
                ArtifactState::Ok
            },
            pinned: self.pinned,
            edit_count: self.edit_count,
            writers: self.writers.clone(),
            added_via: self.added_via,
            created_at: self.created_at.clone(),
            last_written_at: self.last_written_at.clone(),
        }
    }
}

/// One recorded write, ready to upsert. `hash`/`size`/`mtime_ms` are measured
/// by the caller (hashing happens off the store lock).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactWrite {
    /// Id used when the row is new (the owner mints a uuid).
    pub id: String,
    pub scope: ScopeKey,
    pub path: String,
    pub path_key: String,
    pub in_repo: bool,
    /// `None` when the file is over the hash limit or unreadable.
    pub hash: Option<String>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    /// Session that wrote it (soft reference).
    pub writer: Option<String>,
    pub added_via: AddedVia,
    /// ISO8601 time of the write.
    pub now: String,
}

/// Result of one upsert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpsertOutcome {
    pub row: ArtifactRecord,
    /// The row did not exist before.
    pub created: bool,
    /// Anything about the stored row changed (a no-op repeat is `false`).
    pub changed: bool,
    /// A client-visible field changed (path, size, state, pin, edits, writers,
    /// last-written time, or the row was un-hidden). A rewrite of identical
    /// bytes refreshes the stored `mtime` (`changed`) but not this.
    pub visible_changed: bool,
    /// The row was hidden (user Remove) and this write brought it back.
    pub revived: bool,
}

/// Result of [`StoreHandle::set_pinned`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PinOutcome {
    Updated(Box<ArtifactRecord>),
    /// Unknown id, or the row is hidden (not a live artifact).
    NotFound,
    /// Pinning would exceed [`ARTIFACT_PIN_CAP`] in the scope.
    PinLimit,
}

const COLUMNS: &str = "id, scopeKind, scopeId, path, pathKey, inRepo, hash, size, mtimeMs, \
    pinned, pinnedAt, hidden, missing, editCount, writers, addedVia, createdAt, lastWrittenAt, \
    checkedAt";

fn row_to_record(r: &Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    let kind: String = r.get(1)?;
    let writers: String = r.get(14)?;
    let added_via: String = r.get(15)?;
    Ok(ArtifactRecord {
        id: r.get(0)?,
        scope: ScopeKey {
            scope_kind: ScopeKind::parse(&kind).unwrap_or(ScopeKind::Worktree),
            scope_id: r.get(2)?,
        },
        path: r.get(3)?,
        path_key: r.get(4)?,
        in_repo: r.get::<_, i64>(5)? != 0,
        hash: r.get(6)?,
        size: r.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
        mtime_ms: r.get(8)?,
        pinned: r.get::<_, i64>(9)? != 0,
        pinned_at: r.get(10)?,
        hidden: r.get::<_, i64>(11)? != 0,
        missing: r.get::<_, i64>(12)? != 0,
        edit_count: r.get::<_, i64>(13)?.clamp(0, i64::from(u32::MAX)) as u32,
        writers: serde_json::from_str(&writers).unwrap_or_default(),
        added_via: AddedVia::parse(&added_via),
        created_at: r.get(16)?,
        last_written_at: r.get(17)?,
        checked_at: r.get(18)?,
    })
}

fn get_in(conn: &Connection, id: &str) -> StoreResult<Option<ArtifactRecord>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM artifacts WHERE id = ?1"),
            params![id],
            row_to_record,
        )
        .optional()?)
}

fn find_in(
    conn: &Connection,
    scope: &ScopeKey,
    path_key: &str,
) -> StoreResult<Option<ArtifactRecord>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2 AND pathKey = ?3"
            ),
            params![scope.scope_kind.as_str(), scope.scope_id, path_key],
            row_to_record,
        )
        .optional()?)
}

fn writers_json(writers: &[String]) -> String {
    serde_json::to_string(writers).unwrap_or_else(|_| "[]".into())
}

fn write_record(conn: &Connection, rec: &ArtifactRecord) -> StoreResult<()> {
    conn.execute(
        "UPDATE artifacts SET path = ?2, pathKey = ?3, inRepo = ?4, hash = ?5, size = ?6, \
         mtimeMs = ?7, pinned = ?8, pinnedAt = ?9, hidden = ?10, missing = ?11, editCount = ?12, \
         writers = ?13, lastWrittenAt = ?14, checkedAt = ?15 WHERE id = ?1",
        params![
            rec.id,
            rec.path,
            rec.path_key,
            i64::from(rec.in_repo),
            rec.hash,
            rec.size.map(|n| n as i64),
            rec.mtime_ms,
            i64::from(rec.pinned),
            rec.pinned_at,
            i64::from(rec.hidden),
            i64::from(rec.missing),
            i64::from(rec.edit_count),
            writers_json(&rec.writers),
            rec.last_written_at,
            rec.checked_at,
        ],
    )?;
    Ok(())
}

/// Did the file content change between the stored row and a new measurement?
/// Hashes decide when both exist; otherwise `(size, mtime)` is the fallback
/// signal, and "no signal on either side" counts as changed.
fn content_changed(old: &ArtifactRecord, w: &ArtifactWrite) -> bool {
    match (&old.hash, &w.hash) {
        (Some(a), Some(b)) => a != b,
        (None, None) => {
            old.mtime_ms.is_none()
                || w.mtime_ms.is_none()
                || old.mtime_ms != w.mtime_ms
                || old.size != w.size
        }
        _ => true,
    }
}

fn push_writer(writers: &mut Vec<String>, session: &str) {
    writers.retain(|w| w != session);
    writers.insert(0, session.to_string());
    writers.truncate(ARTIFACT_MAX_WRITERS);
}

fn upsert_in(conn: &Connection, w: &ArtifactWrite) -> StoreResult<UpsertOutcome> {
    let Some(old) = find_in(conn, &w.scope, &w.path_key)? else {
        let mut writers = Vec::new();
        if let Some(s) = &w.writer {
            push_writer(&mut writers, s);
        }
        let rec = ArtifactRecord {
            id: w.id.clone(),
            scope: w.scope.clone(),
            path: w.path.clone(),
            path_key: w.path_key.clone(),
            in_repo: w.in_repo,
            hash: w.hash.clone(),
            size: w.size,
            mtime_ms: w.mtime_ms,
            pinned: false,
            pinned_at: None,
            hidden: false,
            missing: false,
            edit_count: 1,
            writers,
            added_via: w.added_via,
            created_at: w.now.clone(),
            last_written_at: w.now.clone(),
            checked_at: Some(w.now.clone()),
        };
        conn.execute(
            "INSERT INTO artifacts (id, scopeKind, scopeId, path, pathKey, inRepo, hash, size, \
             mtimeMs, pinned, pinnedAt, hidden, missing, editCount, writers, addedVia, createdAt, \
             lastWrittenAt, checkedAt) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, 0, 0, 1, ?10, ?11, ?12, ?12, ?12)",
            params![
                rec.id,
                rec.scope.scope_kind.as_str(),
                rec.scope.scope_id,
                rec.path,
                rec.path_key,
                i64::from(rec.in_repo),
                rec.hash,
                rec.size.map(|n| n as i64),
                rec.mtime_ms,
                writers_json(&rec.writers),
                rec.added_via.as_str(),
                rec.created_at,
            ],
        )?;
        return Ok(UpsertOutcome {
            row: rec,
            created: true,
            changed: true,
            visible_changed: true,
            revived: false,
        });
    };

    let mut new = old.clone();
    new.path = w.path.clone();
    new.in_repo = w.in_repo;
    new.hash = w.hash.clone();
    new.size = w.size;
    new.mtime_ms = w.mtime_ms;
    // A write brings a removed or missing row back; it does not by itself
    // count as an edit or reorder the list (only changed content does).
    new.hidden = false;
    new.missing = false;
    if let Some(s) = &w.writer {
        push_writer(&mut new.writers, s);
    }
    if content_changed(&old, w) {
        new.edit_count = old.edit_count.saturating_add(1);
        new.last_written_at = w.now.clone();
    }
    if new == old {
        return Ok(UpsertOutcome {
            row: old,
            created: false,
            changed: false,
            visible_changed: false,
            revived: false,
        });
    }
    new.checked_at = Some(w.now.clone());
    write_record(conn, &new)?;
    let visible_changed = old.path != new.path
        || old.in_repo != new.in_repo
        || old.size != new.size
        || old.hidden != new.hidden
        || old.missing != new.missing
        || old.edit_count != new.edit_count
        || old.writers != new.writers
        || old.last_written_at != new.last_written_at;
    Ok(UpsertOutcome {
        revived: old.hidden && !new.hidden,
        row: new,
        created: false,
        changed: true,
        visible_changed,
    })
}

impl StoreHandle {
    /// Run `f` with the connection on the blocking pool.
    async fn artifacts_db<T, F>(&self, f: F) -> StoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> StoreResult<T> + Send + 'static,
    {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = inner.conn.lock().unwrap();
            f(&mut conn)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Every row of a scope (hidden included), newest first.
    pub async fn list_artifacts(&self, scope: &ScopeKey) -> StoreResult<Vec<ArtifactRecord>> {
        let scope = scope.clone();
        self.artifacts_db(move |conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLUMNS} FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2 \
                 ORDER BY lastWrittenAt DESC, id ASC"
            ))?;
            let rows = stmt
                .query_map(params![scope.scope_kind.as_str(), scope.scope_id], |r| {
                    row_to_record(r)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn get_artifact(&self, id: &str) -> StoreResult<Option<ArtifactRecord>> {
        let id = id.to_string();
        self.artifacts_db(move |conn| get_in(conn, &id)).await
    }

    pub async fn find_by_path_key(
        &self,
        scope: &ScopeKey,
        path_key: &str,
    ) -> StoreResult<Option<ArtifactRecord>> {
        let scope = scope.clone();
        let path_key = path_key.to_string();
        self.artifacts_db(move |conn| find_in(conn, &scope, &path_key))
            .await
    }

    /// Insert or refresh the row for `(scope, pathKey)`. A repeat with the same
    /// content adds no edit and no reorder (`changed == false` when nothing at
    /// all differs).
    pub async fn upsert_artifact(&self, write: ArtifactWrite) -> StoreResult<UpsertOutcome> {
        self.artifacts_db(move |conn| upsert_in(conn, &write)).await
    }

    /// Apply many writes in ONE transaction (one commit per intake drain); any
    /// failure rolls every write back.
    pub async fn apply_artifact_batch(
        &self,
        writes: Vec<ArtifactWrite>,
    ) -> StoreResult<Vec<UpsertOutcome>> {
        self.artifacts_db(move |conn| {
            let tx = conn.transaction()?;
            let mut out = Vec::with_capacity(writes.len());
            for w in &writes {
                out.push(upsert_in(&tx, w)?);
            }
            tx.commit()?;
            Ok(out)
        })
        .await
    }

    /// Pin or unpin a live (non-hidden) row; pinning is capped per scope.
    pub async fn set_pinned(&self, id: &str, pinned: bool, now: &str) -> StoreResult<PinOutcome> {
        let id = id.to_string();
        let now = now.to_string();
        self.artifacts_db(move |conn| {
            let tx = conn.transaction()?;
            let Some(mut rec) = get_in(&tx, &id)? else {
                return Ok(PinOutcome::NotFound);
            };
            if rec.hidden {
                return Ok(PinOutcome::NotFound);
            }
            if pinned && !rec.pinned {
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2 AND pinned = 1",
                    params![rec.scope.scope_kind.as_str(), rec.scope.scope_id],
                    |r| r.get(0),
                )?;
                if count >= i64::from(ARTIFACT_PIN_CAP) {
                    return Ok(PinOutcome::PinLimit);
                }
            }
            if rec.pinned != pinned {
                rec.pinned = pinned;
                rec.pinned_at = pinned.then_some(now);
                write_record(&tx, &rec)?;
            }
            tx.commit()?;
            Ok(PinOutcome::Updated(Box::new(rec)))
        })
        .await
    }

    /// User "Remove": hide the row (also clears its pin) until written again.
    pub async fn hide_artifact(&self, id: &str) -> StoreResult<Option<ArtifactRecord>> {
        let id = id.to_string();
        self.artifacts_db(move |conn| {
            let Some(mut rec) = get_in(conn, &id)? else {
                return Ok(None);
            };
            if rec.hidden {
                return Ok(None);
            }
            rec.hidden = true;
            rec.pinned = false;
            rec.pinned_at = None;
            write_record(conn, &rec)?;
            Ok(Some(rec))
        })
        .await
    }

    /// Set/clear `missing` and stamp `checkedAt`. Returns the row only when the
    /// `missing` flag actually changed.
    pub async fn set_missing(
        &self,
        id: &str,
        missing: bool,
        checked_at: &str,
    ) -> StoreResult<Option<ArtifactRecord>> {
        let id = id.to_string();
        let checked_at = checked_at.to_string();
        self.artifacts_db(move |conn| {
            let Some(mut rec) = get_in(conn, &id)? else {
                return Ok(None);
            };
            let flipped = rec.missing != missing;
            rec.missing = missing;
            rec.checked_at = Some(checked_at);
            write_record(conn, &rec)?;
            Ok(flipped.then_some(rec))
        })
        .await
    }

    /// Re-point a row at a new path (a recognised move), keeping its id, pin,
    /// edit count and writers. Fails (`Ok(None)`) when the target key is taken.
    pub async fn update_path(
        &self,
        id: &str,
        path: &str,
        path_key: &str,
        in_repo: bool,
    ) -> StoreResult<Option<ArtifactRecord>> {
        let id = id.to_string();
        let path = path.to_string();
        let path_key = path_key.to_string();
        self.artifacts_db(move |conn| {
            let Some(mut rec) = get_in(conn, &id)? else {
                return Ok(None);
            };
            if let Some(other) = find_in(conn, &rec.scope, &path_key)? {
                if other.id != rec.id {
                    return Ok(None);
                }
            }
            rec.path = path;
            rec.path_key = path_key;
            rec.in_repo = in_repo;
            rec.missing = false;
            write_record(conn, &rec)?;
            Ok(Some(rec))
        })
        .await
    }

    /// Refresh the measured `hash`/`size`/`mtimeMs` of a row WITHOUT counting an
    /// edit or touching `lastWrittenAt` (a background rehash found the file
    /// different from the stored measurement; only an agent write is an edit).
    /// Also clears `missing` and stamps `checkedAt`. Returns the row only when
    /// a stored value changed.
    pub async fn refresh_measurement(
        &self,
        id: &str,
        hash: Option<String>,
        size: Option<u64>,
        mtime_ms: Option<i64>,
        checked_at: &str,
    ) -> StoreResult<Option<ArtifactRecord>> {
        let id = id.to_string();
        let checked_at = checked_at.to_string();
        self.artifacts_db(move |conn| {
            let Some(mut rec) = get_in(conn, &id)? else {
                return Ok(None);
            };
            let before = rec.clone();
            rec.hash = hash;
            rec.size = size;
            rec.mtime_ms = mtime_ms;
            rec.missing = false;
            let differs = rec != before;
            rec.checked_at = Some(checked_at);
            write_record(conn, &rec)?;
            Ok(differs.then_some(rec))
        })
        .await
    }

    /// Fold the row `new` into the missing row `old_id` in ONE transaction:
    /// delete `new`, re-point `old_id` at `new`'s path and refresh its measured
    /// hash/size/mtime from `new`. The old row keeps its id, pin, edit count
    /// and writers. Returns the updated old row, or `None` (nothing changed)
    /// when `old_id` or `new` is gone, `new` no longer owns its path key (an
    /// intake write re-created it), or a third row owns that key.
    pub async fn merge_artifact_into(
        &self,
        old_id: &str,
        new: ArtifactRecord,
        checked_at: &str,
    ) -> StoreResult<Option<ArtifactRecord>> {
        let old_id = old_id.to_string();
        let checked_at = checked_at.to_string();
        self.artifacts_db(move |conn| {
            let tx = conn.transaction()?;
            let Some(mut rec) = get_in(&tx, &old_id)? else {
                return Ok(None);
            };
            match find_in(&tx, &rec.scope, &new.path_key)? {
                Some(owner) if owner.id == new.id => {}
                _ => return Ok(None),
            }
            tx.execute("DELETE FROM artifacts WHERE id = ?1", params![new.id])?;
            rec.path = new.path;
            rec.path_key = new.path_key;
            rec.in_repo = new.in_repo;
            rec.hash = new.hash;
            rec.size = new.size;
            rec.mtime_ms = new.mtime_ms;
            rec.missing = false;
            rec.checked_at = Some(checked_at);
            write_record(&tx, &rec)?;
            tx.commit()?;
            Ok(Some(rec))
        })
        .await
    }

    /// Drop rows beyond [`ARTIFACT_CAP`]: hidden unpinned oldest first, then
    /// the oldest unpinned; pinned rows are never dropped. Returns the ids
    /// removed.
    pub async fn evict_over_cap(&self, scope: &ScopeKey) -> StoreResult<Vec<String>> {
        let scope = scope.clone();
        self.artifacts_db(move |conn| {
            let tx = conn.transaction()?;
            let total: i64 = tx.query_row(
                "SELECT COUNT(*) FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2",
                params![scope.scope_kind.as_str(), scope.scope_id],
                |r| r.get(0),
            )?;
            let excess = total - i64::from(ARTIFACT_CAP);
            if excess <= 0 {
                return Ok(Vec::new());
            }
            let ids = {
                let mut stmt = tx.prepare(
                    "SELECT id FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2 AND pinned = 0 \
                     ORDER BY hidden DESC, lastWrittenAt ASC, id ASC LIMIT ?3",
                )?;
                let ids = stmt
                    .query_map(
                        params![scope.scope_kind.as_str(), scope.scope_id, excess],
                        |r| r.get::<_, String>(0),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                ids
            };
            for id in &ids {
                tx.execute("DELETE FROM artifacts WHERE id = ?1", params![id])?;
            }
            tx.commit()?;
            Ok(ids)
        })
        .await
    }

    /// Delete every row of a scope (worktree/project deleted).
    pub async fn purge_scope(&self, scope: &ScopeKey) -> StoreResult<usize> {
        let scope = scope.clone();
        self.artifacts_db(move |conn| {
            Ok(conn.execute(
                "DELETE FROM artifacts WHERE scopeKind = ?1 AND scopeId = ?2",
                params![scope.scope_kind.as_str(), scope.scope_id],
            )?)
        })
        .await
    }

    /// Boot purge of rows whose worktree/project no longer exists.
    ///
    /// REFUSES (returns 0) when the `projects` table is empty: a failed or
    /// partial manifest migration looks exactly like "the user deleted
    /// everything", and guessing wrong would wipe every artifact. The caller
    /// must additionally only call this when `migrate_manifests` succeeded on
    /// this boot (see `vst-daemon`'s `artifact_boot`).
    pub async fn purge_orphan_artifacts(&self) -> StoreResult<usize> {
        self.artifacts_db(|conn| {
            let projects: i64 =
                conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))?;
            if projects == 0 {
                return Ok(0);
            }
            Ok(conn.execute(
                "DELETE FROM artifacts WHERE \
                 (scopeKind = 'worktree' AND scopeId NOT IN (SELECT id FROM worktrees)) OR \
                 (scopeKind = 'project' AND scopeId NOT IN (SELECT id FROM projects))",
                [],
            )?)
        })
        .await
    }
}
