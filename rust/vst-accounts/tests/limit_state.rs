//! Limit-state derivation tests (Decision 10/12).

mod common;

use vst_accounts::limit_state::{
    auth_from_identity, from_result, from_signal, needs_identity_check,
};
use vst_types::{
    AccountAuth, AccountIdentity, AccountLimited, LimitSignal, LimitStatus, LimitWindow,
    LimitedSource, LimitsResult,
};

fn window(id: &str, used: Option<f64>, resets_at: Option<&str>) -> LimitWindow {
    LimitWindow {
        harness: "fakecli".into(),
        window_id: id.into(),
        account_id: None,
        cadence_minutes: None,
        used_pct: used,
        resets_at: resets_at.map(str::to_string),
        as_of: "2026-01-01T00:00:00Z".into(),
        status: LimitStatus::Ok,
        label: None,
        dollars: None,
    }
}

fn result(status: LimitStatus, windows: Vec<LimitWindow>) -> LimitsResult {
    LimitsResult {
        harness: "fakecli".into(),
        account_id: None,
        status,
        message: None,
        as_of: "2026-01-01T00:00:00Z".into(),
        windows,
    }
}

const NOW: &str = "2026-01-01T00:00:00Z";

#[test]
fn limit_state_from_result() {
    let full = result(
        LimitStatus::Ok,
        vec![window(
            "five_hour",
            Some(100.0),
            Some("2026-01-01T05:00:00Z"),
        )],
    );
    assert_eq!(
        from_result(&full, NOW),
        Some(AccountLimited {
            window_id: "five_hour".into(),
            resets_at: Some("2026-01-01T05:00:00Z".into()),
            source: LimitedSource::Poller,
        })
    );

    let nearly = result(
        LimitStatus::Ok,
        vec![window(
            "five_hour",
            Some(99.0),
            Some("2026-01-01T05:00:00Z"),
        )],
    );
    assert_eq!(from_result(&nearly, NOW), None);

    let reset_passed = result(
        LimitStatus::Ok,
        vec![window(
            "five_hour",
            Some(100.0),
            Some("2025-12-31T00:00:00Z"),
        )],
    );
    assert_eq!(
        from_result(&reset_passed, NOW),
        None,
        "a past reset clears it"
    );

    let no_reset = result(
        LimitStatus::Ok,
        vec![window("five_hour", Some(100.0), None)],
    );
    assert_eq!(
        from_result(&no_reset, NOW),
        None,
        "no reset time cannot be limited"
    );
}

#[test]
fn needs_identity_check_only_for_signed_out_and_no_plan_limits() {
    assert!(needs_identity_check(&result(
        LimitStatus::SignedOut,
        vec![]
    )));
    assert!(needs_identity_check(&result(
        LimitStatus::NoPlanLimits,
        vec![]
    )));
    assert!(!needs_identity_check(&result(LimitStatus::Ok, vec![])));
    assert!(!needs_identity_check(&result(LimitStatus::NoData, vec![])));
    assert!(!needs_identity_check(&result(LimitStatus::Error, vec![])));
    assert!(!needs_identity_check(&result(
        LimitStatus::NotInstalled,
        vec![]
    )));
}

#[test]
fn auth_from_identity_maps_signed_in_states() {
    let signed_in = AccountIdentity {
        signed_in: Some(true),
        ..AccountIdentity::default()
    };
    let signed_out = AccountIdentity {
        signed_in: Some(false),
        ..AccountIdentity::default()
    };
    assert_eq!(auth_from_identity(&signed_in), Some(AccountAuth::SignedIn));
    assert_eq!(
        auth_from_identity(&signed_out),
        Some(AccountAuth::SignedOut)
    );
    assert_eq!(auth_from_identity(&AccountIdentity::default()), None);
}

#[test]
fn limit_state_from_signal() {
    let rejected = LimitSignal {
        window_id: "five_hour".into(),
        used_pct: 42.0,
        resets_at: Some("2026-01-01T05:00:00Z".into()),
        rejected: true,
    };
    assert_eq!(
        from_signal(&rejected),
        Some(AccountLimited {
            window_id: "five_hour".into(),
            resets_at: Some("2026-01-01T05:00:00Z".into()),
            source: LimitedSource::Chat,
        })
    );
    let full = LimitSignal {
        window_id: "seven_day".into(),
        used_pct: 100.0,
        resets_at: None,
        rejected: false,
    };
    assert_eq!(
        from_signal(&full).map(|l| l.source),
        Some(LimitedSource::Chat)
    );
    let fine = LimitSignal {
        window_id: "seven_day".into(),
        used_pct: 99.9,
        resets_at: None,
        rejected: false,
    };
    assert_eq!(from_signal(&fine), None, "below 100% clears it");
}
