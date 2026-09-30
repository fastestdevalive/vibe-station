//! Behavior contract for `sqliteRowMappers.ts` (part 01-storage).
//! Ported 1:1 from `daemon/src/__tests__/sqliteRowMappers.test.ts`.

use vst_store::row_mappers::{
    bool_to_row, project_to_row, row_to_bool, row_to_project, row_to_session, row_to_worktree,
    session_to_row, worktree_to_row, SessionRow,
};
use vst_types::{
    Channel, LifecycleState, PrState, ProjectRecord, SessionNameSource, SessionRecord,
    TranscriptKind, WorktreeRecord,
};

fn base_row() -> SessionRow {
    SessionRow {
        id: "vs-1-a-abcd1234".into(),
        worktree_id: Some("vs-1".into()),
        project_id: "proj-1".into(),
        is_main: 1,
        sort_order: 1.0,
        r#type: "agent".into(),
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: "vst-vs-1-a-abcd1234".into(),
        use_tmux: 1,
        channel: None,
        state: "working".into(),
        reason: None,
        last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        transcript_kind: None,
        transcript_path: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        spawned_from: None,
        superseded_by: None,
        pr_state: None,
        pr_number: None,
        pr_url: None,
        pr_checked_at: None,
        pr_branch: None,
    }
}

#[test]
fn bool_helpers() {
    assert!(!row_to_bool(0));
    assert!(row_to_bool(1));
    assert_eq!(bool_to_row(true), 1);
    assert_eq!(bool_to_row(false), 0);
}

#[test]
fn session_round_trip_every_field() {
    let session = SessionRecord {
        id: "vs-1-a-abcd1234".into(),
        worktree_id: Some("vs-1".into()),
        project_id: "proj-1".into(),
        is_main: false,
        sort_order: 2.0,
        r#type: vst_types::SessionType::Agent,
        mode_id: Some("claude-default".into()),
        name: Some("fix-login-bug".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: "vst-vs-1-a-abcd1234".into(),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Working,
            reason: Some("spawned".into()),
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: Some(vst_types::TranscriptRef {
            kind: TranscriptKind::VstJson,
            path: Some("/data/messages.jsonl".into()),
        }),
        agent_chat_id: Some("chat-123".into()),
        acp_session_id: None,
        model_override: Some("claude-opus".into()),
        pinned_at: Some("2024-01-02T00:00:00.000Z".into()),
        initial_prompt: Some("fix the login bug".into()),
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    };
    let row = session_to_row(&session, "proj-1", Some("vs-1"));
    let back = row_to_session(&row);
    assert_eq!(back, session);
}

#[test]
fn session_omits_optionals_when_null() {
    let minimal = SessionRecord {
        id: "proj-1-t-11112222".into(),
        worktree_id: None,
        project_id: "proj-1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: vst_types::SessionType::Terminal,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: "vst-proj-1-t-11112222".into(),
        use_tmux: false,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::NotStarted,
            reason: None,
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    };
    let row = session_to_row(&minimal, "proj-1", None);
    let back = row_to_session(&row);
    assert_eq!(back, minimal);
    assert!(back.worktree_id.is_none());
    assert!(back.transcript_ref.is_none());
}

#[test]
fn parent_session_id_round_trips_through_spawned_from() {
    let mut with_parent = SessionRecord {
        id: "vs-1-a-abcd1234".into(),
        worktree_id: Some("vs-1".into()),
        project_id: "proj-1".into(),
        is_main: false,
        sort_order: 2.0,
        r#type: vst_types::SessionType::Agent,
        mode_id: Some("claude-default".into()),
        name: Some("fix-login-bug".into()),
        name_source: Some(SessionNameSource::Auto),
        tmux_name: "vst-vs-1-a-abcd1234".into(),
        use_tmux: true,
        channel: Some(Channel::Tmux),
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Working,
            reason: Some("spawned".into()),
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: Some(vst_types::TranscriptRef {
            kind: TranscriptKind::VstJson,
            path: Some("/data/messages.jsonl".into()),
        }),
        agent_chat_id: Some("chat-123".into()),
        acp_session_id: None,
        model_override: Some("claude-opus".into()),
        pinned_at: Some("2024-01-02T00:00:00.000Z".into()),
        initial_prompt: Some("fix the login bug".into()),
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    };
    with_parent.parent_session_id = Some("sess-parent-1".into());
    let row = session_to_row(&with_parent, "proj-1", Some("vs-1"));
    assert_eq!(row.spawned_from.as_deref(), Some("sess-parent-1"));
    let back = row_to_session(&row);
    assert_eq!(back.parent_session_id.as_deref(), Some("sess-parent-1"));
    assert_eq!(back, with_parent);
}

#[test]
fn legacy_spawned_from_column_loads_parent_link() {
    let mut row = base_row();
    row.spawned_from = Some("sess-legacy-parent".into());
    let back = row_to_session(&row);
    assert_eq!(
        back.parent_session_id.as_deref(),
        Some("sess-legacy-parent")
    );
}

#[test]
fn needs_review_maps_to_idle_lifecycle_and_open_pr() {
    let mut row = base_row();
    row.state = "needs_review".into();
    let back = row_to_session(&row);
    assert_eq!(back.lifecycle.state, LifecycleState::Idle);
    assert_eq!(back.pr.as_ref().unwrap().state, PrState::Open);
    assert_eq!(back.pr.as_ref().unwrap().checked_at, "");
}

#[test]
fn needs_review_does_not_clobber_real_pr() {
    let mut row = base_row();
    row.state = "needs_review".into();
    row.pr_state = Some("merged".into());
    row.pr_number = Some(42);
    row.pr_url = Some("https://github.com/o/r/pull/42".into());
    row.pr_checked_at = Some("2024-01-03T00:00:00.000Z".into());
    let back = row_to_session(&row);
    assert_eq!(back.lifecycle.state, LifecycleState::Idle);
    let pr = back.pr.unwrap();
    assert_eq!(pr.state, PrState::Merged);
    assert_eq!(pr.number, Some(42));
    assert_eq!(pr.url.as_deref(), Some("https://github.com/o/r/pull/42"));
    assert_eq!(pr.checked_at, "2024-01-03T00:00:00.000Z");
}

#[test]
fn non_legacy_state_untouched() {
    let mut row = base_row();
    row.state = "working".into();
    let back = row_to_session(&row);
    assert_eq!(back.lifecycle.state, LifecycleState::Working);
    assert!(back.pr.is_none());
}

#[test]
fn pr_branch_round_trips() {
    let mut row = base_row();
    row.state = "working".into();
    row.pr_state = Some("open".into());
    row.pr_number = Some(7);
    row.pr_url = Some("https://github.com/o/r/pull/7".into());
    row.pr_checked_at = Some("2024-01-03T00:00:00.000Z".into());
    row.pr_branch = Some("feature-x".into());
    let back = row_to_session(&row);
    let pr = back.pr.unwrap();
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.pr_branch.as_deref(), Some("feature-x"));
}

#[test]
fn session_to_row_writes_pr_branch_null_when_absent() {
    let session = SessionRecord {
        id: "s1".into(),
        worktree_id: None,
        project_id: "proj-1".into(),
        is_main: true,
        sort_order: 0.0,
        r#type: vst_types::SessionType::Agent,
        mode_id: None,
        name: None,
        name_source: None,
        tmux_name: "t1".into(),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: Some(vst_types::PrStatus {
            state: PrState::Open,
            number: None,
            url: None,
            checked_at: "2024-01-01T00:00:00.000Z".into(),
            error: None,
            pr_branch: Some("feature-x".into()),
        }),
    };
    assert_eq!(
        session_to_row(&session, "proj-1", None)
            .pr_branch
            .as_deref(),
        Some("feature-x")
    );
    let mut no_pr = session;
    no_pr.pr = None;
    assert!(session_to_row(&no_pr, "proj-1", None).pr_branch.is_none());
}

fn wt(id: &str, branch: &str, hidden_at: Option<&str>) -> WorktreeRecord {
    WorktreeRecord {
        id: id.into(),
        name: None,
        branch: branch.into(),
        // A worktree read back from the DB always carries a concrete boolean
        // (the column is `INTEGER NOT NULL DEFAULT 0` and cannot store
        // "absent") — `None` normalizes to `Some(false)` on a round-trip.
        branch_is_placeholder: Some(false),
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: hidden_at.map(str::to_string),
        sort_order: 1.0,
        terminal_seq: Some(0),
        agent_seq: Some(0),
        lsp_enabled: None,
        sessions: vec![],
        open_files: vec!["src/a.rs".into()],
    }
}

#[test]
fn worktree_round_trip() {
    let record = WorktreeRecord {
        id: "vs-1".into(),
        name: Some("Login fix".into()),
        branch: "feature-login".into(),
        branch_is_placeholder: Some(false),
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        pinned_at: Some("2024-01-02T00:00:00.000Z".into()),
        hidden_at: None,
        sort_order: 3.0,
        terminal_seq: Some(2),
        agent_seq: Some(5),
        lsp_enabled: None,
        sessions: vec![],
        open_files: vec!["src/a.rs".into()],
    };
    let row = worktree_to_row(&record, "proj-1");
    assert_eq!(row_to_worktree(&row, vec![]), record);

    // A row with a NULL openFiles column deserializes to an empty list.
    let mut null_row = row.clone();
    null_row.open_files = None;
    let reopened = row_to_worktree(&null_row, vec![]);
    assert!(reopened.open_files.is_empty());
}

#[test]
fn worktree_hidden_at_round_trip_and_omit() {
    let hidden = wt("vs-2", "feature-hidden", Some("2024-01-03T00:00:00.000Z"));
    let row = worktree_to_row(&hidden, "proj-1");
    assert_eq!(row_to_worktree(&row, vec![]), hidden);

    let visible = wt("vs-3", "feature-visible", None);
    let row = worktree_to_row(&visible, "proj-1");
    assert!(row.hidden_at.is_none());
    assert!(row_to_worktree(&row, vec![]).hidden_at.is_none());
}

fn project(id: &str, hidden: bool) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/repos/{id}"),
        prefix: "vs".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: hidden.then_some(true),
        direct_sessions: vec![],
        direct_session_seq: Some(4),
        worktrees: vec![],
        next_worktree_num: Some(6),
        lsp_enabled: None,
        open_files: vec![],
    }
}

#[test]
fn project_round_trip() {
    let record = project("proj-1", true);
    let row = project_to_row(&record);
    assert_eq!(row_to_project(&row, vec![], vec![]), record);
}

#[test]
fn project_omits_hidden_when_false() {
    let record = ProjectRecord {
        id: "proj-2".into(),
        absolute_path: "/repos/proj-2".into(),
        prefix: "vs".into(),
        is_git: true,
        default_branch: None,
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    };
    let row = project_to_row(&record);
    let back = row_to_project(&row, vec![], vec![]);
    assert!(back.hidden.is_none());
}
