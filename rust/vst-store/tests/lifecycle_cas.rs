//! `StoreHandle::update_session_lifecycle_if` — the compare-and-set the
//! lifecycle poller uses so a stale dead-pane snapshot can never overwrite a
//! session that was resumed (new state / new `lastTransitionAt`) in between.

use vst_store::StoreHandle;
use vst_types::{LifecycleState, ProjectRecord, SessionLifecycle, SessionRecord, SessionType};

const TS: &str = "2024-01-01T00:00:00.000Z";

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(|w| w.into()),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
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

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "p".into(),
        absolute_path: "/fake/p".into(),
        prefix: "p".into(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: TS.into(),
        hidden: None,
        direct_sessions: vec![session("s1", "p", None)],
        direct_session_seq: None,
        worktrees: vec![],
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

fn exited(reason: &str) -> SessionLifecycle {
    SessionLifecycle {
        state: LifecycleState::Exited,
        reason: Some(reason.into()),
        last_transition_at: "2024-02-02T00:00:00.000Z".into(),
    }
}

async fn stored(store: &StoreHandle) -> SessionLifecycle {
    store.find_session("s1").await.unwrap().1.lifecycle
}

#[tokio::test]
async fn applies_when_state_and_timestamp_match() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("t.db")).unwrap();
    store.add_project(project()).await.unwrap();

    let applied = store
        .update_session_lifecycle_if("p", "s1", LifecycleState::Idle, TS, exited("r"))
        .await
        .unwrap();
    assert!(applied);
    let lc = stored(&store).await;
    assert_eq!(lc.state, LifecycleState::Exited);
    assert_eq!(lc.reason.as_deref(), Some("r"));
    assert_eq!(lc.last_transition_at, "2024-02-02T00:00:00.000Z");
}

#[tokio::test]
async fn changes_nothing_when_state_or_timestamp_differ_or_session_missing() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("t.db")).unwrap();
    store.add_project(project()).await.unwrap();

    // Wrong expected state.
    assert!(!store
        .update_session_lifecycle_if("p", "s1", LifecycleState::Working, TS, exited("r"))
        .await
        .unwrap());
    // Right state, stale timestamp.
    assert!(!store
        .update_session_lifecycle_if(
            "p",
            "s1",
            LifecycleState::Idle,
            "2023-01-01T00:00:00.000Z",
            exited("r")
        )
        .await
        .unwrap());
    // Unknown session.
    assert!(!store
        .update_session_lifecycle_if("p", "nope", LifecycleState::Idle, TS, exited("r"))
        .await
        .unwrap());

    let lc = stored(&store).await;
    assert_eq!(lc.state, LifecycleState::Idle);
    assert_eq!(lc.reason, None);
    assert_eq!(lc.last_transition_at, TS);
}
