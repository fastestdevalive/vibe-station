//! SQL for review comments: create / patch / delete / list, attach leases,
//! restore from a snapshot, and purges.
//!
//! `vst-review` is the single writer; this module only owns the statements.
//! There is NO foreign key on the tables (a project save re-inserts worktrees
//! and sessions), so rows of deleted scopes are purged explicitly
//! ([`StoreHandle::purge_scope_comments`], [`StoreHandle::purge_orphan_comments`]).
//!
//! Every method runs its SQL inside `spawn_blocking` on the one connection, so
//! a transaction here is atomic against every other store writer. The consumer
//! side (turn holds, scheduled-row snapshots, `take_for_*`) is in
//! [`crate::comment_consumers`].

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use vst_types::artifacts::{ScopeKey, ScopeKind};
use vst_types::review::{
    AnchorReason, AnchorState, CommentSurface, DiffScope, DiffSide, LineSpan, PathKind,
    RestoreReason, ReviewComment, ReviewCommentSnapshot, MAX_COMMENTS,
};
use vst_types::review_format::block_bytes;

use crate::{StoreError, StoreHandle, StoreResult};

pub(crate) const COLS: &str = "id, scopeKind, scopeId, pin, path, pathKind, surface, diffScope, \
    baseSha, side, lineStart, lineEnd, oldStart, oldEnd, newStart, newEnd, quote, prefix, suffix, \
    occurrence, text, anchor, anchorReason, curStart, curEnd, movedFrom, attachedTo, \
    restoredReason, blockBytes, version, createdAt, updatedAt";

/// Order shown everywhere: by file, then first line, then pin.
pub(crate) const ORDER: &str =
    "ORDER BY path ASC, COALESCE(lineStart, newStart, oldStart, 0) ASC, pin ASC";

pub(crate) fn comment_from_row(r: &Row<'_>) -> rusqlite::Result<ReviewComment> {
    let kind: String = r.get(1)?;
    let path_kind: String = r.get(5)?;
    let surface: String = r.get(6)?;
    let diff_scope: Option<String> = r.get(7)?;
    let side: Option<String> = r.get(9)?;
    let anchor: String = r.get(21)?;
    let anchor_reason: Option<String> = r.get(22)?;
    let cur_start: Option<u32> = r.get(23)?;
    let cur_end: Option<u32> = r.get(24)?;
    let restored: Option<String> = r.get(27)?;
    Ok(ReviewComment {
        id: r.get(0)?,
        scope_kind: ScopeKind::parse(&kind).unwrap_or(ScopeKind::Worktree),
        scope_id: r.get(2)?,
        pin: r.get(3)?,
        path: r.get(4)?,
        path_kind: PathKind::parse(&path_kind).unwrap_or(PathKind::Repo),
        surface: CommentSurface::parse(&surface).unwrap_or(CommentSurface::File),
        diff_scope: diff_scope.as_deref().and_then(DiffScope::parse),
        base_sha: r.get(8)?,
        side: side.as_deref().and_then(DiffSide::parse),
        line_start: r.get(10)?,
        line_end: r.get(11)?,
        old_start: r.get(12)?,
        old_end: r.get(13)?,
        new_start: r.get(14)?,
        new_end: r.get(15)?,
        quote: r.get(16)?,
        prefix: r.get(17)?,
        suffix: r.get(18)?,
        occurrence: r.get(19)?,
        text: r.get(20)?,
        anchor: AnchorState::parse(&anchor).unwrap_or(AnchorState::Anchored),
        anchor_reason: anchor_reason.as_deref().and_then(AnchorReason::parse),
        current: match (cur_start, cur_end) {
            (Some(start), Some(end)) => Some(LineSpan { start, end }),
            _ => None,
        },
        moved_from: r.get(25)?,
        attached_to: r.get(26)?,
        restored_reason: restored.as_deref().and_then(RestoreReason::parse),
        block_bytes: r.get(28)?,
        version: r.get(29)?,
        created_at: r.get(30)?,
        updated_at: r.get(31)?,
    })
}

/// The live-row predicate: a row marked `heldBy` belongs to an in-flight Rich
/// Chat turn and is "absent" for every reader except the hold code, the purges
/// and `list_comment_scopes` (see `vst-store/tests/comment_holds.rs` guard test).
pub(crate) const LIVE: &str = "heldBy IS NULL";

pub(crate) fn select_by_ids(
    conn: &Connection,
    scope: &ScopeKey,
    ids: &[String],
) -> rusqlite::Result<Vec<ReviewComment>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND id = ?3 AND {LIVE}"
    ))?;
    for id in ids {
        if let Some(c) = stmt
            .query_row(
                params![scope.scope_kind.as_str(), scope.scope_id, id],
                comment_from_row,
            )
            .optional()?
        {
            out.push(c);
        }
    }
    Ok(out)
}

pub(crate) fn select_one(conn: &Connection, id: &str) -> rusqlite::Result<Option<ReviewComment>> {
    conn.query_row(
        &format!("SELECT {COLS} FROM comments WHERE id = ?1 AND {LIVE}"),
        params![id],
        comment_from_row,
    )
    .optional()
}

/// A row by id whether live or held; the flag is `heldBy IS NOT NULL`. Only for
/// id-collision checks (`create_comment`, `restore_in`).
fn select_one_any(conn: &Connection, id: &str) -> rusqlite::Result<Option<(ReviewComment, bool)>> {
    conn.query_row(
        &format!("SELECT {COLS}, heldBy IS NOT NULL FROM comments WHERE id = ?1"),
        params![id],
        |r| Ok((comment_from_row(r)?, r.get::<_, bool>(32)?)),
    )
    .optional()
}

/// The next pin of a scope: the highest pin among its LIVE comment rows plus
/// one, or 1 when none (a send/schedule removes or hides the rows, so the next
/// batch starts again at 1). Gaps are allowed; a number is never handed out
/// while a higher-numbered live comment exists. There is no separate counter table.
pub(crate) fn peek_next_pin(tx: &Transaction<'_>, scope: &ScopeKey) -> rusqlite::Result<u32> {
    let max: Option<u32> = tx.query_row(
        "SELECT MAX(pin) FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND heldBy IS NULL",
        params![scope.scope_kind.as_str(), scope.scope_id],
        |r| r.get(0),
    )?;
    Ok(max.map_or(1, |m| m + 1))
}

pub(crate) fn pin_taken(
    tx: &Transaction<'_>,
    scope: &ScopeKey,
    pin: u32,
) -> rusqlite::Result<bool> {
    let n: i64 = tx.query_row(
        "SELECT COUNT(*) FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND pin = ?3 AND heldBy IS NULL",
        params![scope.scope_kind.as_str(), scope.scope_id, pin],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub(crate) fn live_count(tx: &Transaction<'_>, scope: &ScopeKey) -> rusqlite::Result<usize> {
    let n: i64 = tx.query_row(
        "SELECT COUNT(*) FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND heldBy IS NULL",
        params![scope.scope_kind.as_str(), scope.scope_id],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// The hold marker of a held row (`heldBy`, `heldSession`, `heldTurn`, `heldAt`).
pub(crate) struct HeldMark<'a> {
    pub hold_id: &'a str,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub at: &'a str,
}

fn insert_row(tx: &Transaction<'_>, c: &ReviewComment, or_ignore: bool) -> rusqlite::Result<usize> {
    insert_row_marked(tx, c, or_ignore, None)
}

fn insert_row_marked(
    tx: &Transaction<'_>,
    c: &ReviewComment,
    or_ignore: bool,
    held: Option<&HeldMark<'_>>,
) -> rusqlite::Result<usize> {
    let verb = if or_ignore {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO comments (id, scopeKind, scopeId, pin, path, pathKind, surface, diffScope, \
             baseSha, side, lineStart, lineEnd, oldStart, oldEnd, newStart, newEnd, quote, prefix, \
             suffix, occurrence, text, anchor, anchorReason, curStart, curEnd, movedFrom, \
             attachedTo, restoredReason, blockBytes, version, createdAt, updatedAt, \
             heldBy, heldSession, heldTurn, heldAt) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,\
             ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36)"
        ),
        params![
            c.id,
            c.scope_kind.as_str(),
            c.scope_id,
            c.pin,
            c.path,
            c.path_kind.as_str(),
            c.surface.as_str(),
            c.diff_scope.map(DiffScope::as_str),
            c.base_sha,
            c.side.map(DiffSide::as_str),
            c.line_start,
            c.line_end,
            c.old_start,
            c.old_end,
            c.new_start,
            c.new_end,
            c.quote,
            c.prefix,
            c.suffix,
            c.occurrence,
            c.text,
            c.anchor.as_str(),
            c.anchor_reason.map(AnchorReason::as_str),
            c.current.map(|s| s.start),
            c.current.map(|s| s.end),
            c.moved_from,
            c.attached_to,
            c.restored_reason.map(RestoreReason::as_str),
            c.block_bytes,
            c.version,
            c.created_at,
            c.updated_at,
            held.map(|h| h.hold_id),
            held.map(|h| h.session_id),
            held.map(|h| h.turn_id),
            held.map(|h| h.at),
        ],
    )
}

/// Insert a snapshot as a HELD row (adopting a scheduled hold: its rows were
/// deleted at schedule time). `INSERT OR IGNORE` by id: an id already present
/// (live or held) is skipped. Held rows are outside the live pin index, so the
/// snapshot keeps its pin. Returns whether a row was inserted.
pub(crate) fn insert_held_row(
    tx: &Transaction<'_>,
    scope: &ScopeKey,
    s: &ReviewCommentSnapshot,
    mark: &HeldMark<'_>,
    now: &str,
) -> rusqlite::Result<bool> {
    let row = comment_from_snapshot(scope, s, None, now);
    Ok(insert_row_marked(tx, &row, true, Some(mark))? > 0)
}

/// Result of [`StoreHandle::create_comment`].
#[derive(Clone, Debug, PartialEq)]
pub enum CreateOutcome {
    Created(ReviewComment),
    /// The id already exists in this scope: the first comment, unchanged.
    Existing(ReviewComment),
    /// The id belongs to another scope.
    IdTaken,
    /// The scope already has [`MAX_COMMENTS`] live comments.
    CapReached,
}

/// Rebuild a stored comment from a snapshot (restore path).
fn comment_from_snapshot(
    scope: &ScopeKey,
    s: &ReviewCommentSnapshot,
    reason: Option<RestoreReason>,
    now: &str,
) -> ReviewComment {
    let stored = match (s.line_start, s.line_end) {
        (Some(a), Some(b)) => Some(LineSpan { start: a, end: b }),
        _ => None,
    };
    ReviewComment {
        id: s.id.clone(),
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id.clone(),
        pin: s.pin,
        path: s.path.clone(),
        path_kind: s.path_kind,
        surface: s.surface,
        diff_scope: s.diff_scope,
        base_sha: s.base_sha.clone(),
        side: s.side,
        line_start: s.line_start,
        line_end: s.line_end,
        old_start: s.old_start,
        old_end: s.old_end,
        new_start: s.new_start,
        new_end: s.new_end,
        quote: s.quote.clone(),
        prefix: s.prefix.clone(),
        suffix: s.suffix.clone(),
        occurrence: s.occurrence,
        text: s.text.clone(),
        anchor: s.anchor,
        anchor_reason: s.anchor_reason,
        current: s.lines.filter(|l| Some(*l) != stored),
        moved_from: s.moved_from.clone(),
        attached_to: None,
        restored_reason: reason,
        block_bytes: block_bytes(s),
        version: 1,
        created_at: s.created_at.clone().unwrap_or_else(|| now.to_string()),
        updated_at: now.to_string(),
    }
}

impl StoreHandle {
    /// Run `f` on the connection inside `spawn_blocking`.
    pub(crate) async fn comments_db<T, F>(&self, f: F) -> StoreResult<T>
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

    /// Create a comment (idempotent by id). The pin is allocated inside the
    /// transaction as (highest existing pin in the scope) + 1, or 1 for an empty
    /// scope; `restore_pin` keeps its old pin only when it is free. `comment.pin`,
    /// `version`, and the timestamps are overwritten here.
    pub async fn create_comment(
        &self,
        comment: ReviewComment,
        restore_pin: Option<u32>,
        now: &str,
    ) -> StoreResult<CreateOutcome> {
        let now = now.to_string();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let scope = ScopeKey {
                scope_kind: comment.scope_kind,
                scope_id: comment.scope_id.clone(),
            };
            if let Some((existing, held)) = select_one_any(&tx, &comment.id)? {
                return Ok(
                    if !held
                        && existing.scope_kind == scope.scope_kind
                        && existing.scope_id == scope.scope_id
                    {
                        CreateOutcome::Existing(existing)
                    } else {
                        CreateOutcome::IdTaken
                    },
                );
            }
            if live_count(&tx, &scope)? >= MAX_COMMENTS {
                return Ok(CreateOutcome::CapReached);
            }
            let pin = match restore_pin {
                Some(p) if p >= 1 && !pin_taken(&tx, &scope, p)? => p,
                _ => peek_next_pin(&tx, &scope)?,
            };
            let mut row = comment;
            row.pin = pin;
            row.version = 1;
            row.attached_to = None;
            row.restored_reason = None;
            row.created_at = now.clone();
            row.updated_at = now;
            insert_row(&tx, &row, false)?;
            tx.commit()?;
            Ok(CreateOutcome::Created(row))
        })
        .await
    }

    /// One comment by id.
    pub async fn get_comment(&self, id: &str) -> StoreResult<Option<ReviewComment>> {
        let id = id.to_string();
        self.comments_db(move |conn| Ok(select_one(conn, &id)?))
            .await
    }

    /// Comments of a scope ordered by (path, first line, pin); `path` narrows to
    /// one file, `unsent_only` to those not attached to any composer.
    pub async fn list_comments(
        &self,
        scope: &ScopeKey,
        path: Option<&str>,
        unsent_only: bool,
    ) -> StoreResult<Vec<ReviewComment>> {
        let scope = scope.clone();
        let path = path.map(str::to_string);
        self.comments_db(move |conn| {
            let mut sql = format!(
                "SELECT {COLS} FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 \
                 AND (?3 IS NULL OR path = ?3) AND heldBy IS NULL"
            );
            if unsent_only {
                sql.push_str(" AND attachedTo IS NULL");
            }
            sql.push(' ');
            sql.push_str(ORDER);
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(
                    params![scope.scope_kind.as_str(), scope.scope_id, path],
                    comment_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// The pin the next created comment of a scope would get.
    pub async fn next_comment_pin(&self, scope: &ScopeKey) -> StoreResult<u32> {
        let scope = scope.clone();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            Ok(peek_next_pin(&tx, &scope)?)
        })
        .await
    }

    /// Replace a comment's text (last writer wins; `version` and `updatedAt`
    /// bump). `None` when it no longer exists.
    pub async fn update_comment_text(
        &self,
        id: &str,
        text: &str,
        block_bytes: u32,
        now: &str,
    ) -> StoreResult<Option<ReviewComment>> {
        let (id, text, now) = (id.to_string(), text.to_string(), now.to_string());
        self.comments_db(move |conn| {
            let n = conn.execute(
                "UPDATE comments SET text = ?2, blockBytes = ?3, version = version + 1, updatedAt = ?4 \
                 WHERE id = ?1 AND heldBy IS NULL",
                params![id, text, block_bytes, now],
            )?;
            if n == 0 {
                return Ok(None);
            }
            Ok(select_one(conn, &id)?)
        })
        .await
    }

    /// Delete a comment; returns the removed row.
    pub async fn delete_comment(&self, id: &str) -> StoreResult<Option<ReviewComment>> {
        let id = id.to_string();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let row = select_one(&tx, &id)?;
            if row.is_some() {
                tx.execute(
                    "DELETE FROM comments WHERE id = ?1 AND heldBy IS NULL",
                    params![id],
                )?;
            }
            tx.commit()?;
            Ok(row)
        })
        .await
    }

    /// Clear the "restored" notice of a scope's comments; returns the changed rows.
    pub async fn dismiss_restored(&self, scope: &ScopeKey) -> StoreResult<Vec<ReviewComment>> {
        let scope = scope.clone();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let ids: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT id FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND restoredReason IS NOT NULL AND heldBy IS NULL",
                )?;
                let rows = stmt
                    .query_map(params![scope.scope_kind.as_str(), scope.scope_id], |r| {
                        r.get(0)
                    })?
                    .collect::<Result<Vec<String>, _>>()?;
                rows
            };
            tx.execute(
                "UPDATE comments SET restoredReason = NULL WHERE scopeKind = ?1 AND scopeId = ?2 AND restoredReason IS NOT NULL AND heldBy IS NULL",
                params![scope.scope_kind.as_str(), scope.scope_id],
            )?;
            let rows = select_by_ids(&tx, &scope, &ids)?;
            tx.commit()?;
            Ok(rows)
        })
        .await
    }

    // ── Attach leases ─────────────────────────────────────────────────────────

    /// Attach comments to a composer (`session:<id>`), moving them from any other
    /// composer. `ids == None` = every comment of the scope. Returns the rows that
    /// changed (for events) and every id of the request now attached to `key`.
    pub async fn attach_comments(
        &self,
        scope: &ScopeKey,
        key: &str,
        ids: Option<&[String]>,
        now: &str,
    ) -> StoreResult<AttachOutcome> {
        let (scope, key, now) = (scope.clone(), key.to_string(), now.to_string());
        let ids = ids.map(<[String]>::to_vec);
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let targets: Vec<String> = match ids {
                Some(ids) => select_by_ids(&tx, &scope, &ids)?
                    .into_iter()
                    .map(|c| c.id)
                    .collect(),
                None => {
                    let mut stmt = tx.prepare(
                        "SELECT id FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 AND heldBy IS NULL",
                    )?;
                    let rows = stmt
                        .query_map(params![scope.scope_kind.as_str(), scope.scope_id], |r| {
                            r.get(0)
                        })?
                        .collect::<Result<Vec<String>, _>>()?;
                    rows
                }
            };
            let mut changed = Vec::new();
            for id in &targets {
                let moved = tx.execute(
                    "UPDATE comments SET attachedTo = ?2, attachedAt = ?3, attachTouchedAt = ?3 \
                     WHERE id = ?1 AND heldBy IS NULL AND (attachedTo IS NULL OR attachedTo != ?2)",
                    params![id, key, now],
                )?;
                if moved > 0 {
                    changed.push(id.clone());
                } else {
                    tx.execute(
                        "UPDATE comments SET attachTouchedAt = ?3 WHERE id = ?1 AND attachedTo = ?2 AND heldBy IS NULL",
                        params![id, key, now],
                    )?;
                }
            }
            let rows = select_by_ids(&tx, &scope, &changed)?;
            tx.commit()?;
            Ok(AttachOutcome {
                changed: rows,
                attached: targets,
            })
        })
        .await
    }

    /// Extend the lease of every comment attached to `key` in `scope`; returns how
    /// many comments hold it. Never attaches anything new and emits no event.
    pub async fn refresh_lease(
        &self,
        scope: &ScopeKey,
        key: &str,
        now: &str,
    ) -> StoreResult<usize> {
        let (scope, key, now) = (scope.clone(), key.to_string(), now.to_string());
        self.comments_db(move |conn| {
            Ok(conn.execute(
                "UPDATE comments SET attachTouchedAt = ?4 WHERE scopeKind = ?1 AND scopeId = ?2 AND attachedTo = ?3 AND heldBy IS NULL",
                params![scope.scope_kind.as_str(), scope.scope_id, key, now],
            )?)
        })
        .await
    }

    /// Detach attached comments of a scope (optionally only those of one composer
    /// and/or in `ids`); returns the changed rows.
    pub async fn detach_comments(
        &self,
        scope: &ScopeKey,
        key: Option<&str>,
        ids: Option<&[String]>,
    ) -> StoreResult<Vec<ReviewComment>> {
        let scope = scope.clone();
        let key = key.map(str::to_string);
        let ids = ids.map(<[String]>::to_vec);
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let candidates: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT id FROM comments WHERE scopeKind = ?1 AND scopeId = ?2 \
                     AND attachedTo IS NOT NULL AND (?3 IS NULL OR attachedTo = ?3) AND heldBy IS NULL",
                )?;
                let rows = stmt
                    .query_map(
                        params![scope.scope_kind.as_str(), scope.scope_id, key],
                        |r| r.get(0),
                    )?
                    .collect::<Result<Vec<String>, _>>()?;
                rows
            };
            let targets: Vec<String> = match ids {
                Some(ids) => candidates.into_iter().filter(|c| ids.contains(c)).collect(),
                None => candidates,
            };
            for id in &targets {
                tx.execute(
                    "UPDATE comments SET attachedTo = NULL, attachedAt = NULL, attachTouchedAt = NULL WHERE id = ?1 AND heldBy IS NULL",
                    params![id],
                )?;
            }
            let rows = select_by_ids(&tx, &scope, &targets)?;
            tx.commit()?;
            Ok(rows)
        })
        .await
    }

    /// Detach everything attached to one composer, across scopes (its session was
    /// deleted or changed channel); returns the changed rows.
    pub async fn detach_composer(&self, key: &str) -> StoreResult<Vec<ReviewComment>> {
        let key = key.to_string();
        self.comments_db(move |conn| detach_where(conn, "attachedTo = ?1", &key))
            .await
    }

    /// Distinct composer keys that currently hold at least one comment.
    pub async fn list_attached_composers(&self) -> StoreResult<Vec<String>> {
        self.comments_db(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT attachedTo FROM comments WHERE attachedTo IS NOT NULL AND heldBy IS NULL ORDER BY attachedTo",
            )?;
            let rows = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// Detach every lease untouched since `cutoff` (ISO8601, same format the
    /// caller stamps); returns the changed rows.
    pub async fn expire_leases(&self, cutoff: &str) -> StoreResult<Vec<ReviewComment>> {
        let cutoff = cutoff.to_string();
        self.comments_db(move |conn| {
            detach_where(
                conn,
                "attachedTo IS NOT NULL AND attachTouchedAt IS NOT NULL AND attachTouchedAt < ?1",
                &cutoff,
            )
        })
        .await
    }

    // ── Restore ───────────────────────────────────────────────────────────────

    /// Put snapshotted comments back into the panel with their original pins
    /// (`INSERT OR IGNORE` by id and by pin, so a repeat restores nothing new and
    /// a live comment is never overwritten). Restored rows are detached and carry
    /// `reason` until dismissed. The 500 cap is not applied: a restore never loses
    /// comments. Returns the rows actually inserted.
    pub async fn restore_comments(
        &self,
        scope: &ScopeKey,
        snapshots: &[ReviewCommentSnapshot],
        reason: RestoreReason,
        now: &str,
    ) -> StoreResult<Vec<ReviewComment>> {
        let scope = scope.clone();
        let snapshots = snapshots.to_vec();
        let now = now.to_string();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let rows = restore_in(&tx, &scope, &snapshots, Some(reason), &now)?;
            tx.commit()?;
            Ok(rows)
        })
        .await
    }

    /// [`restore_comments`](Self::restore_comments) without a tray notice
    /// (`restoredReason` stays unset): the user asked for it ("Restore to
    /// comments" on a sent card).
    pub async fn restore_comments_quiet(
        &self,
        scope: &ScopeKey,
        snapshots: &[ReviewCommentSnapshot],
        now: &str,
    ) -> StoreResult<Vec<ReviewComment>> {
        let scope = scope.clone();
        let snapshots = snapshots.to_vec();
        let now = now.to_string();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let rows = restore_in(&tx, &scope, &snapshots, None, &now)?;
            tx.commit()?;
            Ok(rows)
        })
        .await
    }

    // ── Anchoring ─────────────────────────────────────────────────────────────

    /// Every scope that has at least one comment (boot pass, resync).
    pub async fn list_comment_scopes(&self) -> StoreResult<Vec<ScopeKey>> {
        self.comments_db(|conn| {
            let mut stmt =
                conn.prepare("SELECT DISTINCT scopeKind, scopeId FROM comments ORDER BY 1, 2")?;
            let rows = stmt
                .query_map([], |r| {
                    let kind: String = r.get(0)?;
                    Ok(ScopeKey {
                        scope_kind: ScopeKind::parse(&kind).unwrap_or(ScopeKind::Worktree),
                        scope_id: r.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// Write re-anchor results in one transaction. `version` and `updatedAt`
    /// never change (the text did not). Returns only the rows that actually
    /// differ afterwards, so an unchanged re-check sends no event.
    pub async fn apply_anchor_updates(
        &self,
        updates: Vec<AnchorUpdate>,
    ) -> StoreResult<Vec<ReviewComment>> {
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let mut changed = Vec::new();
            for u in updates {
                let Some(old) = select_one(&tx, &u.id)? else {
                    continue;
                };
                if old.path == u.path
                    && old.moved_from == u.moved_from
                    && old.anchor == u.anchor
                    && old.anchor_reason == u.reason
                    && old.current == u.current
                {
                    continue;
                }
                tx.execute(
                    "UPDATE comments SET path = ?2, movedFrom = ?3, anchor = ?4, anchorReason = ?5, \
                     curStart = ?6, curEnd = ?7 WHERE id = ?1 AND heldBy IS NULL",
                    params![
                        u.id,
                        u.path,
                        u.moved_from,
                        u.anchor.as_str(),
                        u.reason.map(AnchorReason::as_str),
                        u.current.map(|c| c.start),
                        u.current.map(|c| c.end),
                    ],
                )?;
                if let Some(row) = select_one(&tx, &u.id)? {
                    changed.push(row);
                }
            }
            tx.commit()?;
            Ok(changed)
        })
        .await
    }

    // ── Purges ────────────────────────────────────────────────────────────────

    /// Delete every comment (held ones included) of a scope (worktree / project
    /// deleted). Returns the number of comment rows removed.
    pub async fn purge_scope_comments(&self, scope: &ScopeKey) -> StoreResult<usize> {
        let scope = scope.clone();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let (k, id) = (scope.scope_kind.as_str(), scope.scope_id.as_str());
            let n = tx.execute(
                "DELETE FROM comments WHERE scopeKind = ?1 AND scopeId = ?2",
                params![k, id],
            )?;
            tx.commit()?;
            Ok(n)
        })
        .await
    }

    /// Boot purge of comments (held ones included) whose worktree / project no
    /// longer exists. REFUSES (returns 0) when the `projects` table is empty: a
    /// failed or partial manifest migration looks exactly like "the user deleted
    /// everything" (the caller must additionally only run it after a successful
    /// migration, as `artifact_boot` does).
    pub async fn purge_orphan_comments(&self) -> StoreResult<usize> {
        self.comments_db(|conn| {
            let tx = conn.transaction()?;
            let projects: i64 = tx.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))?;
            if projects == 0 {
                return Ok(0);
            }
            const ORPHAN: &str =
                "(scopeKind = 'worktree' AND scopeId NOT IN (SELECT id FROM worktrees)) OR \
                 (scopeKind = 'project' AND scopeId NOT IN (SELECT id FROM projects))";
            let n = tx.execute(&format!("DELETE FROM comments WHERE {ORPHAN}"), [])?;
            tx.commit()?;
            Ok(n)
        })
        .await
    }
}

/// One re-anchor result (see [`StoreHandle::apply_anchor_updates`]); every field
/// is the FINAL value to store.
#[derive(Clone, Debug, PartialEq)]
pub struct AnchorUpdate {
    pub id: String,
    pub path: String,
    pub moved_from: Option<String>,
    pub anchor: AnchorState,
    pub reason: Option<AnchorReason>,
    pub current: Option<LineSpan>,
}

/// Result of [`StoreHandle::attach_comments`].
#[derive(Clone, Debug, PartialEq)]
pub struct AttachOutcome {
    /// Rows whose `attachedTo` changed (events).
    pub changed: Vec<ReviewComment>,
    /// Every id of the request that is now attached to the composer.
    pub attached: Vec<String>,
}

/// Detach the rows matching `where_clause` (one bound parameter) and return them.
fn detach_where(
    conn: &mut Connection,
    where_clause: &str,
    bind: &str,
) -> StoreResult<Vec<ReviewComment>> {
    let tx = conn.transaction()?;
    let ids: Vec<(String, String, String)> = {
        let mut stmt = tx.prepare(&format!(
            "SELECT id, scopeKind, scopeId FROM comments WHERE ({where_clause}) AND heldBy IS NULL"
        ))?;
        let rows = stmt
            .query_map(params![bind], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    tx.execute(
        &format!(
            "UPDATE comments SET attachedTo = NULL, attachedAt = NULL, attachTouchedAt = NULL WHERE ({where_clause}) AND heldBy IS NULL"
        ),
        params![bind],
    )?;
    let mut out = Vec::new();
    for (id, kind, scope_id) in ids {
        let scope = ScopeKey {
            scope_kind: ScopeKind::parse(&kind).unwrap_or(ScopeKind::Worktree),
            scope_id,
        };
        out.extend(select_by_ids(&tx, &scope, &[id])?);
    }
    tx.commit()?;
    Ok(out)
}

/// The restore body, shared with the consumer-side restores.
pub(crate) fn restore_in(
    tx: &Transaction<'_>,
    scope: &ScopeKey,
    snapshots: &[ReviewCommentSnapshot],
    reason: Option<RestoreReason>,
    now: &str,
) -> rusqlite::Result<Vec<ReviewComment>> {
    let mut inserted = Vec::new();
    for s in snapshots {
        let mut row = comment_from_snapshot(scope, s, reason, now);
        if select_one_any(tx, &row.id)?.is_some() {
            continue; // idempotent by id (a held row counts: its hold restores it)
        }
        // Keep the old pin only when free; otherwise max + 1 (never a duplicate).
        if row.pin < 1 || pin_taken(tx, scope, row.pin)? {
            row.pin = peek_next_pin(tx, scope)?;
        }
        if insert_row(tx, &row, true)? > 0 {
            inserted.push(row);
        }
    }
    Ok(inserted)
}
