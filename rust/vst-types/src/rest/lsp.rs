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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusResponse {
    pub status: LspStatus,
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLanguageStatus {
    pub language: String,
    pub status: LspStatus,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub children: Vec<OutlineSymbol>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LspOutlineResponse {
    Symbols {
        symbols: Vec<OutlineSymbol>,
    },
    Unsupported {
        unsupported: bool,
    },
}
