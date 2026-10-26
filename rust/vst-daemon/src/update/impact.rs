//! Restart impact: which sessions a restart would interrupt (agent working,
//! attached PTY, in-flight Rich Chat turn).
//!
//! Scans all non-archived sessions in the store to determine which ones
//! would be disrupted by a daemon restart.

use std::sync::Arc;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::StoreHandle;
use vst_types::domain::{Channel, LifecycleState, SessionRecord, SessionType};
use vst_types::rest::update::{ImpactItem, ImpactKind};

/// Compute the list of sessions that would be impacted by a restart.
///
/// Walks `store.get_all_projects()` (both direct and worktree sessions), skipping
/// sessions with `archived_at.is_some()` or `lifecycle.state ∈ {Exited, Done, Drafting, NotStarted}`.
/// First matching impact rule wins:
/// 1. an **agent** session with `lifecycle.state == Working` → `ImpactKind::Working`
///    (a plain terminal is always `working` but its tmux session survives a restart)
/// 2. `channel == Some(Channel::Pty)` → `ImpactKind::Pty`
/// 3. `channel == Some(Channel::Json)` with `registry.get(id).map_or(false, |s| !s.is_settled())` → `ImpactKind::JsonTurn`
/// `channel` `None` or `Tmux` are never counted unless rule 1 matches (`Working`, agents only).
pub async fn compute_impact(
    store: &StoreHandle,
    registry: &Arc<JsonAgentRegistry<JsonAgentSession>>,
) -> Vec<ImpactItem> {
    let projects = store.get_all_projects().await;
    let mut items = Vec::new();

    for project in projects {
        // Direct sessions
        for session in project.direct_sessions {
            if let Some(item) = evaluate_session(&session, registry) {
                items.push(item);
            }
        }

        // Worktree sessions
        for worktree in project.worktrees {
            for session in worktree.sessions {
                if let Some(item) = evaluate_session(&session, registry) {
                    items.push(item);
                }
            }
        }
    }

    items
}

fn evaluate_session(
    session: &SessionRecord,
    registry: &Arc<JsonAgentRegistry<JsonAgentSession>>,
) -> Option<ImpactItem> {
    if session.archived_at.is_some() {
        return None;
    }

    match session.lifecycle.state {
        LifecycleState::Exited
        | LifecycleState::Done
        | LifecycleState::Drafting
        | LifecycleState::NotStarted => return None,
        _ => {}
    }

    let is_agent = session.r#type == SessionType::Agent;
    let kind = if is_agent && session.lifecycle.state == LifecycleState::Working {
        ImpactKind::Working
    } else if session.channel == Some(Channel::Pty) {
        ImpactKind::Pty
    } else if session.channel == Some(Channel::Json) {
        let is_busy = registry.get(&session.id).map_or(false, |s| !s.is_settled());
        if is_busy {
            ImpactKind::JsonTurn
        } else {
            return None;
        }
    } else {
        return None;
    };

    Some(ImpactItem {
        session_id: session.id.clone(),
        name: session.name.clone(),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::domain::*;

    fn dummy_session(id: &str, state: LifecycleState, channel: Option<Channel>) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            worktree_id: None,
            project_id: "p1".to_string(),
            is_main: true,
            sort_order: 0.0,
            r#type: SessionType::Agent,
            mode_id: None,
            mode_icon: None,
            name: Some(format!("name-{id}")),
            name_source: None,
            tmux_name: format!("tmux-{id}"),
            use_tmux: true,
            channel,
            lifecycle: SessionLifecycle {
                state,
                reason: None,
                last_transition_at: "now".to_string(),
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
            carry_over: None,
        }
    }

    #[test]
    fn test_evaluate_session_rules() {
        let registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());

        // Working session => Working
        let s1 = dummy_session("s1", LifecycleState::Working, Some(Channel::Tmux));
        let item1 = evaluate_session(&s1, &registry).unwrap();
        assert_eq!(item1.kind, ImpactKind::Working);

        // Plain terminal: always `working`, tmux survives => not listed
        let mut t1 = dummy_session("t1", LifecycleState::Working, Some(Channel::Tmux));
        t1.r#type = SessionType::Terminal;
        assert!(evaluate_session(&t1, &registry).is_none());

        // Plain terminal on a pty channel is still interrupted => Pty
        let mut t2 = dummy_session("t2", LifecycleState::Working, Some(Channel::Pty));
        t2.r#type = SessionType::Terminal;
        assert_eq!(
            evaluate_session(&t2, &registry).unwrap().kind,
            ImpactKind::Pty
        );

        // Pty-channel idle => Pty
        let s2 = dummy_session("s2", LifecycleState::Idle, Some(Channel::Pty));
        let item2 = evaluate_session(&s2, &registry).unwrap();
        assert_eq!(item2.kind, ImpactKind::Pty);

        // Pty-channel Exited or archived => none
        let s3 = dummy_session("s3", LifecycleState::Exited, Some(Channel::Pty));
        assert!(evaluate_session(&s3, &registry).is_none());

        let mut s4 = dummy_session("s4", LifecycleState::Idle, Some(Channel::Pty));
        s4.archived_at = Some("archived".to_string());
        assert!(evaluate_session(&s4, &registry).is_none());

        // Tmux / channel: None idle => none
        let s5 = dummy_session("s5", LifecycleState::Idle, Some(Channel::Tmux));
        assert!(evaluate_session(&s5, &registry).is_none());

        let s6 = dummy_session("s6", LifecycleState::Idle, None);
        assert!(evaluate_session(&s6, &registry).is_none());
    }
}
