//! `routes/worktrees.ts` — worktrees CRUD, tree, files, diff, pr, disk-usage.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::domain::Channel;

use super::shared::Worktree;

/// `POST /worktrees` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeBody {
    pub project_id: String,
    pub mode_id: String,
    /// Optional/blank → derived from `prompt` or auto-generated `wip/<wtId>`.
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub prompt: Option<String>,
    pub use_tmux: Option<bool>,
    pub channel: Option<Channel>,
    pub name: Option<String>,
    pub source_agent_id: Option<String>,
    pub skip_auto_turn: Option<bool>,
}

/// `PATCH /worktrees/:id/pin` and `PATCH /worktrees/:id/hide` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchWorktreeToggleBody {
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
}

/// `PATCH /worktrees/:id/pin|hide` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchWorktreeResult {
    pub ok: bool,
    pub worktree: Worktree,
}

/// `PATCH /worktrees/:id/rename` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorktreeBody {
    pub name: String,
}

/// `PATCH /worktrees/:id/rename` success (empty name → null).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorktreeResult {
    pub ok: bool,
    pub name: Option<String>,
}

/// `PATCH /worktrees/:id/reorder` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderWorktreeBody {
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
}

/// `PATCH /worktrees/:id/reorder` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderWorktreeResult {
    pub ok: bool,
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
}

/// `POST /worktrees/:id/done` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDoneResult {
    pub ok: bool,
    pub updated: i64,
    pub terminals_released: i64,
}

/// `DELETE /worktrees/:id` 409 guard body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeNotDoneError {
    pub error: String,
    pub sessions: Vec<String>,
}

/// `GET /worktrees/disk-usage` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub device: DiskDevice,
    pub worktrees: Vec<WorktreeUsage>,
}

/// `DiskUsage.device`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDevice {
    pub used_bytes: i64,
    pub total_bytes: i64,
    pub available_bytes: i64,
    pub mount_point: String,
}

/// One `DiskUsage.worktrees` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUsage {
    pub id: String,
    pub disk_bytes: i64,
}

/// `GET /worktrees/:id/changed-paths` entry — a name-status row plus an
/// optional per-path line-level diffstat.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPath {
    pub path: String,
    /// git porcelain status char(s).
    pub status: String,
    /// Present only when numstat matched.
    pub insertions: Option<i64>,
    /// Present only when numstat matched.
    pub deletions: Option<i64>,
    /// File mtime (ms since epoch). Set only for `scope=local` entries whose
    /// file still exists on disk (not deleted) — lets clients sort by most
    /// recently touched.
    pub mtime_ms: Option<i64>,
}

/// `GET /worktrees/:id/diffstat` — the `getDiffStat` result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub insertions: i64,
    pub deletions: i64,
}

/// `GET /worktrees/:id/commits` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitsResult {
    pub commits: Vec<CommitLogEntry>,
}

/// `GET /worktrees/:id/commits` entry (`CommitLogEntry` in git.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    /// ISO 8601, author date.
    pub date: String,
    pub subject: String,
    /// Full raw commit message (subject + body).
    pub body: String,
    pub insertions: i64,
    pub deletions: i64,
    pub has_binary_changes: bool,
    pub is_on_branch: bool,
}

/// `GET /worktrees/:id/submodules` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulesResult {
    pub submodules: Vec<SubmoduleInfo>,
}

/// One submodule (`SubmoduleInfo` in git.ts).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub sha: Option<String>,
    pub short_sha: Option<String>,
    pub branch: Option<String>,
    pub subject: Option<String>,
    pub status: SubmoduleStatus,
}

/// `SubmoduleInfo.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubmoduleStatus {
    Clean,
    Modified,
    #[serde(rename = "out-of-date")]
    OutOfDate,
    Uninitialized,
}

/// `GET /worktrees/:id/pr` result — a discriminated union on `kind`
/// (`PrLookupResult` in github.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum PrLookupResult {
    #[serde(rename = "pr", rename_all = "camelCase")]
    Pr { pr: PrInfo },
    #[serde(rename = "no_pr")]
    NoPr,
    #[serde(rename = "not_github")]
    NotGithub,
    #[serde(rename = "no_credentials")]
    NoCredentials,
    #[serde(rename = "error", rename_all = "camelCase")]
    Error {
        reason: PrErrorReason,
        message: String,
        retry_after_ms: Option<i64>,
    },
}

/// `PrInfo` (github.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub state: PrInfoState,
    pub merged: bool,
    pub draft: bool,
    pub author: Option<String>,
}

/// `PrInfo.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrInfoState {
    Open,
    Closed,
}

/// `PrLookupResult.Error.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrErrorReason {
    Network,
    RateLimited,
    Auth,
    Api,
}

/// `POST /worktrees/:id/open-file` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileBody {
    pub path: String,
}

/// `GET/POST/DELETE /worktrees/:id/open-files` response — the full updated
/// list of open file paths, relative to the worktree root.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilesResult {
    pub paths: Vec<String>,
}

/// `POST/DELETE /worktrees/:id/open-files` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilesBody {
    pub path: String,
}

/// `GET /worktrees/:id/pending-file-opens` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileOpens {
    pub paths: Vec<String>,
}

/// `GET /worktrees/:id/file-list` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResult {
    pub files: Vec<String>,
    pub truncated: bool,
    pub source: String,
}

/// One submatch hit within a search result line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    pub pre: String,
    pub mid: String,
    pub post: String,
}

/// All matches for a single file in the search results.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

/// `GET /worktrees/:id/search` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFileMatches>,
    pub truncated: bool,
    pub total_matches: usize,
}

/// `GET /worktrees/:id/file-search` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// `GET /worktrees/:id/gutter/*path` response — line-level git diff annotations.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GutterResult {
    pub added: Vec<u32>,
    pub deleted: Vec<u32>,
    pub modified: Vec<u32>,
}
