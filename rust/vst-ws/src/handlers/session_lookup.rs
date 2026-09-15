//! Resolve a session id to its record — worktree sessions AND direct sessions.
//!
//! Ports `daemon/src/ws/handlers/sessionLookup.ts`. Direct sessions live in
//! `project.direct_sessions` and have no worktree. This returns only
//! `(project, session)` because that is all any caller needs (sessionOpen,
//! sessionInput, sessionResize each destructure `session` alone).
//!
//! The original TS bug this guards against: the lookup used to scan only
//! `project.worktrees`, so every direct session was invisible to
//! `session:open`/`session:input`/`session:resize` — the daemon answered
//! "Session not found" while the agent was alive and healthy. The Rust version
//! must scan direct sessions too.

use vst_store::StoreHandle;
use vst_types::domain::{ProjectRecord, SessionRecord};

/// A resolved project + session.
pub type SessionLookupResult = (ProjectRecord, SessionRecord);

/// A snapshot of all projects to scan for a session id.
///
/// Constructed from a `StoreHandle` (production) or directly from a `Vec` of
/// projects (tests).
#[derive(Debug, Clone)]
pub struct SessionLookup {
    projects: Vec<ProjectRecord>,
}

impl SessionLookup {
    /// Build from an explicit list of projects (tests).
    pub fn from_projects(projects: Vec<ProjectRecord>) -> Self {
        SessionLookup { projects }
    }

    /// Build from a `StoreHandle`, reading all projects (production).
    pub async fn from_store(store: &StoreHandle) -> Self {
        SessionLookup {
            projects: store.get_all_projects().await,
        }
    }
}

/// Resolve a session id to its `(project, session)` record, scanning worktree
/// sessions AND direct sessions across all projects.
pub async fn find_session_record(
    lookup: &SessionLookup,
    session_id: &str,
) -> Option<SessionLookupResult> {
    for project in &lookup.projects {
        for worktree in &project.worktrees {
            if let Some(session) = worktree.sessions.iter().find(|s| s.id == session_id) {
                return Some((project.clone(), session.clone()));
            }
        }
        // Direct sessions (no worktree) — must be scanned too.
        if let Some(direct) = project.direct_sessions.iter().find(|s| s.id == session_id) {
            return Some((project.clone(), direct.clone()));
        }
    }
    None
}
