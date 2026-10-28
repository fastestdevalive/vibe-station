//! Scheduling a message together with review comments.
//!
//! The snapshot lives on the scheduled row (`commentsSnapshot`, an
//! [`ScheduledReviewPayload`]); the comment rows are deleted in the same
//! transaction that inserts the row. What happens to the snapshot afterwards:
//! a Rich Chat fire adopts it into a turn hold, a Terminal fire pastes
//! it ([`crate::terminal::review_paste_body`]), cancel / failure puts it back in
//! the panel (the route or the outcome observer), Retry re-holds what is still
//! there ([`ReviewHandle::rehold_schedule_impl`]).

use vst_store::comment_consumers::{Consumer, ScheduleSpec, TakeLimits};
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    DeletedReason, ReviewError, ScheduleTake, RICH_SEND_MAX_BYTES, RICH_SEND_MAX_COMMENTS,
    TERMINAL_SEND_MAX_BYTES,
};

use crate::service::ReviewHandle;

fn internal(e: impl std::fmt::Display) -> ReviewError {
    ReviewError::Internal(e.to_string())
}

impl ReviewHandle {
    /// Take the comments into a new scheduled row (see [`ScheduleTake`]).
    pub async fn take_for_schedule_impl(&self, req: ScheduleTake) -> Result<(), ReviewError> {
        let name = self
            .scope_label(&req.scope)
            .await
            .ok_or(ReviewError::NotFound)?;
        let composer = self
            .resolve_composer(&req.scope, &req.comment_ids, req.composer_key.as_deref())
            .await?;
        // Terminal rows paste the message plus the block: the block gets what the
        // message leaves of the 32 KB cap (the fire-time check stays for rows that
        // meet a channel toggle later).
        let tmux = req.channel == "tmux";
        let max_bytes = if tmux {
            vst_types::review_format::block_budget(TERMINAL_SEND_MAX_BYTES, &req.message)
        } else {
            RICH_SEND_MAX_BYTES
        };
        if tmux && req.message.trim_end().len() >= TERMINAL_SEND_MAX_BYTES {
            return Err(ReviewError::TooLarge {
                limit: u32::try_from(TERMINAL_SEND_MAX_BYTES).unwrap_or(u32::MAX),
                unit: "bytes",
            });
        }
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
                    max_bytes,
                },
                Consumer::Schedule(ScheduleSpec {
                    id: req.row_id.clone(),
                    session_id: req.session_id.clone(),
                    message: req.message,
                    fire_at: req.fire_at,
                    now: req.now,
                    channel: Some(req.channel),
                    attachments: req.attachments,
                }),
            )
            .await
            .map_err(internal)?
            .map_err(|e| {
                if tmux {
                    crate::terminal::cap_limit(e)
                } else {
                    e
                }
            })?;
        self.push_deleted(&req.scope, &taken.deleted, DeletedReason::Scheduled);
        tracing::info!(
            row = %req.row_id,
            session = %req.session_id,
            count = taken.snapshots.len(),
            "[vst] review comments scheduled"
        );
        Ok(())
    }

    /// Retry of a failed scheduled row: re-hold the comments of its restored
    /// snapshot that are still in the panel. Returns how many were re-held.
    pub async fn rehold_schedule_impl(&self, row_id: &str) -> Result<u32, ReviewError> {
        let row = self
            .0
            .store
            .get_scheduled_message(row_id)
            .await
            .map_err(internal)?
            .ok_or(ReviewError::NotFound)?;
        let Some(payload) = crate::terminal_text::parse_row_payload(&row) else {
            return Ok(0);
        };
        let scope = ScopeKey {
            scope_kind: payload.scope_kind,
            scope_id: payload.scope_id.clone(),
        };
        let name = self
            .scope_label(&scope)
            .await
            .unwrap_or(payload.name.clone());
        let max_bytes = if row.channel.as_deref() == Some("tmux") {
            vst_types::review_format::block_budget(TERMINAL_SEND_MAX_BYTES, &row.message)
        } else {
            RICH_SEND_MAX_BYTES
        };
        let held = self
            .0
            .store
            .rehold_failed_schedule_row(
                row_id,
                &name,
                TakeLimits {
                    max_comments: RICH_SEND_MAX_COMMENTS,
                    max_bytes,
                },
            )
            .await
            .map_err(internal)??;
        let Some(deleted) = held else { return Ok(0) };
        if deleted.is_empty() && row.message.trim().is_empty() && row.attachments.is_none() {
            // Nothing of its own and nothing left to send.
            return Err(ReviewError::Changed { remaining: 0 });
        }
        self.push_deleted(&scope, &deleted, DeletedReason::Scheduled);
        Ok(u32::try_from(deleted.len()).unwrap_or(u32::MAX))
    }
}
