//! `GET /fs/check`, `GET /fs/complete` — `routes/fs.ts`.

use serde::{Deserialize, Serialize};

/// `GET /fs/check` response. All four fields always present; `has_commits` is
/// serialized as JSON `null` when the path is not a directory or not a git
/// repo (it is never omitted).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCheck {
    pub exists: bool,
    pub is_directory: bool,
    pub is_git: bool,
    pub has_commits: Option<bool>,
}

/// `GET /fs/complete` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsComplete {
    /// resolved dir
    pub base: String,
    pub entries: Vec<FsCompleteEntry>,
    pub truncated: bool,
}

/// One `fs/complete` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCompleteEntry {
    pub name: String,
    pub path: String,
}
