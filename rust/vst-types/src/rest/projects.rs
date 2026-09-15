//! `routes/projects.ts` — projects CRUD, branches, tree, files.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use super::shared::{Project, Session, Worktree};

/// `POST /projects` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectBody {
    pub path: String,
    pub name: Option<String>,
    /// regex `/^[a-z0-9]{1,6}$/`
    pub prefix: Option<String>,
    pub setup: Option<bool>,
}

/// `POST /projects/create` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNewProjectBody {
    pub name: String,
    pub dir: Option<String>,
    pub start_agent: Option<StartAgent>,
}

/// `CreateNewProjectBody.startAgent`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgent {
    pub mode_id: String,
    pub prompt: Option<String>,
    pub use_worktree: Option<bool>,
    pub branch: Option<String>,
}

/// `POST /projects/create` success.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNewProjectResult {
    pub project: Project,
    /// Present only when `startAgent.useWorktree` is true.
    pub worktree: Option<Worktree>,
    /// Present only when `startAgent` given.
    pub session: Option<Session>,
    pub warning: Option<String>,
}

/// `GET /projects/:projectId/branches` response.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchesResult {
    pub branches: Vec<String>,
    /// JSON null for non-git projects.
    pub default_branch: Option<String>,
}

/// `PATCH /projects/:id` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchProjectBody {
    pub hidden: bool,
}

/// `PATCH /projects/:id` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchProjectResult {
    pub ok: bool,
    pub project: Project,
}

/// A tree entry (`/tree`), shared with worktrees.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub r#type: TreeEntryType,
    pub path: String,
}

/// `TreeEntry.type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeEntryType {
    Dir,
    File,
}

/// A flat file-list entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListEntry {
    pub path: String,
}

/// `POST /projects` and `POST /projects/create` error bodies (carry extra
/// conflict data).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectError {
    pub error: String,
    pub conflict_with: Option<String>,
    pub details: Option<serde_json::Value>,
}
