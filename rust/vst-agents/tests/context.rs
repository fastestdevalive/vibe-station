//! Behavior contract for `vst_agents::context` — ports `services/context.ts`
//! (`resolvedContextOf`, the `*For(ctx, …)` path helpers, and `buildVstEnv`).
//! The path-derivation half was already ported as `vst-agents::paths`; this
//! completes the direct-vs-worktree resolution and the VST_* env builder.

use vst_agents::context::{
    build_vst_env, resolved_context_of, session_data_dir_for, system_prompt_path_for,
    AgentContextRef, BuildVstEnvOptions,
};
use vst_agents::home::with_home;
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

fn make_project(id: &str) -> ProjectRecord {
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

fn make_worktree(id: &str) -> WorktreeRecord {
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

fn make_session(id: &str) -> SessionRecord {
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

#[test]
fn resolved_context_of_worktree_vs_direct() {
    let _guard = with_home("/tmp/fakehome".into());
    let project = make_project("p1");
    let wt = make_worktree("w1");
    let wt_ctx = resolved_context_of(project.clone(), Some(wt.clone()));
    assert_eq!(
        wt_ctx.ref_,
        AgentContextRef::Worktree {
            project_id: "p1".into(),
            worktree_id: "w1".into()
        }
    );
    assert_eq!(
        wt_ctx.cwd,
        "/tmp/fakehome/.vibe-station/projects/p1/worktrees/w1"
    );
    assert!(wt_ctx.worktree.is_some());

    let dir_ctx = resolved_context_of(project.clone(), None);
    assert_eq!(
        dir_ctx.ref_,
        AgentContextRef::Project {
            project_id: "p1".into()
        }
    );
    assert_eq!(dir_ctx.cwd, "/repos/p1");
    assert!(dir_ctx.worktree.is_none());
}

#[test]
fn session_data_dir_for_routes_to_direct() {
    let project = make_project("p1");
    let ctx = resolved_context_of(project, None);
    let dir = session_data_dir_for(&ctx, "s1");
    assert!(dir.ends_with("/projects/p1/sessions/s1"), "got {dir}");
}

#[test]
fn session_data_dir_for_routes_to_worktree() {
    let project = make_project("p1");
    let ctx = resolved_context_of(project, Some(make_worktree("w1")));
    let dir = session_data_dir_for(&ctx, "s1");
    assert!(
        dir.ends_with("/projects/p1/session-data/w1/s1"),
        "got {dir}"
    );
}

#[test]
fn system_prompt_path_for_worktree() {
    let project = make_project("p1");
    let ctx = resolved_context_of(project, Some(make_worktree("w1")));
    let p = system_prompt_path_for(&ctx, "s1");
    assert!(
        p.ends_with("/projects/p1/session-data/w1/s1/system-prompt.md"),
        "got {p}"
    );
}

#[test]
fn build_vst_env_worktree_includes_worktree_var() {
    let _guard = with_home("/tmp/fakehome".into());
    let project = make_project("p1");
    let session = make_session("s1");
    let env = build_vst_env(&BuildVstEnvOptions {
        project,
        worktree: Some(make_worktree("w1")),
        session,
        daemon_port: 7421,
    });
    assert_eq!(env.get("VST_SESSION").map(|s| s.as_str()), Some("s1"));
    assert_eq!(env.get("VST_WORKTREE").map(|s| s.as_str()), Some("w1"));
    assert_eq!(env.get("VST_PROJECT").map(|s| s.as_str()), Some("p1"));
    assert_eq!(
        env.get("VST_DAEMON_URL").map(|s| s.as_str()),
        Some("http://127.0.0.1:7421")
    );
    assert!(env
        .get("PATH")
        .unwrap()
        .contains("/tmp/fakehome/.vibe-station/bin"));
}

#[test]
fn build_vst_env_direct_omits_worktree_var() {
    let _guard = with_home("/tmp/fakehome".into());
    let project = make_project("p1");
    let session = make_session("s1");
    let env = build_vst_env(&BuildVstEnvOptions {
        project,
        worktree: None,
        session,
        daemon_port: 7421,
    });
    assert!(!env.contains_key("VST_WORKTREE"));
    assert_eq!(env.get("VST_SESSION").map(|s| s.as_str()), Some("s1"));
}
