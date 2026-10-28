//! Artifacts contract: the wire row and the capture sink producers report into.
//!
//! No I/O here (this crate stays dependency-light). The owner that records,
//! caps, batches and serves artifact bytes is `vst-artifacts`; producers
//! (`vst-agents`) only see the `ArtifactSink` trait, injected from `run.rs`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Maximum rows kept per scope (hidden rows count toward it).
pub const ARTIFACT_CAP: u32 = 500;
/// Maximum pinned rows per scope.
pub const ARTIFACT_PIN_CAP: u32 = 50;
/// Maximum distinct writer session ids kept on a row (newest first).
pub const ARTIFACT_MAX_WRITERS: usize = 5;

/// What an artifact list is scoped to. Direct (worktree-less) sessions use
/// `Project`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Worktree,
    Project,
}

impl ScopeKind {
    /// The stored / wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Worktree => "worktree",
            ScopeKind::Project => "project",
        }
    }

    /// Inverse of [`as_str`](Self::as_str).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "worktree" => Some(ScopeKind::Worktree),
            "project" => Some(ScopeKind::Project),
            _ => None,
        }
    }
}

/// One artifact scope: a worktree id or a project id.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeKey {
    pub scope_kind: ScopeKind,
    pub scope_id: String,
}

impl ScopeKey {
    pub fn worktree(id: impl Into<String>) -> Self {
        Self {
            scope_kind: ScopeKind::Worktree,
            scope_id: id.into(),
        }
    }

    pub fn project(id: impl Into<String>) -> Self {
        Self {
            scope_kind: ScopeKind::Project,
            scope_id: id.into(),
        }
    }
}

/// Coarse type of an artifact, derived from its file extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Doc,
    Image,
    Other,
}

impl ArtifactKind {
    /// Classify by extension (case-insensitive). Pure: never touches the disk.
    pub fn from_path(path: &str) -> Self {
        let ext = path
            .rsplit('/')
            .next()
            .and_then(|name| name.rsplit_once('.'))
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "md" | "markdown" | "mdx" | "html" | "htm" => ArtifactKind::Doc,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => {
                ArtifactKind::Image
            }
            _ => ArtifactKind::Other,
        }
    }
}

/// Whether the file was found on the last check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactState {
    Ok,
    Missing,
}

/// How the row was first recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddedVia {
    Capture,
    Cli,
}

impl AddedVia {
    pub fn as_str(self) -> &'static str {
        match self {
            AddedVia::Capture => "capture",
            AddedVia::Cli => "cli",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "cli" {
            AddedVia::Cli
        } else {
            AddedVia::Capture
        }
    }
}

/// The wire row (`GET /artifacts`, `artifact:upserted`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRow {
    pub id: String,
    pub scope_kind: ScopeKind,
    pub scope_id: String,
    /// Canonical absolute path.
    pub path: String,
    /// Repo-relative, or absolute when `!in_repo`.
    pub display_path: String,
    pub in_repo: bool,
    pub kind: ArtifactKind,
    #[serde(default)]
    pub size: Option<u64>,
    pub state: ArtifactState,
    pub pinned: bool,
    pub edit_count: u32,
    /// Newest first, at most [`ARTIFACT_MAX_WRITERS`].
    pub writers: Vec<String>,
    pub added_via: AddedVia,
    pub created_at: String,
    pub last_written_at: String,
}

/// An upserted row as carried by `artifact:upserted`: the row plus whether it
/// is new to the list (so a client can notify on first appearance only).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpsert {
    #[serde(flatten)]
    pub row: ArtifactRow,
    pub created: bool,
}

/// Why rows left a list (`artifact:removed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactRemoveReason {
    Cap,
    Removed,
    Merged,
}

/// What an agent did to a file, as reported by a producer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum FileOp {
    Write,
    Delete,
    /// The effect's `path` is the destination; `from` the source.
    Move {
        from: String,
    },
}

/// One path-bearing effect of a completed tool call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEffect {
    /// Path as the agent reported it (absolute, or relative to the context cwd).
    pub path: String,
    #[serde(flatten)]
    pub op: FileOp,
}

impl FileEffect {
    pub fn write(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            op: FileOp::Write,
        }
    }

    pub fn delete(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            op: FileOp::Delete,
        }
    }

    pub fn moved(from: impl Into<String>, to: impl Into<String>) -> Self {
        Self {
            path: to.into(),
            op: FileOp::Move { from: from.into() },
        }
    }
}

/// Who wrote, and relative to what: the session that emitted the effects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteContext {
    pub project_id: String,
    /// `None` for a direct (worktree-less) session: scope is then the project.
    pub worktree_id: Option<String>,
    pub session_id: String,
    /// Working directory relative paths resolve against.
    pub cwd: PathBuf,
}

/// Receives "this session just wrote these files" notifications.
///
/// Fire-and-forget: implementations must be cheap, must not block and must not
/// panic. Coalescing, validation, persistence and broadcast are the
/// implementation's job.
pub trait ArtifactSink: Send + Sync + 'static {
    fn record(&self, ctx: WriteContext, effects: Vec<FileEffect>);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_from_extension() {
        assert_eq!(ArtifactKind::from_path("/a/plan.MD"), ArtifactKind::Doc);
        assert_eq!(ArtifactKind::from_path("/a/x.html"), ArtifactKind::Doc);
        assert_eq!(ArtifactKind::from_path("/a/shot.PNG"), ArtifactKind::Image);
        assert_eq!(ArtifactKind::from_path("/a/main.rs"), ArtifactKind::Other);
        assert_eq!(ArtifactKind::from_path("/a.d/noext"), ArtifactKind::Other);
    }

    #[test]
    fn file_effect_wire_shape() {
        let v = serde_json::to_value(FileEffect::moved("/a", "/b")).unwrap();
        assert_eq!(v, serde_json::json!({"path":"/b","op":"move","from":"/a"}));
        let back: FileEffect = serde_json::from_value(v).unwrap();
        assert_eq!(back, FileEffect::moved("/a", "/b"));
    }
}
