//! REST shapes of the review-comment routes (`/worktrees/:id/comments*`,
//! `/projects/:id/comments*`, `/comments/:id`).

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::review::{
    CommentSurface, DiffScope, DiffSide, PathKind, ReviewComment, TerminalDelivery,
};

/// `POST /worktrees/:id/comments` (and the project twin).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentBody {
    /// Client UUID; creating the same id twice returns the first comment.
    pub id: String,
    pub path: String,
    pub path_kind: PathKind,
    pub surface: CommentSurface,
    pub diff_scope: Option<DiffScope>,
    pub base_sha: Option<String>,
    pub side: Option<DiffSide>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub old_start: Option<u32>,
    pub old_end: Option<u32>,
    pub new_start: Option<u32>,
    pub new_end: Option<u32>,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default)]
    pub occurrence: u32,
    pub text: String,
    /// Re-create a comment deleted elsewhere under its old pin when that pin is free.
    pub restore_pin: Option<u32>,
}

/// `PATCH /comments/:id`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchCommentBody {
    pub text: String,
    /// Informational: last writer wins.
    pub version: Option<u32>,
}

/// `201`/`200` body of a create and `200` of a patch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommentResponse {
    pub comment: ReviewComment,
}

/// `GET /worktrees/:id/comments`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentListResponse {
    pub comments: Vec<ReviewComment>,
    pub next_pin: u32,
    /// In-flight immediate Terminal deliveries of the scope.
    pub terminal_deliveries: Vec<TerminalDelivery>,
}

/// `POST /worktrees/:id/comments/attach`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachBody {
    /// `session:<id>`.
    pub composer_key: String,
    /// Omitted = every comment in the scope.
    pub comment_ids: Option<Vec<String>>,
    /// Refresh the lease only; never attaches anything new.
    pub refresh_only: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttachResponse {
    pub attached: Vec<String>,
}

/// `POST /worktrees/:id/comments/detach`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachBody {
    /// Omitted = any composer.
    pub composer_key: Option<String>,
    /// Omitted = every attached comment matching `composerKey`.
    pub comment_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DetachResponse {
    pub detached: Vec<String>,
}

/// `POST /worktrees/:id/comments/render` (Copy as text; never size-limited).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBody {
    /// Omitted = every comment in the scope.
    pub comment_ids: Option<Vec<String>>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderResponse {
    pub text: String,
    pub bytes: u32,
    pub count: u32,
}

/// `POST /worktrees/:id/comments/dismiss-restored`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DismissRestoredResponse {
    pub cleared: u32,
}

/// `POST /worktrees/:id/terminal-deliveries` (and the `/projects/:id` twin).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalDeliveryBody {
    /// Client UUID; becomes the immediate row's id (idempotent by it).
    pub terminal_delivery_id: String,
    pub session_id: String,
    pub comment_ids: Vec<String>,
    pub message: Option<String>,
    /// `session:<id>` the comments are attached to, when sent from an attached composer.
    pub composer_key: Option<String>,
}

/// `202` body of a terminal delivery create.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateTerminalDeliveryResponse {
    pub delivery: TerminalDelivery,
}

/// `POST /sessions/:id/chat/turns/:turnId/restore-review`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreReviewResponse {
    pub restored: u32,
    /// Pins already back in the panel.
    pub skipped: u32,
}

/// `GET /sessions/:id/terminal-readiness`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalReadinessWire {
    Ready,
    AwaitingApproval,
    Unknown,
}

impl From<crate::terminal_delivery::TerminalReadiness> for TerminalReadinessWire {
    fn from(r: crate::terminal_delivery::TerminalReadiness) -> Self {
        use crate::terminal_delivery::TerminalReadiness as R;
        match r {
            R::Ready => Self::Ready,
            R::AwaitingApproval => Self::AwaitingApproval,
            R::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalReadinessResponse {
    pub readiness: TerminalReadinessWire,
}
