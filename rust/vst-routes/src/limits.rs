//! Harness usage-limit routes — thin, stateless handlers over `LimitsHandle`.
//!
//! Owns nothing: all cache/timer/backoff state lives in the injected
//! `vst_harness_limits::LimitsHandle`. This module only validates, persists,
//! and serialises the slot prefs (in `user_ordered_lists` scope `limits-slots`)
//! and maps the handle's calls onto REST shapes.

use vst_harness_limits::LimitsHandle;
use vst_store::StoreHandle;
use vst_types::limits::{
    default_slots, LimitSlotRef, LimitsRefreshResult, LimitsSnapshot, PutLimitSlotsBody,
};

/// `user_ordered_lists` scope key holding the two pinned limit slots.
pub const LIMITS_SLOTS_SCOPE: &str = "limits-slots";

/// Errors surfaced by the limits routes.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LimitsRouteError {
    #[error("validation_error: {0}")]
    Validation(String),
}

/// Handler bundle for `/limits`, `/limits/refresh`, `/limits/slots`.
#[derive(Clone)]
pub struct LimitsRoutes {
    limits: LimitsHandle,
    store: StoreHandle,
}

impl LimitsRoutes {
    pub fn new(limits: LimitsHandle, store: StoreHandle) -> Self {
        Self { limits, store }
    }

    /// `GET /limits` — returns the cache, kicks a background stale refresh.
    pub fn get_limits(&self) -> LimitsSnapshot {
        self.limits.note_client_fetch();
        self.limits.snapshot()
    }

    /// `POST /limits/refresh` — awaits the probes (bounded by the scheduler),
    /// returns whether they started and the resulting snapshot.
    pub async fn refresh(&self) -> LimitsRefreshResult {
        let outcome = self.limits.refresh_manual().await;
        LimitsRefreshResult {
            started: outcome.started,
            retry_after_secs: outcome.retry_after_secs,
            snapshot: self.limits.snapshot(),
        }
    }

    /// `PUT /limits/slots` — validate, persist, then `set_slots` (which
    /// broadcasts `limits:updated`).
    pub async fn put_slots(
        &self,
        body: PutLimitSlotsBody,
    ) -> Result<LimitsSnapshot, LimitsRouteError> {
        let slots = validate_slots(&body.slots)?;
        let keys: Vec<String> = slots.iter().map(|s| s.to_key()).collect();
        self.store.set_ordered_list(LIMITS_SLOTS_SCOPE, keys).await;
        Ok(self.limits.set_slots(slots))
    }

    /// Used by `run.rs` at boot: read persisted slots, falling back to
    /// `default_slots()` when absent/corrupt.
    pub async fn load_slots(store: &StoreHandle) -> [LimitSlotRef; 2] {
        let list = store.get_ordered_list(LIMITS_SLOTS_SCOPE).await;
        if list.item_ids.len() != 2 {
            return default_slots();
        }
        let mut parsed: Vec<LimitSlotRef> = Vec::new();
        for key in &list.item_ids {
            match LimitSlotRef::from_key(key) {
                Some(slot) => parsed.push(slot),
                None => return default_slots(),
            }
        }
        if parsed.len() == 2 && parsed[0] != parsed[1] {
            [parsed[0].clone(), parsed[1].clone()]
        } else {
            default_slots()
        }
    }
}

/// Validate the two-slot body per the API contract.
fn validate_slots(slots: &[LimitSlotRef]) -> Result<[LimitSlotRef; 2], LimitsRouteError> {
    if slots.len() != 2 {
        return Err(LimitsRouteError::Validation(
            "slots must contain exactly 2 entries".to_string(),
        ));
    }
    if slots.iter().any(|s| {
        s.harness.is_empty()
            || s.window_id.is_empty()
            || s.harness.contains('/')
            || s.window_id.contains('/')
    }) {
        return Err(LimitsRouteError::Validation(
            "harness and windowId must be non-empty and contain no '/'".to_string(),
        ));
    }
    if slots[0] == slots[1] {
        return Err(LimitsRouteError::Validation(
            "slots must be different".to_string(),
        ));
    }
    Ok([slots[0].clone(), slots[1].clone()])
}
