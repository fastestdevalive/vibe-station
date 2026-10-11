//! Merge policy for probe results — when a definitive state replaces the
//! cached value vs. when a transient `error` keeps the last good numbers.

use vst_types::{LimitStatus, LimitWindow, LimitsResult};

/// Merge a fresh probe result into the previously cached one.
///
/// Decision 3: a non-`error` result is definitive and replaces `prev` entirely.
/// An `error` result keeps `prev`'s windows that have a `used_pct` (dimmed:
/// their status rewritten to `error`, original `as_of` kept) alongside the new
/// `message`, and only blanks everything when `prev` had nothing worth keeping.
pub fn merge_result(prev: Option<&LimitsResult>, new: LimitsResult) -> LimitsResult {
    if new.status != LimitStatus::Error {
        return new; // definitive states replace
    }
    let Some(prev) = prev else { return new };
    let kept: Vec<LimitWindow> = prev
        .windows
        .iter()
        .filter(|w| w.used_pct.is_some())
        .cloned()
        .map(|mut w| {
            w.status = LimitStatus::Error;
            w
        })
        .collect();
    if kept.is_empty() {
        return new;
    }
    LimitsResult {
        windows: kept,
        as_of: prev.as_of.clone(),
        ..new
    }
}

/// Equal ignoring every `as_of` field (result + windows).
pub fn results_equivalent(a: &LimitsResult, b: &LimitsResult) -> bool {
    if a.harness != b.harness
        || a.status != b.status
        || a.message != b.message
        || a.windows.len() != b.windows.len()
    {
        return false;
    }
    a.windows.iter().zip(b.windows.iter()).all(|(x, y)| {
        x.window_id == y.window_id
            && x.cadence_minutes == y.cadence_minutes
            && x.used_pct == y.used_pct
            && x.resets_at == y.resets_at
            && x.status == y.status
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::{LimitSlotRef, LimitWindow};

    fn window(
        harness: &str,
        id: &str,
        used_pct: Option<f64>,
        status: LimitStatus,
        as_of: &str,
    ) -> LimitWindow {
        LimitWindow {
            harness: harness.into(),
            window_id: id.into(),
            cadence_minutes: Some(300),
            used_pct,
            resets_at: Some("2026-10-11T02:10:00.386Z".into()),
            as_of: as_of.into(),
            status,
        }
    }

    fn ok_result(harness: &str, as_of: &str) -> LimitsResult {
        LimitsResult {
            harness: harness.into(),
            status: LimitStatus::Ok,
            message: None,
            as_of: as_of.into(),
            windows: vec![window(
                harness,
                "five_hour",
                Some(21.0),
                LimitStatus::Ok,
                as_of,
            )],
        }
    }

    #[test]
    fn error_keeps_last_good_windows_dimmed() {
        let prev = ok_result("claude", "2026-10-11T00:00:00.000Z");
        let new = LimitsResult {
            harness: "claude".into(),
            status: LimitStatus::Error,
            message: Some("probe timed out".into()),
            as_of: "2026-10-11T00:05:00.000Z".into(),
            windows: vec![],
        };
        let merged = merge_result(Some(&prev), new);
        assert_eq!(merged.status, LimitStatus::Error);
        assert_eq!(merged.message.as_deref(), Some("probe timed out"));
        assert_eq!(merged.as_of, "2026-10-11T00:00:00.000Z", "as_of from prev");
        assert_eq!(merged.windows.len(), 1);
        assert_eq!(merged.windows[0].used_pct, Some(21.0));
        assert_eq!(merged.windows[0].status, LimitStatus::Error);
        assert_eq!(merged.windows[0].as_of, "2026-10-11T00:00:00.000Z");
    }

    #[test]
    fn error_without_prev_returns_new() {
        let new = LimitsResult {
            harness: "codex".into(),
            status: LimitStatus::Error,
            message: Some("probe timed out".into()),
            as_of: "2026-10-11T00:05:00.000Z".into(),
            windows: vec![],
        };
        let merged = merge_result(None, new.clone());
        assert_eq!(merged, new);
    }

    #[test]
    fn signed_out_replaces_prev_entirely() {
        let prev = ok_result("claude", "2026-10-11T00:00:00.000Z");
        let new = LimitsResult {
            harness: "claude".into(),
            status: LimitStatus::SignedOut,
            message: Some("signed out".into()),
            as_of: "2026-10-11T00:05:00.000Z".into(),
            windows: vec![window(
                "claude",
                "five_hour",
                None,
                LimitStatus::SignedOut,
                "2026-10-11T00:05:00.000Z",
            )],
        };
        let merged = merge_result(Some(&prev), new.clone());
        assert_eq!(merged, new, "definitive state replaces entirely");
        assert_eq!(merged.windows[0].used_pct, None);
    }

    #[test]
    fn equivalent_ignores_as_of() {
        let a = ok_result("claude", "2026-10-11T00:00:00.000Z");
        let b = ok_result("claude", "2026-10-11T00:30:00.000Z");
        assert!(results_equivalent(&a, &b));
    }

    #[test]
    fn not_equivalent_when_pct_changes() {
        let a = ok_result("claude", "2026-10-11T00:00:00.000Z");
        let mut b = ok_result("claude", "2026-10-11T00:30:00.000Z");
        b.windows[0].used_pct = Some(22.0);
        assert!(!results_equivalent(&a, &b));
    }

    #[test]
    fn slot_ref_key_roundtrip() {
        let s = LimitSlotRef::new("claude", "five_hour");
        assert_eq!(s.to_key(), "claude/five_hour");
        assert_eq!(LimitSlotRef::from_key("claude/five_hour"), Some(s));
        assert_eq!(LimitSlotRef::from_key("claude/five/hour"), None);
        assert_eq!(LimitSlotRef::from_key("/five_hour"), None);
        assert_eq!(LimitSlotRef::from_key("claude/"), None);
        assert_eq!(LimitSlotRef::from_key("no-slash"), None);
    }
}
