//! Review comments riding a queued turn (plan 04, Rich Chat delivery).
//!
//! The engine never owns the comments: `vst-review` holds them as rows marked
//! `heldBy = hold_id` from the send until the turn's `user` row is persisted. This
//! module is the engine's side of that contract, through the `TurnObserver`
//! seam in `vst-types` (so `vst-agents` has no edge on `vst-review`):
//!
//! - [`persist_turn_row`](JsonAgentSession::persist_turn_row): the ONE place a
//!   queued turn's `user` row is written when the turn leaves the queue (the
//!   drain pop AND a delivered steer), followed by `turn_persisted`;
//! - cancel paths hand `(hold_id, reason)` pairs to
//!   [`spawn_turn_cancelled`](JsonAgentSession::spawn_turn_cancelled) after
//!   dropping the state lock;
//! - the reset path moves a review out of / back into a turn
//!   ([`take_review`](JsonAgentSession::take_review) /
//!   [`restore_review`](JsonAgentSession::restore_review)).
//!
//! A review turn is never steered: a steer carries only the raw message and
//! would silently drop the comments.

use std::sync::Arc;

use vst_types::review::{RestoreReason, TurnObserver};

use super::events::EmitUserEventOpts;
use super::{JsonAgentSession, QueuedTurn, ReviewTurn};

/// Append the rendered review block to a turn's message (run time, after skill
/// resolution, attachments and the mention block; line 1 is never touched).
pub(super) fn append_review_block(message: String, review: &ReviewTurn) -> String {
    let block =
        vst_types::review_format::render_review_block(&review.record.name, &review.record.comments);
    if message.trim().is_empty() {
        block
    } else {
        format!("{message}\n\n{block}")
    }
}

impl JsonAgentSession {
    /// Attach the review observer (first call wins).
    pub fn attach_review_observer(&self, observer: Arc<dyn TurnObserver>) {
        let _ = self.0.review_observer.set(observer);
    }

    /// Persist the `user` row of a turn that is leaving the queue, then settle
    /// its hold: `turn_persisted` once the row is in the transcript; if the
    /// session was released first (nothing was written) the comments go back to
    /// the panel instead. Does not depend on the turn still being in `queue`
    /// (`abort_and_drain` may have cleared it mid-steer-RPC).
    /// Returns whether the row reached the transcript. The drain uses it: a turn
    /// popped just before `release()` was NOT persisted (its comments were
    /// restored), so it must not run.
    pub(super) async fn persist_turn_row(&self, turn: &QueuedTurn) -> bool {
        self.persist_turn_row_with(turn, false).await
    }

    /// [`Self::persist_turn_row`] for the drain: the success settle
    /// (`turn_persisted`, a store write) runs detached, so no await sits between
    /// popping the turn and `run_one_turn` registering it as active. Otherwise a
    /// Stop pressed in that window would find neither a queued nor an active turn
    /// and be dropped. Safe: boot reconcile deletes holds whose user row was
    /// persisted, and a persisted hold is never also cancelled.
    pub(super) async fn persist_popped_turn_row(&self, turn: &QueuedTurn) -> bool {
        self.persist_turn_row_with(turn, true).await
    }

    async fn persist_turn_row_with(&self, turn: &QueuedTurn, detach_settle: bool) -> bool {
        let persisted = self.emit_user_event(
            &turn.turn_id,
            &turn.raw_message,
            &turn.attachments,
            EmitUserEventOpts {
                silent: turn.silent,
                mentions: turn.mentions.clone(),
                review: turn.review.as_ref().map(|r| r.record.clone()),
                ..Default::default()
            },
        );
        let (Some(review), Some(observer)) = (&turn.review, self.0.review_observer.get()) else {
            return persisted;
        };
        if persisted && detach_settle {
            match tokio::runtime::Handle::try_current() {
                Ok(handle) => {
                    let (observer, hold_id) = (observer.clone(), review.hold_id.clone());
                    handle.spawn(async move { observer.turn_persisted(&hold_id).await });
                }
                Err(_) => observer.turn_persisted(&review.hold_id).await,
            }
        } else if persisted {
            observer.turn_persisted(&review.hold_id).await;
        } else {
            let reason = *self.0.release_reason.lock().unwrap();
            observer.turn_cancelled(&review.hold_id, reason).await;
        }
        persisted
    }

    /// Restore the comments of cancelled turns. The state lock must already be
    /// dropped; the observer call runs detached (boot reconcile covers a crash
    /// in between, and `turn_cancelled` is idempotent).
    pub(super) fn spawn_turn_cancelled(&self, cancelled: Vec<(String, RestoreReason)>) {
        if cancelled.is_empty() {
            return;
        }
        let Some(observer) = self.0.review_observer.get().cloned() else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                "[vst] review turn cancelled outside a runtime; hold left for reconcile"
            );
            return;
        };
        handle.spawn(async move {
            for (hold_id, reason) in cancelled {
                observer.turn_cancelled(&hold_id, reason).await;
            }
        });
    }

    /// Take a turn's review out of it (reset path), whether the turn is still in
    /// `queue` or already moved into the editing `holds` by
    /// `begin_edit_queued_turn`. The turn keeps running without it, so a later
    /// `release()` -> cancel sweep never restores it. A second call returns `None`.
    pub fn take_review(&self, turn_id: &str) -> Option<ReviewTurn> {
        let mut s = self.0.state.lock().unwrap();
        if let Some(t) = s.queue.iter_mut().find(|t| t.turn_id == turn_id) {
            return t.review.take();
        }
        s.holds.get_mut(turn_id).and_then(|h| h.turn.review.take())
    }

    /// The reviews of the turns still in the queue, without taking them (the
    /// reset's up-front size check for a Terminal target).
    pub fn queued_reviews(&self) -> Vec<ReviewTurn> {
        let s = self.0.state.lock().unwrap();
        s.queue.iter().filter_map(|t| t.review.clone()).collect()
    }

    /// Give a taken review back to its turn (a failed or cancelled reset).
    /// `false` when the turn is gone or already carries one: the caller then
    /// restores the hold itself.
    pub fn restore_review(&self, turn_id: &str, review: ReviewTurn) -> bool {
        let mut s = self.0.state.lock().unwrap();
        let turn = match s.queue.iter_mut().find(|t| t.turn_id == turn_id) {
            Some(t) => Some(t),
            None => s.holds.get_mut(turn_id).map(|h| &mut h.turn),
        };
        match turn {
            Some(t) if t.review.is_none() => {
                t.review = Some(review);
                true
            }
            _ => false,
        }
    }
}
