//! `draft_texts` table: revision monotonicity, tombstones, list/delete, and
//! surviving a project save (no FK — see the schema comment).

use vst_store::draft_texts::PutOutcome;
use vst_store::StoreHandle;
use vst_types::{LifecycleState, ProjectRecord, SessionRecord, SessionType, WorktreeRecord};

const T0: &str = "2026-01-01T00:00:00.000Z";

fn open() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, store)
}

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(Into::into),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        account_id: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: T0.into(),
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

fn project(id: &str, worktree_id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: "prj".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: T0.into(),
        hidden: None,
        direct_sessions: vec![session("direct-1", id, None)],
        direct_session_seq: None,
        worktrees: vec![WorktreeRecord {
            id: worktree_id.into(),
            name: None,
            branch: "b".into(),
            branch_is_placeholder: None,
            base_branch: "main".into(),
            base_sha: "a".repeat(40),
            created_at: T0.into(),
            pinned_at: None,
            hidden_at: None,
            sort_order: 0.0,
            terminal_seq: Some(0),
            agent_seq: Some(0),
            lsp_enabled: None,
            sessions: vec![session("sess-1", id, Some(worktree_id))],
            open_files: vec![],
        }],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

#[tokio::test]
async fn put_creates_revision_1() {
    let (_d, store) = open();
    let outcome = store
        .put_draft_text("sess-1", "hello", "client-a", T0)
        .await
        .unwrap();
    let PutOutcome::Written(row) = outcome else {
        panic!("first put must be Written, got {outcome:?}");
    };
    assert_eq!(row.revision, 1);
    assert_eq!(row.text, "hello");
    assert_eq!(row.client_id.as_deref(), Some("client-a"));
    assert_eq!(row.updated_at, T0);

    let read = store.get_draft_text("sess-1").await.unwrap().unwrap();
    assert_eq!(read, row);
}

#[tokio::test]
async fn put_same_text_is_unchanged() {
    let (_d, store) = open();
    let first = store
        .put_draft_text("sess-1", "hello", "client-a", T0)
        .await
        .unwrap();
    let PutOutcome::Written(written) = first else {
        panic!("expected Written");
    };

    let outcome = store
        .put_draft_text("sess-1", "hello", "client-b", "2026-01-01T00:00:01.000Z")
        .await
        .unwrap();
    let PutOutcome::Unchanged(row) = outcome else {
        panic!("equal text must be Unchanged, got {outcome:?}");
    };
    // Same doc: revision, updatedAt and clientId are all left as stored.
    assert_eq!(row, written);
    assert_eq!(
        store.get_draft_text("sess-1").await.unwrap().unwrap(),
        written
    );
}

#[tokio::test]
async fn put_empty_keeps_tombstone_and_next_put_continues_revision() {
    let (_d, store) = open();
    store
        .put_draft_text("sess-1", "hello", "client-a", T0)
        .await
        .unwrap();
    let outcome = store
        .put_draft_text("sess-1", "", "client-a", "2026-01-01T00:00:01.000Z")
        .await
        .unwrap();
    let PutOutcome::Written(tombstone) = outcome else {
        panic!("clearing text is a real change (Written)");
    };
    assert_eq!(tombstone.revision, 2);
    assert_eq!(tombstone.text, "");

    // The empty row is still there — deleting it would restart revision at 1.
    let read = store.get_draft_text("sess-1").await.unwrap().unwrap();
    assert_eq!(read.text, "");
    assert_eq!(read.revision, 2);

    let outcome = store
        .put_draft_text("sess-1", "again", "client-b", "2026-01-01T00:00:02.000Z")
        .await
        .unwrap();
    let PutOutcome::Written(next) = outcome else {
        panic!("expected Written");
    };
    assert_eq!(next.revision, 3);
}

#[tokio::test]
async fn list_includes_tombstones() {
    let (_d, store) = open();
    store
        .put_draft_text("global-new", "draft prompt", "client-a", T0)
        .await
        .unwrap();
    store
        .put_draft_text("review-picker:worktree:wt-1", "note", "client-a", T0)
        .await
        .unwrap();
    store
        .put_draft_text("review-picker:worktree:wt-1", "", "client-b", T0)
        .await
        .unwrap();

    let rows = store.list_draft_texts().await.unwrap();
    assert_eq!(rows.len(), 2);
    let by_scope: std::collections::HashMap<_, _> =
        rows.iter().map(|r| (r.scope.as_str(), r)).collect();
    assert_eq!(by_scope["global-new"].text, "draft prompt");
    assert_eq!(by_scope["review-picker:worktree:wt-1"].text, "");
    assert_eq!(by_scope["review-picker:worktree:wt-1"].revision, 2);
}

#[tokio::test]
async fn delete_removes_row() {
    let (_d, store) = open();
    store
        .put_draft_text("sess-1", "hello", "client-a", T0)
        .await
        .unwrap();
    assert!(store.delete_draft_text("sess-1").await.unwrap());
    assert!(store.get_draft_text("sess-1").await.unwrap().is_none());
    assert!(!store.delete_draft_text("sess-1").await.unwrap());
    assert_eq!(store.list_draft_texts().await.unwrap(), vec![]);
}

/// No FK: every project save deletes and re-inserts the project's sessions,
/// which must not wipe the draft row (nor reset its revision).
#[tokio::test]
async fn survives_mutate_project() {
    let (_d, store) = open();
    store.add_project(project("p1", "wt-1")).await.unwrap();
    store
        .put_draft_text("sess-1", "typed", "client-a", T0)
        .await
        .unwrap();

    store
        .mutate_project("p1", |p| {
            p.worktrees[0]
                .sessions
                .push(session("sess-2", "p1", Some("wt-1")));
            Ok(p.clone())
        })
        .await
        .unwrap();

    let row = store.get_draft_text("sess-1").await.unwrap().unwrap();
    assert_eq!(row.text, "typed");
    assert_eq!(row.revision, 1);
}
