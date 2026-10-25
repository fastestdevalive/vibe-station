//! Plain-terminal hygiene: delete exited terminals, and keep the dock's
//! auto-create idempotent.
//!
//! - **Reaper** — a plain terminal (`type == Terminal`) that reaches `Exited`
//!   is dead weight (agents are different: exited agents are resumable and are
//!   never touched here). The lifecycle poller / `worktree_done` / `recover.rs`
//!   keep writing the state; this module is the only deleter. It reuses
//!   [`SessionRoutes::delete_session`], so the usual `session:deleted`
//!   broadcast reaches every client.
//! - **Create guard** — `POST /sessions { onlyIfNone: true }` on a terminal
//!   returns the scope's existing live terminal instead of creating another.
//!   [`find_live_terminal`] is the predicate and [`TERMINAL_CREATE_LOCK`]
//!   serializes check → spawn → persist (the spawn precedes persistence, so
//!   the store lock alone cannot close the race).

use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use vst_types::events::ServerEvent;
use vst_types::{LifecycleState, SessionRecord, SessionType};

use crate::sessions::{find_session_context, DeleteError, SessionContext, SessionRoutes};

/// Held across check → spawn → persist by a guarded terminal create. Lock order
/// is always this lock → store lock; nothing under the store lock takes it.
pub(crate) static TERMINAL_CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Take [`TERMINAL_CREATE_LOCK`] for a guarded (`onlyIfNone`) terminal create;
/// `None` (no locking) for every other create. Hold the result for the whole
/// check → spawn → persist sequence.
pub(crate) async fn lock_if_guarded(guarded: bool) -> Option<tokio::sync::MutexGuard<'static, ()>> {
    if guarded {
        Some(TERMINAL_CREATE_LOCK.lock().await)
    } else {
        None
    }
}

/// The live terminal in `sessions` (one scope: a project's direct sessions or
/// one worktree's sessions), if any. Exited/done and archived terminals do not
/// count; agents never do.
pub(crate) fn find_live_terminal(sessions: &[SessionRecord]) -> Option<&SessionRecord> {
    sessions.iter().find(|s| {
        s.r#type == SessionType::Terminal
            && s.archived_at.is_none()
            && !matches!(
                s.lifecycle.state,
                LifecycleState::Exited | LifecycleState::Done
            )
    })
}

/// Delete `id` iff it is *still* an exited plain terminal. Re-reads first: a
/// Resume (or a late event) may have revived it since the event was sent.
pub async fn reap_if_exited_terminal(routes: &SessionRoutes, id: &str) {
    let Some(ctx) = find_session_context(&routes.store, id).await else {
        return;
    };
    let session = match &ctx {
        SessionContext::Direct { session, .. } | SessionContext::Worktree { session, .. } => {
            session
        }
        SessionContext::Global { .. } => return,
    };
    if session.r#type == SessionType::Terminal && session.lifecycle.state == LifecycleState::Exited
    {
        match routes.delete_session(id).await {
            // NotFound = something else deleted it first; nothing to do.
            Ok(_) | Err(DeleteError::NotFound(_)) => {}
            // Not retried until the next `Lagged` re-sweep or boot, so say so.
            Err(e) => tracing::warn!("[vst] reaping exited terminal {id} failed: {e:?}"),
        }
    }
}

/// Delete every terminal (direct + worktree) already stored as `Exited` — the
/// boot case, where `recover.rs` marked them without broadcasting.
pub async fn sweep_exited_terminals(routes: &SessionRoutes) {
    let mut ids = Vec::new();
    for project in routes.store.get_all_projects().await {
        let worktree_sessions = project.worktrees.iter().flat_map(|w| w.sessions.iter());
        for s in project.direct_sessions.iter().chain(worktree_sessions) {
            if s.r#type == SessionType::Terminal && s.lifecycle.state == LifecycleState::Exited {
                ids.push(s.id.clone());
            }
        }
    }
    for id in ids {
        reap_if_exited_terminal(routes, &id).await;
    }
}

/// Start the reaper: subscribe FIRST, then sweep, then follow `Exited` events.
/// Subscribing before the sweep closes the startup gap — an `Exited` sent in
/// between would otherwise be lost for good (`mark_session_exited` never
/// re-sends it). A lagged receiver may have missed events, so it re-sweeps.
pub fn spawn_exited_terminal_reaper(routes: SessionRoutes) -> JoinHandle<()> {
    let mut rx = routes.broadcaster.subscribe();
    tokio::spawn(async move {
        sweep_exited_terminals(&routes).await;
        loop {
            match rx.recv().await {
                Ok(ServerEvent::SessionState {
                    session_id,
                    state: LifecycleState::Exited,
                    ..
                }) => reap_if_exited_terminal(&routes, &session_id).await,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => sweep_exited_terminals(&routes).await,
                Err(RecvError::Closed) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::{Channel, SessionLifecycle};

    fn rec(id: &str, ty: SessionType, state: LifecycleState) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            worktree_id: None,
            project_id: "p".into(),
            is_main: false,
            sort_order: 1.0,
            r#type: ty,
            mode_id: None,
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: format!("vst-{id}"),
            use_tmux: true,
            channel: Some(Channel::Tmux),
            lifecycle: SessionLifecycle {
                state,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    #[test]
    fn live_terminal_skips_exited_done_archived_and_agents() {
        let exited = rec("exited", SessionType::Terminal, LifecycleState::Exited);
        let done = rec("done", SessionType::Terminal, LifecycleState::Done);
        let mut archived = rec("archived", SessionType::Terminal, LifecycleState::Working);
        archived.archived_at = Some("2026-01-02T00:00:00.000Z".into());
        let agent = rec("agent", SessionType::Agent, LifecycleState::Working);
        let live = rec("live", SessionType::Terminal, LifecycleState::Working);

        assert!(find_live_terminal(&[exited, done, archived, agent.clone()]).is_none());
        let all = [agent, live];
        assert_eq!(
            find_live_terminal(&all).map(|s| s.id.as_str()),
            Some("live")
        );
    }
}
