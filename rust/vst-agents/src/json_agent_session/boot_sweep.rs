//! Boot sweep for stale background `working` lifecycle rows.
//!
//! `Working(background)` / `Working(subagent-notice)` are written without a
//! human prompt and settled by in-memory state (quiet timer / drain finally).
//! A crash or restart loses that state, so sessions would stay `working`
//! forever. Run once at boot, before the server accepts connections.
//! (Sessions are created lazily, so a constructor hook cannot do this.)

use vst_store::StoreHandle;
use vst_types::{
    Broadcaster, Channel, LifecycleState, ServerEvent, SessionLifecycle, SessionRecord,
};

use crate::json_agent_chat::{
    BACKGROUND_REASON, BACKGROUND_SETTLED_REASON, SUBAGENT_NOTICE_REASON,
};

fn is_stale_background_working(s: &SessionRecord) -> bool {
    // Only JSON sessions write these reasons; a stored `None` channel resolves
    // to JSON at runtime, so exclude only the explicit terminal channels.
    !matches!(s.channel, Some(Channel::Tmux | Channel::Pty))
        && s.lifecycle.state == LifecycleState::Working
        && matches!(
            s.lifecycle.reason.as_deref(),
            Some(BACKGROUND_REASON | SUBAGENT_NOTICE_REASON)
        )
}

/// Settle every JSON-channel session stuck in `Working` with a background /
/// subagent-notice reason to `WaitingForHuman(background-settled)`; returns
/// the number of sessions changed. Plain `Working` and non-JSON sessions are
/// untouched.
pub async fn sweep_stale_background_working(
    store: &StoreHandle,
    broadcaster: &Broadcaster,
) -> usize {
    let projects = store.get_all_projects().await;
    let mut stale: Vec<(String, String)> = Vec::new();
    for p in &projects {
        let all = p
            .worktrees
            .iter()
            .flat_map(|w| w.sessions.iter())
            .chain(p.direct_sessions.iter());
        for s in all {
            if is_stale_background_working(s) {
                stale.push((p.id.clone(), s.id.clone()));
            }
        }
    }
    let mut n = 0;
    for (project_id, session_id) in stale {
        let lifecycle = SessionLifecycle {
            state: LifecycleState::WaitingForHuman,
            reason: Some(BACKGROUND_SETTLED_REASON.to_string()),
            last_transition_at: crate::util::now_iso_8601(),
        };
        if store
            .update_session_lifecycle(&project_id, &session_id, lifecycle)
            .await
            .is_ok()
        {
            broadcaster.send(ServerEvent::SessionState {
                session_id,
                state: LifecycleState::WaitingForHuman,
                reason: Some(BACKGROUND_SETTLED_REASON.to_string()),
            });
            n += 1;
        }
    }
    n
}
