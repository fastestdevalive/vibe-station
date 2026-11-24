use std::path::Path;
use std::time::Duration;

use vst_store::transcript::AroundPage;
use vst_store::transcript_search::{SearchError, SearchOutcome, SearchRequest, BACKFILL_BUDGET};

use super::backfill::backfill_within;
use super::{with_disk_store, with_disk_store_mut, JsonAgentSession};

impl JsonAgentSession {
    /// Search the session transcript, advancing the lazy backfill under a
    /// time budget. The store mutex is released between backfill chunks.
    pub fn search_transcript(&self, req: &SearchRequest) -> Result<SearchOutcome, SearchError> {
        self.search_inner(req, BACKFILL_BUDGET, || {})
    }

    /// Test seam over the production search path: a custom budget, and a
    /// callback run between backfill steps that receives whether the store lock
    /// was free at that point.
    #[doc(hidden)]
    pub fn search_transcript_for_test(
        &self,
        req: &SearchRequest,
        budget: Duration,
        mut between: impl FnMut(bool),
    ) -> Result<SearchOutcome, SearchError> {
        self.search_inner(req, budget, || {
            // Evaluated first: the probe guard must not outlive it into `between`.
            let lock_free = self.0.store.try_lock().is_ok();
            between(lock_free);
        })
    }

    fn search_inner(
        &self,
        req: &SearchRequest,
        budget: Duration,
        between: impl FnMut(),
    ) -> Result<SearchOutcome, SearchError> {
        // One lease across every backfill step and the final read: the slot lock is
        // taken per step, but the store is opened once.
        let _lease = self.lease_store().ok();
        backfill_within(
            budget,
            || {
                let mut guard = self.0.store.lock().unwrap();
                let Some(store) = guard.store.as_mut() else {
                    return Ok(true);
                };
                let sid = store.session_id().to_string();
                store.backfill_step().map_err(|e| {
                    tracing::warn!(session_id = %sid, "backfill_step failed: {e}");
                    SearchError::Db(e)
                })
            },
            between,
        )?;

        let mut guard = self.0.store.lock().unwrap();
        let Some(store) = guard.store.as_mut() else {
            return Ok(SearchOutcome::empty(req.q.clone()));
        };
        store.search(req)
    }

    /// Turn-aligned window around `seq` within `max_bytes`.
    pub fn page_around(
        &self,
        seq: i64,
        n_turns: i64,
        max_bytes: usize,
    ) -> rusqlite::Result<AroundPage> {
        self.with_store(
            |st| st.page_around(seq, n_turns, max_bytes),
            Ok(AroundPage::default()),
        )
    }
}

/// Search a session's transcript from disk (no live session).
pub fn search_from_data_dir(
    data_dir: &Path,
    session_id: &str,
    req: &SearchRequest,
) -> Result<SearchOutcome, SearchError> {
    with_disk_store_mut(
        data_dir,
        session_id,
        |store| {
            backfill_within(
                BACKFILL_BUDGET,
                || {
                    store.backfill_step().map_err(|e| {
                        tracing::warn!(session_id = %session_id, "backfill_step failed: {e}");
                        SearchError::Db(e)
                    })
                },
                || {},
            )?;
            store.search(req)
        },
        Ok(SearchOutcome::empty(req.q.clone())),
    )
}

/// Turn-aligned window around `seq` from disk (no live session).
pub fn read_page_around_from_data_dir(
    data_dir: &Path,
    session_id: &str,
    seq: i64,
    n_turns: i64,
    max_bytes: usize,
) -> rusqlite::Result<AroundPage> {
    with_disk_store(
        data_dir,
        session_id,
        |s| s.page_around(seq, n_turns, max_bytes),
        Ok(AroundPage::default()),
    )
}
