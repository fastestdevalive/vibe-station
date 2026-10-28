//! Boot reconcile: put everything a crashed or restarted daemon left in flight
//! back where the user can see it, exactly once. Runs BEFORE the store's
//! `recover_orphans` (which purges rows of deleted sessions and fails the rows a
//! previous daemon had claimed).
//!
//! 1. Turn holds: a hold whose session transcript already has a non-cancelled
//!    `user` row for the hold's `turnId` was delivered (delete it); any other
//!    hold is restored (`restart`, or `session_removed` when the session is gone).
//! 2. Claimed pending Rich Chat schedule rows whose snapshot is still `held`
//!    (delivery was in flight) are restored (`restart`) and flipped `restored`;
//!    rows marked `adopted` belong to their hold (step 1).
//! 3. Pending rows of sessions that no longer exist (the boot purge is about to
//!    delete them, and no outcome will ever be reported for a gone session) are
//!    restored (`session_removed`), Terminal rows included.
//! 4. The ids of claimed pending immediate Terminal rows are remembered: 02's
//!    recovery fails them `error` and the observer then restores them with the
//!    `restart` reason ("last send didn't finish", R110).
//!
//! The orphan purge of comments (held rows included) of deleted worktrees and
//! projects is `vst-daemon`'s `review_boot` (it runs earlier, gated on the manifest
//! migration), so nothing here restores into a scope that is gone.

use std::sync::Arc;

use vst_store::comment_consumers::HeldFilter;
use vst_types::review::{AsyncResult, RestoreReason};
use vst_types::{NormalizedEvent, NormalizedEventKind};

use crate::service::ReviewHandle;

/// Reads a session's transcript (`None` = the session no longer exists).
pub type TranscriptReader =
    Arc<dyn Fn(&str) -> AsyncResult<Option<Vec<NormalizedEvent>>> + Send + Sync>;

/// What a boot reconcile did (logged; asserted in tests).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BootReport {
    pub holds_deleted: u32,
    pub holds_restored: u32,
    pub schedule_rows_restored: u32,
    pub immediate_rows_noted: u32,
}

fn turn_persisted(events: &[NormalizedEvent], turn_id: &str) -> bool {
    events.iter().any(|e| {
        e.kind == NormalizedEventKind::User
            && e.turn_id.as_deref() == Some(turn_id)
            && e.cancelled != Some(true)
    })
}

/// A boot-recovery listing that failed is logged (ids/counts only) and treated
/// as empty: the rows survive, so the next boot retries.
fn warn_default<T, E: std::fmt::Display>(r: Result<Vec<T>, E>, what: &str) -> Vec<T> {
    r.unwrap_or_else(|e| {
        tracing::warn!("[vst] boot recovery: listing {what} failed: {e}");
        Vec::new()
    })
}

impl ReviewHandle {
    /// See the module docs. Call once, before `recover_orphans`.
    pub async fn reconcile_boot(&self, transcript: TranscriptReader) -> BootReport {
        let mut report = BootReport::default();

        for hold in warn_default(self.0.store.list_holds(None).await, "holds") {
            match transcript(&hold.session_id).await {
                None => {
                    self.restore_hold_impl(&hold.hold_id, RestoreReason::SessionRemoved)
                        .await;
                    report.holds_restored += 1;
                }
                Some(events) if turn_persisted(&events, &hold.turn_id) => {
                    self.drop_hold_impl(&hold.hold_id).await;
                    report.holds_deleted += 1;
                }
                Some(_) => {
                    self.restore_hold_impl(&hold.hold_id, RestoreReason::Restart)
                        .await;
                    report.holds_restored += 1;
                }
            }
        }

        let claimed = warn_default(
            self.0.store.list_held_snapshots(HeldFilter::Claimed).await,
            "claimed snapshots",
        );
        report.schedule_rows_restored += u32::try_from(claimed.len()).unwrap_or(u32::MAX);
        self.restore_held_rows(claimed, RestoreReason::Restart)
            .await;

        let orphaned = warn_default(
            self.0
                .store
                .list_held_snapshots(HeldFilter::OrphanedSessionsAnyChannel)
                .await,
            "orphaned snapshots",
        );
        report.schedule_rows_restored += u32::try_from(orphaned.len()).unwrap_or(u32::MAX);
        self.restore_held_rows(orphaned, RestoreReason::SessionRemoved)
            .await;

        let ids = warn_default(
            self.0.store.claimed_immediate_ids().await,
            "claimed immediate rows",
        );
        report.immediate_rows_noted = u32::try_from(ids.len()).unwrap_or(u32::MAX);
        self.note_boot_immediate(ids);

        // Leases of dead sessions, holds of vanished sessions, immediate rows of
        // sessions that are gone.
        self.reconcile_scope_all().await;

        tracing::info!(
            holds_deleted = report.holds_deleted,
            holds_restored = report.holds_restored,
            schedule_rows_restored = report.schedule_rows_restored,
            immediate_rows = report.immediate_rows_noted,
            "[vst] review boot reconcile"
        );
        report
    }
}
