//! Review comments to a Terminal (tmux) agent: the immediate send, the outcome
//! observer, and the `terminal-delivery:updated` events.
//!
//! A send is an `origin = 'immediate'` row of `scheduled_messages` inserted
//! already claimed and `waiting` in the same transaction that removes the
//! comments (`StoreHandle::take_for_terminal_row`), so the 1 s schedule poller
//! never sees it; then [`TerminalDeliveryHandle::fire`] owns the job.
//! This module never writes a tmux row's terminal state: every outcome reaches
//! [`ReviewHandle::on_terminal_outcome`] through the handle's `OutcomeObserver`
//! (exactly once), which restores the comments for `Failed`/`Cancelled`/`Gone`
//! and keeps the hold for `Sent`/`Rearmed`.
//!
//! The paste body of any row that holds a snapshot is the Appendix A block built
//! at fire time ([`review_paste_body`]); `sanitize_paste_text` sanitizes it and applies the 32 KB
//! and multi-line checks to THAT text.
//!
//! **Logging (R84):** ids, counts and reasons only, never comment text.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::broadcast;
use vst_store::comment_consumers::{ScheduleSpec, TakeLimits};
use vst_types::artifacts::ScopeKey;
use vst_types::domain::{ScheduledMessageMeta, ScheduledPhase};
use vst_types::rest::review::CreateTerminalDeliveryBody;
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::review::{
    DeletedReason, DeliveryState, PayloadState, RestoreReason, ReviewError, ReviewRecord,
    ScheduledReviewPayload, TerminalDelivery, RICH_SEND_MAX_COMMENTS, TERMINAL_SEND_MAX_BYTES,
};
use vst_types::review_format::render_review_message;
use vst_types::terminal_delivery::{FailureKind, TerminalOutcome, TerminalReadiness};
use vst_types::{ServerEvent, SessionType};

use crate::delivery::{
    OutcomeObserver, PasteBody, RowCapture, TargetResolver, TerminalDeliveryHandle,
};
use crate::service::ReviewHandle;

/// Why a Terminal send or cancel was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TerminalError {
    #[error(transparent)]
    Review(#[from] ReviewError),
    /// The session is not a Terminal agent whose CLI can take review comments
    /// (HTTP 400 `TERMINAL_DELIVERY_UNSUPPORTED`).
    #[error("{0}")]
    Unsupported(&'static str),
    /// The paste already started; it can no longer be cancelled (409).
    #[error("the paste already started")]
    Pasting,
    /// The request named no comments, so there is nothing to paste (400).
    #[error("no comments to send")]
    NoComments,
}

/// What the Terminal owner needs from the daemon: the delivery handle and the
/// resolver that tells a session's current channel and capabilities.
#[derive(Clone)]
pub struct TerminalWiring {
    pub delivery: TerminalDeliveryHandle,
    pub resolver: Arc<dyn TargetResolver>,
}

/// A row's snapshot, read before the row is deleted (see [`RowCapture`]).
struct Captured {
    origin_immediate: bool,
    session_id: String,
    message: String,
    payload: ScheduledReviewPayload,
}

#[derive(Default)]
struct Book {
    /// Last `terminal-delivery:updated` state pushed per immediate row.
    phases: HashMap<String, (String, DeliveryState)>,
    /// Rows whose outcome was already reported (a late phase event must not
    /// resurrect them).
    finished: HashSet<String>,
    /// `finished` in insertion order, so the oldest id is evicted first.
    finished_order: std::collections::VecDeque<String>,
}

/// Most finished ids remembered (see [`Book::finished`]).
const MAX_FINISHED: usize = 512;

impl Book {
    fn mark_finished(&mut self, id: &str) {
        if self.finished.insert(id.to_string()) {
            self.finished_order.push_back(id.to_string());
        }
        while self.finished_order.len() > MAX_FINISHED {
            if let Some(old) = self.finished_order.pop_front() {
                self.finished.remove(&old);
            }
        }
    }
}

/// State of the Terminal owner kept inside [`ReviewHandle`].
#[derive(Default)]
pub struct TerminalState {
    wiring: OnceLock<TerminalWiring>,
    captured: Mutex<HashMap<String, Captured>>,
    /// Ids of claimed pending immediate rows found at boot (R110: a restart is
    /// why they fail).
    boot_immediate: Mutex<HashSet<String>>,
    book: Mutex<Book>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn internal(e: impl std::fmt::Display) -> ReviewError {
    ReviewError::Internal(e.to_string())
}

/// A refusal of the block budget reports the whole-paste cap (the budget handed to
/// the store is that cap minus the message).
pub(crate) fn cap_limit(e: ReviewError) -> ReviewError {
    match e {
        ReviewError::TooLarge { unit: "bytes", .. } => ReviewError::TooLarge {
            limit: to_u32(TERMINAL_SEND_MAX_BYTES),
            unit: "bytes",
        },
        other => other,
    }
}

fn payload_of(row: &ScheduledMessageRow) -> Option<ScheduledReviewPayload> {
    crate::terminal_text::parse_row_payload(row)
}

fn is_immediate(row: &ScheduledMessageRow) -> bool {
    row.origin.as_deref() == Some("immediate")
}

/// How a row's paste bytes are built: the user's message, then the Appendix A
/// block of the snapshot it HOLDS. A snapshot that is no longer `held`
/// (restored, adopted by a Rich Chat turn) is not the row's to paste. Install it
/// on the delivery handle with `with_paste_body`.
pub fn review_paste_body() -> PasteBody {
    Arc::new(|row| match payload_of(row) {
        Some(p) if p.state == PayloadState::Held && !p.comments.is_empty() => {
            render_review_message(&p.name, &row.message, &p.comments)
        }
        _ => row.message.clone(),
    })
}

/// Restore reason for a failed/cancelled/gone outcome (Decision 12 mapping).
pub fn restore_reason(
    outcome: TerminalOutcome,
    immediate: bool,
    in_boot_set: bool,
) -> RestoreReason {
    match outcome {
        TerminalOutcome::Failed(kind) => match kind {
            FailureKind::TimedOut => RestoreReason::TimedOut,
            FailureKind::AgentExited => RestoreReason::AgentExited,
            FailureKind::Archived => RestoreReason::SessionRemoved,
            FailureKind::RestartedMidPaste => RestoreReason::Restart,
            FailureKind::Error if in_boot_set => RestoreReason::Restart,
            FailureKind::ChannelUnsupported | FailureKind::Error => {
                if immediate {
                    RestoreReason::SendFailed
                } else {
                    RestoreReason::ScheduleFailed
                }
            }
        },
        TerminalOutcome::Cancelled => {
            if immediate {
                RestoreReason::SendCancelled
            } else {
                RestoreReason::ScheduleCancelled
            }
        }
        TerminalOutcome::Gone => RestoreReason::SessionRemoved,
        // A defensive immediate re-arm.
        TerminalOutcome::Rearmed => RestoreReason::ChannelChanged,
        // `Sent` restores nothing; this arm only completes the match.
        TerminalOutcome::Sent => RestoreReason::SendFailed,
    }
}

fn delivery_state(outcome: TerminalOutcome) -> DeliveryState {
    match outcome {
        TerminalOutcome::Sent => DeliveryState::Sent,
        TerminalOutcome::Failed(FailureKind::TimedOut) => DeliveryState::TimedOut,
        TerminalOutcome::Failed(_) | TerminalOutcome::Gone | TerminalOutcome::Rearmed => {
            DeliveryState::Failed
        }
        TerminalOutcome::Cancelled => DeliveryState::Cancelled,
    }
}

fn delivery_reason(outcome: TerminalOutcome, reason: RestoreReason) -> Option<String> {
    match outcome {
        TerminalOutcome::Sent | TerminalOutcome::Cancelled => None,
        TerminalOutcome::Failed(FailureKind::Error) if reason == RestoreReason::Restart => {
            Some(RestoreReason::Restart.as_str().to_string())
        }
        TerminalOutcome::Failed(kind) => Some(kind.as_str().to_string()),
        TerminalOutcome::Gone | TerminalOutcome::Rearmed => Some(reason.as_str().to_string()),
    }
}

fn scope_of(p: &ScheduledReviewPayload) -> ScopeKey {
    ScopeKey {
        scope_kind: p.scope_kind,
        scope_id: p.scope_id.clone(),
    }
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl ReviewHandle {
    // ── Wiring ────────────────────────────────────────────────────────────────

    /// Attach the Terminal delivery handle and resolver (once; later calls are
    /// ignored). Needs `&self` because the handle is cloned into the observer
    /// closure before the delivery handle exists.
    pub fn attach_terminal(&self, wiring: TerminalWiring) {
        let _ = self.0.terminal.wiring.set(wiring);
    }

    fn wiring(&self) -> Option<&TerminalWiring> {
        self.0.terminal.wiring.get()
    }

    /// The outcome observer to pass to `TerminalDeliveryHandle::new`. Sync and
    /// non-blocking: the work runs on its own task.
    pub fn terminal_observer(&self) -> OutcomeObserver {
        let me = self.clone();
        Arc::new(move |row_id, outcome| {
            let me = me.clone();
            tokio::spawn(async move { me.on_terminal_outcome(&row_id, outcome).await });
        })
    }

    /// The [`RowCapture`] hook to install on the delivery handle: it keeps the
    /// snapshot of a row that is about to be deleted (cancel, session removal).
    pub fn terminal_row_capture(&self) -> RowCapture {
        let me = self.clone();
        Arc::new(move |row| {
            if let Some(payload) = payload_of(row) {
                lock(&me.0.terminal.captured).insert(
                    row.id.clone(),
                    Captured {
                        origin_immediate: is_immediate(row),
                        session_id: row.session_id.clone(),
                        message: row.message.clone(),
                        payload,
                    },
                );
            }
        })
    }

    // ── Send ──────────────────────────────────────────────────────────────────

    /// `POST /worktrees/:id/terminal-deliveries`: take the comments into an
    /// immediate row and start its job. Idempotent by `terminalDeliveryId`.
    pub async fn send_terminal(
        &self,
        scope: &ScopeKey,
        req: CreateTerminalDeliveryBody,
    ) -> Result<TerminalDelivery, TerminalError> {
        let wiring = self
            .wiring()
            .ok_or(TerminalError::Unsupported(
                "terminal delivery is not available",
            ))?
            .clone();
        let name = self.scope_label(scope).await.ok_or(ReviewError::NotFound)?;

        // Idempotent retry: the same id returns the first delivery.
        if let Some(row) = self
            .0
            .store
            .get_scheduled_message(&req.terminal_delivery_id)
            .await
            .map_err(internal)?
        {
            let payload = is_immediate(&row)
                .then(|| payload_of(&row))
                .flatten()
                .filter(|p| scope_of(p) == *scope && row.session_id == req.session_id)
                .ok_or(ReviewError::Duplicate)?;
            let waits = self.waits_behind(&row.session_id).await;
            return Ok(self.delivery_of(&row, &payload, state_of_row(&row), None, waits));
        }

        if req.comment_ids.is_empty() {
            return Err(TerminalError::NoComments);
        }

        // The session must be a Terminal agent of this scope whose CLI can take
        // a multi-line paste.
        let (project, session) = self
            .0
            .store
            .find_session(&req.session_id)
            .await
            .ok_or(ReviewError::NotFound)?;
        let session_scope = match &session.worktree_id {
            Some(w) => ScopeKey::worktree(w.clone()),
            None => ScopeKey::project(project.id.clone()),
        };
        if session_scope != *scope {
            return Err(ReviewError::Scope.into());
        }
        if session.r#type != SessionType::Agent || session.archived_at.is_some() {
            return Err(TerminalError::Unsupported("not a live agent session"));
        }
        let target = wiring
            .resolver
            .resolve(&req.session_id)
            .await
            .ok_or(ReviewError::NotFound)?;
        if !target.channel_is_tmux {
            return Err(TerminalError::Unsupported("not a Terminal agent"));
        }
        if !target.caps.is_some_and(|c| c.multiline_ok) {
            return Err(TerminalError::Unsupported(
                "this agent cannot take review comments in its terminal",
            ));
        }

        let message = req.message.clone().unwrap_or_default();
        // The cap is on the whole paste (message + block): the block gets what the
        // message leaves.
        let block_budget =
            vst_types::review_format::block_budget(TERMINAL_SEND_MAX_BYTES, &message);
        if message.trim_end().len() >= TERMINAL_SEND_MAX_BYTES {
            return Err(ReviewError::TooLarge {
                limit: to_u32(TERMINAL_SEND_MAX_BYTES),
                unit: "bytes",
            }
            .into());
        }
        let composer = self
            .resolve_composer(scope, &req.comment_ids, req.composer_key.as_deref())
            .await?;
        let now = self.now_iso();
        let taken = self
            .0
            .store
            .take_for_terminal_row(
                scope,
                &req.comment_ids,
                composer.as_deref(),
                &name,
                TakeLimits {
                    max_comments: RICH_SEND_MAX_COMMENTS,
                    max_bytes: block_budget,
                },
                ScheduleSpec {
                    id: req.terminal_delivery_id.clone(),
                    session_id: req.session_id.clone(),
                    message: message.clone(),
                    fire_at: now.clone(),
                    now: now.clone(),
                    channel: Some("tmux".to_string()),
                    attachments: None,
                },
            )
            .await
            .map_err(internal)?
            .map_err(cap_limit)?;
        self.push_deleted(scope, &taken.deleted, DeletedReason::Sent);
        tracing::info!(
            delivery = %req.terminal_delivery_id,
            session = %req.session_id,
            count = taken.snapshots.len(),
            "[vst] terminal review delivery queued"
        );

        let row = self
            .0
            .store
            .get_scheduled_message(&req.terminal_delivery_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| ReviewError::Internal("immediate row vanished".to_string()))?;
        let payload = ScheduledReviewPayload {
            state: PayloadState::Held,
            scope_kind: scope.scope_kind,
            scope_id: scope.scope_id.clone(),
            name,
            comments: taken.snapshots,
        };
        let delivery = self.delivery_of(
            &row,
            &payload,
            DeliveryState::Waiting,
            None,
            taken.waits_behind.unwrap_or(0),
        );
        lock(&self.0.terminal.book).phases.insert(
            row.id.clone(),
            (row.session_id.clone(), DeliveryState::Waiting),
        );
        self.emit_delivery(delivery.clone());
        wiring.delivery.fire(row).await;
        Ok(delivery)
    }

    /// `DELETE /terminal-deliveries/:id`: stop the job (the observer then restores
    /// the comments). `Pasting` once the paste started.
    pub async fn cancel_terminal(&self, delivery_id: &str) -> Result<(), TerminalError> {
        let wiring = self
            .wiring()
            .ok_or(TerminalError::Unsupported(
                "terminal delivery is not available",
            ))?
            .clone();
        let row = self
            .0
            .store
            .get_scheduled_message(delivery_id)
            .await
            .map_err(internal)?
            .filter(is_immediate)
            .ok_or(ReviewError::NotFound)?;
        match wiring
            .delivery
            .cancel_row(&row.session_id, delivery_id)
            .await
            .map_err(internal)?
        {
            vst_store::CancelOutcome::Deleted => Ok(()),
            vst_store::CancelOutcome::InFlight => Err(TerminalError::Pasting),
            vst_store::CancelOutcome::NotFound => Err(ReviewError::NotFound.into()),
        }
    }

    /// `GET /sessions/:id/terminal-readiness`: one bounded probe, nothing pasted.
    pub async fn terminal_readiness(&self, session_id: &str) -> TerminalReadiness {
        match self.wiring() {
            Some(w) => w.delivery.probe_once(session_id).await,
            None => TerminalReadiness::Unknown,
        }
    }

    // ── Events ────────────────────────────────────────────────────────────────

    fn emit_delivery(&self, delivery: TerminalDelivery) {
        self.0
            .broadcaster
            .send(ServerEvent::TerminalDeliveryUpdated { delivery });
    }

    fn delivery_of(
        &self,
        row: &ScheduledMessageRow,
        payload: &ScheduledReviewPayload,
        state: DeliveryState,
        reason: Option<String>,
        waits_behind: u32,
    ) -> TerminalDelivery {
        let snaps = &payload.comments;
        TerminalDelivery {
            id: row.id.clone(),
            scope_kind: payload.scope_kind,
            scope_id: payload.scope_id.clone(),
            session_id: row.session_id.clone(),
            state,
            comment_ids: snaps.iter().map(|c| c.id.clone()).collect(),
            comment_count: to_u32(snaps.len()),
            bytes: to_u32(render_review_message(&payload.name, &row.message, snaps).len()),
            message: Some(row.message.clone()).filter(|m| !m.is_empty()),
            reason,
            waits_behind: Some(waits_behind).filter(|n| *n > 0),
            updated_at: self.now_iso(),
        }
    }

    async fn waits_behind(&self, session_id: &str) -> u32 {
        match self.0.store.list_all_immediate_rows().await {
            Ok(rows) => rows
                .iter()
                .find(|r| r.session_id == session_id)
                .map_or(0, |r| r.waits_behind),
            Err(_) => 0,
        }
    }

    // ── Outcomes ──────────────────────────────────────────────────────────────

    /// One terminal outcome of a tmux row (the delivery handle's observer, once
    /// per outcome). A row without a comment snapshot is none of our business.
    pub async fn on_terminal_outcome(&self, row_id: &str, outcome: TerminalOutcome) {
        let captured = lock(&self.0.terminal.captured).remove(row_id);
        // A transient read error must not read as "not ours" (the held snapshot
        // would never be restored): retry once, then log.
        let mut read = self.0.store.get_scheduled_message(row_id).await;
        if read.is_err() {
            read = self.0.store.get_scheduled_message(row_id).await;
        }
        let row = match read {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(row_id, "terminal outcome could not read its row: {e}");
                None
            }
        };
        // A captured copy exists exactly when the row was deleted under us.
        let (immediate, session_id, message, payload) = match (&captured, &row) {
            (Some(c), _) => (
                c.origin_immediate,
                c.session_id.clone(),
                c.message.clone(),
                c.payload.clone(),
            ),
            (None, Some(r)) => match payload_of(r) {
                Some(p) => (is_immediate(r), r.session_id.clone(), r.message.clone(), p),
                None => return,
            },
            (None, None) => return,
        };
        let scope = scope_of(&payload);

        let finish = |state: DeliveryState, reason: Option<String>| {
            let mut book = lock(&self.0.terminal.book);
            book.phases.remove(row_id);
            book.mark_finished(row_id);
            drop(book);
            if immediate {
                let stub = ScheduledMessageRow {
                    id: row_id.to_string(),
                    session_id: session_id.clone(),
                    message: message.clone(),
                    attachments: None,
                    fire_at: String::new(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    status: String::new(),
                    sent_at: None,
                    sent_turn_id: None,
                    failure_reason: None,
                    claimed_at: None,
                    channel: Some("tmux".to_string()),
                    delivery_phase: None,
                    failure_kind: None,
                    comments_snapshot: None,
                    origin: Some("immediate".to_string()),
                };
                self.emit_delivery(self.delivery_of(&stub, &payload, state, reason, 0));
            }
        };

        match outcome {
            // The comments were pasted: they stay gone.
            TerminalOutcome::Sent => finish(DeliveryState::Sent, None),
            // A schedule row goes back to `scheduled` and still holds its snapshot.
            TerminalOutcome::Rearmed if !immediate => {}
            _ => {
                let in_boot = lock(&self.0.terminal.boot_immediate).contains(row_id);
                let reason = restore_reason(outcome, immediate, in_boot);
                if outcome == TerminalOutcome::Rearmed {
                    tracing::warn!(
                        row = row_id,
                        "[vst] immediate terminal row re-armed; restoring"
                    );
                }
                // A row that still exists is guarded by its payload flip
                // (`held -> restored`); a deleted one (captured) was reported once.
                let flip = (captured.is_none() && row.is_some()).then_some(row_id);
                if self.scope_label(&scope).await.is_some() {
                    self.restore_snapshot_impl(
                        flip,
                        ReviewRecord {
                            name: payload.name.clone(),
                            comments: payload.comments.clone(),
                        },
                        scope,
                        reason,
                    )
                    .await;
                } else if let Some(id) = flip {
                    // The scope is gone: nothing to restore into.
                    let _ = self
                        .0
                        .store
                        .set_payload_state(id, PayloadState::Restored, Some(&[PayloadState::Held]))
                        .await;
                }
                if captured.is_some() && row.is_some() {
                    // Unconditional restore above (the row was being deleted):
                    // mark what we did on a row that still exists.
                    let _ = self
                        .0
                        .store
                        .set_payload_state(
                            row_id,
                            PayloadState::Restored,
                            Some(&[PayloadState::Held]),
                        )
                        .await;
                }
                if immediate && row.is_some() {
                    if let Err(e) = self.0.store.delete_scheduled_message(row_id).await {
                        tracing::warn!(row = row_id, "[vst] immediate row delete failed: {e}");
                    }
                }
                finish(delivery_state(outcome), delivery_reason(outcome, reason));
            }
        }
    }

    // ── Bus subscriber ────────────────────────────────────────────────────────

    /// Map `SessionScheduledChanged` rows with `origin = 'immediate'` to
    /// `terminal-delivery:updated` (waiting <-> pasting), pushing only a real
    /// change. On `Lagged`, [`reconcile_immediate_rows`](Self::reconcile_immediate_rows)
    /// re-derives from the store.
    pub(crate) async fn run_terminal_events(&self) {
        let mut rx = self.0.broadcaster.subscribe();
        loop {
            match rx.recv().await {
                Ok(ServerEvent::SessionScheduledChanged {
                    session_id,
                    scheduled_sends,
                    ..
                }) => {
                    self.on_scheduled_changed(&session_id, &scheduled_sends)
                        .await
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.reconcile_immediate_rows().await
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    /// One `session:scheduled-changed` (the loop's intake; public for tests).
    pub async fn on_scheduled_changed(&self, session_id: &str, sends: &[ScheduledMessageMeta]) {
        let live: Vec<(&ScheduledMessageMeta, DeliveryState)> = sends
            .iter()
            .filter(|m| m.origin.as_deref() == Some("immediate"))
            .map(|m| {
                let state = match m.phase {
                    Some(ScheduledPhase::Pasting) => DeliveryState::Pasting,
                    _ => DeliveryState::Waiting,
                };
                (m, state)
            })
            .collect();
        // Rows of this session that left the list stop being tracked.
        lock(&self.0.terminal.book)
            .phases
            .retain(|id, (sid, _)| sid != session_id || live.iter().any(|(m, _)| &m.id == id));
        for (meta, state) in live {
            let changed = {
                let mut book = lock(&self.0.terminal.book);
                if book.finished.contains(&meta.id) {
                    false
                } else {
                    book.phases
                        .insert(meta.id.clone(), (session_id.to_string(), state))
                        .map(|(_, s)| s)
                        != Some(state)
                }
            };
            if !changed {
                continue;
            }
            let Ok(Some(row)) = self.0.store.get_scheduled_message(&meta.id).await else {
                continue;
            };
            if row.status != "pending" {
                continue;
            }
            let Some(payload) = payload_of(&row) else {
                continue;
            };
            let waits = self.waits_behind(session_id).await;
            self.emit_delivery(self.delivery_of(&row, &payload, state, None, waits));
        }
    }

    /// Re-check, against the store, the immediate rows the bus could have told
    /// us about: a pending row whose session is gone (its `Gone` outcome was
    /// lost) goes back to the panel and is deleted.
    pub async fn reconcile_immediate_rows(&self) {
        let rows = match self.0.store.list_all_immediate_rows().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[vst] immediate row reconcile failed: {e}");
                return;
            }
        };
        for r in rows {
            if self.0.store.find_session(&r.session_id).await.is_some() {
                continue;
            }
            let scope = scope_of(&r.payload);
            if self.scope_label(&scope).await.is_some() {
                self.restore_snapshot_impl(
                    Some(&r.row_id),
                    ReviewRecord {
                        name: r.payload.name.clone(),
                        comments: r.payload.comments.clone(),
                    },
                    scope,
                    RestoreReason::SessionRemoved,
                )
                .await;
            }
            let _ = self.0.store.delete_scheduled_message(&r.row_id).await;
            lock(&self.0.terminal.book).phases.remove(&r.row_id);
            tracing::info!(row = %r.row_id, "[vst] stale immediate terminal row restored");
        }
    }

    // ── Boot ──────────────────────────────────────────────────────────────────

    pub(crate) fn note_boot_immediate(&self, ids: Vec<String>) {
        lock(&self.0.terminal.boot_immediate).extend(ids);
    }
}

fn state_of_row(row: &ScheduledMessageRow) -> DeliveryState {
    match (row.status.as_str(), row.delivery_phase.as_deref()) {
        ("sent", _) => DeliveryState::Sent,
        ("failed", _) => DeliveryState::Failed,
        (_, Some("pasting")) => DeliveryState::Pasting,
        _ => DeliveryState::Waiting,
    }
}

/// Which scope an immediate row belongs to (tests).
pub fn row_scope(row: &ScheduledMessageRow) -> Option<ScopeKey> {
    payload_of(row).map(|p| scope_of(&p))
}

#[cfg(test)]
mod finished_tests {
    use super::*;

    #[test]
    fn eviction_is_oldest_first_and_keeps_the_latest_ids() {
        let mut book = Book::default();
        for i in 0..=MAX_FINISHED {
            book.mark_finished(&format!("r{i}"));
        }
        assert_eq!(book.finished.len(), MAX_FINISHED);
        assert!(!book.finished.contains("r0"), "oldest evicted");
        assert!(book.finished.contains(&format!("r{MAX_FINISHED}")));
    }
}
