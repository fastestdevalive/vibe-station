use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub hard_ok: bool,
    pub ok: bool,
    pub feature_ok: bool,
    pub host_os: String,
    pub hostname: String,
    pub checked_at: String,
    pub checks: Vec<DoctorCheckDto>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheckDto {
    pub name: String,
    pub status: DoctorCheckStatus,
    pub required: bool,
    pub group: CheckGroup,
    pub message: String,
    pub resolved_path: Option<String>,
    /// Host-OS command, kept for back-compat; `hint` is the full structured form.
    pub install_hint: Option<String>,
    /// Structured corrective hint (why + per-OS commands + docs link + action),
    /// from `doctor_hints.rs`. `None` for OK checks and checks with no hint.
    #[serde(default)]
    pub hint: Option<DoctorHintDto>,
    /// Per-item rows for list-style checks (orphan worktrees / sessions).
    /// Empty for every other check.
    #[serde(default)]
    pub items: Vec<DoctorItemDto>,
}

/// Which OS a hint command applies to. `Any` = same on every OS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HintOs {
    Macos,
    Linux,
    Windows,
    Any,
}

/// In-app action a hint or item offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DoctorAction {
    Forget,
    Kill,
    Retry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HintCommandDto {
    pub os: HintOs,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorHintDto {
    pub title: Option<String>,
    pub why: String,
    pub commands: Vec<HintCommandDto>,
    pub docs_url: Option<String>,
    pub action: Option<DoctorAction>,
}

/// One row of a list-style check, e.g. a single orphan worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorItemDto {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    /// Copyable CLI equivalent of `action`.
    pub command: String,
    pub action: DoctorAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorCheckStatus {
    Ok,
    Warn,
    Error,
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckGroup {
    Required,
    AgentCli,
    Optional,
    Diagnostic,
    Feature,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_report_with_all_status_and_group_variants() {
        let report = DoctorReport {
            hard_ok: true,
            ok: false,
            feature_ok: true,
            host_os: "linux".to_string(),
            hostname: "test-host".to_string(),
            checked_at: "2026-01-01T00:00:00Z".to_string(),
            checks: vec![
                DoctorCheckDto {
                    name: "ok-required".to_string(),
                    status: DoctorCheckStatus::Ok,
                    required: true,
                    group: CheckGroup::Required,
                    message: "all good".to_string(),
                    resolved_path: Some("/usr/bin/tmux".to_string()),
                    install_hint: None,
                    hint: None,
                    items: vec![],
                },
                DoctorCheckDto {
                    name: "warn-agent-cli".to_string(),
                    status: DoctorCheckStatus::Warn,
                    required: false,
                    group: CheckGroup::AgentCli,
                    message: "optional CLI missing".to_string(),
                    resolved_path: None,
                    install_hint: Some("curl -fsSL https://bun.sh/install | bash".to_string()),
                    hint: Some(DoctorHintDto {
                        title: None,
                        why: "Optional agent CLI.".to_string(),
                        commands: vec![HintCommandDto {
                            os: HintOs::Any,
                            command: "curl -fsSL https://bun.sh/install | bash".to_string(),
                        }],
                        docs_url: Some("https://bun.sh".to_string()),
                        action: Some(DoctorAction::Retry),
                    }),
                    items: vec![DoctorItemDto {
                        id: "wt-1".to_string(),
                        label: "proj / wt-1".to_string(),
                        path: Some("/tmp/wt-1".to_string()),
                        command: "vst worktree rm wt-1 --yes".to_string(),
                        action: DoctorAction::Forget,
                    }],
                },
                DoctorCheckDto {
                    name: "error-optional".to_string(),
                    status: DoctorCheckStatus::Error,
                    required: false,
                    group: CheckGroup::Optional,
                    message: "something failed".to_string(),
                    resolved_path: None,
                    install_hint: None,
                    hint: None,
                    items: vec![],
                },
                DoctorCheckDto {
                    name: "timeout-diagnostic".to_string(),
                    status: DoctorCheckStatus::Timeout,
                    required: false,
                    group: CheckGroup::Diagnostic,
                    message: "timed out".to_string(),
                    resolved_path: None,
                    install_hint: None,
                    hint: None,
                    items: vec![],
                },
            ],
        };

        let value = serde_json::to_value(&report).expect("serialize report");
        let back: DoctorReport = serde_json::from_value(value).expect("deserialize report");
        assert_eq!(report, back);
    }

    #[test]
    fn check_json_without_hint_or_items_still_deserializes() {
        let json = serde_json::json!({
            "name": "tmux",
            "status": "ok",
            "required": true,
            "group": "required",
            "message": "tmux 3.4",
            "resolvedPath": null,
            "installHint": null
        });
        let c: DoctorCheckDto = serde_json::from_value(json).expect("old shape");
        assert_eq!(c.hint, None);
        assert!(c.items.is_empty());
    }

    #[test]
    fn hint_and_item_wire_names_are_camel_and_lowercase() {
        let hint = DoctorHintDto {
            title: None,
            why: "w".into(),
            commands: vec![HintCommandDto {
                os: HintOs::Macos,
                command: "brew install x".into(),
            }],
            docs_url: Some("https://x".into()),
            action: Some(DoctorAction::Forget),
        };
        assert_eq!(
            serde_json::to_value(&hint).unwrap(),
            serde_json::json!({
                "title": null,
                "why": "w",
                "commands": [{ "os": "macos", "command": "brew install x" }],
                "docsUrl": "https://x",
                "action": "forget"
            })
        );
    }
}
