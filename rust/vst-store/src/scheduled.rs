//! Scheduled-message queue: `scheduled_messages` rows and their lifecycle
//! (insert, claim, delivery phase, sent / failed / cancelled, boot recovery).
//!
//! Split out of `lib.rs` to keep that file under the size ceiling; every method is
//! still part of the `StoreHandle` API.

use rusqlite::{params, OptionalExtension};

use crate::{StoreError, StoreHandle, StoreResult};

impl StoreHandle {
    // ── Scheduled messages ─────────────────────────────────────────────────────
    //
    // Lifecycle: `pending` (claimedAt NULL) → claimed (`pending`, claimedAt set —
    // delivery in flight) → `sent` | `failed`. A claim is atomic, so the poller
    // and "send now" can never deliver the same row twice, and a row that was
    // claimed when the daemon died is recoverable (see
    // `recover_orphaned_scheduled_messages`). Failed rows can be retried (back
    // to `pending`) or dismissed (deleted); cancelling a pending message
    // deletes it.
    //
    // Terminal (tmux) rows add `deliveryPhase`: while a delivery job runs the
    // row stays `pending` + claimed with phase `waiting` (cancellable) and then
    // `pasting` (not cancellable). Only `vst-review` sets the phase; every
    // transition out of a delivery clears `deliveryPhase` and `claimedAt`.

    /// Insert a new `pending` scheduled message row. `channel` is the session's
    /// channel at create time (`'json'`/`'tmux'`, `None` = legacy), `origin` is
    /// `'schedule'` or `'immediate'`, `comments_snapshot` is owned by the
    /// review-comments feature (`None` here).
    // The plan fixes this positional signature (callers pass `None`s); a params
    // struct would only move the same nine fields.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
        message: &str,
        attachments_json: Option<&str>,
        fire_at: &str,
        now: &str,
        channel: Option<&str>,
        comments_snapshot: Option<&str>,
        origin: Option<&str>,
    ) -> StoreResult<()> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let message = message.to_string();
        let attachments_json = attachments_json.map(|s| s.to_string());
        let fire_at = fire_at.to_string();
        let now = now.to_string();
        let channel = channel.map(|s| s.to_string());
        let comments_snapshot = comments_snapshot.map(|s| s.to_string());
        let origin = origin.map(|s| s.to_string());
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let conn = inner.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO scheduled_messages (id, sessionId, message, attachments, fireAt, createdAt, updatedAt, status, channel, commentsSnapshot, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10)",
                params![id, session_id, message, attachments_json, fire_at, now, now, channel, comments_snapshot, origin],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// List a session's `pending` scheduled messages, ordered by fireAt
    /// (`createdAt`, `id` as tiebreak). Rows whose delivery is in flight are
    /// excluded — they can no longer be edited, cancelled or sent now — EXCEPT
    /// terminal rows in phase `waiting` / `pasting`, which stay visible (a
    /// `waiting` one is still cancellable).
    pub async fn list_pending_scheduled_messages(
        &self,
        session_id: &str,
    ) -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
        self.query_scheduled(
            format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND {PENDING_VISIBLE} ORDER BY fireAt ASC, createdAt ASC, id ASC LIMIT {MAX_PENDING_SCHEDULED}"),
            session_id.to_string(),
        )
        .await
    }

    /// Every visible row of a session, with NO display cap. Delivery cleanup
    /// (reset, session removal) must see all of them: a row cut off by the
    /// capped list would never be captured, reported `Gone` or restored.
    pub async fn list_delivery_rows(
        &self,
        session_id: &str,
    ) -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
        self.query_scheduled(
            format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND {PENDING_VISIBLE} ORDER BY fireAt ASC, createdAt ASC, id ASC"),
            session_id.to_string(),
        )
        .await
    }

    /// One scheduled-message row by id, in any state (`None` when it no longer
    /// exists). The terminal delivery job re-reads it each tick to notice a
    /// cancel, a re-arm or a delete by another writer.
    pub async fn get_scheduled_message(
        &self,
        id: &str,
    ) -> StoreResult<Option<vst_types::rest::sessions::ScheduledMessageRow>> {
        let id = id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Option<_>> {
            let conn = inner.conn.lock().unwrap();
            Ok(conn
                .query_row(
                    &format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE id = ?1"),
                    params![id],
                    scheduled_from_row,
                )
                .optional()?)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// How many rows count toward the per-session pending cap
    /// ([`MAX_PENDING_SCHEDULED`]): the visible pending rows minus
    /// `origin = 'immediate'` ones (an immediate send is not a schedule).
    pub async fn count_pending_schedule_rows(&self, session_id: &str) -> StoreResult<u32> {
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<u32> {
            let conn = inner.conn.lock().unwrap();
            let n: u32 = conn.query_row(
                &format!("SELECT COUNT(*) FROM scheduled_messages WHERE sessionId = ?1 AND {PENDING_VISIBLE} AND (origin IS NULL OR origin != 'immediate')"),
                params![session_id],
                |r| r.get(0),
            )?;
            Ok(n)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// List the most recent `failed` scheduled messages for a session (newest
    /// first, capped) so the UI can offer Retry / Dismiss.
    pub async fn list_failed_scheduled_messages(
        &self,
        session_id: &str,
    ) -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
        self.query_scheduled(
            format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND status = 'failed' ORDER BY updatedAt DESC LIMIT {MAX_FAILED_SCHEDULED_SHOWN}"),
            session_id.to_string(),
        )
        .await
    }

    async fn query_scheduled(
        &self,
        sql: String,
        arg: String,
    ) -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Vec<_>> {
            let conn = inner.conn.lock().unwrap();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![arg], scheduled_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Atomically claim the OLDEST due, unclaimed `pending` row, if any, skipping
    /// rows of `exclude_sessions` (sessions whose agent just proved unresponsive —
    /// see the poller). Claimed one at a time, right before it is delivered: a
    /// row sitting claimed while earlier rows deliver could neither be cancelled
    /// by the user nor survive a crash without being mislabelled "may have been
    /// sent". A claimed row is owned by the caller until it is marked sent /
    /// failed; nobody else (poller tick, "send now") can claim it.
    pub async fn claim_next_due_scheduled_message(
        &self,
        now_iso: &str,
        exclude_sessions: &[String],
    ) -> StoreResult<Option<vst_types::rest::sessions::ScheduledMessageRow>> {
        let now_iso = now_iso.to_string();
        let exclude: Vec<String> = exclude_sessions.to_vec();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Option<_>> {
            let mut conn = inner.conn.lock().unwrap();
            let tx = conn.transaction()?;
            // `?1` = now; `?2..` = excluded session ids.
            let not_in = if exclude.is_empty() {
                String::new()
            } else {
                let marks: Vec<String> = (0..exclude.len()).map(|i| format!("?{}", i + 2)).collect();
                format!(" AND sessionId NOT IN ({})", marks.join(", "))
            };
            let sql = format!(
                "SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE status = 'pending' AND claimedAt IS NULL AND fireAt <= ?1{not_in} ORDER BY fireAt ASC, createdAt ASC, id ASC LIMIT 1"
            );
            let mut args: Vec<&dyn rusqlite::ToSql> = vec![&now_iso];
            args.extend(exclude.iter().map(|e| e as &dyn rusqlite::ToSql));
            let row = tx
                .query_row(&sql, args.as_slice(), scheduled_from_row)
                .optional()?;
            if let Some(r) = &row {
                tx.execute(
                    "UPDATE scheduled_messages SET claimedAt = ?2, updatedAt = ?2 WHERE id = ?1",
                    params![r.id, now_iso],
                )?;
            }
            tx.commit()?;
            Ok(row)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Everything a client needs to render a session's scheduled-send state
    /// (pending, failed, sent turn ids, recently pasted terminal rows), read in ONE transaction so a concurrent
    /// change can't produce a mixed snapshot (e.g. a row in neither list).
    pub async fn read_schedule_snapshot(&self, session_id: &str) -> StoreResult<ScheduleSnapshot> {
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<ScheduleSnapshot> {
            let mut conn = inner.conn.lock().unwrap();
            let tx = conn.transaction()?;
            let rows = |sql: String| -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
                let mut stmt = tx.prepare(&sql)?;
                let v = stmt
                    .query_map(params![session_id], scheduled_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(v)
            };
            // Immediate rows are listed too (the cap excludes them), so leave
            // room for them past the cap.
            let pending = rows(format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND {PENDING_VISIBLE} ORDER BY fireAt ASC, createdAt ASC, id ASC LIMIT {SNAPSHOT_PENDING_LIMIT}"))?;
            let failed = rows(format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND status = 'failed' ORDER BY updatedAt DESC LIMIT {MAX_FAILED_SCHEDULED_SHOWN}"))?;
            let sent_turn_ids = {
                let mut stmt = tx.prepare(&format!("SELECT sentTurnId FROM scheduled_messages WHERE sessionId = ?1 AND status = 'sent' AND sentTurnId IS NOT NULL ORDER BY sentAt DESC LIMIT {MAX_SENT_TURN_IDS}"))?;
                let v = stmt
                    .query_map(params![session_id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                v
            };
            let pasted = rows(format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND {RECENT_PASTED} AND sentAt >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-{RECENT_PASTED_MINUTES} minutes') ORDER BY sentAt DESC, id ASC LIMIT {MAX_RECENT_PASTED}"))?;
            Ok(ScheduleSnapshot { pending, failed, sent_turn_ids, pasted })
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Atomically claim ONE specific unclaimed `pending` row ("send now").
    /// Also sets `fireAt` to now (Send now means due now; a restart re-arm
    /// then fires it immediately). `None` when it doesn't exist, belongs to another session, was already
    /// claimed (the poller got there first) or is no longer pending.
    pub async fn claim_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
        now: &str,
    ) -> StoreResult<Option<vst_types::rest::sessions::ScheduledMessageRow>> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Option<_>> {
            let mut conn = inner.conn.lock().unwrap();
            let tx = conn.transaction()?;
            let mut row = tx
                .query_row(
                    &format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE id = ?1 AND sessionId = ?2 AND status = 'pending' AND claimedAt IS NULL"),
                    params![id, session_id],
                    scheduled_from_row,
                )
                .optional()?;
            if let Some(r) = row.as_mut() {
                tx.execute(
                    "UPDATE scheduled_messages SET claimedAt = ?2, fireAt = ?2, updatedAt = ?2 WHERE id = ?1",
                    params![id, now],
                )?;
                r.fire_at = now.clone();
            }
            tx.commit()?;
            Ok(row)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Boot recovery for rows still claimed when the daemon died. Keyed on
    /// `deliveryPhase`:
    /// - `waiting` schedule row: nothing was pasted, so it is re-armed
    ///   (`claimedAt`/phase cleared, `fireAt` kept) and re-delivered;
    /// - `waiting` row with `origin = 'immediate'`: never re-armed, failed `error`
    ///   "Daemon restarted before this was pasted";
    /// - `pasting` row (either origin): failed `restarted_mid_paste` — it may or
    ///   may not have reached the agent;
    /// - any other claimed row (any channel): ambiguous, failed with today's text
    ///   (a `channel = 'tmux'` one also gets `failureKind = 'error'`).
    ///
    /// Returns the affected row ids; the store never calls an observer.
    pub async fn recover_orphaned_scheduled_messages(
        &self,
        now: &str,
    ) -> StoreResult<RecoveryOutcome> {
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<RecoveryOutcome> {
            let mut conn = inner.conn.lock().unwrap();
            let tx = conn.transaction()?;
            let claimed: Vec<ClaimedRow> = {
                let mut stmt = tx.prepare(
                    "SELECT id, channel, deliveryPhase, origin FROM scheduled_messages WHERE status = 'pending' AND claimedAt IS NOT NULL ORDER BY createdAt ASC, id ASC",
                )?;
                let v = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                v
            };
            let mut out = RecoveryOutcome::default();
            for (id, channel, phase, origin) in claimed {
                let immediate = origin.as_deref() == Some("immediate");
                let tmux = channel.as_deref() == Some("tmux");
                let fail = |reason: &str, kind: Option<&str>| -> rusqlite::Result<usize> {
                    tx.execute(
                        "UPDATE scheduled_messages SET status = 'failed', failureReason = ?2, failureKind = ?3, claimedAt = NULL, deliveryPhase = NULL, updatedAt = ?4 WHERE id = ?1",
                        params![id, reason, kind, now],
                    )
                };
                match phase.as_deref() {
                    Some("waiting") if !immediate => {
                        tx.execute(
                            "UPDATE scheduled_messages SET claimedAt = NULL, deliveryPhase = NULL, updatedAt = ?2 WHERE id = ?1",
                            params![id, now],
                        )?;
                        out.rearmed.push(id);
                    }
                    Some("waiting") => {
                        fail(RESTARTED_BEFORE_PASTE, Some("error"))?;
                        out.failed_other_tmux.push(id);
                    }
                    Some("pasting") => {
                        fail(RESTARTED_MID_PASTE, Some("restarted_mid_paste"))?;
                        out.failed_mid_paste.push(id);
                    }
                    _ => {
                        fail(RESTARTED_MID_DELIVERY, tmux.then_some("error"))?;
                        if tmux {
                            out.failed_other_tmux.push(id);
                        }
                    }
                }
            }
            tx.commit()?;
            Ok(out)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Move a session's not-yet-delivered scheduled messages (pending, failed,
    /// and terminal rows still `waiting`; not rows mid-paste) to its
    /// replacement — used by session reset, which archives the old session
    /// under a NEW id. Without this the messages would fire at the archived
    /// session and fail where the user can no longer see them. A moved `waiting`
    /// row has `claimedAt`/`deliveryPhase` cleared in the same statement so the
    /// poller re-claims it for the new session. `origin = 'immediate'` rows are
    /// never moved (they belong to a send the user made to the OLD agent).
    /// Returns how many rows moved.
    pub async fn reassign_scheduled_messages(
        &self,
        from_session_id: &str,
        to_session_id: &str,
        now: &str,
    ) -> StoreResult<usize> {
        let from = from_session_id.to_string();
        let to = to_session_id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<usize> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET sessionId = ?2, updatedAt = ?3, claimedAt = NULL, deliveryPhase = NULL WHERE sessionId = ?1 AND (origin IS NULL OR origin != 'immediate') AND ((status = 'pending' AND (claimedAt IS NULL OR deliveryPhase = 'waiting')) OR status = 'failed')",
                params![from, to, now],
            )?;
            Ok(n)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Delete every scheduled-message row of a session (used when the session is
    /// deleted — there is no FK to cascade, see the schema comment).
    pub async fn delete_scheduled_messages_for_session(
        &self,
        session_id: &str,
    ) -> StoreResult<usize> {
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<usize> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "DELETE FROM scheduled_messages WHERE sessionId = ?1",
                params![session_id],
            )?;
            Ok(n)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Delete scheduled-message rows whose session no longer exists. There is
    /// deliberately no foreign key (a project save re-inserts its sessions), so
    /// rows of sessions that were genuinely deleted are purged here instead.
    /// Returns how many rows were removed.
    pub async fn purge_scheduled_messages_for_missing_sessions(&self) -> StoreResult<usize> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<usize> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "DELETE FROM scheduled_messages WHERE sessionId NOT IN (SELECT id FROM sessions)",
                [],
            )?;
            Ok(n)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// List the `sentTurnId`s of the most recent sent scheduled messages for a
    /// session (newest first, capped). Used to badge those turns in the chat
    /// transcript and mark them in the queued tray.
    pub async fn list_sent_scheduled_turn_ids(&self, session_id: &str) -> StoreResult<Vec<String>> {
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Vec<String>> {
            let conn = inner.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!(
                "SELECT sentTurnId FROM scheduled_messages WHERE sessionId = ?1 AND status = 'sent' AND sentTurnId IS NOT NULL ORDER BY sentAt DESC LIMIT {MAX_SENT_TURN_IDS}"
            ))?;
            let rows = stmt
                .query_map(params![session_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Mark a claimed scheduled message as sent after successful delivery.
    pub async fn mark_scheduled_message_sent(
        &self,
        id: &str,
        turn_id: &str,
        now: &str,
    ) -> StoreResult<()> {
        let id = id.to_string();
        let turn_id = turn_id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<()> {
            let conn = inner.conn.lock().unwrap();
            conn.execute(
                "UPDATE scheduled_messages SET status = 'sent', sentAt = ?2, sentTurnId = ?3, updatedAt = ?2, claimedAt = NULL, deliveryPhase = NULL, failureKind = NULL WHERE id = ?1 AND status = 'pending' AND claimedAt IS NOT NULL",
                params![id, now, turn_id],
            )?;
            // Sent rows only feed the "Scheduled" badges (newest MAX_SENT_TURN_IDS
            // per session) — don't let the table grow forever.
            prune_sent(&conn, &id)?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Mark a terminal (tmux) row `sent` after the paste + Enter went out:
    /// status `sent`, `sentTurnId` stays NULL (that is what distinguishes a
    /// pasted row from a delivered Rich Chat turn), phase/claim cleared. Only a
    /// row in phase `pasting` can be pasted. Returns `true` if a row changed.
    pub async fn mark_scheduled_message_pasted(&self, id: &str, now: &str) -> StoreResult<bool> {
        let id = id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET status = 'sent', sentAt = ?2, updatedAt = ?2, claimedAt = NULL, deliveryPhase = NULL, failureKind = NULL WHERE id = ?1 AND status = 'pending' AND deliveryPhase = 'pasting'",
                params![id, now],
            )?;
            if n > 0 {
                prune_sent(&conn, &id)?;
            }
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Compare-and-set a claimed row's delivery phase (`from` `None` = NULL),
    /// e.g. NULL→`waiting`, `waiting`→`pasting`. Exactly one of two racing
    /// callers (a phase change, a cancel) wins. Returns `true` if this call won.
    pub async fn mark_scheduled_phase(
        &self,
        id: &str,
        from: Option<&str>,
        to: &str,
        now: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let from = from.map(|s| s.to_string());
        let to = to.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET deliveryPhase = ?3, updatedAt = ?4 WHERE id = ?1 AND status = 'pending' AND deliveryPhase IS ?2",
                params![id, from, to, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Put a held `waiting` schedule row back to `scheduled` (claim and phase
    /// cleared, `fireAt` kept so it is overdue and re-fires). Never touches an
    /// `origin = 'immediate'` row or one that is `pasting`. Returns `true` if a
    /// row changed.
    pub async fn rearm_scheduled_message(&self, id: &str, now: &str) -> StoreResult<bool> {
        let id = id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET claimedAt = NULL, deliveryPhase = NULL, updatedAt = ?2 WHERE id = ?1 AND status = 'pending' AND deliveryPhase = 'waiting' AND (origin IS NULL OR origin != 'immediate')",
                params![id, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// The terminal rows pasted since `since_iso` (newest first, at most
    /// `limit`): `status = 'sent'` with no `sentTurnId` (only the terminal path
    /// leaves it NULL).
    pub async fn list_recent_pasted(
        &self,
        session_id: &str,
        since_iso: &str,
        limit: u32,
    ) -> StoreResult<Vec<vst_types::rest::sessions::ScheduledMessageRow>> {
        let session_id = session_id.to_string();
        let since = since_iso.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<Vec<_>> {
            let conn = inner.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!("SELECT {SCHEDULED_COLS} FROM scheduled_messages WHERE sessionId = ?1 AND {RECENT_PASTED} AND sentAt >= ?2 ORDER BY sentAt DESC, id ASC LIMIT {limit}"))?;
            let rows = stmt
                .query_map(params![session_id, since], scheduled_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Mark a claimed scheduled message as failed with a human-readable reason
    /// and an optional machine-readable `failure_kind` (a `FailureKind::as_str`
    /// value; `None` for a legacy/json failure). Clears the claim and delivery
    /// phase. Returns `true` if a row changed — `false` when the row was already
    /// cancelled or otherwise left the claimed state, so the caller must not
    /// announce a failure that did not happen.
    pub async fn mark_scheduled_message_failed(
        &self,
        id: &str,
        reason: &str,
        failure_kind: Option<&str>,
        now: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let reason = reason.to_string();
        let failure_kind = failure_kind.map(|s| s.to_string());
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET status = 'failed', failureReason = ?2, failureKind = ?3, claimedAt = NULL, deliveryPhase = NULL, updatedAt = ?4 WHERE id = ?1 AND status = 'pending' AND claimedAt IS NOT NULL",
                params![id, reason, failure_kind, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Like [`Self::mark_scheduled_message_failed`] but only while the row's
    /// delivery phase is still `waiting`: a job whose `waiting` -> `pasting` CAS
    /// already landed keeps the row (the paste happens), so a reset that fails an
    /// immediate row cannot also restore comments that were pasted. Returns
    /// `true` if this call failed the row.
    pub async fn mark_waiting_scheduled_message_failed(
        &self,
        id: &str,
        reason: &str,
        failure_kind: Option<&str>,
        now: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let reason = reason.to_string();
        let failure_kind = failure_kind.map(|s| s.to_string());
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET status = 'failed', failureReason = ?2, failureKind = ?3, claimedAt = NULL, deliveryPhase = NULL, updatedAt = ?4 WHERE id = ?1 AND status = 'pending' AND claimedAt IS NOT NULL AND deliveryPhase = 'waiting'",
                params![id, reason, failure_kind, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Re-queue a `failed` scheduled message to fire immediately. Returns
    /// `true` if a row was updated (id AND session must match).
    pub async fn retry_failed_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
        now: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET status = 'pending', claimedAt = NULL, deliveryPhase = NULL, failureReason = NULL, failureKind = NULL, fireAt = ?3, updatedAt = ?3 WHERE id = ?1 AND sessionId = ?2 AND status = 'failed'",
                params![id, session_id, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Dismiss (delete) a `failed` scheduled message. Returns `true` if a row
    /// was deleted (id AND session must match).
    pub async fn dismiss_failed_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "DELETE FROM scheduled_messages WHERE id = ?1 AND sessionId = ?2 AND status = 'failed'",
                params![id, session_id],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Cancel (delete) a pending scheduled message (ownership guard: must match
    /// both `id` AND `session_id`). A row whose delivery is in flight can no
    /// longer be cancelled, EXCEPT a terminal row still `waiting` (nothing has
    /// been pasted). A terminal row mid-`pasting` yields [`CancelOutcome::InFlight`]
    /// so the caller can say "already delivering".
    pub async fn cancel_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
    ) -> StoreResult<CancelOutcome> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<CancelOutcome> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "DELETE FROM scheduled_messages WHERE id = ?1 AND sessionId = ?2 AND status = 'pending' AND (claimedAt IS NULL OR deliveryPhase = 'waiting')",
                params![id, session_id],
            )?;
            if n > 0 {
                return Ok(CancelOutcome::Deleted);
            }
            let pasting: bool = conn
                .query_row(
                    "SELECT 1 FROM scheduled_messages WHERE id = ?1 AND sessionId = ?2 AND status = 'pending' AND deliveryPhase = 'pasting'",
                    params![id, session_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            Ok(if pasting {
                CancelOutcome::InFlight
            } else {
                CancelOutcome::NotFound
            })
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }

    /// Change the fire time of a pending (not in-flight) scheduled message.
    /// Returns `true` if a row was updated.
    pub async fn reschedule_scheduled_message(
        &self,
        id: &str,
        session_id: &str,
        fire_at: &str,
        now: &str,
    ) -> StoreResult<bool> {
        let id = id.to_string();
        let session_id = session_id.to_string();
        let fire_at = fire_at.to_string();
        let now = now.to_string();
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || -> StoreResult<bool> {
            let conn = inner.conn.lock().unwrap();
            let n = conn.execute(
                "UPDATE scheduled_messages SET fireAt = ?3, updatedAt = ?4 WHERE id = ?1 AND sessionId = ?2 AND status = 'pending' AND claimedAt IS NULL",
                params![id, session_id, fire_at, now],
            )?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| StoreError::Mutation(e.to_string()))?
    }
}

// --- SQL helpers (all invoked from within spawn_blocking) ---

const SCHEDULED_COLS: &str = "id, sessionId, message, attachments, fireAt, createdAt, updatedAt, status, sentAt, sentTurnId, failureReason, claimedAt, channel, deliveryPhase, failureKind, commentsSnapshot, origin";

/// A pending row the UI should see: unclaimed, or claimed terminal rows whose
/// delivery job is still `waiting` / `pasting`.
const PENDING_VISIBLE: &str =
    "status = 'pending' AND (claimedAt IS NULL OR deliveryPhase IN ('waiting', 'pasting'))";

/// A terminal-pasted row: `sent` with no `sentTurnId`.
const RECENT_PASTED: &str = "status = 'sent' AND sentTurnId IS NULL";

/// Terminal-pasted rows are shown for this long after `sentAt`, at most
/// [`MAX_RECENT_PASTED`] of them.
const RECENT_PASTED_MINUTES: u32 = 10;
const MAX_RECENT_PASTED: u32 = 3;

/// Snapshot pending list size: the cap plus headroom for `origin = 'immediate'`
/// rows, which do not count toward it.
const SNAPSHOT_PENDING_LIMIT: u32 = MAX_PENDING_SCHEDULED + 10;

const RESTARTED_MID_DELIVERY: &str = "The daemon restarted while this message was being delivered — it may or may not have been sent. Retry to send it again.";
const RESTARTED_MID_PASTE: &str = "The daemon restarted while this message was being pasted — it may or may not have been sent. Retry to send it again.";
const RESTARTED_BEFORE_PASTE: &str =
    "The daemon restarted before this was pasted. Retry to send it again.";

/// Most pending scheduled messages per session (creation is rejected beyond
/// this; the snapshot's pending list ships up to `SNAPSHOT_PENDING_LIMIT`,
/// a few more, so a Terminal send's immediate rows stay visible).
pub const MAX_PENDING_SCHEDULED: u32 = 100;

/// Cap on failed scheduled sends surfaced per session (newest first).
const MAX_FAILED_SCHEDULED_SHOWN: u32 = 20;

/// Cap on sent-scheduled turn ids shipped in `SessionMeta` per session.
const MAX_SENT_TURN_IDS: u32 = 200;

/// A session's scheduled-send state, read atomically (see `read_schedule_snapshot`).
pub struct ScheduleSnapshot {
    pub pending: Vec<vst_types::rest::sessions::ScheduledMessageRow>,
    pub failed: Vec<vst_types::rest::sessions::ScheduledMessageRow>,
    pub sent_turn_ids: Vec<String>,
    /// Terminal rows pasted in the last 10 minutes (newest first, at most 3).
    pub pasted: Vec<vst_types::rest::sessions::ScheduledMessageRow>,
}

/// `(id, channel, deliveryPhase, origin)` of a row claimed when the daemon died.
type ClaimedRow = (String, Option<String>, Option<String>, Option<String>);

/// Result of [`StoreHandle::cancel_scheduled_message`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// The row was deleted.
    Deleted,
    /// A terminal row is mid-paste; it can no longer be cancelled.
    InFlight,
    /// No such cancellable row (missing, other session, claimed json row, no longer pending).
    NotFound,
}

/// Row ids touched by boot recovery
/// ([`StoreHandle::recover_orphaned_scheduled_messages`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryOutcome {
    /// `waiting` schedule rows put back to `scheduled`.
    pub rearmed: Vec<String>,
    /// Rows that were `pasting` (failed `restarted_mid_paste`).
    pub failed_mid_paste: Vec<String>,
    /// `channel = 'tmux'` rows failed for any other reason (including immediate
    /// rows that were `waiting`).
    pub failed_other_tmux: Vec<String>,
}

/// Keep only the newest [`MAX_SENT_TURN_IDS`] `sent` rows of `id`'s session —
/// sent rows only feed the "Scheduled" badges and the pasted list, so the table
/// must not grow forever.
fn prune_sent(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!("DELETE FROM scheduled_messages WHERE status = 'sent' AND sessionId = (SELECT sessionId FROM scheduled_messages WHERE id = ?1) AND id NOT IN (SELECT id FROM scheduled_messages WHERE status = 'sent' AND sessionId = (SELECT sessionId FROM scheduled_messages WHERE id = ?1) ORDER BY sentAt DESC LIMIT {MAX_SENT_TURN_IDS})"),
        params![id],
    )?;
    Ok(())
}

fn scheduled_from_row(
    r: &rusqlite::Row,
) -> rusqlite::Result<vst_types::rest::sessions::ScheduledMessageRow> {
    Ok(vst_types::rest::sessions::ScheduledMessageRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        message: r.get(2)?,
        attachments: r.get(3)?,
        fire_at: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        status: r.get(7)?,
        sent_at: r.get(8)?,
        sent_turn_id: r.get(9)?,
        failure_reason: r.get(10)?,
        claimed_at: r.get(11)?,
        channel: r.get(12)?,
        delivery_phase: r.get(13)?,
        failure_kind: r.get(14)?,
        comments_snapshot: r.get(15)?,
        origin: r.get(16)?,
    })
}
