//! Deriving the "account limited" state from the two sources of Decision 10.
//!
//! The only writer of that state is `AccountsHandle::set_limited`; this module
//! is the pure mapping it feeds:
//! * the limits poller — a window at >= 100% with a reset time still in the
//!   future means limited; a read below 100% or a reset time in the past clears
//!   it;
//! * a structured chat signal — `rejected` or >= 100% means limited.

use vst_types::{
    AccountAuth, AccountIdentity, AccountLimited, LimitSignal, LimitStatus, LimitedSource,
    LimitsResult,
};

/// The window of `result` that marks the account limited right now, if any.
#[must_use]
pub fn from_result(result: &LimitsResult, now_iso: &str) -> Option<AccountLimited> {
    result
        .windows
        .iter()
        .find(|w| is_full_and_pending(w.used_pct, w.resets_at.as_deref(), now_iso))
        .map(|w| AccountLimited {
            window_id: w.window_id.clone(),
            resets_at: w.resets_at.clone(),
            source: LimitedSource::Poller,
        })
}

/// Whether a window is at/over 100% with a reset time still in the future.
/// ISO8601 UTC strings compare lexicographically.
fn is_full_and_pending(used_pct: Option<f64>, resets_at: Option<&str>, now_iso: &str) -> bool {
    used_pct.is_some_and(|p| p >= 100.0) && resets_at.is_some_and(|r| r > now_iso)
}

/// The "limited" state a structured chat event implies (`None` = clear).
#[must_use]
pub fn from_signal(signal: &LimitSignal) -> Option<AccountLimited> {
    (signal.rejected || signal.used_pct >= 100.0).then(|| AccountLimited {
        window_id: signal.window_id.clone(),
        resets_at: signal.resets_at.clone(),
        source: LimitedSource::Chat,
    })
}

/// Whether a limits read should trigger the plugin's identity command. A limits
/// read is only a TRIGGER, never the decision (Decision 12).
#[must_use]
pub fn needs_identity_check(result: &LimitsResult) -> bool {
    matches!(
        result.status,
        LimitStatus::SignedOut | LimitStatus::NoPlanLimits
    )
}

/// Map an identity read onto an auth value; `None` (unknown) changes nothing.
#[must_use]
pub fn auth_from_identity(identity: &AccountIdentity) -> Option<AccountAuth> {
    match identity.signed_in {
        Some(true) => Some(AccountAuth::SignedIn),
        Some(false) => Some(AccountAuth::SignedOut),
        None => None,
    }
}
