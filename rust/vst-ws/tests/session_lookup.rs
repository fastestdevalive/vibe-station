//! Behavior contract for `vst-ws::handlers::session_lookup` — resolves a
//! session id to its record scanning BOTH worktree sessions and direct
//! sessions. Ports `daemon/src/__tests__/sessionLookup.test.ts`, including the
//! regression that direct sessions used to be invisible.

use vst_types::domain::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};
use vst_ws::handlers::session_lookup::{find_session_record, SessionLookup};

fn session(id: &str, is_direct: bool) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        worktree_id: if is_direct {
            None
        } else {
            Some(format!("w-{id}"))
        },
        project_id: "proj-1".to_string(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("vr-{id}"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2026-01-01T00:00:00.000Z".to_string(),
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
    }
}

fn project(
    id: &str,
    worktree_sessions: Vec<SessionRecord>,
    direct: Vec<SessionRecord>,
) -> ProjectRecord {
    ProjectRecord {
        id: id.to_string(),
        absolute_path: format!("/tmp/{id}"),
        prefix: "p".to_string(),
        is_git: true,
        default_branch: Some("main".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        hidden: None,
        direct_sessions: direct,
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: format!("{id}-w1"),
            name: None,
            branch: "feat".to_string(),
            branch_is_placeholder: None,
            base_branch: "main".to_string(),
            base_sha: String::new(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: None,
            agent_seq: None,
            lsp_enabled: None,
            sessions: worktree_sessions,
            open_files: vec![],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

#[tokio::test]
async fn resolves_a_worktree_session() {
    let wt = session("proj-1-w1-m", false);
    let store = SessionLookup::from_projects(vec![project("proj-1", vec![wt.clone()], vec![])]);
    let result = find_session_record(&store, "proj-1-w1-m").await;
    assert!(result.is_some());
    let (proj, sess) = result.unwrap();
    assert_eq!(proj.id, "proj-1");
    assert_eq!(sess.id, "proj-1-w1-m");
}

#[tokio::test]
async fn resolves_a_direct_agent_session_regression() {
    let direct = session("proj-1-d1", true);
    let store = SessionLookup::from_projects(vec![project("proj-1", vec![], vec![direct.clone()])]);
    let result = find_session_record(&store, "proj-1-d1").await;
    assert!(result.is_some());
    let (proj, sess) = result.unwrap();
    assert_eq!(proj.id, "proj-1");
    assert_eq!(sess.id, "proj-1-d1");
}

#[tokio::test]
async fn resolves_a_direct_terminal_session() {
    let mut direct = session("proj-1-d2", true);
    direct.r#type = SessionType::Terminal;
    let store = SessionLookup::from_projects(vec![project("proj-1", vec![], vec![direct.clone()])]);
    let result = find_session_record(&store, "proj-1-d2").await;
    assert!(result.is_some());
    assert_eq!(result.unwrap().1.id, "proj-1-d2");
}

#[tokio::test]
async fn returns_none_for_unknown_session() {
    let store = SessionLookup::from_projects(vec![project("proj-1", vec![], vec![])]);
    assert!(find_session_record(&store, "nope").await.is_none());
}

#[tokio::test]
async fn finds_direct_sessions_across_projects() {
    let other = session("proj-2-d1", true);
    let mut p2 = project("proj-2", vec![], vec![]);
    p2.direct_sessions = vec![other.clone()];
    let store = SessionLookup::from_projects(vec![project("proj-1", vec![], vec![]), p2]);
    let result = find_session_record(&store, "proj-2-d1").await;
    assert!(result.is_some());
    assert_eq!(result.unwrap().1.id, "proj-2-d1");
}
