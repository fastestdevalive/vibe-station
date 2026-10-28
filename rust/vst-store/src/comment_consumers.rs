//! The consumer side of review comments: a send removes the rows and keeps their
//! snapshot where the delivery lives, in the same transaction.
//!
//! - a Rich Chat turn: the rows stay in `comments`, marked `heldBy = <holdId>`
//!   (+ `heldSession` / `heldTurn` / `heldAt`) and hidden from every reader,
//!   until the turn's user row is persisted (rows deleted) or the turn is
//!   cancelled / released / crashes (marker cleared);
//! - a scheduled message: the `scheduled_messages.commentsSnapshot` JSON object
//!   ([`ScheduledReviewPayload`]) with `origin = 'schedule'`;
//! - a Terminal send: the same column on a row inserted already claimed and
//!   `waiting` with `origin = 'immediate'` (see [`StoreHandle::take_for_terminal_row`]).

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    PayloadState, ReviewComment, ReviewCommentSnapshot, ReviewError, ReviewRecord,
    ScheduledReviewPayload,
};
use vst_types::review_format::render_review_block;

use crate::comments::{
    insert_held_row, peek_next_pin, pin_taken, select_by_ids, HeldMark, COLS, ORDER,
};
use crate::{StoreError, StoreHandle, StoreResult};

/// Largest send accepted by the consuming delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TakeLimits {
    pub max_comments: usize,
    /// Bytes of the rendered block (header included).
    pub max_bytes: usize,
}

/// What a successful take removed.
#[derive(Clone, Debug, PartialEq)]
pub struct Taken {
    /// Snapshots in rendering order.
    pub snapshots: Vec<ReviewCommentSnapshot>,
    /// Ids that left the panel (event: `deleted`).
    pub deleted: Vec<String>,
    /// Immediate Terminal sends only: scheduled messages of the session that are
    /// waiting or pasting ahead of this one.
    pub waits_behind: Option<u32>,
    /// A hold with this id already existed (idempotent retry): nothing was taken.
    pub existing: bool,
}

/// Prefix of the hold id of a hold adopted from scheduled row `<rowId>`.
pub const ADOPT_HOLD_PREFIX: &str = "adopt:";

/// A Rich Chat turn's hold, as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredHold {
    pub hold_id: String,
    pub scope: ScopeKey,
    pub session_id: String,
    pub turn_id: String,
    pub record: ReviewRecord,
    pub created_at: String,
}

/// Where to put the snapshot of a Rich Chat turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldSpec {
    pub hold_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub created_at: String,
}

/// A scheduled-message row to insert together with its snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleSpec {
    /// Row id (a Terminal send uses its `terminalDeliveryId`).
    pub id: String,
    pub session_id: String,
    /// The user's message only; the block is rendered from the snapshot later.
    pub message: String,
    pub fire_at: String,
    pub now: String,
    /// `'json'` / `'tmux'` at create time.
    pub channel: Option<String>,
    /// JSON blob of resolved attachments (scheduled Rich Chat rows only).
    pub attachments: Option<String>,
}

/// The consumer of a take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Consumer {
    Hold(HoldSpec),
    Schedule(ScheduleSpec),
}

/// A held snapshot found on a scheduled row.
#[derive(Clone, Debug, PartialEq)]
pub struct HeldSnapshot {
    pub row_id: String,
    pub session_id: String,
    pub payload: ScheduledReviewPayload,
}

/// Which rows [`StoreHandle::list_held_snapshots`] looks at. All variants only
/// consider `status = 'pending'` rows whose payload state is `held`, and (except
/// [`HeldFilter::OrphanedSessionsAnyChannel`]) that are NOT `channel = 'tmux'`
/// (tmux rows are restored solely through the delivery outcome observer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldFilter<'a> {
    /// Rows of one session.
    Session(&'a str),
    /// Rows whose session no longer exists.
    OrphanedSessions,
    /// Rows a previous daemon had claimed (delivery in flight when it died),
    /// excluding rows that carry a delivery phase (terminal delivery owns those).
    Claimed,
    /// Boot only: rows whose session no longer exists, INCLUDING `channel = 'tmux'`
    /// rows (the boot purge is about to delete them and no outcome will ever be
    /// reported for a session that is gone).
    OrphanedSessionsAnyChannel,
}

/// An in-flight immediate Terminal send.
#[derive(Clone, Debug, PartialEq)]
pub struct ImmediateRow {
    pub row_id: String,
    pub session_id: String,
    pub message: String,
    pub phase: Option<String>,
    pub updated_at: String,
    pub waits_behind: u32,
    pub payload: ScheduledReviewPayload,
}

fn to_internal(e: rusqlite::Error) -> ReviewError {
    ReviewError::Internal(e.to_string())
}

/// What a take does with the validated rows.
#[derive(Clone, Copy)]
enum TakeMode<'a> {
    /// Delete them (schedules, Terminal immediates, re-hold).
    Delete,
    /// Mark them held by a Rich Chat turn.
    Hold(&'a HoldSpec),
}

/// Validate and remove (or hold) the rows; returns the snapshots in rendering order.
#[allow(clippy::too_many_arguments)]
fn take_rows_in(
    tx: &Transaction<'_>,
    scope: &ScopeKey,
    ids: &[String],
    composer: Option<&str>,
    name: &str,
    limits: TakeLimits,
    mode: TakeMode<'_>,
) -> Result<(Vec<ReviewCommentSnapshot>, Vec<String>), ReviewError> {
    let mut wanted: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !wanted.contains(id) {
            wanted.push(id.clone());
        }
    }
    let mut rows: Vec<ReviewComment> = select_by_ids(tx, scope, &wanted).map_err(to_internal)?;
    if rows.len() != wanted.len() {
        return Err(ReviewError::Changed {
            remaining: u32::try_from(rows.len()).unwrap_or(u32::MAX),
        });
    }
    for r in &rows {
        let ok = match (composer, r.attached_to.as_deref()) {
            (Some(k), Some(a)) => k == a,
            (None, None) => true,
            _ => false,
        };
        if !ok {
            return Err(ReviewError::NotAttached);
        }
    }
    rows.sort_by(|a, b| {
        (
            &a.path,
            a.line_start.or(a.new_start).or(a.old_start).unwrap_or(0),
            a.pin,
        )
            .cmp(&(
                &b.path,
                b.line_start.or(b.new_start).or(b.old_start).unwrap_or(0),
                b.pin,
            ))
    });
    if rows.len() > limits.max_comments {
        return Err(ReviewError::TooLarge {
            limit: u32::try_from(limits.max_comments).unwrap_or(u32::MAX),
            unit: "comments",
        });
    }
    let snapshots: Vec<ReviewCommentSnapshot> =
        rows.iter().map(ReviewComment::to_snapshot).collect();
    if render_review_block(name, &snapshots).len() > limits.max_bytes {
        return Err(ReviewError::TooLarge {
            limit: u32::try_from(limits.max_bytes).unwrap_or(u32::MAX),
            unit: "bytes",
        });
    }
    for id in &wanted {
        let n = match mode {
            TakeMode::Delete => tx
                .execute(
                    "DELETE FROM comments WHERE id = ?1 AND heldBy IS NULL",
                    params![id],
                )
                .map_err(to_internal)?,
            TakeMode::Hold(h) => tx
                .execute(
                    "UPDATE comments SET heldBy = ?2, heldSession = ?3, heldTurn = ?4, heldAt = ?5, \
                     attachedTo = NULL, attachedAt = NULL, attachTouchedAt = NULL, restoredReason = NULL \
                     WHERE id = ?1 AND heldBy IS NULL",
                    params![id, h.hold_id, h.session_id, h.turn_id, h.created_at],
                )
                .map_err(to_internal)?,
        };
        if n != 1 {
            return Err(ReviewError::Changed { remaining: 0 });
        }
    }
    Ok((snapshots, wanted))
}

fn payload_json(scope: &ScopeKey, name: &str, snapshots: &[ReviewCommentSnapshot]) -> String {
    serde_json::to_string(&ScheduledReviewPayload {
        state: PayloadState::Held,
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id.clone(),
        name: name.to_string(),
        comments: snapshots.to_vec(),
    })
    .unwrap_or_else(|_| "{}".to_string())
}

/// A held row plus its marker.
struct HeldRow {
    comment: ReviewComment,
    hold_id: String,
    session_id: String,
    turn_id: String,
    held_at: String,
}

/// Held rows (all, one hold, or one session's), grouped by hold in render order.
fn select_held(
    conn: &Connection,
    hold_id: Option<&str>,
    session_id: Option<&str>,
) -> rusqlite::Result<Vec<HeldRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS}, heldBy, heldSession, heldTurn, heldAt FROM comments \
         WHERE heldBy IS NOT NULL AND (?1 IS NULL OR heldBy = ?1) \
         AND (?2 IS NULL OR heldSession = ?2) ORDER BY heldAt ASC, heldBy ASC, {order}",
        order = ORDER.trim_start_matches("ORDER BY ")
    ))?;
    let rows = stmt
        .query_map(params![hold_id, session_id], |r| {
            Ok(HeldRow {
                comment: crate::comments::comment_from_row(r)?,
                hold_id: r.get(32)?,
                // Tolerate a NULL marker column: one bad row must not make the
                // whole query fail (boot would then see no holds at all).
                session_id: r.get::<_, Option<String>>(33)?.unwrap_or_default(),
                turn_id: r.get::<_, Option<String>>(34)?.unwrap_or_default(),
                held_at: r.get::<_, Option<String>>(35)?.unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Group held rows into holds (rows are already ordered by hold, then render order).
fn group_holds(rows: Vec<HeldRow>) -> Vec<StoredHold> {
    let mut out: Vec<StoredHold> = Vec::new();
    for r in rows {
        if out.last().map(|h| h.hold_id.as_str()) != Some(r.hold_id.as_str()) {
            out.push(StoredHold {
                hold_id: r.hold_id.clone(),
                scope: ScopeKey {
                    scope_kind: r.comment.scope_kind,
                    scope_id: r.comment.scope_id.clone(),
                },
                session_id: r.session_id.clone(),
                turn_id: r.turn_id.clone(),
                // The name is rendered from the in-memory turn; not stored.
                record: ReviewRecord {
                    name: String::new(),
                    comments: Vec::new(),
                },
                created_at: r.held_at.clone(),
            });
        }
        if let Some(h) = out.last_mut() {
            h.record.comments.push(r.comment.to_snapshot());
        }
    }
    out
}

fn select_hold(conn: &Connection, hold_id: &str) -> rusqlite::Result<Option<StoredHold>> {
    Ok(group_holds(select_held(conn, Some(hold_id), None)?)
        .into_iter()
        .next())
}

/// Flip the `state` of a row's payload (`only_from` limits which states may flip).
fn flip_payload_in(
    conn: &Connection,
    row_id: &str,
    to: PayloadState,
    only_from: Option<&[PayloadState]>,
) -> rusqlite::Result<bool> {
    let Some(raw): Option<Option<String>> = conn
        .query_row(
            "SELECT commentsSnapshot FROM scheduled_messages WHERE id = ?1",
            params![row_id],
            |r| r.get(0),
        )
        .optional()?
    else {
        return Ok(false);
    };
    let Some(raw) = raw else { return Ok(false) };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false);
    };
    let current = v
        .get("state")
        .and_then(|s| s.as_str())
        .and_then(PayloadState::parse);
    if let (Some(from), Some(cur)) = (only_from, current) {
        if !from.contains(&cur) {
            return Ok(false);
        }
    }
    if current == Some(to) {
        return Ok(false);
    }
    v["state"] = serde_json::Value::String(to.as_str().to_string());
    conn.execute(
        "UPDATE scheduled_messages SET commentsSnapshot = ?2 WHERE id = ?1",
        params![row_id, v.to_string()],
    )?;
    Ok(true)
}

fn waits_behind_in(conn: &Connection, session_id: &str) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM scheduled_messages WHERE sessionId = ?1 AND status = 'pending' \
         AND (origin IS NULL OR origin != 'immediate') AND deliveryPhase IN ('waiting','pasting')",
        params![session_id],
        |r| r.get(0),
    )
}

fn insert_schedule_row(
    tx: &Transaction<'_>,
    spec: &ScheduleSpec,
    payload: &str,
    immediate: bool,
) -> rusqlite::Result<usize> {
    if immediate {
        tx.execute(
            "INSERT INTO scheduled_messages (id, sessionId, message, attachments, fireAt, createdAt, \
             updatedAt, status, channel, commentsSnapshot, origin, claimedAt, deliveryPhase) \
             VALUES (?1, ?2, ?3, ?8, ?4, ?5, ?5, 'pending', ?6, ?7, 'immediate', ?5, 'waiting')",
            params![spec.id, spec.session_id, spec.message, spec.fire_at, spec.now, spec.channel, payload, spec.attachments],
        )
    } else {
        tx.execute(
            "INSERT INTO scheduled_messages (id, sessionId, message, attachments, fireAt, createdAt, \
             updatedAt, status, channel, commentsSnapshot, origin) \
             VALUES (?1, ?2, ?3, ?8, ?4, ?5, ?5, 'pending', ?6, ?7, 'schedule')",
            params![spec.id, spec.session_id, spec.message, spec.fire_at, spec.now, spec.channel, payload, spec.attachments],
        )
    }
}

impl StoreHandle {
    /// Remove `ids` from the panel and store their snapshot with the consumer in
    /// ONE transaction (a Rich Chat hold, or a scheduled row). `composer` is the
    /// sending composer (`session:<id>`) when the ids come from its chip: every id
    /// must then be attached to it; without it every id must be unattached.
    pub async fn take_for_consumer(
        &self,
        scope: &ScopeKey,
        ids: &[String],
        composer: Option<&str>,
        name: &str,
        limits: TakeLimits,
        consumer: Consumer,
    ) -> StoreResult<Result<Taken, ReviewError>> {
        let (scope, ids, name) = (scope.clone(), ids.to_vec(), name.to_string());
        let composer = composer.map(str::to_string);
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            if let Consumer::Hold(h) = &consumer {
                if let Some(existing) = select_hold(&tx, &h.hold_id)? {
                    return Ok(Ok(Taken {
                        snapshots: existing.record.comments,
                        deleted: Vec::new(),
                        waits_behind: None,
                        existing: true,
                    }));
                }
            }
            let mode = match &consumer {
                Consumer::Hold(h) => TakeMode::Hold(h),
                Consumer::Schedule(_) => TakeMode::Delete,
            };
            let (snapshots, deleted) =
                match take_rows_in(&tx, &scope, &ids, composer.as_deref(), &name, limits, mode) {
                    Ok(t) => t,
                    Err(e) => return Ok(Err(e)),
                };
            match &consumer {
                Consumer::Hold(_) => {}
                Consumer::Schedule(spec) => {
                    insert_schedule_row(
                        &tx,
                        spec,
                        &payload_json(&scope, &name, &snapshots),
                        false,
                    )?;
                }
            }
            tx.commit()?;
            Ok(Ok(Taken {
                snapshots,
                deleted,
                waits_behind: None,
                existing: false,
            }))
        })
        .await
    }

    /// Terminal send: in one transaction refuse when another immediate send of
    /// the session is pending (`InFlight`) or this id already exists
    /// (`Duplicate`), otherwise remove the rows and insert the immediate row
    /// already claimed and `waiting` (`origin = 'immediate'`), so the 1 s poller
    /// never sees it. `waits_behind` counts the session's waiting / pasting
    /// scheduled messages. A waiting schedule never blocks an immediate send.
    pub async fn take_for_terminal_row(
        &self,
        scope: &ScopeKey,
        ids: &[String],
        composer: Option<&str>,
        name: &str,
        limits: TakeLimits,
        row: ScheduleSpec,
    ) -> StoreResult<Result<Taken, ReviewError>> {
        let (scope, ids, name) = (scope.clone(), ids.to_vec(), name.to_string());
        let composer = composer.map(str::to_string);
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM scheduled_messages WHERE id = ?1",
                params![row.id],
                |r| r.get(0),
            )?;
            if exists > 0 {
                return Ok(Err(ReviewError::Duplicate));
            }
            let in_flight: i64 = tx.query_row(
                "SELECT COUNT(*) FROM scheduled_messages WHERE sessionId = ?1 \
                 AND origin = 'immediate' AND status = 'pending' AND id != ?2",
                params![row.session_id, row.id],
                |r| r.get(0),
            )?;
            if in_flight > 0 {
                return Ok(Err(ReviewError::InFlight));
            }
            let (snapshots, deleted) = match take_rows_in(
                &tx,
                &scope,
                &ids,
                composer.as_deref(),
                &name,
                limits,
                TakeMode::Delete,
            ) {
                Ok(t) => t,
                Err(e) => return Ok(Err(e)),
            };
            insert_schedule_row(&tx, &row, &payload_json(&scope, &name, &snapshots), true)?;
            let waits = waits_behind_in(&tx, &row.session_id)?;
            tx.commit()?;
            Ok(Ok(Taken {
                snapshots,
                deleted,
                waits_behind: Some(waits),
                existing: false,
            }))
        })
        .await
    }

    /// Store a hold built from a snapshot (a scheduled Rich Chat row fired): its
    /// comments are inserted as HELD rows (their live rows were deleted at schedule
    /// time); an id already present, live or held, is skipped. Idempotent by `hold_id`. With `adopt_row`, that scheduled row's payload is
    /// flipped `held -> adopted` in the same transaction, so a crash can never
    /// leave both a hold and a `held` snapshot restorable; `false` (nothing
    /// stored) when the row is no longer `held`.
    pub async fn insert_hold(
        &self,
        hold: StoredHold,
        adopt_row: Option<&str>,
    ) -> StoreResult<bool> {
        let adopt_row = adopt_row.map(str::to_string);
        let adopt_row_id = adopt_row.clone();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            if let Some(row) = adopt_row {
                if !flip_payload_in(
                    &tx,
                    &row,
                    PayloadState::Adopted,
                    Some(&[PayloadState::Held]),
                )? {
                    return Ok(false);
                }
            }
            let mark = HeldMark {
                hold_id: &hold.hold_id,
                session_id: &hold.session_id,
                turn_id: &hold.turn_id,
                at: &hold.created_at,
            };
            let mut inserted = 0usize;
            for s in &hold.record.comments {
                if insert_held_row(&tx, &hold.scope, s, &mark, &hold.created_at)? {
                    inserted += 1;
                }
            }
            // Every id was skipped (already live or held): no row carries this
            // hold, so boot / the bus could never restore it. The comments are
            // already in the panel, so the row's payload says `restored` now.
            if inserted == 0 {
                if let Some(row) = adopt_row_id.as_deref() {
                    flip_payload_in(
                        &tx,
                        row,
                        PayloadState::Restored,
                        Some(&[PayloadState::Adopted]),
                    )?;
                }
            }
            tx.commit()?;
            Ok(true)
        })
        .await
    }

    /// Put a scheduled row's snapshot back into the panel. With `row_id` the
    /// payload flips `held -> restored` in the same transaction and a snapshot
    /// that is no longer `held` restores nothing (`Ok(vec![])`): of two failure
    /// paths racing for one row, exactly one restores. Without `row_id` it is a
    /// plain restore.
    pub async fn restore_snapshot_row(
        &self,
        row_id: Option<&str>,
        scope: &ScopeKey,
        snapshots: &[ReviewCommentSnapshot],
        reason: vst_types::review::RestoreReason,
        now: &str,
    ) -> StoreResult<Vec<ReviewComment>> {
        let row_id = row_id.map(str::to_string);
        let (scope, snapshots, now) = (scope.clone(), snapshots.to_vec(), now.to_string());
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            if let Some(row) = row_id {
                if !flip_payload_in(
                    &tx,
                    &row,
                    PayloadState::Restored,
                    Some(&[PayloadState::Held]),
                )? {
                    return Ok(Vec::new());
                }
            }
            let rows = crate::comments::restore_in(&tx, &scope, &snapshots, Some(reason), &now)?;
            tx.commit()?;
            Ok(rows)
        })
        .await
    }

    pub async fn get_hold(&self, hold_id: &str) -> StoreResult<Option<StoredHold>> {
        let id = hold_id.to_string();
        self.comments_db(move |conn| Ok(select_hold(conn, &id)?))
            .await
    }

    /// Delete a hold and return it, atomically: of two concurrent callers
    /// (persist and cancel) exactly one gets `Some`.
    pub async fn remove_hold(&self, hold_id: &str) -> StoreResult<Option<StoredHold>> {
        let id = hold_id.to_string();
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let hold = select_hold(&tx, &id)?;
            if hold.is_some() {
                tx.execute("DELETE FROM comments WHERE heldBy = ?1", params![id])?;
            }
            tx.commit()?;
            Ok(hold)
        })
        .await
    }

    /// Delete a hold and put its snapshot back into the panel in ONE
    /// transaction (a crash can neither lose nor duplicate the comments; of two
    /// concurrent callers exactly one gets `Some`). The rows actually inserted
    /// are returned with the hold.
    pub async fn restore_hold(
        &self,
        hold_id: &str,
        reason: vst_types::review::RestoreReason,
        now: &str,
    ) -> StoreResult<Option<(StoredHold, Vec<ReviewComment>)>> {
        let (id, now) = (hold_id.to_string(), now.to_string());
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let mut held = select_held(&tx, Some(&id), None)?;
            let hold = select_hold(&tx, &id)?;
            let mut restored_ids: Vec<String> = Vec::new();
            if let Some(h) = &hold {
                // Renumber in pin order: keep the pin when free among live rows,
                // else max + 1 (the live-only unique index would reject a clash).
                held.sort_by_key(|r| r.comment.pin);
                for r in &held {
                    let pin = if r.comment.pin >= 1 && !pin_taken(&tx, &h.scope, r.comment.pin)? {
                        r.comment.pin
                    } else {
                        peek_next_pin(&tx, &h.scope)?
                    };
                    let n = tx.execute(
                        "UPDATE comments SET heldBy = NULL, heldSession = NULL, heldTurn = NULL, \
                         heldAt = NULL, pin = ?2, restoredReason = ?3, version = 1, updatedAt = ?4 \
                         WHERE id = ?1 AND heldBy = ?5",
                        params![r.comment.id, pin, reason.as_str(), now, id],
                    )?;
                    if n > 0 {
                        restored_ids.push(r.comment.id.clone());
                    }
                }
            }
            let rows = match &hold {
                Some(h) => select_by_ids(&tx, &h.scope, &restored_ids)?,
                None => Vec::new(),
            };
            // A hold adopted from a scheduled row (`adopt:<rowId>`) leaves that
            // row's payload `adopted`; once its comments are back in the panel the
            // row must say so (`restored`), or a Retry would send it without them
            // while its chip still counts them.
            // Only when the hold still had rows: a late loser after `remove_hold`
            // (the turn persisted) must leave the payload `adopted`.
            let row_id = id
                .strip_prefix(ADOPT_HOLD_PREFIX)
                .filter(|_| hold.is_some());
            if let Some(row) = row_id {
                flip_payload_in(
                    &tx,
                    row,
                    PayloadState::Restored,
                    Some(&[PayloadState::Adopted]),
                )?;
            }
            tx.commit()?;
            Ok(hold.map(|h| (h, rows)))
        })
        .await
    }

    /// Holds of one session, or all holds.
    pub async fn list_holds(&self, session_id: Option<&str>) -> StoreResult<Vec<StoredHold>> {
        let session_id = session_id.map(str::to_string);
        self.comments_db(move |conn| {
            Ok(group_holds(select_held(conn, None, session_id.as_deref())?))
        })
        .await
    }

    /// Move a hold to the session / turn that now carries it (reset carry).
    pub async fn rehome_hold(
        &self,
        hold_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> StoreResult<bool> {
        let (h, s, t) = (
            hold_id.to_string(),
            session_id.to_string(),
            turn_id.to_string(),
        );
        self.comments_db(move |conn| {
            Ok(conn.execute(
                "UPDATE comments SET heldSession = ?2, heldTurn = ?3 WHERE heldBy = ?1",
                params![h, s, t],
            )? > 0)
        })
        .await
    }

    /// Flip a scheduled row's payload `state` (only from one of `only_from`, when
    /// given). `false` when the row, its payload or the transition does not apply.
    pub async fn set_payload_state(
        &self,
        row_id: &str,
        to: PayloadState,
        only_from: Option<&[PayloadState]>,
    ) -> StoreResult<bool> {
        let row_id = row_id.to_string();
        let only_from = only_from.map(<[PayloadState]>::to_vec);
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let flipped = flip_payload_in(&tx, &row_id, to, only_from.as_deref())?;
            tx.commit()?;
            Ok(flipped)
        })
        .await
    }

    /// Scheduled rows whose payload is still `held` (see [`HeldFilter`]).
    pub async fn list_held_snapshots(
        &self,
        filter: HeldFilter<'_>,
    ) -> StoreResult<Vec<HeldSnapshot>> {
        let (clause, bind): (&str, Option<String>) = match filter {
            HeldFilter::Session(s) => ("AND sessionId = ?1", Some(s.to_string())),
            HeldFilter::OrphanedSessions => (
                "AND (?1 IS NULL) AND sessionId NOT IN (SELECT id FROM sessions)",
                None,
            ),
            // A row with a delivery phase is a terminal-delivery job's: store recovery
            // re-arms a `waiting` one (it must keep its comments) and the outcome
            // observer reports the rest, whatever channel was stored at creation.
            HeldFilter::Claimed => (
                "AND (?1 IS NULL) AND claimedAt IS NOT NULL AND deliveryPhase IS NULL",
                None,
            ),
            HeldFilter::OrphanedSessionsAnyChannel => (
                "AND (?1 IS NULL) AND sessionId NOT IN (SELECT id FROM sessions)",
                None,
            ),
        };
        let channel_clause = if filter == HeldFilter::OrphanedSessionsAnyChannel {
            ""
        } else {
            "AND (channel IS NULL OR channel != 'tmux')"
        };
        let sql = format!(
            "SELECT id, sessionId, commentsSnapshot FROM scheduled_messages \
             WHERE status = 'pending' {channel_clause} \
             AND commentsSnapshot IS NOT NULL {clause} ORDER BY createdAt ASC, id ASC"
        );
        self.comments_db(move |conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![bind], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|(row_id, session_id, raw)| {
                    let payload: ScheduledReviewPayload = serde_json::from_str(&raw).ok()?;
                    (payload.state == PayloadState::Held).then_some(HeldSnapshot {
                        row_id,
                        session_id,
                        payload,
                    })
                })
                .collect())
        })
        .await
    }

    /// Ids of claimed pending immediate Terminal rows (boot: a restart is why they
    /// fail, R110).
    pub async fn claimed_immediate_ids(&self) -> StoreResult<Vec<String>> {
        self.comments_db(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id FROM scheduled_messages WHERE status = 'pending' AND claimedAt IS NOT NULL \
                 AND origin = 'immediate' ORDER BY createdAt ASC, id ASC",
            )?;
            let rows = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
        .await
    }

    /// In-flight immediate Terminal sends of a scope (`origin = 'immediate'`,
    /// still `pending`).
    pub async fn list_immediate_rows(&self, scope: &ScopeKey) -> StoreResult<Vec<ImmediateRow>> {
        let rows = self.list_all_immediate_rows().await?;
        Ok(rows
            .into_iter()
            .filter(|r| {
                r.payload.scope_kind == scope.scope_kind && r.payload.scope_id == scope.scope_id
            })
            .collect())
    }

    /// In-flight immediate Terminal sends of every scope.
    pub async fn list_all_immediate_rows(&self) -> StoreResult<Vec<ImmediateRow>> {
        self.comments_db(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, sessionId, message, deliveryPhase, updatedAt, commentsSnapshot \
                 FROM scheduled_messages WHERE status = 'pending' AND origin = 'immediate' \
                 AND commentsSnapshot IS NOT NULL ORDER BY createdAt ASC, id ASC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::new();
            for (row_id, session_id, message, phase, updated_at, raw) in rows {
                let Some(payload) = ScheduledReviewPayload::parse(&raw) else {
                    tracing::warn!(row_id = %row_id, "immediate row's commentsSnapshot unreadable; skipped");
                    continue;
                };
                let waits_behind = waits_behind_in(conn, &session_id)?;
                out.push(ImmediateRow {
                    row_id,
                    session_id,
                    message,
                    phase,
                    updated_at,
                    waits_behind,
                    payload,
                });
            }
            Ok(out)
        })
        .await
    }

    /// Retry of a FAILED scheduled row whose snapshot went back to the panel
    /// (`restored`): in one transaction take the comments of that snapshot that
    /// are still in the panel (unattached) and flip the payload back to `held`
    /// with the fresh snapshots. Returns the ids re-held (`None` when the
    /// row is not a failed row with a `restored` payload: nothing changes).
    pub async fn rehold_failed_schedule_row(
        &self,
        row_id: &str,
        name: &str,
        limits: TakeLimits,
    ) -> StoreResult<Result<Option<Vec<String>>, ReviewError>> {
        let (row_id, name) = (row_id.to_string(), name.to_string());
        self.comments_db(move |conn| {
            let tx = conn.transaction()?;
            let raw: Option<Option<String>> = tx
                .query_row(
                    "SELECT commentsSnapshot FROM scheduled_messages WHERE id = ?1 AND status = 'failed'",
                    params![row_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(Some(raw)) = raw else { return Ok(Ok(None)) };
            let Some(payload) = ScheduledReviewPayload::parse(&raw) else {
                tracing::warn!(row_id = %row_id, "failed row's commentsSnapshot unreadable; not re-held");
                return Ok(Ok(None));
            };
            if payload.state != PayloadState::Restored {
                return Ok(Ok(None));
            }
            let scope = ScopeKey {
                scope_kind: payload.scope_kind,
                scope_id: payload.scope_id.clone(),
            };
            let ids: Vec<String> = payload.comments.iter().map(|c| c.id.clone()).collect();
            let present = select_by_ids(&tx, &scope, &ids).map_err(to_internal);
            let present = match present {
                Ok(p) => p,
                Err(e) => return Ok(Err(e)),
            };
            let live: Vec<String> = present
                .iter()
                .filter(|c| c.attached_to.is_none())
                .map(|c| c.id.clone())
                .collect();
            if live.is_empty() {
                // Nothing of the snapshot is left in the panel: the row no longer
                // carries comments (a stale snapshot would keep its chip counting them).
                tx.execute(
                    "UPDATE scheduled_messages SET commentsSnapshot = NULL WHERE id = ?1",
                    params![row_id],
                )?;
                tx.commit()?;
                return Ok(Ok(Some(Vec::new())));
            }
            let (snapshots, deleted) =
                match take_rows_in(&tx, &scope, &live, None, &name, limits, TakeMode::Delete) {
                    Ok(t) => t,
                    Err(e) => return Ok(Err(e)),
                };
            tx.execute(
                "UPDATE scheduled_messages SET commentsSnapshot = ?2 WHERE id = ?1",
                params![row_id, payload_json(&scope, &name, &snapshots)],
            )?;
            tx.commit()?;
            Ok(Ok(Some(deleted)))
        })
        .await
    }

    /// Delete one scheduled row by id (an already-terminal immediate row after its
    /// outcome was handled). `true` when a row was removed.
    pub async fn delete_scheduled_message(&self, id: &str) -> StoreResult<bool> {
        let id = id.to_string();
        self.comments_db(move |conn| {
            Ok(conn.execute("DELETE FROM scheduled_messages WHERE id = ?1", params![id])? > 0)
        })
        .await
    }
}

impl From<StoreError> for ReviewError {
    fn from(e: StoreError) -> Self {
        ReviewError::Internal(e.to_string())
    }
}
