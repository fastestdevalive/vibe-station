//! The session's transcript store, open only while leased.
//!
//! One lease count on the store slot: the first lease opens `messages.db`, the
//! last one dropped closes it, so a session at rest holds no file descriptors
//! and at most one connection exists per session. A running drain holds a lease
//! for the whole turn; every other access is [`JsonAgentSession::with_store`]
//! (one lease around one closure), and chunked loops hold one lease across
//! their steps while still locking the slot per step.
//!
//! Rules: a [`StoreLease`] is a LOCAL value, never kept in `State`; never drop
//! one while the slot lock or the `state` lock is held (the last drop takes the
//! slot lock); never call `with_store`/`lease_store` from inside a `with_store`
//! closure (the slot mutex is not re-entrant).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use vst_store::transcript::{open_transcript_store, TranscriptStore};

use super::{Inner, JsonAgentSession};

/// `Inner.store`: the open store and how many leases keep it open.
/// Invariant: `store.is_some()` exactly when `leases > 0` (the first lease
/// opens, the last drop closes), so there is no separate "dispose" step.
#[derive(Default)]
pub(crate) struct StoreSlot {
    pub(super) store: Option<TranscriptStore>,
    leases: usize,
}

/// Keeps the session's store open until dropped.
pub struct StoreLease(Arc<Inner>);

impl Drop for StoreLease {
    fn drop(&mut self) {
        let mut slot = self.0.store.lock().unwrap_or_else(|e| e.into_inner());
        slot.leases = slot.leases.saturating_sub(1);
        if slot.leases == 0 {
            if let Some(store) = slot.store.take() {
                store.close();
            }
        }
    }
}

impl JsonAgentSession {
    /// Open the store (if not already open) and keep it open while the lease lives.
    ///
    /// # Errors
    /// The transcript database could not be opened.
    pub fn lease_store(&self) -> Result<StoreLease, String> {
        if self.0.fail_store_opens.load(Ordering::SeqCst) {
            return Err("transcript store open disabled (test)".to_string());
        }
        let mut slot = self.0.store.lock().unwrap_or_else(|e| e.into_inner());
        if slot.leases == 0 {
            slot.store = Some(
                open_transcript_store(&self.0.data_dir, &self.0.session_id)
                    .map_err(|e| e.to_string())?,
            );
        }
        slot.leases += 1;
        Ok(StoreLease(self.0.clone()))
    }

    /// Run `f` on the store under one lease; `fallback` when it cannot be opened.
    pub(super) fn with_store<T>(
        &self,
        f: impl FnOnce(&mut TranscriptStore) -> T,
        fallback: T,
    ) -> T {
        let lease = match self.lease_store() {
            Ok(lease) => lease,
            Err(e) => {
                tracing::warn!(session_id = %self.0.session_id, error = %e, "[json-agent] transcript open failed; using the fallback");
                return fallback;
            }
        };
        let out = {
            let mut slot = self.0.store.lock().unwrap_or_else(|e| e.into_inner());
            slot.store.as_mut().map_or(fallback, f)
        };
        drop(lease);
        out
    }

    /// Test-only: make every later store open fail, so the next row write is
    /// not persisted (the failure `persist_turn_row` reports as `false`).
    #[doc(hidden)]
    pub fn fail_store_opens_for_test(&self) {
        self.0.fail_store_opens.store(true, Ordering::SeqCst);
    }

    /// Test-only: whether the transcript database is open right now.
    #[doc(hidden)]
    pub fn store_is_open_for_test(&self) -> bool {
        self.0
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .store
            .is_some()
    }

    /// Test-only: whether an ACP child connection exists.
    #[doc(hidden)]
    pub fn has_live_connection_for_test(&self) -> bool {
        self.0.state.lock().unwrap().connection.is_some()
    }
}
