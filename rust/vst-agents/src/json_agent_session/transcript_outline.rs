//! Whole-chat outline reads: the live session's store, or the store on disk.
//! Every read first catches the persisted index up within a budget; a failed
//! catch-up answers "not ready" instead of an error.

use std::path::Path;
use std::time::Duration;

use vst_store::transcript::TranscriptStore;
use vst_store::transcript_outline::{OutlineSummary, OutlineWindow};

use super::backfill::backfill_within;
use super::{with_disk_store_mut, JsonAgentSession};

/// Time one read may spend catching the outline index up.
const OUTLINE_BUILD_BUDGET: Duration = Duration::from_secs(8);

fn catch_up_within(step: impl FnMut() -> rusqlite::Result<bool>) {
    if let Err(e) = backfill_within(OUTLINE_BUILD_BUDGET, step, || {}) {
        tracing::warn!("[outline] catch-up failed; index stays not ready: {e}");
    }
}

impl JsonAgentSession {
    /// The live session's outline summary; the store lock is taken per catch-up step.
    pub fn outline_summary(&self) -> rusqlite::Result<Option<OutlineSummary>> {
        self.catch_up_outline();
        let guard = self.0.store.lock().unwrap();
        guard.as_ref().map_or_else(
            || Ok(Some(OutlineSummary::empty())),
            TranscriptStore::outline_summary,
        )
    }

    /// The live session's outline window from turn index `from`.
    pub fn outline_window(
        &self,
        from: i64,
        limit: usize,
    ) -> rusqlite::Result<Option<OutlineWindow>> {
        self.catch_up_outline();
        let guard = self.0.store.lock().unwrap();
        guard.as_ref().map_or_else(
            || Ok(Some(OutlineWindow::empty(from))),
            |st| st.outline_window(from, limit),
        )
    }

    fn catch_up_outline(&self) {
        catch_up_within(|| {
            let mut guard = self.0.store.lock().unwrap();
            guard
                .as_mut()
                .map_or(Ok(true), TranscriptStore::catch_up_step)
        });
    }
}

/// The outline summary of a session from disk (no live session).
pub fn outline_summary_from_data_dir(
    data_dir: &Path,
    session_id: &str,
) -> rusqlite::Result<Option<OutlineSummary>> {
    with_disk_store_mut(
        data_dir,
        session_id,
        |store| {
            catch_up_within(|| store.catch_up_step());
            store.outline_summary()
        },
        Ok(Some(OutlineSummary::empty())),
    )
}

/// The outline window of a session from disk (no live session).
pub fn outline_window_from_data_dir(
    data_dir: &Path,
    session_id: &str,
    from: i64,
    limit: usize,
) -> rusqlite::Result<Option<OutlineWindow>> {
    with_disk_store_mut(
        data_dir,
        session_id,
        |store| {
            catch_up_within(|| store.catch_up_step());
            store.outline_window(from, limit)
        },
        Ok(Some(OutlineWindow::empty(from))),
    )
}
