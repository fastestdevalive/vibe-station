//! `StoreHandle::update_session_activity` persistence + the full-save guard
//! that keeps a stale cached clone from rewinding the activity columns.

use vst_store::StoreHandle;
use vst_types::{
    LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType, WorktreeRecord,
};

fn session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: "p1".into(),
        is_main: false,
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: None,
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: SessionLifecycle {
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
        carry_over: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
    }
}

fn worktree_with(session: SessionRecord) -> WorktreeRecord {
    WorktreeRecord {
        id: "wt1".into(),
        name: None,
        branch: "feat".into(),
        branch_is_placeholder: Some(false),
        base_branch: "main".into(),
        base_sha: "0".repeat(40),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        pinned_at: None,
        hidden_at: None,
        sort_order: 1.0,
        terminal_seq: Some(0),
        agent_seq: Some(0),
        lsp_enabled: None,
        sessions: vec![session],
        open_files: vec![],
    }
}

fn project(sessions: Vec<SessionRecord>) -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/fake/p1".into(),
        prefix: "p1".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: sessions,
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

#[tokio::test]
async fn activity_persists_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vibe-station.db");
    {
        let store = StoreHandle::open(&db).unwrap();
        store
            .add_project(project(vec![session("s1")]))
            .await
            .unwrap();
        let ok = store
            .update_session_activity(
                "p1",
                "s1",
                "2026-10-21T10:00:00Z",
                Some(&tool("Edit", Some("a.ts"))),
            )
            .await
            .unwrap();
        assert!(ok);
        // `None` keeps the stored line.
        store
            .update_session_activity("p1", "s1", "2026-10-21T10:00:05Z", None)
            .await
            .unwrap();
    }
    let store = StoreHandle::open(&db).unwrap();
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_activity_at.as_deref(), Some("2026-10-21T10:00:05Z"));
    // `lastLine` is reserved: never written by the activity path.
    assert_eq!(s.last_line, None);
    // `None` keeps the stored tool.
    assert_eq!(s.last_tool, Some(tool("Edit", Some("a.ts"))));
}

#[tokio::test]
async fn tool_without_detail_clears_old_detail() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project(vec![session("s1")]))
        .await
        .unwrap();
    store
        .update_session_activity(
            "p1",
            "s1",
            "2026-10-21T10:00:00Z",
            Some(&tool("Read", Some("a.md"))),
        )
        .await
        .unwrap();
    store
        .update_session_activity(
            "p1",
            "s1",
            "2026-10-21T10:00:01Z",
            Some(&tool("Grep", None)),
        )
        .await
        .unwrap();
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_tool, Some(tool("Grep", None)));
}

fn tool(name: &str, detail: Option<&str>) -> vst_types::activity::ToolActivity {
    vst_types::activity::ToolActivity {
        name: name.into(),
        detail: detail.map(str::to_string),
    }
}

#[tokio::test]
async fn unknown_session_returns_false() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project(vec![session("s1")]))
        .await
        .unwrap();
    let ok = store
        .update_session_activity(
            "p1",
            "nope",
            "2026-10-21T10:00:00Z",
            Some(&tool("Bash", Some("ls"))),
        )
        .await
        .unwrap();
    assert!(!ok);
}

#[tokio::test]
async fn full_save_from_stale_clone_does_not_rewind_activity() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project(vec![session("s1")]))
        .await
        .unwrap();
    store
        .update_session_activity(
            "p1",
            "s1",
            "2026-10-21T10:00:00Z",
            Some(&tool("Bash", Some("ls"))),
        )
        .await
        .unwrap();

    // A stale clone carrying an OLDER activity pair is saved back.
    store
        .mutate_project("p1", |p| {
            let mut stale = p.clone();
            stale.direct_sessions[0].last_activity_at = Some("2026-10-21T09:00:00Z".into());
            Ok(stale)
        })
        .await
        .unwrap();
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_activity_at.as_deref(), Some("2026-10-21T10:00:00Z"));
    assert_eq!(s.last_tool, Some(tool("Bash", Some("ls"))));

    // A stale clone with NO activity must not wipe it either.
    store
        .mutate_project("p1", |p| {
            let mut stale = p.clone();
            stale.direct_sessions[0].last_activity_at = None;
            stale.direct_sessions[0].last_tool = None;
            Ok(stale)
        })
        .await
        .unwrap();
    let (_, s) = store.find_session("s1").await.unwrap();
    assert_eq!(s.last_activity_at.as_deref(), Some("2026-10-21T10:00:00Z"));
    assert_eq!(s.last_tool, Some(tool("Bash", Some("ls"))));
}

#[tokio::test]
async fn activity_write_updates_cache_in_place_for_direct_and_worktree_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let mut p = project(vec![session("s1")]);
    let mut wt_session = session("w1");
    wt_session.worktree_id = Some("wt1".into());
    p.worktrees.push(worktree_with(wt_session));
    store.add_project(p).await.unwrap();

    // Cache read (no DB) reflects the write immediately.
    assert!(store
        .update_session_activity(
            "p1",
            "s1",
            "2026-10-21T10:00:00Z",
            Some(&tool("Edit", None))
        )
        .await
        .unwrap());
    assert!(store
        .update_session_activity("p1", "w1", "2026-10-21T10:00:01Z", None)
        .await
        .unwrap());
    let (_, s) = store.find_session_cached("s1").unwrap();
    assert_eq!(s.last_activity_at.as_deref(), Some("2026-10-21T10:00:00Z"));
    assert_eq!(s.last_tool, Some(tool("Edit", None)));
    let (_, w) = store.find_session_cached("w1").unwrap();
    assert_eq!(w.last_activity_at.as_deref(), Some("2026-10-21T10:00:01Z"));
}
