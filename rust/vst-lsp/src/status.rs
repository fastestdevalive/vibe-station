pub use vst_types::rest::lsp::LspStatus;

use vst_types::rest::lsp::{
    LspAction, LspFailure, LspFailureKind, LspSeverity, LspStatusPresentation,
};

use crate::registry;

/// Single source of truth for what an `LspStatus` (+ optional detected
/// `language`) means to a human: label word, display language name,
/// dot-severity, detail sentence, and click action. Every consumer (global
/// bottom bar, tools-pane side panel, per-language popup rows) renders these
/// fields — none of them re-derive text/color/action from the raw enum.
pub fn describe(status: LspStatus, language: Option<&str>) -> LspStatusPresentation {
    let display_name = language.and_then(|lang| {
        registry::lookup_by_language(lang).map(|cfg| cfg.display_name.to_string())
    });

    let (label, severity, detail, action, action_label): (
        &str,
        LspSeverity,
        String,
        Option<LspAction>,
        Option<&str>,
    ) = match status {
        LspStatus::Ready => (
            "Ready",
            LspSeverity::Ok,
            "LSP: ready".to_string(),
            None,
            None,
        ),
        LspStatus::Starting => (
            "Starting",
            LspSeverity::Warn,
            "LSP: starting…".to_string(),
            None,
            None,
        ),
        LspStatus::Indexing => (
            "Indexing",
            LspSeverity::Warn,
            "LSP: indexing…".to_string(),
            None,
            None,
        ),
        LspStatus::Idle => (
            "Idle",
            LspSeverity::Neutral,
            "LSP: idle".to_string(),
            Some(LspAction::Resume),
            Some("Resume"),
        ),
        LspStatus::Stopped => (
            "Stopped",
            LspSeverity::Neutral,
            "LSP: stopped — click to resume".to_string(),
            Some(LspAction::Resume),
            Some("Resume"),
        ),
        LspStatus::Disabled => (
            "Disabled",
            LspSeverity::Neutral,
            "LSP is disabled for this workspace — click to enable.".to_string(),
            Some(LspAction::Enable),
            Some("Enable"),
        ),
        LspStatus::NotFound => {
            let detail = match &display_name {
                Some(name) => format!("LSP: not available for {name} — server not found on host"),
                None => "LSP: not available — server not found on host".to_string(),
            };
            // Neutral, not Warn — "server not installed on host" is a steady-state fact about
            // this host, not a transient condition like Starting/Indexing (also Warn). Matches
            // the pre-consolidation frontend, which colored this state gray.
            ("Unavailable", LspSeverity::Neutral, detail, None, None)
        }
        LspStatus::Unsupported => {
            // `LspManager::status` only ever returns `Unsupported` with `language: None` (no
            // language was detected at all), so `display_name` is always `None` here in
            // practice — this arm intentionally ignores it rather than branching on a case
            // that can't be reached, to avoid implying a "not available for X" message that
            // would never actually show.
            (
                "N/A",
                LspSeverity::Neutral,
                "LSP: unsupported file type".to_string(),
                None,
                None,
            )
        }
        LspStatus::Error => (
            "Error",
            LspSeverity::Error,
            "LSP: server error".to_string(),
            None,
            None,
        ),
    };

    LspStatusPresentation {
        label: label.to_string(),
        display_name,
        severity,
        detail,
        action,
        action_label: action_label.map(|s| s.to_string()),
    }
}

/// Presentation for a latched start failure (`status == Error` with a
/// `failure`). Dependency kinds are a steady, user-fixable setup fact → yellow
/// "Setup needed", not red; a crash the daemon is still auto-restarting reads
/// "Restarting". `detail` is always the failure's own summary.
pub fn describe_failure(failure: &LspFailure, language: Option<&str>) -> LspStatusPresentation {
    let base = describe(LspStatus::Error, language);
    let retry = (Some(LspAction::Retry), Some("Retry".to_string()));
    let (label, severity, (action, action_label)) = match failure.kind {
        LspFailureKind::MissingDependency | LspFailureKind::IncompatibleDependency => {
            ("Setup needed", LspSeverity::Warn, retry)
        }
        LspFailureKind::Crashed if failure.auto_retry => {
            ("Restarting", LspSeverity::Warn, (None, None))
        }
        _ => ("Error", LspSeverity::Error, retry),
    };
    LspStatusPresentation {
        label: label.to_string(),
        severity,
        detail: failure.summary.clone(),
        action,
        action_label,
        ..base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::rest::lsp::{LspRemediation, LspRemediationKind};

    const ALL_FAILURE_KINDS: [LspFailureKind; 7] = [
        LspFailureKind::MissingDependency,
        LspFailureKind::IncompatibleDependency,
        LspFailureKind::InitFailed,
        LspFailureKind::ExitedOnStart,
        LspFailureKind::InitTimeout,
        LspFailureKind::Crashed,
        LspFailureKind::SpawnFailed,
    ];

    fn failure(kind: LspFailureKind, auto_retry: bool) -> LspFailure {
        LspFailure {
            kind,
            summary: format!("summary for {kind:?}"),
            message: None,
            exit_code: None,
            remediation: vec![LspRemediation {
                kind: LspRemediationKind::Retry,
                label: "Retry".into(),
                command: None,
            }],
            auto_retry,
        }
    }

    #[test]
    fn failure_presentation_labels_severities_and_actions() {
        for kind in ALL_FAILURE_KINDS {
            let f = failure(kind, false);
            let p = describe_failure(&f, Some("typescript"));
            assert_eq!(p.detail, f.summary, "{kind:?}: detail == summary");
            assert_eq!(p.display_name.as_deref(), Some("TypeScript / JavaScript"));
            let (label, severity) = match kind {
                LspFailureKind::MissingDependency | LspFailureKind::IncompatibleDependency => {
                    ("Setup needed", LspSeverity::Warn)
                }
                _ => ("Error", LspSeverity::Error),
            };
            assert_eq!(p.label, label, "{kind:?}");
            assert_eq!(p.severity, severity, "{kind:?}");
            assert_eq!(p.action, Some(LspAction::Retry), "{kind:?}");
            assert_eq!(p.action_label.as_deref(), Some("Retry"));
        }
        let p = describe_failure(&failure(LspFailureKind::Crashed, true), Some("rust"));
        assert_eq!(
            (p.label.as_str(), p.severity, p.action),
            ("Restarting", LspSeverity::Warn, None)
        );
        // Re-probing dependency failures are also `auto_retry` — still Setup needed.
        let p = describe_failure(&failure(LspFailureKind::MissingDependency, true), None);
        assert_eq!(p.label, "Setup needed");
        assert_eq!(p.action, Some(LspAction::Retry));
    }

    #[test]
    fn failure_presentation_serializes_retry_action() {
        let p = describe_failure(&failure(LspFailureKind::InitFailed, false), Some("rust"));
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["action"], "retry");
        assert_eq!(v["actionLabel"], "Retry");
        assert_eq!(v["severity"], "error");
    }

    const ALL_STATUSES: [LspStatus; 9] = [
        LspStatus::Unsupported,
        LspStatus::NotFound,
        LspStatus::Starting,
        LspStatus::Indexing,
        LspStatus::Ready,
        LspStatus::Idle,
        LspStatus::Stopped,
        LspStatus::Error,
        LspStatus::Disabled,
    ];

    #[test]
    fn every_state_has_a_non_null_detail() {
        for status in ALL_STATUSES {
            let p = describe(status, None);
            assert!(
                !p.detail.is_empty(),
                "{status:?} produced empty detail with no language"
            );
            let p = describe(status, Some("rust"));
            assert!(
                !p.detail.is_empty(),
                "{status:?} produced empty detail with a language"
            );
        }
    }

    #[test]
    fn disabled_gets_enable_action_stopped_and_idle_get_resume_others_none() {
        assert_eq!(
            describe(LspStatus::Disabled, None).action,
            Some(LspAction::Enable)
        );
        assert_eq!(
            describe(LspStatus::Stopped, Some("rust")).action,
            Some(LspAction::Resume)
        );
        assert_eq!(
            describe(LspStatus::Idle, Some("rust")).action,
            Some(LspAction::Resume)
        );
        for status in [
            LspStatus::Ready,
            LspStatus::Starting,
            LspStatus::Indexing,
            LspStatus::NotFound,
            LspStatus::Unsupported,
            LspStatus::Error,
        ] {
            assert_eq!(
                describe(status, Some("rust")).action,
                None,
                "{status:?} should have no action"
            );
        }
    }

    #[test]
    fn not_found_and_unsupported_are_neutral_not_warn() {
        // Regression guard: these are steady-state "not on this host" facts, not transient
        // busy-states like Starting/Indexing (which ARE Warn) — see the comment in `describe()`.
        assert_eq!(
            describe(LspStatus::NotFound, Some("rust")).severity,
            LspSeverity::Neutral
        );
        assert_eq!(
            describe(LspStatus::Unsupported, None).severity,
            LspSeverity::Neutral
        );
    }

    #[test]
    fn unsupported_detail_ignores_display_name() {
        // `Unsupported` is never actually reached with a language (see the comment in
        // `describe()`), but if it ever were, the message must not claim "not available for X".
        let p = describe(LspStatus::Unsupported, Some("rust"));
        assert_eq!(p.detail, "LSP: unsupported file type");
    }

    #[test]
    fn json_shape_matches_frontend_camel_case_contract() {
        let p = describe(LspStatus::Idle, Some("rust"));
        let value = serde_json::to_value(&p).expect("LspStatusPresentation must serialize");
        assert_eq!(value["label"], "Idle");
        assert_eq!(value["displayName"], "Rust");
        assert_eq!(value["severity"], "neutral");
        assert_eq!(value["action"], "resume");
        assert_eq!(value["actionLabel"], "Resume");
    }

    #[test]
    fn display_name_sourced_from_registry_and_none_without_language() {
        let p = describe(LspStatus::NotFound, Some("typescript"));
        assert_eq!(p.display_name.as_deref(), Some("TypeScript / JavaScript"));

        let p = describe(LspStatus::Unsupported, None);
        assert_eq!(p.display_name, None);
    }

    #[test]
    fn labels_match_existing_frontend_wording() {
        assert_eq!(describe(LspStatus::Ready, Some("rust")).label, "Ready");
        assert_eq!(
            describe(LspStatus::Starting, Some("rust")).label,
            "Starting"
        );
        assert_eq!(
            describe(LspStatus::Indexing, Some("rust")).label,
            "Indexing"
        );
        assert_eq!(describe(LspStatus::Idle, Some("rust")).label, "Idle");
        assert_eq!(describe(LspStatus::Stopped, Some("rust")).label, "Stopped");
        assert_eq!(describe(LspStatus::Disabled, None).label, "Disabled");
        assert_eq!(
            describe(LspStatus::NotFound, Some("rust")).label,
            "Unavailable"
        );
        assert_eq!(describe(LspStatus::Unsupported, None).label, "N/A");
        assert_eq!(describe(LspStatus::Error, Some("rust")).label, "Error");
    }
}
