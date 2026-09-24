//! Behavior contract for `json_agent_chat.rs` (part 04c).
//!
//! Ports `daemon/src/__tests__/jsonAgentChat.buildSystemPrompt.test.ts`.
//!
//! The TS suite uses module mocks to verify `richChat: true` is forwarded to
//! `buildPrompt`/`buildDirectPrompt`. In Rust the prompt builder is in the
//! same crate and takes a plain bool — we verify the *observable output*
//! instead: the rich-chat subagent fragment is present (proving `rich_chat=true`)
//! and the worktree/project dispatch is correct.

use vst_types::domain::{
    Channel, LifecycleState, NormalizedEventProvider, ProjectRecord, SessionLifecycle,
    SessionRecord, SessionType, WorktreeRecord,
};

use vst_agents::json_agent_chat::{build_system_prompt_for_test, JsonSessionContext, ResolvedMode};

// ---------------------------------------------------------------------------
// Fixture helpers (exact field names from vst-types/src/domain.rs)
// ---------------------------------------------------------------------------

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
        lsp_enabled: None,
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
        lsp_enabled: None,
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
        mode_id: Some("mode-1".into()),
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: false,
        channel: Some(Channel::Json),
        lifecycle: SessionLifecycle {
            state: LifecycleState::Idle,
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

fn mode(context: Option<&str>) -> ResolvedMode {
    ResolvedMode {
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: Some("mode-1".into()),
        mode_name: Some("Default".into()),
        context: context.map(|s| s.to_string()),
        is_fallback: false,
    }
}

// ---------------------------------------------------------------------------
// T1 — worktree path: rich_chat fragment present, worktree info present
// ---------------------------------------------------------------------------

/// Ports: "passes richChat: true for the worktree path (buildPrompt)".
/// The Rust equivalent is: the result contains the subagent rich-chat text
/// (which `build_prompt` injects only when `rich_chat = true`) AND the
/// worktree-specific section (which only `build_prompt`, not
/// `build_direct_prompt`, produces).
#[test]
fn worktree_ctx_uses_build_prompt_with_rich_chat() {
    let ctx = JsonSessionContext {
        project: make_project("p1"),
        worktree: Some(make_worktree("wt1")),
        session: make_session("s1"),
    };

    let prompt = build_system_prompt_for_test(&ctx, &mode(None));

    // Rich-chat subagent fragment is present (proof of `rich_chat = true`).
    let has_rich_chat =
        prompt.contains("Rich Chat") || prompt.contains("Subagent") || prompt.contains("subagent");
    assert!(
        has_rich_chat,
        "Expected rich-chat content in prompt, got:\n{prompt}"
    );

    // Worktree-specific section was injected by `build_prompt`.
    let has_worktree = prompt.contains("**Worktree:**") || prompt.contains("**Branch:**");
    assert!(
        has_worktree,
        "Expected worktree section in prompt, got:\n{prompt}"
    );
}

// ---------------------------------------------------------------------------
// T2 — direct (no-worktree) path: rich_chat present, no worktree section
// ---------------------------------------------------------------------------

/// Ports: "passes richChat: true for the direct path (buildDirectPrompt)".
#[test]
fn direct_ctx_uses_build_direct_prompt_with_rich_chat() {
    let ctx = JsonSessionContext {
        project: make_project("p2"),
        worktree: None,
        session: make_session("s2"),
    };

    let prompt = build_system_prompt_for_test(&ctx, &mode(None));

    // Rich-chat subagent fragment is present (proof of `rich_chat = true`).
    let has_rich_chat =
        prompt.contains("Rich Chat") || prompt.contains("Subagent") || prompt.contains("subagent");
    assert!(
        has_rich_chat,
        "Expected rich-chat content in prompt, got:\n{prompt}"
    );

    // Worktree info must NOT be present — this is a direct session.
    assert!(
        !prompt.contains("**Worktree:**"),
        "Direct session prompt must not contain worktree section"
    );
}

// ---------------------------------------------------------------------------
// T3 — mode context is threaded through
// ---------------------------------------------------------------------------

#[test]
fn mode_context_is_injected() {
    let ctx = JsonSessionContext {
        project: make_project("p3"),
        worktree: Some(make_worktree("wt3")),
        session: make_session("s3"),
    };

    let prompt =
        build_system_prompt_for_test(&ctx, &mode(Some("You are a specialist in testing.")));
    assert!(
        prompt.contains("You are a specialist in testing."),
        "Mode context not found in prompt:\n{prompt}"
    );
}

// ---------------------------------------------------------------------------
// T4 — session_data_dir_for: correct path shape for worktree vs direct
// ---------------------------------------------------------------------------

#[test]
fn session_data_dir_for_worktree_session() {
    use vst_agents::json_agent_chat::session_data_dir_for;

    let ctx = JsonSessionContext {
        project: make_project("p4"),
        worktree: Some(make_worktree("wt4")),
        session: make_session("s4"),
    };

    let s = session_data_dir_for(&ctx).display().to_string();
    assert!(s.contains("p4"), "project id missing: {s}");
    assert!(s.contains("wt4"), "worktree id missing: {s}");
    assert!(s.contains("s4"), "session id missing: {s}");
    assert!(s.contains("session-data"), "expected session-data dir: {s}");
}

#[test]
fn session_data_dir_for_direct_session() {
    use vst_agents::json_agent_chat::session_data_dir_for;

    let ctx = JsonSessionContext {
        project: make_project("p5"),
        worktree: None,
        session: make_session("s5"),
    };

    let s = session_data_dir_for(&ctx).display().to_string();
    assert!(s.contains("p5"), "project id missing: {s}");
    assert!(s.contains("s5"), "session id missing: {s}");
    assert!(s.contains("sessions"), "expected sessions dir: {s}");
    assert!(
        !s.contains("session-data"),
        "direct path must not use session-data: {s}"
    );
}
