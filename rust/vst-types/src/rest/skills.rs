//! `GET /skills` — `routes/skills.ts`.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// `GET /skills` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResult {
    pub skills: Vec<SkillCatalogEntry>,
    pub directories: Vec<SkillDirectoryStatus>,
}

/// A single user-skill catalog entry.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogEntry {
    pub name: String,
    /// Always present on the wire (handler defaults to `""`).
    pub description: String,
    pub argument_hint: Option<String>,
    pub path: String,
}

/// One scanned skill directory's status.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDirectoryStatus {
    pub path: String,
    pub skill_count: i64,
    /// Present only on a real scan failure.
    pub error: Option<String>,
    /// True when the directory is absent.
    pub missing: Option<bool>,
}
