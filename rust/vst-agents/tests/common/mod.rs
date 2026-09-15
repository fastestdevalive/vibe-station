//! Shared test fixtures for the 04a vst-agents integration tests.
#![allow(dead_code)]

use vst_agents::{LaunchConfig, PluginContext};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

/// Build a minimal session record with the given id.
pub fn make_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
            state: LifecycleState::Working,
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
    }
}

/// Build a minimal worktree record.
pub fn make_worktree(id: &str) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: format!("branch-{id}"),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: None,
        agent_seq: None,
        sessions: vec![],
    }
}

/// Build a minimal project record.
pub fn make_project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/repos/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
    }
}

/// A worktree context (cwd is the worktree checkout).
pub fn wt_ctx(project_id: &str, worktree_id: &str, cwd: &str) -> PluginContext {
    PluginContext {
        cwd: cwd.into(),
        project_id: project_id.into(),
        worktree: Some(make_worktree(worktree_id)),
    }
}

/// A direct (project) context — no worktree, cwd is the project checkout.
pub fn proj_ctx(project_id: &str, cwd: &str) -> PluginContext {
    PluginContext {
        cwd: cwd.into(),
        project_id: project_id.into(),
        worktree: None,
    }
}

/// A launch config for a worktree context.
pub fn wt_launch(project_id: &str, session: SessionRecord, cwd: &str) -> LaunchConfig {
    LaunchConfig {
        project: make_project(project_id),
        ctx: wt_ctx(project_id, "w1", cwd),
        session,
        daemon_port: 7421,
        model: None,
    }
}

/// A launch config for a direct (project) context.
pub fn proj_launch(project_id: &str, session: SessionRecord, cwd: &str) -> LaunchConfig {
    LaunchConfig {
        project: make_project(project_id),
        ctx: proj_ctx(project_id, cwd),
        session,
        daemon_port: 7421,
        model: None,
    }
}
