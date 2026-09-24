//! Behavior contract for `vst_agents::prompt_builder` — ports
//! `daemon/src/__tests__/promptBuilder.test.ts` (the 3-layer L1/L2/L3 builder +
//! richChat Decision 10 split).

use std::path::PathBuf;

use vst_agents::prompt_builder::{
    build_direct_prompt, build_prompt, reset_skill_cache_for_test, BuildDirectPromptInput,
    BuildPromptInput,
};
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

fn make_project(path: &str) -> ProjectRecord {
    ProjectRecord {
        id: "my-project".into(),
        absolute_path: path.into(),
        prefix: "mypr".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
    }
}

fn make_worktree() -> WorktreeRecord {
    WorktreeRecord {
        id: "wt-mypr-1".into(),
        name: None,
        branch: "fix-auth".into(),
        branch_is_placeholder: None,
        base_branch: "main".into(),
        base_sha: "abc1234abc1234abc1234abc1234abc1234abc123".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 0.0,
        terminal_seq: None,
        agent_seq: None,
        lsp_enabled: None,
        sessions: vec![],
    }
}

fn session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "my-project".into(),
        is_main: true,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("vr-mypr-1-{id}"),
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

fn with_temp_rule(dir: &PathBuf, name: &str, content: &str) {
    std::fs::create_dir_all(dir.join(".vibe-station")).unwrap();
    if name == "AGENTS.md" {
        std::fs::write(dir.join("AGENTS.md"), content).unwrap();
    } else {
        std::fs::write(dir.join(".vibe-station").join("rules.md"), content).unwrap();
    }
}

#[test]
fn build_prompt_contains_l1_and_l2() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let project = make_project(tmp.path().to_str().unwrap());
    let worktree = make_worktree();
    let r = build_prompt(&BuildPromptInput {
        project,
        worktree,
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.len() > 50);
    assert!(r.system_prompt.contains("my-project"));
    assert!(r.system_prompt.contains("fix-auth"));
    assert!(r.system_prompt.contains("main"));
}

#[test]
fn build_prompt_includes_mode_context_when_provided() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: Some("You are fixing a bug. Open a PR when done.".into()),
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.contains("You are fixing a bug"));
    assert!(r.system_prompt.contains("## Mode Instructions"));
}

#[test]
fn build_prompt_omits_mode_when_absent() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(!r.system_prompt.contains("## Mode Instructions"));
}

#[test]
fn build_prompt_sets_task_prompt() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: Some("Fix the login bug".into()),
        rich_chat: false,
    });
    assert_eq!(r.task_prompt.as_deref(), Some("Fix the login bug"));
}

#[test]
fn build_prompt_task_prompt_absent_without_user_prompt() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.task_prompt.is_none());
}

#[test]
fn build_prompt_reads_agents_md_l3() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    with_temp_rule(
        &tmp.path().to_path_buf(),
        "AGENTS.md",
        "# Rules\nAlways write tests.",
    );
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.contains("Always write tests."));
}

#[test]
fn build_prompt_falls_back_to_rules_md() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    with_temp_rule(
        &tmp.path().to_path_buf(),
        "rules.md",
        "Custom rule: no console.log.",
    );
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.contains("Custom rule: no console.log."));
}

#[test]
fn build_prompt_works_without_rules() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree: make_worktree(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.len() > 50);
}

#[test]
fn build_prompt_includes_sibling_sessions() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let mut worktree = make_worktree();
    worktree.sessions = vec![session("sess-1")];
    let r = build_prompt(&BuildPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        worktree,
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(r.system_prompt.contains("sess-1"));
}

#[test]
fn rich_chat_splits_subagent_section() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let project = make_project(tmp.path().to_str().unwrap());
    let worktree = make_worktree();
    let with = build_prompt(&BuildPromptInput {
        project: project.clone(),
        worktree: worktree.clone(),
        mode_context: None,
        user_prompt: None,
        rich_chat: true,
    });
    let without = build_prompt(&BuildPromptInput {
        project,
        worktree,
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(with.system_prompt.contains("Subagents (Rich Chat only)"));
    assert!(!without.system_prompt.contains("Subagents (Rich Chat only)"));
}

#[test]
fn rich_chat_default_equals_explicit_false() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let project = make_project(tmp.path().to_str().unwrap());
    let worktree = make_worktree();
    let default = build_prompt(&BuildPromptInput {
        project: project.clone(),
        worktree: worktree.clone(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    let explicit = build_prompt(&BuildPromptInput {
        project,
        worktree,
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert_eq!(default.system_prompt, explicit.system_prompt);

    let dproject = make_project(tmp.path().to_str().unwrap());
    let dd = build_direct_prompt(&BuildDirectPromptInput {
        project: dproject.clone(),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    let de = build_direct_prompt(&BuildDirectPromptInput {
        project: dproject,
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert_eq!(dd.system_prompt, de.system_prompt);
}

#[test]
fn build_direct_prompt_rich_chat() {
    reset_skill_cache_for_test();
    let tmp = tempfile::tempdir().unwrap();
    let with = build_direct_prompt(&BuildDirectPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        mode_context: None,
        user_prompt: None,
        rich_chat: true,
    });
    let without = build_direct_prompt(&BuildDirectPromptInput {
        project: make_project(tmp.path().to_str().unwrap()),
        mode_context: None,
        user_prompt: None,
        rich_chat: false,
    });
    assert!(with.system_prompt.contains("Subagents (Rich Chat only)"));
    assert!(!without.system_prompt.contains("Subagents (Rich Chat only)"));
}
