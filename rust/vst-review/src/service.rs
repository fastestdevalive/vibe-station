//! The review-comments owner: creating, editing and deleting comments, attach
//! leases, "Copy as text", and the coalesced `comments:changed` events.
//!
//! Single writer of the `comments` tables (`vst-store` only owns the SQL). Sends
//! (holds, schedules, Terminal deliveries) live in sibling modules; they reuse
//! [`ReviewHandle`]'s event helpers so a client sees one coalesced stream.
//!
//! **Logging (R84):** comment text, quotes and messages are never logged; only
//! ids and counts.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use vst_artifacts::ArtifactsHandle;
use vst_store::comments::CreateOutcome;
use vst_store::StoreHandle;
use vst_types::artifacts::{ScopeKey, ScopeKind};
use vst_types::rest::review::{
    AttachBody, CreateCommentBody, DetachBody, PatchCommentBody, RenderBody, RenderResponse,
};
use vst_types::review::{
    AnchorState, CommentSurface, DeletedComment, DeletedReason, DeliveryState, PathKind,
    ReviewComment, ReviewCommentSnapshot, ReviewError, TerminalDelivery, MAX_AFFIX_CHARS,
    MAX_QUOTE, MAX_TEXT,
};
use vst_types::review_format::{
    block_bytes, path_has_control, render_review_message, strip_control_chars,
};
use vst_types::{Broadcaster, ServerEvent};

use crate::clock::{format_iso, now_secs};

/// How long an untouched attach lease lives (R69).
pub const LEASE_SECS: u64 = 30 * 60;
/// How often expired leases are swept.
pub const LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// `comments:changed` events of one scope are merged over this window (R112).
pub const EVENT_COALESCE: Duration = Duration::from_millis(250);

/// Seconds since the Unix epoch; injectable for lease tests.
pub type NowSecs = Arc<dyn Fn() -> u64 + Send + Sync>;

/// A scope's comments plus what the tray needs next to them.
#[derive(Clone, Debug, PartialEq)]
pub struct CommentList {
    pub comments: Vec<ReviewComment>,
    pub next_pin: u32,
    /// In-flight immediate Terminal deliveries of the scope.
    pub terminal_deliveries: Vec<TerminalDelivery>,
}

#[derive(Default)]
struct Pending {
    upserted: Vec<ReviewComment>,
    deleted: Vec<DeletedComment>,
    /// A flush task is already scheduled for this scope.
    scheduled: bool,
}

pub(crate) struct Inner {
    pub(crate) store: StoreHandle,
    pub(crate) broadcaster: Broadcaster,
    pub(crate) artifacts: ArtifactsHandle,
    now: NowSecs,
    pending: Mutex<HashMap<ScopeKey, Pending>>,
    sweeping: AtomicBool,
    /// Bounded watcher + re-anchoring (`with_watcher`); `None` in tests that
    /// only exercise CRUD.
    pub(crate) watching: Option<crate::reanchor::Watching>,
    /// Terminal delivery seam + observer bookkeeping (`terminal.rs`).
    pub(crate) terminal: crate::terminal::TerminalState,
}

/// Handle to the review-comments owner. Clone is cheap.
#[derive(Clone)]
pub struct ReviewHandle(pub(crate) Arc<Inner>);

impl std::fmt::Debug for ReviewHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReviewHandle").finish_non_exhaustive()
    }
}

fn internal(e: impl std::fmt::Display) -> ReviewError {
    ReviewError::Internal(e.to_string())
}

/// Truncate to at most `n` characters, keeping the start.
fn head_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Truncate to at most `n` characters, keeping the end.
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

/// A repo-relative path: non-empty, no control characters, not absolute, no
/// `..` segment.
fn valid_repo_path(path: &str) -> bool {
    !path.is_empty()
        && !path_has_control(path)
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.split('/').any(|seg| seg == "..")
}

fn composer_ok(key: &str) -> bool {
    key.strip_prefix("session:")
        .is_some_and(|id| !id.is_empty() && !path_has_control(id))
}

impl ReviewHandle {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster, artifacts: ArtifactsHandle) -> Self {
        ReviewHandle(Arc::new(Inner {
            store,
            broadcaster,
            artifacts,
            now: Arc::new(now_secs),
            pending: Mutex::new(HashMap::new()),
            sweeping: AtomicBool::new(false),
            watching: None,
            terminal: crate::terminal::TerminalState::default(),
        }))
    }

    /// Attach the bounded path watcher and the scope resolver (roots of
    /// worktrees / projects): comments are then watched, re-anchored when their
    /// file or the git state changes, and purged with their scope. Call before
    /// the handle is cloned or started.
    pub fn with_watcher(
        mut self,
        watcher: vst_fswatch::path_watcher::PathWatcher,
        resolver: Arc<dyn vst_artifacts::ScopeResolver>,
    ) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.0) {
            inner.watching = Some(crate::reanchor::Watching::new(watcher, resolver));
        }
        self
    }

    /// Replace the clock (tests). Call before the handle is cloned or started.
    pub fn with_clock(mut self, now: NowSecs) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.0) {
            inner.now = now;
        }
        self
    }

    /// The lease sweeper: every [`LEASE_SWEEP_INTERVAL`], detach leases untouched
    /// for [`LEASE_SECS`]. Same shape as `PrPollerHandle::start`: an in-flight
    /// guard, `MissedTickBehavior::Skip`, and an event only on real change.
    ///
    /// With a watcher attached, the same task also runs the re-anchor loop
    /// (`reanchor.rs`); aborting the returned handle stops both.
    pub fn start(self: Arc<Self>) -> JoinHandle<()> {
        let sweeper = {
            let me = self.clone();
            async move {
                let mut tick = tokio::time::interval(LEASE_SWEEP_INTERVAL);
                tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    me.sweep_leases().await;
                }
            }
        };
        // Each loop is its own task, so a panic in one cannot end the others.
        let (a, b, c) = (self.clone(), self.clone(), self.clone());
        let tasks = vec![
            tokio::spawn(sweeper),
            tokio::spawn(async move { a.run_reanchor().await }),
            tokio::spawn(async move { b.run_holds_events().await }),
            tokio::spawn(async move { c.run_terminal_events().await }),
        ];
        tokio::spawn(async move {
            // Aborting the returned handle aborts every loop.
            let _abort = AbortAll(tasks.iter().map(JoinHandle::abort_handle).collect());
            for t in tasks {
                if let Err(e) = t.await {
                    if e.is_panic() {
                        tracing::error!("[vst] a review background loop panicked: {e}");
                    }
                }
            }
        })
    }

    /// One sweep; returns how many comments were detached.
    pub async fn sweep_leases(&self) -> usize {
        if self.0.sweeping.swap(true, Ordering::AcqRel) {
            return 0;
        }
        let cutoff = format_iso((self.0.now)().saturating_sub(LEASE_SECS));
        let n = match self.0.store.expire_leases(&cutoff).await {
            Ok(rows) => {
                let n = rows.len();
                self.push_upserts(rows);
                n
            }
            Err(e) => {
                tracing::warn!("[vst] comment lease sweep failed: {e}");
                0
            }
        };
        self.0.sweeping.store(false, Ordering::Release);
        n
    }

    pub(crate) fn now_iso(&self) -> String {
        format_iso((self.0.now)())
    }

    // ── Events ────────────────────────────────────────────────────────────────

    /// Queue upserted comments for the next `comments:changed` of their scope.
    pub(crate) fn push_upserts(&self, rows: Vec<ReviewComment>) {
        for row in rows {
            let key = ScopeKey {
                scope_kind: row.scope_kind,
                scope_id: row.scope_id.clone(),
            };
            self.push(&key, |p| {
                p.deleted.retain(|d| d.id != row.id);
                match p.upserted.iter_mut().find(|u| u.id == row.id) {
                    Some(slot) => *slot = row,
                    None => p.upserted.push(row),
                }
            });
        }
    }

    /// Queue a removal for the next `comments:changed` of `scope`.
    pub(crate) fn push_deleted(&self, scope: &ScopeKey, ids: &[String], reason: DeletedReason) {
        for id in ids {
            self.push(scope, |p| {
                p.upserted.retain(|u| &u.id != id);
                p.deleted.retain(|d| &d.id != id);
                p.deleted.push(DeletedComment {
                    id: id.clone(),
                    reason,
                });
            });
        }
    }

    fn push(&self, scope: &ScopeKey, f: impl FnOnce(&mut Pending)) {
        let schedule = {
            let mut map = crate::service::lock(&self.0.pending);
            let p = map.entry(scope.clone()).or_default();
            f(p);
            !std::mem::replace(&mut p.scheduled, true)
        };
        if schedule {
            let me = self.clone();
            let scope = scope.clone();
            tokio::spawn(async move {
                tokio::time::sleep(EVENT_COALESCE).await;
                me.flush_scope(&scope);
            });
        }
    }

    fn flush_scope(&self, scope: &ScopeKey) {
        let pending = crate::service::lock(&self.0.pending).remove(scope);
        let Some(p) = pending else { return };
        if self.0.watching.is_some() {
            // Whatever changed the comments (create, delete, send, restore, a
            // followed move), the watched set follows them.
            let (me, scope) = (self.clone(), scope.clone());
            tokio::spawn(async move { me.sync_watches(&scope).await });
        }
        if p.upserted.is_empty() && p.deleted.is_empty() {
            return;
        }
        self.0.broadcaster.send(ServerEvent::CommentsChanged {
            scope_kind: scope.scope_kind,
            scope_id: scope.scope_id.clone(),
            upserted: p.upserted,
            deleted: p.deleted,
        });
    }

    /// Send every queued `comments:changed` now (tests; shutdown).
    pub fn flush_events(&self) {
        let scopes: Vec<ScopeKey> = crate::service::lock(&self.0.pending)
            .keys()
            .cloned()
            .collect();
        for s in scopes {
            self.flush_scope(&s);
        }
    }

    // ── Scopes ────────────────────────────────────────────────────────────────

    /// The header name of a scope's messages (the branch, or the project folder
    /// name for direct sessions); `None` when the scope does not exist.
    pub async fn scope_label(&self, scope: &ScopeKey) -> Option<String> {
        match scope.scope_kind {
            ScopeKind::Project => {
                let p = self.0.store.get_project(&scope.scope_id).await?;
                Some(
                    Path::new(&p.absolute_path)
                        .file_name()
                        .map_or(p.prefix.clone(), |n| n.to_string_lossy().into_owned()),
                )
            }
            ScopeKind::Worktree => self
                .0
                .store
                .get_all_projects()
                .await
                .into_iter()
                .flat_map(|p| p.worktrees)
                .find(|w| w.id == scope.scope_id)
                .map(|w| w.branch),
        }
    }

    async fn require_scope(&self, scope: &ScopeKey) -> Result<String, ReviewError> {
        self.scope_label(scope).await.ok_or(ReviewError::NotFound)
    }

    // ── Comments ──────────────────────────────────────────────────────────────

    /// A scope's comments (optionally one file's, or only the unattached ones).
    pub async fn list(
        &self,
        scope: &ScopeKey,
        path: Option<&str>,
        unsent_only: bool,
    ) -> Result<CommentList, ReviewError> {
        self.require_scope(scope).await?;
        let comments = self
            .0
            .store
            .list_comments(scope, path, unsent_only)
            .await
            .map_err(internal)?;
        let next_pin = self
            .0
            .store
            .next_comment_pin(scope)
            .await
            .map_err(internal)?;
        let rows = self
            .0
            .store
            .list_immediate_rows(scope)
            .await
            .map_err(internal)?;
        let terminal_deliveries = rows
            .into_iter()
            .map(|r| {
                let snaps = &r.payload.comments;
                TerminalDelivery {
                    id: r.row_id,
                    scope_kind: scope.scope_kind,
                    scope_id: scope.scope_id.clone(),
                    session_id: r.session_id,
                    state: match r.phase.as_deref() {
                        Some("pasting") => DeliveryState::Pasting,
                        _ => DeliveryState::Waiting,
                    },
                    comment_ids: snaps.iter().map(|c| c.id.clone()).collect(),
                    comment_count: u32::try_from(snaps.len()).unwrap_or(u32::MAX),
                    bytes: u32::try_from(
                        vst_types::review_format::render_review_message(
                            &r.payload.name,
                            &r.message,
                            snaps,
                        )
                        .len(),
                    )
                    .unwrap_or(u32::MAX),
                    message: Some(r.message).filter(|m| !m.is_empty()),
                    reason: None,
                    waits_behind: Some(r.waits_behind).filter(|n| *n > 0),
                    updated_at: r.updated_at,
                }
            })
            .collect();
        Ok(CommentList {
            comments,
            next_pin,
            terminal_deliveries,
        })
    }

    /// One comment by id (`vst comment show`).
    pub async fn get(&self, id: &str) -> Result<ReviewComment, ReviewError> {
        self.0
            .store
            .get_comment(id)
            .await
            .map_err(internal)?
            .ok_or(ReviewError::NotFound)
    }

    /// Validate the anchor shape of a create request.
    fn validate_anchor(body: &CreateCommentBody) -> Result<(), ReviewError> {
        if body.id.is_empty() || body.id.len() > 100 || path_has_control(&body.id) {
            return Err(ReviewError::InvalidAnchor);
        }
        let is_diff = body.surface == CommentSurface::Diff;
        if is_diff != (body.diff_scope.is_some() && body.side.is_some()) {
            return Err(ReviewError::InvalidAnchor);
        }
        if !is_diff
            && (body.diff_scope.is_some()
                || body.side.is_some()
                || body.base_sha.is_some()
                || body.old_start.is_some()
                || body.old_end.is_some()
                || body.new_start.is_some()
                || body.new_end.is_some())
        {
            return Err(ReviewError::InvalidAnchor);
        }
        // The base reaches `git diff` at re-anchor time: only a hex object id.
        if let Some(sha) = body.base_sha.as_deref() {
            if !vst_git::is_valid_base_sha(sha) {
                return Err(ReviewError::InvalidAnchor);
            }
        }
        let ranges = [
            (body.line_start, body.line_end),
            (body.old_start, body.old_end),
            (body.new_start, body.new_end),
        ];
        for (a, b) in ranges {
            match (a, b) {
                (None, None) => {}
                (Some(a), Some(b)) if a >= 1 && a <= b => {}
                (Some(a), None) if a >= 1 => {}
                _ => return Err(ReviewError::InvalidAnchor),
            }
        }
        if body.quote.is_empty() && body.line_start.is_none() {
            return Err(ReviewError::InvalidAnchor);
        }
        Ok(())
    }

    /// Create a comment (idempotent by id). Returns the comment and whether it
    /// was newly created.
    pub async fn create(
        &self,
        scope: &ScopeKey,
        body: CreateCommentBody,
    ) -> Result<(ReviewComment, bool), ReviewError> {
        self.require_scope(scope).await?;
        Self::validate_anchor(&body)?;
        if body.path_kind == PathKind::Artifact {
            let p = Path::new(&body.path);
            if !p.is_absolute()
                || path_has_control(&body.path)
                || self.0.artifacts.authorize_read(scope, p).await.is_none()
            {
                return Err(ReviewError::InvalidPath);
            }
        } else if !valid_repo_path(&body.path) {
            return Err(ReviewError::InvalidPath);
        }
        let text = strip_control_chars(&body.text);
        let quote = strip_control_chars(&body.quote);
        if text.len() > MAX_TEXT {
            return Err(ReviewError::TextTooLong);
        }
        if quote.len() > MAX_QUOTE {
            return Err(ReviewError::QuoteTooLong);
        }
        let line_end = body.line_end.or(body.line_start);
        let now = self.now_iso();
        let mut comment = ReviewComment {
            id: body.id,
            scope_kind: scope.scope_kind,
            scope_id: scope.scope_id.clone(),
            pin: 0,
            path: body.path,
            path_kind: body.path_kind,
            surface: body.surface,
            diff_scope: body.diff_scope,
            base_sha: body.base_sha,
            side: body.side,
            line_start: body.line_start,
            line_end,
            old_start: body.old_start,
            old_end: body.old_end.or(body.old_start),
            new_start: body.new_start,
            new_end: body.new_end.or(body.new_start),
            quote,
            prefix: tail_chars(&strip_control_chars(&body.prefix), MAX_AFFIX_CHARS),
            suffix: head_chars(&strip_control_chars(&body.suffix), MAX_AFFIX_CHARS),
            occurrence: body.occurrence,
            text,
            anchor: AnchorState::Anchored,
            anchor_reason: None,
            current: None,
            moved_from: None,
            attached_to: None,
            restored_reason: None,
            block_bytes: 0,
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        comment.block_bytes = block_bytes(&comment.to_snapshot());
        match self
            .0
            .store
            .create_comment(comment, body.restore_pin, &now)
            .await
            .map_err(internal)?
        {
            CreateOutcome::Created(c) => {
                tracing::debug!(comment = %c.id, pin = c.pin, "[vst] comment created");
                self.push_upserts(vec![c.clone()]);
                Ok((c, true))
            }
            CreateOutcome::Existing(c) => Ok((c, false)),
            CreateOutcome::IdTaken => Err(ReviewError::IdTaken),
            CreateOutcome::CapReached => Err(ReviewError::CapReached),
        }
    }

    /// Replace a comment's text (last writer wins).
    pub async fn patch(
        &self,
        id: &str,
        body: PatchCommentBody,
    ) -> Result<ReviewComment, ReviewError> {
        let text = strip_control_chars(&body.text);
        if text.len() > MAX_TEXT {
            return Err(ReviewError::TextTooLong);
        }
        let existing = self
            .0
            .store
            .get_comment(id)
            .await
            .map_err(internal)?
            .ok_or(ReviewError::NotFound)?;
        let mut probe = existing.to_snapshot();
        probe.text.clone_from(&text);
        let updated = self
            .0
            .store
            .update_comment_text(id, &text, block_bytes(&probe), &self.now_iso())
            .await
            .map_err(internal)?
            .ok_or(ReviewError::NotFound)?;
        self.push_upserts(vec![updated.clone()]);
        Ok(updated)
    }

    /// Delete a comment.
    pub async fn delete(&self, id: &str) -> Result<(), ReviewError> {
        let row = self
            .0
            .store
            .delete_comment(id)
            .await
            .map_err(internal)?
            .ok_or(ReviewError::NotFound)?;
        let scope = ScopeKey {
            scope_kind: row.scope_kind,
            scope_id: row.scope_id,
        };
        self.push_deleted(&scope, &[row.id], DeletedReason::Deleted);
        Ok(())
    }

    // ── Attach leases ─────────────────────────────────────────────────────────

    /// Attach comments to a composer, moving them from any other (one composer at
    /// a time, R133). The same key again refreshes the lease; `refresh_only`
    /// never attaches anything new. Returns the ids attached to the composer.
    pub async fn attach(
        &self,
        scope: &ScopeKey,
        body: AttachBody,
    ) -> Result<Vec<String>, ReviewError> {
        self.require_scope(scope).await?;
        if !composer_ok(&body.composer_key) {
            return Err(ReviewError::InvalidComposer);
        }
        let now = self.now_iso();
        if body.refresh_only == Some(true) {
            self.0
                .store
                .refresh_lease(scope, &body.composer_key, &now)
                .await
                .map_err(internal)?;
            let rows = self
                .0
                .store
                .list_comments(scope, None, false)
                .await
                .map_err(internal)?;
            return Ok(rows
                .into_iter()
                .filter(|c| c.attached_to.as_deref() == Some(body.composer_key.as_str()))
                .map(|c| c.id)
                .collect());
        }
        let out = self
            .0
            .store
            .attach_comments(scope, &body.composer_key, body.comment_ids.as_deref(), &now)
            .await
            .map_err(internal)?;
        self.push_upserts(out.changed);
        Ok(out.attached)
    }

    /// Detach comments (any client may release a lease). Returns the ids detached.
    pub async fn detach(
        &self,
        scope: &ScopeKey,
        body: DetachBody,
    ) -> Result<Vec<String>, ReviewError> {
        self.require_scope(scope).await?;
        if body
            .composer_key
            .as_deref()
            .is_some_and(|k| !composer_ok(k))
        {
            return Err(ReviewError::InvalidComposer);
        }
        let rows = self
            .0
            .store
            .detach_comments(
                scope,
                body.composer_key.as_deref(),
                body.comment_ids.as_deref(),
            )
            .await
            .map_err(internal)?;
        let ids = rows.iter().map(|c| c.id.clone()).collect();
        self.push_upserts(rows);
        Ok(ids)
    }

    /// Clear the "restored" notices of a scope; returns how many were cleared.
    pub async fn dismiss_restored(&self, scope: &ScopeKey) -> Result<u32, ReviewError> {
        self.require_scope(scope).await?;
        let rows = self
            .0
            .store
            .dismiss_restored(scope)
            .await
            .map_err(internal)?;
        let n = u32::try_from(rows.len()).unwrap_or(u32::MAX);
        self.push_upserts(rows);
        Ok(n)
    }

    // ── Copy as text ──────────────────────────────────────────────────────────

    /// Render comments as the message format ("Copy as text"). Never size-limited:
    /// caps apply to sends only. Nothing is marked sent or removed.
    pub async fn render(
        &self,
        scope: &ScopeKey,
        body: RenderBody,
    ) -> Result<RenderResponse, ReviewError> {
        let name = self.require_scope(scope).await?;
        let rows = self
            .0
            .store
            .list_comments(scope, None, false)
            .await
            .map_err(internal)?;
        let picked: Vec<ReviewCommentSnapshot> = rows
            .iter()
            .filter(|c| match &body.comment_ids {
                Some(ids) => ids.contains(&c.id),
                None => true,
            })
            .map(ReviewComment::to_snapshot)
            .collect();
        let text = render_review_message(&name, body.message.as_deref().unwrap_or(""), &picked);
        Ok(RenderResponse {
            bytes: u32::try_from(text.len()).unwrap_or(u32::MAX),
            count: u32::try_from(picked.len()).unwrap_or(u32::MAX),
            text,
        })
    }
}

/// Lock a std mutex, ignoring poison: one panicking task must not cascade into
/// every later user of the same state.
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A store read that falls back to its default on error, but says so.
pub(crate) fn or_warn<T: Default, E: std::fmt::Display>(r: Result<T, E>, what: &str) -> T {
    r.unwrap_or_else(|e| {
        tracing::warn!("[vst] {what} failed: {e}");
        T::default()
    })
}

struct AbortAll(Vec<tokio::task::AbortHandle>);

impl Drop for AbortAll {
    fn drop(&mut self) {
        for h in &self.0 {
            h.abort();
        }
    }
}

#[cfg(test)]
mod lock_tests {
    use super::lock;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_poisoned_lock_stays_usable() {
        let m = Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(m.is_poisoned());
        *lock(&m) += 1;
        assert_eq!(*lock(&m), 2);
    }
}
