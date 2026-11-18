//! Draft-text owner — the server-owned composer draft text stored in the
//! `draft_texts` table (`.vibekit/feature-plans/wip/draft-text-sync`).
//!
//! Single writer: this module validates a scope's grammar and existence,
//! enforces the byte cap, lets `vst-store` assign the revision, and broadcasts
//! `ServerEvent::DraftTextChanged` only when the text really changed (Decision
//! 3: last-writer-wins, no 409 dance). Routes are thin (`routes.rs`); the
//! migration-gated orphan sweep lives in `boot.rs`.
//!
//! Bodies are never logged — `scope` and byte length only (R8). Scopes:
//! `global-new`, a session id (live, or a global drafting session), and
//! `review-picker:<worktree|project>:<id>`.

use vst_store::draft_texts::{DraftTextRow, PutOutcome};
use vst_store::StoreHandle;
use vst_types::draft_text::{DraftTextDoc, MAX_DRAFT_TEXT_BYTES};
use vst_types::events::{Broadcaster, ServerEvent};

pub mod boot;
pub mod routes;

/// Scope of the Tier-2 new-agent prompt. Always valid (no existence check).
pub const GLOBAL_NEW_SCOPE: &str = "global-new";

/// Scope grammar `^[A-Za-z0-9._:-]{1,160}$`; every accepted char is ASCII, so
/// the byte length is the character count.
const MAX_SCOPE_BYTES: usize = 160;

/// A page-load `crypto.randomUUID()` fits comfortably; the contract is 1..=64.
const MAX_CLIENT_ID_BYTES: usize = 64;

/// Owner failure; `routes.rs` maps each variant to its status and code.
#[derive(Debug)]
pub enum DraftTextError {
    BadScope,
    BadClientId,
    NotFound,
    TooLarge { limit: usize },
    Store(String),
}

/// Cheap clonable handle to the draft-text owner.
#[derive(Clone)]
pub struct DraftTextHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
}

impl DraftTextHandle {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self { store, broadcaster }
    }

    /// One scope's doc. An absent row reads as the revision-0 empty doc (an
    /// invalid scope shape is still a `bad_scope`, never a silent empty doc).
    pub async fn get(&self, scope: &str) -> Result<DraftTextDoc, DraftTextError> {
        if !valid_scope_shape(scope) {
            return Err(DraftTextError::BadScope);
        }
        match self.store.get_draft_text(scope).await {
            Ok(Some(row)) => Ok(doc_of(row)),
            Ok(None) => Ok(absent_doc(scope)),
            Err(e) => Err(DraftTextError::Store(e.to_string())),
        }
    }

    /// Every row, empty tombstones included (never purged: a purge would reset
    /// revisions under open clients).
    pub async fn list(&self) -> Result<Vec<DraftTextDoc>, DraftTextError> {
        self.store
            .list_draft_texts()
            .await
            .map(|rows| rows.into_iter().map(doc_of).collect())
            .map_err(|e| DraftTextError::Store(e.to_string()))
    }

    /// Last-writer-wins write. Broadcasting happens only on a real change
    /// (`Written`); rewriting the stored text returns the same doc silently.
    pub async fn put(
        &self,
        scope: &str,
        text: &str,
        client_id: &str,
    ) -> Result<DraftTextDoc, DraftTextError> {
        if !valid_scope_shape(scope) {
            return Err(DraftTextError::BadScope);
        }
        if client_id.is_empty() || client_id.len() > MAX_CLIENT_ID_BYTES {
            return Err(DraftTextError::BadClientId);
        }
        if text.len() > MAX_DRAFT_TEXT_BYTES {
            return Err(DraftTextError::TooLarge {
                limit: MAX_DRAFT_TEXT_BYTES,
            });
        }
        if !scope_exists(&self.store, scope).await {
            return Err(DraftTextError::NotFound);
        }
        let now = now_iso();
        match self
            .store
            .put_draft_text(scope, text, client_id, &now)
            .await
        {
            Ok(PutOutcome::Unchanged(row)) => Ok(doc_of(row)),
            Ok(PutOutcome::Written(row)) => {
                tracing::debug!(scope = %row.scope, len = row.text.len(), "draft text written");
                self.broadcaster.send(ServerEvent::DraftTextChanged {
                    scope: row.scope.clone(),
                    text: row.text.clone(),
                    revision: row.revision,
                    updated_at: row.updated_at.clone(),
                    client_id: row.client_id.clone(),
                });
                Ok(doc_of(row))
            }
            Err(e) => Err(DraftTextError::Store(e.to_string())),
        }
    }

    /// Delete a session's row when the session goes away (`SessionDeleted`).
    /// `Lagged` is ignored: the next boot's gated sweep catches strays.
    pub fn spawn_session_deleted_subscriber(&self) -> tokio::task::JoinHandle<()> {
        let store = self.store.clone();
        let mut rx = self.broadcaster.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::SessionDeleted { session_id }) => {
                        match store.delete_draft_text(&session_id).await {
                            Ok(true) => {
                                tracing::debug!(scope = %session_id, "draft text row removed with its session");
                            }
                            Ok(false) => {}
                            Err(e) => tracing::warn!(
                                "[vst] draft text delete for a deleted session failed: {e}"
                            ),
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }
}

/// Whether `scope` names something that exists right now. `global-new` is
/// always valid; a session id may be a live session or a global drafting
/// session; picker scopes name a worktree/project. Anything else is `NotFound`
/// here and is swept at boot.
async fn scope_exists(store: &StoreHandle, scope: &str) -> bool {
    if scope == GLOBAL_NEW_SCOPE {
        return true;
    }
    if let Some(rest) = scope.strip_prefix("review-picker:") {
        if let Some(id) = rest.strip_prefix("worktree:") {
            return store
                .get_all_projects()
                .await
                .iter()
                .any(|p| p.worktrees.iter().any(|w| w.id == id));
        }
        if let Some(id) = rest.strip_prefix("project:") {
            return store.get_project(id).await.is_some();
        }
        return false;
    }
    store.find_session(scope).await.is_some() || store.get_global_draft(scope).await.is_some()
}

/// `^[A-Za-z0-9._:-]{1,160}$`.
fn valid_scope_shape(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= MAX_SCOPE_BYTES
        && scope
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn doc_of(row: DraftTextRow) -> DraftTextDoc {
    DraftTextDoc {
        scope: row.scope,
        text: row.text,
        revision: row.revision,
        updated_at: Some(row.updated_at),
        client_id: row.client_id,
    }
}

fn absent_doc(scope: &str) -> DraftTextDoc {
    DraftTextDoc {
        scope: scope.to_string(),
        text: String::new(),
        revision: 0,
        updated_at: None,
        client_id: None,
    }
}

/// ISO8601 UTC with milliseconds (`2026-01-01T00:00:00.000Z`), the wire format
/// every timestamp in this API uses. No monotonic statics: draft writes have no
/// ordering requirement beyond `revision`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
