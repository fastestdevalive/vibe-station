//! `StoreHandle::find_session` — the session-id lookup the hot WS paths
//! (`session:open`/`input`/`resize`) use instead of deep-cloning the whole
//! store via `get_all_projects()` on every message.
//!
//! Two things are load-bearing here and both have burned us before:
//!   1. Direct sessions (a project's `direct_sessions`, no worktree) must be
//!      scanned. The Node original only scanned `project.worktrees`, so every
//!      direct session was invisible to the WS lookup and the daemon answered
//!      "Session not found" while the agent was alive and healthy.
//!   2. `ensure_loaded()` must run first. Without it, the very first lookup
//!      after a cold daemon start reads an empty cache and returns `None`,
//!      which the caller reports as "session not found".

use vst_store::StoreHandle;
use vst_types::{LifecycleState, ProjectRecord, SessionRecord, SessionType, WorktreeRecord};

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(|w| w.into()),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
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
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn project(id: &str, worktree_sessions: &[&str], direct_sessions: &[&str]) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: id.chars().take(4).collect(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: direct_sessions
            .iter()
            .map(|s| session(s, id, None))
            .collect(),
        direct_session_seq: None,
        worktrees: if worktree_sessions.is_empty() {
            vec![]
        } else {
            vec![WorktreeRecord {
                id: format!("{id}-w1"),
                name: None,
                branch: "b".into(),
                branch_is_placeholder: None,
                base_branch: "main".into(),
                base_sha: "a".repeat(40),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                pinned_at: None,
                hidden_at: None,
                sort_order: 0.0,
                terminal_seq: Some(0),
                agent_seq: Some(0),
                lsp_enabled: None,
                sessions: worktree_sessions
                    .iter()
                    .map(|s| session(s, id, Some(&format!("{id}-w1"))))
                    .collect(),
            }]
        },
        next_worktree_num: None,
        lsp_enabled: None,
    }
}

async fn seeded_store(dir: &std::path::Path) -> StoreHandle {
    let store = StoreHandle::open(dir.join("vibe-station.db")).unwrap();
    store
        .add_project(project("proj-1", &["proj-1-w1-m"], &["proj-1-d1"]))
        .await
        .unwrap();
    store
        .add_project(project("proj-2", &[], &["proj-2-d1"]))
        .await
        .unwrap();
    store
}

#[tokio::test]
async fn finds_a_worktree_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded_store(dir.path()).await;

    let (p, s) = store.find_session("proj-1-w1-m").await.unwrap();
    assert_eq!(p.id, "proj-1");
    assert_eq!(s.id, "proj-1-w1-m");
    assert_eq!(s.worktree_id.as_deref(), Some("proj-1-w1"));
}

#[tokio::test]
async fn finds_a_direct_session_with_no_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded_store(dir.path()).await;

    let (p, s) = store.find_session("proj-1-d1").await.unwrap();
    assert_eq!(p.id, "proj-1");
    assert_eq!(s.id, "proj-1-d1");
    assert!(s.worktree_id.is_none());
}

#[tokio::test]
async fn finds_a_direct_session_in_a_later_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded_store(dir.path()).await;

    let (p, s) = store.find_session("proj-2-d1").await.unwrap();
    assert_eq!(p.id, "proj-2");
    assert_eq!(s.id, "proj-2-d1");
}

#[tokio::test]
async fn returns_none_for_an_unknown_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded_store(dir.path()).await;

    assert!(store.find_session("nope").await.is_none());
}

/// Cold start: a brand-new handle over an existing DB whose cache has never
/// been loaded. `find_session` must `ensure_loaded()` itself rather than
/// reading an empty cache and reporting the session as missing.
#[tokio::test]
async fn loads_the_cache_on_a_cold_handle() {
    let dir = tempfile::tempdir().unwrap();
    {
        let _seed = seeded_store(dir.path()).await;
    }

    // Fresh handle, no `get_project`/`get_all_projects` call to warm the cache.
    let cold = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let (_p, s) = cold
        .find_session("proj-1-d1")
        .await
        .expect("cold handle must load the cache before answering");
    assert_eq!(s.id, "proj-1-d1");
}
