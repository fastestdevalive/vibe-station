//! Review comments: the wire types, limits and the injection seams
//! ([`ReviewPort`], [`TurnObserver`]) shared by `vst-store`, `vst-review`,
//! `vst-agents`, `vst-routes` and the daemon. No I/O lives here.
//!
//! `vst-review` owns comment lifecycle; `vst-agents` and `vst-routes` see only the
//! two traits below (injected from `run.rs`), so neither needs a dependency edge
//! on `vst-review` for the Rich Chat path. The message format lives in
//! [`crate::review_format`].

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::artifacts::{ScopeKey, ScopeKind};

// ── Limits ────────────────────────────────────────────────────────────────────

/// Live comments per scope; creating the 501st is refused (restores still insert).
pub const MAX_COMMENTS: usize = 500;
/// Comment text, bytes.
pub const MAX_TEXT: usize = 8192;
/// Quoted text, bytes.
pub const MAX_QUOTE: usize = 2048;
/// Prefix / suffix context, characters.
pub const MAX_AFFIX_CHARS: usize = 160;
/// Rich Chat send: most comments in one turn.
pub const RICH_SEND_MAX_COMMENTS: usize = 200;
/// Rich Chat send: largest rendered block, bytes.
pub const RICH_SEND_MAX_BYTES: usize = 131_072;
/// Terminal send: largest rendered block, bytes (equals `vst-review`'s paste cap).
pub const TERMINAL_SEND_MAX_BYTES: usize = 32_768;

// ── Small string enums ────────────────────────────────────────────────────────

/// Declares `as_str` / `parse` / `ALL` for a string enum; the serde spelling is
/// kept equal to `as_str` by a test.
macro_rules! str_enum {
    ($name:ident { $($var:ident => $s:literal),+ $(,)? }) => {
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$var),+];

            /// The stored / wire spelling.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$var => $s),+ }
            }

            /// Inverse of [`as_str`](Self::as_str); `None` for an unknown value.
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some($name::$var),)+ _ => None }
            }
        }
    };
}

/// Where a comment was made (the re-anchor corpus).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CommentSurface {
    #[serde(rename = "diff")]
    Diff,
    #[serde(rename = "file")]
    File,
    #[serde(rename = "markdown")]
    Markdown,
    #[serde(rename = "html-source")]
    HtmlSource,
}
str_enum!(CommentSurface { Diff => "diff", File => "file", Markdown => "markdown", HtmlSource => "html-source" });

/// `repo`: a repo-relative path; `artifact`: an absolute path that is an artifact
/// of the scope (checked by the artifacts read gate).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Repo,
    Artifact,
}
str_enum!(PathKind { Repo => "repo", Artifact => "artifact" });

/// Which diff a `diff` comment was made on. Commit scope is not allowed (R41).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffScope {
    Local,
    Branch,
}
str_enum!(DiffScope { Local => "local", Branch => "branch" });

/// Which side of a diff a comment is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffSide {
    Old,
    New,
}
str_enum!(DiffSide { Old => "old", New => "new" });

/// Anchor axis (independent of the delivery axis).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorState {
    Anchored,
    Outdated,
    FileMissing,
    CantCheck,
}
str_enum!(AnchorState { Anchored => "anchored", Outdated => "outdated", FileMissing => "file_missing", CantCheck => "cant_check" });

/// Why a comment is `cant_check`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorReason {
    FileTooLarge,
    WatchLimit,
}
str_enum!(AnchorReason { FileTooLarge => "file_too_large", WatchLimit => "watch_limit" });

/// Why comments came back to the panel from a snapshot (tray notice until
/// dismissed).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreReason {
    TurnCancelled,
    SendFailed,
    TimedOut,
    AgentExited,
    Restart,
    SessionRemoved,
    ChannelChanged,
    ScheduleCancelled,
    ScheduleFailed,
    SendCancelled,
}
str_enum!(RestoreReason {
    TurnCancelled => "turn_cancelled", SendFailed => "send_failed", TimedOut => "timed_out",
    AgentExited => "agent_exited", Restart => "restart", SessionRemoved => "session_removed",
    ChannelChanged => "channel_changed", ScheduleCancelled => "schedule_cancelled",
    ScheduleFailed => "schedule_failed", SendCancelled => "send_cancelled",
});

/// Why a comment left the panel (`comments:changed.deleted[].reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletedReason {
    Deleted,
    Sent,
    Scheduled,
}
str_enum!(DeletedReason { Deleted => "deleted", Sent => "sent", Scheduled => "scheduled" });

/// Lifecycle of a `ScheduledReviewPayload` (the `commentsSnapshot` JSON object).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadState {
    /// The snapshot is the only copy: a failure must restore it.
    Held,
    /// A json fire turned it into a turn hold; the hold now owns it.
    Adopted,
    /// The comments are back in the panel.
    Restored,
}
str_enum!(PayloadState { Held => "held", Adopted => "adopted", Restored => "restored" });

/// State of a Terminal delivery as the tray shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Waiting,
    Pasting,
    Sent,
    TimedOut,
    Failed,
    Cancelled,
}
str_enum!(DeliveryState { Waiting => "waiting", Pasting => "pasting", Sent => "sent", TimedOut => "timed_out", Failed => "failed", Cancelled => "cancelled" });

// ── Wire types ────────────────────────────────────────────────────────────────

/// An inclusive 1-based line span.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineSpan {
    pub start: u32,
    pub end: u32,
}

/// One review comment as clients see it (lease timestamps are internal).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    /// Client-minted UUID (creation is idempotent by id).
    pub id: String,
    pub scope_kind: ScopeKind,
    pub scope_id: String,
    /// Highest existing pin in the scope + 1 at creation, 1 for an empty scope (R60).
    pub pin: u32,
    /// Repo-relative, or absolute for an artifact.
    pub path: String,
    pub path_kind: PathKind,
    pub surface: CommentSurface,
    pub diff_scope: Option<DiffScope>,
    pub base_sha: Option<String>,
    pub side: Option<DiffSide>,
    /// Side-relative source span (markdown: AST span, R40).
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub old_start: Option<u32>,
    pub old_end: Option<u32>,
    pub new_start: Option<u32>,
    pub new_end: Option<u32>,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    /// Index among duplicates of the quote at creation time.
    pub occurrence: u32,
    pub text: String,
    pub anchor: AnchorState,
    pub anchor_reason: Option<AnchorReason>,
    /// Re-anchored span when it differs from the stored one.
    pub current: Option<LineSpan>,
    /// The path before a followed move.
    pub moved_from: Option<String>,
    /// `session:<id>` of the composer these are attached to.
    pub attached_to: Option<String>,
    pub restored_reason: Option<RestoreReason>,
    /// Size of this comment's rendered block (limit pre-check).
    pub block_bytes: u32,
    pub version: u32,
    pub created_at: String,
    pub updated_at: String,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// What a sent / scheduled comment looked like: the unit of rendering and of
/// restore. Carries the full anchor so a restored comment re-anchors exactly
/// like the original.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentSnapshot {
    pub id: String,
    pub pin: u32,
    pub path: String,
    pub path_kind: PathKind,
    pub surface: CommentSurface,
    pub diff_scope: Option<DiffScope>,
    pub side: Option<DiffSide>,
    pub lines: Option<LineSpan>,
    pub quote: String,
    pub text: String,
    pub anchor: AnchorState,
    pub anchor_reason: Option<AnchorReason>,
    pub base_sha: Option<String>,
    pub old_start: Option<u32>,
    pub old_end: Option<u32>,
    pub new_start: Option<u32>,
    pub new_end: Option<u32>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prefix: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub suffix: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub occurrence: u32,
    pub moved_from: Option<String>,
    pub created_at: Option<String>,
}

impl ReviewComment {
    /// The span shown in "Lines:": the re-anchored one when present, else the
    /// stored side-relative span.
    pub fn display_lines(&self) -> Option<LineSpan> {
        self.current.or(match (self.line_start, self.line_end) {
            (Some(start), Some(end)) => Some(LineSpan { start, end }),
            (Some(start), None) => Some(LineSpan { start, end: start }),
            _ => None,
        })
    }

    /// Snapshot for sending / scheduling / restoring.
    pub fn to_snapshot(&self) -> ReviewCommentSnapshot {
        ReviewCommentSnapshot {
            id: self.id.clone(),
            pin: self.pin,
            path: self.path.clone(),
            path_kind: self.path_kind,
            surface: self.surface,
            diff_scope: self.diff_scope,
            side: self.side,
            lines: self.display_lines(),
            quote: self.quote.clone(),
            text: self.text.clone(),
            anchor: self.anchor,
            anchor_reason: self.anchor_reason,
            base_sha: self.base_sha.clone(),
            old_start: self.old_start,
            old_end: self.old_end,
            new_start: self.new_start,
            new_end: self.new_end,
            line_start: self.line_start,
            line_end: self.line_end,
            prefix: self.prefix.clone(),
            suffix: self.suffix.clone(),
            occurrence: self.occurrence,
            moved_from: self.moved_from.clone(),
            created_at: Some(self.created_at.clone()),
        }
    }
}

/// The comments of one turn: stored on the transcript's user row (`review`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    /// Branch name (or project name for direct sessions): the message header.
    pub name: String,
    pub comments: Vec<ReviewCommentSnapshot>,
}

/// What a queued turn's card shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub count: u32,
    pub files: u32,
}

impl ReviewRecord {
    /// Comment and distinct-file counts.
    pub fn summary(&self) -> ReviewSummary {
        let mut paths: Vec<&str> = self.comments.iter().map(|c| c.path.as_str()).collect();
        paths.sort_unstable();
        paths.dedup();
        ReviewSummary {
            count: u32::try_from(self.comments.len()).unwrap_or(u32::MAX),
            files: u32::try_from(paths.len()).unwrap_or(u32::MAX),
        }
    }
}

/// The `commentsSnapshot` JSON object of a scheduled row (`snapshot_meta` counts
/// its `comments`). `origin` is the column, never part of this object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledReviewPayload {
    pub state: PayloadState,
    pub scope_kind: ScopeKind,
    pub scope_id: String,
    pub name: String,
    pub comments: Vec<ReviewCommentSnapshot>,
}

impl ScheduledReviewPayload {
    /// Parse a `commentsSnapshot` column value (`None` for anything that is not
    /// this object, even after the tolerant fallback of [`Self::parse_checked`]).
    pub fn parse(json: &str) -> Option<Self> {
        Self::parse_checked(json).ok().map(|(p, _)| p)
    }

    /// Strict parse first; if that fails, retry after replacing a comment's
    /// unknown `anchor` (written by a newer build) with `cant_check` and
    /// dropping an unknown `anchorReason`, so a snapshot (the only copy of the
    /// user's comments) stays restorable. The flag is `true` when the fallback
    /// was needed, so callers can log it.
    pub fn parse_checked(json: &str) -> Result<(Self, bool), serde_json::Error> {
        let strict_err = match serde_json::from_str::<Self>(json) {
            Ok(p) => return Ok((p, false)),
            Err(e) => e,
        };
        let Ok(mut v) = serde_json::from_str::<serde_json::Value>(json) else {
            return Err(strict_err);
        };
        if let Some(comments) = v.get_mut("comments").and_then(|c| c.as_array_mut()) {
            for c in comments {
                let Some(o) = c.as_object_mut() else { continue };
                let bad_anchor = o
                    .get("anchor")
                    .and_then(|a| a.as_str())
                    .map_or(true, |a| AnchorState::parse(a).is_none());
                if bad_anchor {
                    o.insert("anchor".into(), "cant_check".into());
                }
                let bad_reason = o
                    .get("anchorReason")
                    .and_then(|a| a.as_str())
                    .is_some_and(|a| AnchorReason::parse(a).is_none());
                if bad_reason {
                    o.remove("anchorReason");
                }
            }
        }
        serde_json::from_value::<Self>(v)
            .map(|p| (p, true))
            .map_err(|_| strict_err)
    }
}

/// A comment that left the panel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeletedComment {
    pub id: String,
    pub reason: DeletedReason,
}

/// A Terminal send in flight or just finished, as the tray shows it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDelivery {
    pub id: String,
    pub scope_kind: ScopeKind,
    pub scope_id: String,
    pub session_id: String,
    pub state: DeliveryState,
    pub comment_ids: Vec<String>,
    pub comment_count: u32,
    /// UTF-8 bytes of the paste: message + review block.
    pub bytes: u32,
    pub message: Option<String>,
    pub reason: Option<String>,
    pub waits_behind: Option<u32>,
    pub updated_at: String,
}

// ── Injection seams ───────────────────────────────────────────────────────────

/// Boxed future returned by the object-safe port methods.
pub type AsyncResult<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Which scope a hold or snapshot belongs to (a worktree or a project).
pub type ReviewScope = ScopeKey;

/// Why a port call was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReviewError {
    #[error("comment not found")]
    NotFound,
    /// Some ids no longer exist (deleted or sent elsewhere); `remaining` ids exist.
    #[error("comments changed ({remaining} remaining)")]
    Changed { remaining: u32 },
    /// Over a send limit; `unit` is `"comments"` or `"bytes"`.
    #[error("review too large (limit {limit} {unit})")]
    TooLarge { limit: u32, unit: &'static str },
    /// An id is attached to a different composer (or not to the sending one).
    #[error("comments are attached to another composer")]
    NotAttached,
    #[error("comment is outside the scope")]
    Scope,
    /// A create used an id that belongs to another scope or is held by a queued
    /// send (the id is taken, not out of scope).
    #[error("comment id is already in use")]
    IdTaken,
    #[error("invalid anchor")]
    InvalidAnchor,
    #[error("invalid path")]
    InvalidPath,
    /// A composer key that is not `session:<id>`.
    #[error("invalid composer key")]
    InvalidComposer,
    #[error("comment limit reached")]
    CapReached,
    #[error("comment text too long")]
    TextTooLong,
    #[error("quote too long")]
    QuoteTooLong,
    /// Another Terminal delivery is pending for the session.
    #[error("a delivery is already in flight")]
    InFlight,
    /// The row to create already exists (idempotent retry of a delivery).
    #[error("already exists")]
    Duplicate,
    #[error("store error: {0}")]
    Internal(String),
}

/// What to hold for a queued turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldRequest {
    /// Minted by the chat route; the idempotency key.
    pub hold_id: String,
    pub scope: ReviewScope,
    pub session_id: String,
    /// The turn id the user row will carry (the boot-reconcile key).
    pub turn_id: String,
    pub comment_ids: Vec<String>,
    /// The sending composer (`session:<id>`) when the ids come from its chip.
    pub composer_key: Option<String>,
}

/// Comments to schedule together with a message (`take_for_schedule`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleTake {
    pub scope: ReviewScope,
    pub comment_ids: Vec<String>,
    /// The sending composer (`session:<id>`) when the ids come from its chip.
    pub composer_key: Option<String>,
    /// Id of the scheduled row to insert.
    pub row_id: String,
    pub session_id: String,
    /// The user's message only (the block is rendered from the snapshot when it fires).
    pub message: String,
    pub fire_at: String,
    pub now: String,
    /// `"json"` or `"tmux"`: picks the size limit (Rich Chat 128 KB, Terminal 32 KB).
    pub channel: String,
    /// JSON blob of resolved attachments, when any.
    pub attachments: Option<String>,
}

/// A stored hold.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewHold {
    pub hold_id: String,
    pub record: ReviewRecord,
}

/// What `vst-routes` / `vst-agents` may ask of the comments owner.
pub trait ReviewPort: Send + Sync {
    /// Validate ids belong to `scope` (and to `composer` when given), snapshot, mark the rows `heldBy` the hold (they leave the panel). Idempotent by hold_id.
    fn hold_for_turn(&self, req: HoldRequest) -> AsyncResult<Result<ReviewHold, ReviewError>>;
    /// Restore a hold. The turn observer is the ONLY json-release restore path.
    fn restore_hold(&self, hold_id: &str, reason: RestoreReason) -> AsyncResult<()>;
    /// Reset-carry: move the hold to the new session/turn.
    fn rehome_hold(&self, hold_id: &str, session_id: &str, turn_id: &str) -> AsyncResult<()>;
    /// Consume a hold (a Terminal target rendered it into the launch prompt).
    fn consume_hold(&self, hold_id: &str) -> AsyncResult<()>;
    /// Scheduled Rich Chat row fired: hold from the row's snapshot. `row_id` is the scheduled
    /// row: its payload flips `held -> adopted` in the same transaction as the hold insert, and
    /// `Err(NotFound)` means the snapshot is no longer `held` (restored, sent, row gone): nothing
    /// is held and the caller must not enqueue the review.
    fn adopt_snapshot(
        &self,
        row_id: &str,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        session_id: &str,
        turn_id: &str,
    ) -> AsyncResult<Result<ReviewHold, ReviewError>>;
    /// Snapshot with no hold (schedule cancel/fail, immediate terminal outcome, launch-prompt spawn failure).
    /// With `row_id`, the row's payload flips `held -> restored` in the same transaction and a snapshot
    /// that is no longer `held` restores nothing, so a failure path can never restore twice.
    fn restore_snapshot(
        &self,
        row_id: Option<&str>,
        snapshot: ReviewRecord,
        scope: ReviewScope,
        reason: RestoreReason,
    ) -> AsyncResult<()>;
    /// Called by routes BEFORE a scheduled-row purge so no snapshot vanishes (session delete; project/worktree save).
    /// Restores ONLY rows with status='pending' AND (channel IS NULL OR channel != 'tmux') whose payload state='held'
    /// (tmux rows are restored solely by the OutcomeObserver, `Gone`; sent, adopted and already-restored rows are skipped).
    /// Every restore flips the payload to state:'restored'.
    /// `true` when every snapshot was restored; `false` when the store failed to list or restore one:
    /// the caller then SKIPS the purge (the snapshot is the only copy; `reconcile_boot` restores it).
    fn restore_for_session(&self, session_id: &str) -> AsyncResult<bool>;
    fn restore_orphaned_snapshots(&self) -> AsyncResult<bool>;
    /// Schedule with comments: in ONE transaction validate the ids (`NotAttached` / `Changed` /
    /// `TooLarge`), delete the rows and insert the `origin='schedule'` row carrying the snapshot.
    /// Nothing is deleted when it refuses.
    fn take_for_schedule(&self, req: ScheduleTake) -> AsyncResult<Result<(), ReviewError>>;
    /// Retry of a failed scheduled row whose snapshot went back to the panel: re-hold the comments
    /// that are still there (`held` again). `Err(Changed { remaining: 0 })` when none remain and the
    /// row has no message of its own. Returns the number re-held.
    fn rehold_schedule(&self, row_id: &str) -> AsyncResult<Result<u32, ReviewError>>;
}

/// What `vst-agents` tells the comments owner about a turn that carries a review.
pub trait TurnObserver: Send + Sync {
    /// Awaited right AFTER every user-row persist of a turn with `review` (the drain AND `steer_queued_head`); deletes the hold. Idempotent.
    fn turn_persisted(&self, hold_id: &str) -> AsyncResult<()>;
    /// Cancel / release / withdraw-and-drop of a turn whose `review` is still Some. IDEMPOTENT: `release()` can run the cancel sweep twice; a missing or already-restored hold is `Ok(())`, no second restore, no second event.
    fn turn_cancelled(&self, hold_id: &str, reason: RestoreReason) -> AsyncResult<()>;
}

// ── Scheduled-row snapshot count ──────────────────────────────────────────────

/// What the scheduled-send UI shows about a row's comment snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    pub count: u32,
}

/// Count the comments in a `commentsSnapshot` JSON object: the length of its
/// top-level `comments` array. Parsed tolerantly: anything that is not an object
/// with a non-empty `comments` array (invalid JSON, wrong shape, zero) is `None`.
pub fn snapshot_meta(comments_snapshot_json: &str) -> Option<SnapshotMeta> {
    let v: serde_json::Value = serde_json::from_str(comments_snapshot_json).ok()?;
    let n = v.as_object()?.get("comments")?.as_array()?.len();
    u32::try_from(n)
        .ok()
        .filter(|n| *n > 0)
        .map(|count| SnapshotMeta { count })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload_json(anchor: &str) -> String {
        format!(
            r#"{{"state":"held","scopeKind":"worktree","scopeId":"wt","name":"b","comments":[{{"id":"c1","pin":1,"path":"a.rs","pathKind":"repo","surface":"file","quote":"q","text":"t","anchor":"{anchor}","anchorReason":"future_reason"}}]}}"#
        )
    }

    #[test]
    fn snapshot_with_a_future_anchor_state_still_parses() {
        let (p, degraded) =
            ScheduledReviewPayload::parse_checked(&payload_json("future_state")).expect("tolerant");
        assert!(degraded);
        assert_eq!(p.comments[0].anchor, AnchorState::CantCheck);
        assert_eq!(p.comments[0].anchor_reason, None);
        let (p, degraded) = ScheduledReviewPayload::parse_checked(
            &payload_json("outdated").replace("future_reason", "watch_limit"),
        )
        .unwrap();
        assert!(!degraded);
        assert_eq!(p.comments[0].anchor, AnchorState::Outdated);
        assert!(ScheduledReviewPayload::parse("{\"state\":\"future\"}").is_none());
    }

    #[test]
    fn counts_top_level_comments_array() {
        assert_eq!(
            snapshot_meta(r#"{"comments":[{},{}]}"#),
            Some(SnapshotMeta { count: 2 })
        );
    }

    #[test]
    fn wrong_shapes_are_none() {
        for bad in [
            "[{},{}]",
            "{}",
            r#"{"comments":3}"#,
            "not json",
            r#"{"comments":[]}"#,
            "",
            "null",
        ] {
            assert_eq!(snapshot_meta(bad), None, "{bad}");
        }
    }

    fn serde_str<T: Serialize>(v: &T) -> String {
        serde_json::to_value(v)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn enum_spellings_match_serde() {
        for v in CommentSurface::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(CommentSurface::parse(v.as_str()), Some(*v));
        }
        for v in PathKind::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(PathKind::parse(v.as_str()), Some(*v));
        }
        for v in DiffScope::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(DiffScope::parse(v.as_str()), Some(*v));
        }
        for v in DiffSide::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(DiffSide::parse(v.as_str()), Some(*v));
        }
        for v in AnchorState::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(AnchorState::parse(v.as_str()), Some(*v));
        }
        for v in AnchorReason::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(AnchorReason::parse(v.as_str()), Some(*v));
        }
        for v in RestoreReason::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(RestoreReason::parse(v.as_str()), Some(*v));
        }
        for v in DeletedReason::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(DeletedReason::parse(v.as_str()), Some(*v));
        }
        for v in PayloadState::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(PayloadState::parse(v.as_str()), Some(*v));
        }
        for v in DeliveryState::ALL {
            assert_eq!(serde_str(v), v.as_str());
            assert_eq!(DeliveryState::parse(v.as_str()), Some(*v));
        }
        assert_eq!(CommentSurface::parse("nope"), None);
    }

    #[test]
    fn payload_shape_meets_snapshot_meta_count_rule() {
        let json = r#"{"state":"held","scopeKind":"worktree","scopeId":"w","name":"main","comments":[{},{}]}"#;
        assert_eq!(snapshot_meta(json), Some(SnapshotMeta { count: 2 }));
        let p = ScheduledReviewPayload {
            state: PayloadState::Held,
            scope_kind: ScopeKind::Worktree,
            scope_id: "w".into(),
            name: "main".into(),
            comments: vec![],
        };
        assert_eq!(snapshot_meta(&serde_json::to_string(&p).unwrap()), None);
    }
}
