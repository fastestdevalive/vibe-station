use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspFileRef {
    #[serde(rename = "workspace")]
    Workspace { path: String },
    #[serde(rename = "external")]
    External { token: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspStatus {
    Unsupported,
    NotFound,
    Starting,
    Indexing,
    Ready,
    Idle,
    Stopped,
    Error,
    Disabled,
}

impl LspStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::NotFound => "not_found",
            Self::Starting => "starting",
            Self::Indexing => "indexing",
            Self::Ready => "ready",
            Self::Idle => "idle",
            Self::Stopped => "stopped",
            Self::Error => "error",
            Self::Disabled => "disabled",
        }
    }
}

impl std::fmt::Display for LspStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspSeverity {
    Ok,
    Warn,
    Error,
    Neutral,
}

// Machine-readable, NOT derived from `action_label` text — a future copy change
// to `action_label` must never change which client call `onClick` dispatches to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspAction {
    Enable,
    Resume,
    /// Clear a latched start failure and respawn (`POST …/lsp/restart`).
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusPresentation {
    pub label: String,
    /// Human display name for `language` (e.g. "TypeScript / JavaScript"), sourced from
    /// `registry::lookup_by_language` — the ONLY place this is computed.
    /// `None` when `language` itself is `None` (e.g. `unsupported` with nothing detected yet).
    pub display_name: Option<String>,
    pub severity: LspSeverity,
    /// Always populated — every state gets a real sentence server-side.
    pub detail: String,
    pub action: Option<LspAction>,
    /// Button text for `action` (e.g. "Enable", "Resume") — presentation only; `onClick`
    /// dispatch must branch on `action`, never on this string.
    pub action_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusResponse {
    pub status: LspStatus,
    pub language: Option<String>,
    #[serde(flatten)]
    pub presentation: LspStatusPresentation,
    /// The server is up but reported a health warning/error (rust-analyzer's
    /// `experimental/serverStatus`), e.g. dependencies failed to load.
    #[serde(default)]
    pub degraded: Option<LspDegraded>,
    /// Why the server is not up (`status == Error`). Never set together with
    /// `degraded`: `degraded` means "up but impaired", `failure` "not up".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<LspFailure>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspDegradedLevel {
    /// The server reported a health problem (rust-analyzer `serverStatus`).
    #[default]
    Warning,
    /// Informational only, e.g. running against a fallback TypeScript.
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDegraded {
    pub message: String,
    #[serde(default)]
    pub level: LspDegradedLevel,
}

/// How a language server failed to come up. Classified by phase (spawn /
/// initialize / after Ready) and by a structural pre-spawn dependency probe —
/// never by matching server text, except as a documented backstop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspFailureKind {
    /// Structural probe: nothing usable to run against (e.g. no TypeScript).
    MissingDependency,
    /// Structural probe: dependency present but unusable (TS 7: no tsserver.js).
    IncompatibleDependency,
    /// `initialize` returned a JSON-RPC error.
    InitFailed,
    /// EOF / exit before the initialize response.
    ExitedOnStart,
    /// No initialize response within the timeout.
    InitTimeout,
    /// Died after a successful initialize.
    Crashed,
    /// `spawn()` failed for a reason other than "not found" (EACCES, ENOEXEC…).
    SpawnFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspRemediationKind {
    CopyCommand,
    Retry,
    ViewLog,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRemediation {
    /// Dispatch on this — never on `label`.
    pub kind: LspRemediationKind,
    pub label: String,
    /// Only for `CopyCommand`.
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFailure {
    pub kind: LspFailureKind,
    /// Short daemon-authored sentence (== `presentation.detail` while failed).
    pub summary: String,
    /// Raw server text: init error message and/or stderr tail. ≤2 KB.
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    pub remediation: Vec<LspRemediation>,
    /// True while the daemon will retry on its own (crash backoff, or a
    /// dependency failure being re-probed).
    pub auto_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLanguageStatus {
    pub language: String,
    pub status: LspStatus,
    #[serde(flatten)]
    pub presentation: LspStatusPresentation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<LspFailure>,
}

/// Body of `POST …/lsp/restart`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRestartRequest {
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusesResponse {
    pub statuses: Vec<LspLanguageStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLanguageSurveyEntry {
    pub language: String,
    pub display_name: String,
    pub command: String,
    pub installed_on_host: bool,
    pub install_command: Option<String>,
    pub install_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLanguageSurveyResponse {
    pub languages: Vec<LspLanguageSurveyEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPositionRequest {
    pub file: LspFileRef,
    pub line: u32,
    pub character: u32,
    #[serde(default)]
    pub cursor: Option<String>,
}

fn confidence_lsp() -> String {
    "lsp".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub line: u32,
    pub character: u32,
    /// Exclusive UTF-16 end column of the range; `None` when it spans lines.
    #[serde(default)]
    pub end_character: Option<u32>,
    /// The RAW source line (only the line terminator stripped) — `character`
    /// and `end_character` index into it, so it must never be trimmed.
    pub preview: String,
    pub external: bool,
    pub path: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub display_path: Option<String>,
    #[serde(default = "confidence_lsp")]
    pub confidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDefinitionResponse {
    pub locations: Vec<Location>,
    /// Set only when the daemon substituted a text search for the language server.
    #[serde(default)]
    pub fallback: Option<LspFallback>,
}

/// Why a definition/references response is ripgrep text matches rather than
/// language-server results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspFallbackReason {
    Disabled,
    Starting,
    NotFound,
    Unsupported,
    /// The language server failed to start (see the status `failure`).
    ServerFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFallback {
    pub reason: LspFallbackReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LspHoverResponse {
    Found {
        signature: String,
        doc: Option<String>,
    },
    Empty {
        empty: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceEntry {
    pub line: u32,
    pub character: u32,
    /// Exclusive UTF-16 end column of the range; `None` when it spans lines.
    #[serde(default)]
    pub end_character: Option<u32>,
    /// The RAW source line (only the line terminator stripped) — `character`
    /// and `end_character` index into it, so it must never be trimmed.
    pub preview: String,
    pub is_declaration: bool,
    #[serde(default = "confidence_lsp")]
    pub confidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceGroup {
    pub path: Option<String>,
    pub external: bool,
    pub token: Option<String>,
    pub display_path: Option<String>,
    pub entries: Vec<ReferenceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspReferencesResponse {
    pub references: Vec<ReferenceGroup>,
    pub has_more: bool,
    pub cursor: Option<String>,
    /// Set only when the daemon substituted a text search for the language server.
    #[serde(default)]
    pub fallback: Option<LspFallback>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub name: String,
    pub kind: String,
    /// Position of the symbol's NAME (`selectionRange.start`), falling back to
    /// `range.start` when the server sends no selection range.
    pub line: u32,
    pub character: u32,
    /// First line of the full symbol range (doc comments / attributes included)
    /// — used with `end_line` for scroll-sync containment.
    #[serde(default)]
    pub range_start_line: u32,
    pub end_line: u32,
    pub children: Vec<OutlineSymbol>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LspOutlineResponse {
    Symbols { symbols: Vec<OutlineSymbol> },
    Unsupported { unsupported: bool },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn presentation() -> LspStatusPresentation {
        LspStatusPresentation {
            label: "Setup needed".into(),
            display_name: Some("TypeScript / JavaScript".into()),
            severity: LspSeverity::Warn,
            detail: "TypeScript isn't installed".into(),
            action: Some(LspAction::Retry),
            action_label: Some("Retry".into()),
        }
    }

    fn failure() -> LspFailure {
        LspFailure {
            kind: LspFailureKind::MissingDependency,
            summary: "TypeScript isn't installed".into(),
            message: Some("Could not find a valid TypeScript installation".into()),
            exit_code: None,
            remediation: vec![
                LspRemediation {
                    kind: LspRemediationKind::CopyCommand,
                    label: "Copy install command".into(),
                    command: Some("npm i -D \"typescript@<7\"".into()),
                },
                LspRemediation {
                    kind: LspRemediationKind::Retry,
                    label: "Retry".into(),
                    command: None,
                },
            ],
            auto_retry: true,
        }
    }

    #[test]
    fn status_with_failure_round_trips_in_contract_shape() {
        let resp = LspStatusResponse {
            status: LspStatus::Error,
            language: Some("typescript".into()),
            presentation: presentation(),
            degraded: None,
            failure: Some(failure()),
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["action"], "retry");
        assert_eq!(v["failure"]["kind"], "missing_dependency");
        assert_eq!(v["failure"]["autoRetry"], true);
        assert_eq!(v["failure"]["exitCode"], serde_json::Value::Null);
        assert_eq!(v["failure"]["remediation"][0]["kind"], "copy_command");
        assert_eq!(
            v["failure"]["remediation"][0]["command"],
            "npm i -D \"typescript@<7\""
        );
        let back: LspStatusResponse = serde_json::from_value(v).unwrap();
        assert_eq!(back, resp);
    }

    #[test]
    fn failure_is_omitted_when_none() {
        let resp = LspStatusResponse {
            status: LspStatus::Ready,
            language: None,
            presentation: presentation(),
            degraded: None,
            failure: None,
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert!(v.get("failure").is_none());
        let lang = LspLanguageStatus {
            language: "rust".into(),
            status: LspStatus::Ready,
            presentation: presentation(),
            failure: None,
        };
        assert!(serde_json::to_value(&lang)
            .unwrap()
            .get("failure")
            .is_none());
    }

    #[test]
    fn old_degraded_json_without_level_is_a_warning() {
        let d: LspDegraded = serde_json::from_value(json!({ "message": "x" })).unwrap();
        assert_eq!(d.level, LspDegradedLevel::Warning);
        let v = serde_json::to_value(LspDegraded {
            message: "y".into(),
            level: LspDegradedLevel::Info,
        })
        .unwrap();
        assert_eq!(v, json!({ "message": "y", "level": "info" }));
    }

    #[test]
    fn new_enum_values_use_snake_case() {
        assert_eq!(
            serde_json::to_value(LspFallbackReason::ServerFailed).unwrap(),
            "server_failed"
        );
        for (kind, s) in [
            (
                LspFailureKind::IncompatibleDependency,
                "incompatible_dependency",
            ),
            (LspFailureKind::InitFailed, "init_failed"),
            (LspFailureKind::ExitedOnStart, "exited_on_start"),
            (LspFailureKind::InitTimeout, "init_timeout"),
            (LspFailureKind::Crashed, "crashed"),
            (LspFailureKind::SpawnFailed, "spawn_failed"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), s);
        }
        assert_eq!(
            serde_json::to_value(LspRemediationKind::ViewLog).unwrap(),
            "view_log"
        );
    }
}
