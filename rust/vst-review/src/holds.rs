//! The Rich Chat side of a send: the turn holds (rows marked `heldBy`), and `ReviewHandle` as the
//! two injection seams `vst-agents` / `vst-routes` see (`ReviewPort`,
//! `TurnObserver`, both defined in `vst-types`).
//!
//! A send marks the comment rows `heldBy` (hidden from every reader;
//! same transaction, `ReviewHandle::hold_for_turn`). The hold lives until the
//! turn's `user` row is persisted (`turn_persisted`, rows deleted); a turn
//! cancelled, released or dropped before that clears the marker, restoring the
//! comments (`turn_cancelled`). `turn_cancelled` is the ONLY json-release restore
//! path and is idempotent (`release()` can run its cancel sweep twice): the store
//! deletes the hold and restores the rows in one transaction, so of any number of
//! racing callers exactly one restores and one `comments:changed` goes out.
//!
//! **Logging (R84):** only ids and counts, never comment text.

use std::sync::Arc;

use tokio::sync::broadcast;
use vst_store::comment_consumers::{Consumer, HeldFilter, HoldSpec, StoredHold, TakeLimits};
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    AsyncResult, DeletedReason, HoldRequest, RestoreReason, ReviewCommentSnapshot, ReviewError,
    ReviewHold, ReviewPort, ReviewRecord, ReviewScope, TurnObserver, RICH_SEND_MAX_BYTES,
    RICH_SEND_MAX_COMMENTS,
};
use vst_types::ServerEvent;

use crate::service::ReviewHandle;

fn internal(e: impl std::fmt::Display) -> ReviewError {
    ReviewError::Internal(e.to_string())
}

/// Why a sent card's comments cannot be restored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardRestoreError {
    /// No such turn in the transcript.
    NoSuchTurn,
    /// The turn was cancelled (its comments already came back) or superseded by
    /// a fork (it no longer exists on the live branch).
    Unavailable,
    /// The turn carried no review comments.
    NoReview,
}

/// The review snapshot persisted on a turn's `user` row: what "Restore to
/// comments" reads (never the live hold, which is gone once the row exists).
pub fn persisted_review(
    events: &[vst_types::NormalizedEvent],
    turn_id: &str,
) -> Result<ReviewRecord, CardRestoreError> {
    use vst_types::NormalizedEventKind;
    let rows: Vec<&vst_types::NormalizedEvent> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User && e.turn_id.as_deref() == Some(turn_id))
        .collect();
    if rows.is_empty() {
        return Err(CardRestoreError::NoSuchTurn);
    }
    let live = rows
        .iter()
        .find(|e| e.cancelled != Some(true))
        .ok_or(CardRestoreError::Unavailable)?;
    if live.superseded == Some(true) {
        return Err(CardRestoreError::Unavailable);
    }
    live.review.clone().ok_or(CardRestoreError::NoReview)
}

/// What a "Restore to comments" on a sent card did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RestoredFromCard {
    /// Comments put back into the panel.
    pub restored: u32,
    /// Comments whose id was already in the panel (skipped).
    pub skipped: u32,
}

impl ReviewHandle {
    /// Snapshot `req.comment_ids` and mark their rows `heldBy` the hold (they leave
    /// the panel), in one transaction. Idempotent by `hold_id` (a retry returns the stored hold and
    /// takes nothing).
    pub async fn hold_for_turn_impl(&self, req: HoldRequest) -> Result<ReviewHold, ReviewError> {
        let name = self
            .scope_label(&req.scope)
            .await
            .ok_or(ReviewError::NotFound)?;
        let composer = self.sending_composer(&req).await?;
        let taken = self
            .0
            .store
            .take_for_consumer(
                &req.scope,
                &req.comment_ids,
                composer.as_deref(),
                &name,
                TakeLimits {
                    max_comments: RICH_SEND_MAX_COMMENTS,
                    max_bytes: RICH_SEND_MAX_BYTES,
                },
                Consumer::Hold(HoldSpec {
                    hold_id: req.hold_id.clone(),
                    session_id: req.session_id.clone(),
                    turn_id: req.turn_id.clone(),
                    created_at: self.now_iso(),
                }),
            )
            .await
            .map_err(internal)??;
        if !taken.existing {
            self.push_deleted(&req.scope, &taken.deleted, DeletedReason::Sent);
        }
        Ok(ReviewHold {
            hold_id: req.hold_id,
            record: ReviewRecord {
                name,
                comments: taken.snapshots,
            },
        })
    }

    /// Which composer the ids are being sent from. `req.composer_key` names the
    /// composer of the sending session; the ids may be all attached to it (its
    /// chip) or all unattached (a picker send), never anything else: ids held by
    /// ANOTHER composer, or a mix, are `NotAttached`. (Missing ids are left to the
    /// take, which reports `Changed`.)
    async fn sending_composer(&self, req: &HoldRequest) -> Result<Option<String>, ReviewError> {
        self.resolve_composer(&req.scope, &req.comment_ids, req.composer_key.as_deref())
            .await
    }

    /// The composer rule of every send (`sending_composer`'s body, shared with
    /// Terminal and scheduled sends).
    pub(crate) async fn resolve_composer(
        &self,
        scope: &ScopeKey,
        comment_ids: &[String],
        composer_key: Option<&str>,
    ) -> Result<Option<String>, ReviewError> {
        let rows = self
            .0
            .store
            .list_comments(scope, None, false)
            .await
            .map_err(internal)?;
        let picked: Vec<_> = rows
            .iter()
            .filter(|c| comment_ids.contains(&c.id))
            .collect();
        if picked.iter().all(|c| c.attached_to.is_none()) {
            return Ok(None);
        }
        match composer_key {
            Some(key) if picked.iter().all(|c| c.attached_to.as_deref() == Some(key)) => {
                Ok(Some(key.to_string()))
            }
            _ => Err(ReviewError::NotAttached),
        }
    }

    /// Restore a hold (idempotent: a missing hold is a no-op, no second event).
    pub async fn restore_hold_impl(&self, hold_id: &str, reason: RestoreReason) {
        match self
            .0
            .store
            .restore_hold(hold_id, reason, &self.now_iso())
            .await
        {
            Ok(Some((hold, rows))) => {
                tracing::info!(
                    hold = %hold.hold_id,
                    count = hold.record.comments.len(),
                    reason = reason.as_str(),
                    "[vst] review hold restored"
                );
                self.push_upserts(rows);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("[vst] review hold restore failed: {e}"),
        }
    }

    /// Delete a hold without restoring (its turn was persisted, or consumed).
    pub async fn drop_hold_impl(&self, hold_id: &str) {
        if let Err(e) = self.0.store.remove_hold(hold_id).await {
            tracing::warn!("[vst] review hold delete failed: {e}");
        }
    }

    pub async fn rehome_hold_impl(&self, hold_id: &str, session_id: &str, turn_id: &str) {
        if let Err(e) = self.0.store.rehome_hold(hold_id, session_id, turn_id).await {
            tracing::warn!("[vst] review hold rehome failed: {e}");
        }
    }

    /// A scheduled Rich Chat row fired: turn its held snapshot into a hold.
    pub async fn adopt_snapshot_impl(
        &self,
        row_id: &str,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        session_id: &str,
        turn_id: &str,
    ) -> Result<ReviewHold, ReviewError> {
        // One adoption per scheduled row (the payload flip guards it), so the row
        // id makes the hold id unique and the insert idempotent.
        let hold_id = format!(
            "{}{row_id}",
            vst_store::comment_consumers::ADOPT_HOLD_PREFIX
        );
        let stored = StoredHold {
            hold_id: hold_id.clone(),
            scope,
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            record: snapshot.clone(),
            created_at: self.now_iso(),
        };
        let adopted = self
            .0
            .store
            .insert_hold(stored, Some(row_id))
            .await
            .map_err(internal)?;
        if !adopted {
            return Err(ReviewError::NotFound);
        }
        Ok(ReviewHold {
            hold_id,
            record: snapshot,
        })
    }

    /// Put a snapshot back into the panel (schedule cancel / failure, launch
    /// failure). With `row_id` it restores at most once per scheduled row.
    pub async fn restore_snapshot_impl(
        &self,
        row_id: Option<&str>,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        reason: RestoreReason,
    ) {
        self.try_restore_snapshot(row_id, snapshot, scope, reason)
            .await;
    }

    /// [`Self::restore_snapshot_impl`], reporting whether the store accepted it.
    async fn try_restore_snapshot(
        &self,
        row_id: Option<&str>,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        reason: RestoreReason,
    ) -> bool {
        match self
            .0
            .store
            .restore_snapshot_row(row_id, &scope, &snapshot.comments, reason, &self.now_iso())
            .await
        {
            Ok(rows) => {
                self.push_upserts(rows);
                true
            }
            Err(e) => {
                tracing::warn!("[vst] review comments restore failed: {e}");
                false
            }
        }
    }

    /// Restore every pending non-Terminal scheduled row of a session whose
    /// snapshot is still `held` (called before a purge of its rows). `false`
    /// when a snapshot could not be listed or restored: the caller must then
    /// keep the rows (their snapshot is the only copy) for the boot sweep.
    pub async fn restore_for_session_impl(&self, session_id: &str) -> bool {
        match self
            .0
            .store
            .list_held_snapshots(HeldFilter::Session(session_id))
            .await
        {
            Ok(held) => {
                self.restore_held_rows(held, RestoreReason::SessionRemoved)
                    .await
            }
            Err(e) => {
                tracing::warn!("[vst] listing held review snapshots failed: {e}");
                false
            }
        }
    }

    /// Restore the `held` snapshots whose session no longer exists (a project
    /// or worktree save is about to purge their rows). `false` as above.
    pub async fn restore_orphaned_snapshots_impl(&self) -> bool {
        match self
            .0
            .store
            .list_held_snapshots(HeldFilter::OrphanedSessions)
            .await
        {
            Ok(held) => {
                self.restore_held_rows(held, RestoreReason::SessionRemoved)
                    .await
            }
            Err(e) => {
                tracing::warn!("[vst] listing orphaned review snapshots failed: {e}");
                false
            }
        }
    }

    pub(crate) async fn restore_held_rows(
        &self,
        held: Vec<vst_store::comment_consumers::HeldSnapshot>,
        reason: RestoreReason,
    ) -> bool {
        let mut all_ok = true;
        for h in held {
            let scope = ScopeKey {
                scope_kind: h.payload.scope_kind,
                scope_id: h.payload.scope_id.clone(),
            };
            if self.scope_label(&scope).await.is_none() {
                // The worktree / project is gone: nothing to restore into.
                let _ = self
                    .0
                    .store
                    .set_payload_state(
                        &h.row_id,
                        vst_types::review::PayloadState::Restored,
                        Some(&[vst_types::review::PayloadState::Held]),
                    )
                    .await;
                continue;
            }
            all_ok &= self
                .try_restore_snapshot(
                    Some(&h.row_id),
                    ReviewRecord {
                        name: h.payload.name,
                        comments: h.payload.comments,
                    },
                    scope,
                    reason,
                )
                .await;
        }
        all_ok
    }

    /// "Restore to comments" on a sent card: put the persisted snapshot back,
    /// skipping comments whose id is already in the panel. No tray notice (the
    /// user asked for it).
    pub async fn restore_sent_review(
        &self,
        scope: &ScopeKey,
        snapshots: &[ReviewCommentSnapshot],
    ) -> Result<RestoredFromCard, ReviewError> {
        let rows = self
            .0
            .store
            .restore_comments_quiet(scope, snapshots, &self.now_iso())
            .await
            .map_err(internal)?;
        let restored = u32::try_from(rows.len()).unwrap_or(u32::MAX);
        let total = u32::try_from(snapshots.len()).unwrap_or(u32::MAX);
        self.push_upserts(rows);
        Ok(RestoredFromCard {
            restored,
            skipped: total.saturating_sub(restored),
        })
    }

    // ── Bus subscriber ────────────────────────────────────────────────────────

    /// Follow the broadcaster for the events that end a composer lease: a session
    /// deleted, archived or switched channel (leases are Rich Chat only). On
    /// `Lagged`, events were lost, so [`reconcile_scope_all`](Self::reconcile_scope_all)
    /// re-derives everything from the store.
    pub(crate) async fn run_holds_events(&self) {
        let mut rx = self.0.broadcaster.subscribe();
        loop {
            match rx.recv().await {
                Ok(ev) => self.on_holds_event(ev).await,
                Err(broadcast::error::RecvError::Lagged(_)) => self.reconcile_scope_all().await,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    /// One bus event (the loop's intake; public so tests can drive it).
    pub async fn on_holds_event(&self, ev: ServerEvent) {
        match ev {
            ServerEvent::SessionDeleted { session_id } => {
                self.detach_session_lease(&session_id).await;
                for hold in crate::service::or_warn(
                    self.0.store.list_holds(Some(&session_id)).await,
                    "list holds of a deleted session",
                ) {
                    self.restore_hold_impl(&hold.hold_id, RestoreReason::SessionRemoved)
                        .await;
                }
            }
            ServerEvent::SessionUpdated {
                session_id,
                channel,
                archived_at,
                ..
            } if channel.is_some() || archived_at.is_some() => {
                self.detach_session_lease(&session_id).await;
            }
            // A hidden worktree detaches its sessions' leases (a pending Terminal
            // delivery to it fails `archived` through the delivery job, and the
            // observer restores those comments).
            ServerEvent::WorktreeUpdated { worktree }
                if worktree.get("hiddenAt").is_some_and(|v| !v.is_null()) =>
            {
                let Some(id) = worktree.get("id").and_then(|v| v.as_str()) else {
                    return;
                };
                let sessions: Vec<String> = self
                    .0
                    .store
                    .get_all_projects()
                    .await
                    .into_iter()
                    .flat_map(|p| p.worktrees)
                    .filter(|w| w.id == id)
                    .flat_map(|w| w.sessions.into_iter().map(|s| s.id))
                    .collect();
                for sid in sessions {
                    self.detach_session_lease(&sid).await;
                }
            }
            _ => {}
        }
    }

    async fn detach_session_lease(&self, session_id: &str) {
        match self
            .0
            .store
            .detach_composer(&format!("session:{session_id}"))
            .await
        {
            Ok(rows) => self.push_upserts(rows),
            Err(e) => tracing::warn!("[vst] composer lease release failed: {e}"),
        }
    }

    /// Re-check, against the store, everything the bus could have told us about:
    /// a lease on a session that is gone, archived or no longer Rich Chat is
    /// detached, and a hold whose session is gone is restored. (Immediate
    /// Terminal rows are re-checked by the Terminal owner.)
    pub async fn reconcile_scope_all(&self) {
        let projects = self.0.store.get_all_projects().await;
        let sessions: Vec<&vst_types::SessionRecord> = projects
            .iter()
            .flat_map(|p| {
                p.worktrees
                    .iter()
                    .flat_map(|w| w.sessions.iter())
                    .chain(p.direct_sessions.iter())
            })
            .collect();
        let live_json = |id: &str| {
            sessions.iter().any(|s| {
                s.id == id && s.archived_at.is_none() && s.channel == Some(vst_types::Channel::Json)
            })
        };
        let exists = |id: &str| sessions.iter().any(|s| s.id == id);
        for key in crate::service::or_warn(
            self.0.store.list_attached_composers().await,
            "list attached composers",
        ) {
            let keep = key.strip_prefix("session:").is_some_and(live_json);
            if !keep {
                match self.0.store.detach_composer(&key).await {
                    Ok(rows) => self.push_upserts(rows),
                    Err(e) => tracing::warn!("[vst] composer lease release failed: {e}"),
                }
            }
        }
        for hold in crate::service::or_warn(self.0.store.list_holds(None).await, "list holds") {
            if !exists(&hold.session_id) {
                self.restore_hold_impl(&hold.hold_id, RestoreReason::SessionRemoved)
                    .await;
            }
        }
    }
}

impl ReviewPort for ReviewHandle {
    fn hold_for_turn(&self, req: HoldRequest) -> AsyncResult<Result<ReviewHold, ReviewError>> {
        let me = self.clone();
        Box::pin(async move { me.hold_for_turn_impl(req).await })
    }

    fn restore_hold(&self, hold_id: &str, reason: RestoreReason) -> AsyncResult<()> {
        let (me, id) = (self.clone(), hold_id.to_string());
        Box::pin(async move { me.restore_hold_impl(&id, reason).await })
    }

    fn rehome_hold(&self, hold_id: &str, session_id: &str, turn_id: &str) -> AsyncResult<()> {
        let me = self.clone();
        let (h, s, t) = (
            hold_id.to_string(),
            session_id.to_string(),
            turn_id.to_string(),
        );
        Box::pin(async move { me.rehome_hold_impl(&h, &s, &t).await })
    }

    fn consume_hold(&self, hold_id: &str) -> AsyncResult<()> {
        let (me, id) = (self.clone(), hold_id.to_string());
        Box::pin(async move { me.drop_hold_impl(&id).await })
    }

    fn adopt_snapshot(
        &self,
        row_id: &str,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        session_id: &str,
        turn_id: &str,
    ) -> AsyncResult<Result<ReviewHold, ReviewError>> {
        let me = self.clone();
        let (r, s, t) = (
            row_id.to_string(),
            session_id.to_string(),
            turn_id.to_string(),
        );
        Box::pin(async move { me.adopt_snapshot_impl(&r, snapshot, scope, &s, &t).await })
    }

    fn restore_snapshot(
        &self,
        row_id: Option<&str>,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        reason: RestoreReason,
    ) -> AsyncResult<()> {
        let me = self.clone();
        let row = row_id.map(str::to_string);
        Box::pin(async move {
            me.restore_snapshot_impl(row.as_deref(), snapshot, scope, reason)
                .await
        })
    }

    fn restore_for_session(&self, session_id: &str) -> AsyncResult<bool> {
        let (me, id) = (self.clone(), session_id.to_string());
        Box::pin(async move { me.restore_for_session_impl(&id).await })
    }

    fn restore_orphaned_snapshots(&self) -> AsyncResult<bool> {
        let me = self.clone();
        Box::pin(async move { me.restore_orphaned_snapshots_impl().await })
    }

    fn take_for_schedule(
        &self,
        req: vst_types::review::ScheduleTake,
    ) -> AsyncResult<Result<(), ReviewError>> {
        let me = self.clone();
        Box::pin(async move { me.take_for_schedule_impl(req).await })
    }

    fn rehold_schedule(&self, row_id: &str) -> AsyncResult<Result<u32, ReviewError>> {
        let (me, id) = (self.clone(), row_id.to_string());
        Box::pin(async move { me.rehold_schedule_impl(&id).await })
    }
}

impl TurnObserver for ReviewHandle {
    fn turn_persisted(&self, hold_id: &str) -> AsyncResult<()> {
        let (me, id) = (self.clone(), hold_id.to_string());
        Box::pin(async move { me.drop_hold_impl(&id).await })
    }

    fn turn_cancelled(&self, hold_id: &str, reason: RestoreReason) -> AsyncResult<()> {
        let (me, id) = (self.clone(), hold_id.to_string());
        Box::pin(async move { me.restore_hold_impl(&id, reason).await })
    }
}

/// Shared handles, as injected into `JsonAgentRegistry::set_review_hooks`.
pub fn hooks(handle: &ReviewHandle) -> (Arc<dyn ReviewPort>, Arc<dyn TurnObserver>) {
    (Arc::new(handle.clone()), Arc::new(handle.clone()))
}
