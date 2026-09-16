//! Behavior contract for `sessions.ts` Group B1 (dispatch #2).
//!
//! Ports the Group B1 slice of `daemon/src/routes/sessions.ts` (lines
//! 1072-~1770): `DELETE /sessions/:id`, `PATCH /sessions/:id/draft`,
//! `POST /sessions/:id/start` (draft promotion), and
//! `PATCH /sessions/:id/pin|rename|reorder|delink`.
//!
//! The two highest-risk invariants are exercised here:
//! 1. `DELETE` main-session promotion re-derives "is main / has eligible
//!    sibling" INSIDE the store's locked `mutate_project` callback.
//! 2. `POST /start` builds its response from fully-persisted state before the
//!    fire-and-forget spawn.
//!
//! NOT exercised (require a live git repo, `#[ignore]`d): the
//! `isWorktreeNew` arm of `POST /start` (calls `git worktree add`), and the
//! actual tmux/pty spawn jobs (spawn is fired with `skipAutoTurn: true` +
//! json channel so it short-circuits in tests).

use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{
    find_session_context, find_worktree_context, DeleteError, DeleteResult, DraftError,
    MutateError, SessionContext, SessionRoutes, StartError,
};
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::{
    DelinkResult, PatchDraftBody, PinResult, RenameSessionResult, ReorderSessionResult,
    StartDraftBody, StartDraftResult,
};
use vst_types::{
    Channel, DraftConfig, DraftEntryPoint, LifecycleState, PrState, PrStatus, ProjectRecord,
    SessionLifecycle, SessionNameSource, SessionRecord, SessionType, WorktreeChoice,
    WorktreeRecord,
};
use vst_ws::state::attachment_registry::AttachmentRegistry;

fn store() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempdir().unwrap();
    let s = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, s)
}

fn make_session(id: &str, project_id: &str) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: None,
        project_id: project_id.into(),
        is_main: false,
        sort_order: 1.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        name: None,
        name_source: None,
        tmux_name: format!("vst-{id}"),
        use_tmux: true,
        channel: Some(Channel::Tmux),
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
        terminal_seq: Some(1),
        agent_seq: Some(1),
        sessions: vec![],
    }
}

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
        direct_session_seq: Some(1),
        worktrees: vec![],
        next_worktree_num: Some(1),
    }
}

fn routes(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        tmux: vst_proc::tmux::Tmux::new(),
        daemon_port: 3999,
        json_unsupported: Arc::new(|_| None),
        subagent_notify: SubagentNotifyHandle::new(),
        attachment_registry: AttachmentRegistry::new(),
    }
}

async fn add_project(store: &StoreHandle, p: ProjectRecord) {
    store.add_project(p).await.unwrap();
}

fn drafting_session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.worktree_id = worktree_id.map(str::to_string);
    s.lifecycle.state = LifecycleState::Drafting;
    s.channel = Some(Channel::Json);
    s.use_tmux = false;
    s.draft_prompt = Some("initial".into());
    s
}

fn draft_config(entry: DraftEntryPoint, mode_id: &str) -> DraftConfig {
    DraftConfig {
        entry_point: entry,
        mode_id: Some(mode_id.to_string()),
        channel: Some(Channel::Json),
        worktree_choice: None,
        existing_worktree_id: None,
        branch: None,
        base_branch: None,
        use_tmux: None,
        use_worktree: None,
    }
}

// ---------------------------------------------------------------------------
// DELETE /sessions/:id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_global_draft_removes_row() {
    let (_d, store) = store();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: Some("hi".into()),
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let res = r.delete_session("gd1").await.unwrap();
    assert_eq!(
        res,
        DeleteResult {
            promoted_session_id: None
        }
    );
    assert!(store.get_global_draft("gd1").await.is_none());
}

#[tokio::test]
async fn delete_direct_session_removes_from_direct_sessions() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s-dir", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.delete_session("s-dir").await.unwrap();
    assert_eq!(res.promoted_session_id, None);
    let project = store.get_project("p1").await.unwrap();
    assert!(project.direct_sessions.is_empty());
}

#[tokio::test]
async fn delete_worktree_non_main_session_no_promotion() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-main", "p1");
    main.is_main = true;
    main.sort_order = 1.0;
    let mut other = make_session("s-other", "p1");
    other.worktree_id = Some("w1".into());
    other.sort_order = 2.0;
    w.sessions.push(main);
    w.sessions.push(other);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.delete_session("s-other").await.unwrap();
    assert_eq!(res.promoted_session_id, None);
    let project = store.get_project("p1").await.unwrap();
    let sessions = &project.worktrees[0].sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "s-main");
    assert!(sessions[0].is_main);
}

#[tokio::test]
async fn delete_worktree_main_promotes_eligible_sibling_and_carries_pr() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-main", "p1");
    main.is_main = true;
    main.sort_order = 1.0;
    main.pr = Some(PrStatus {
        state: PrState::Open,
        number: Some(42),
        url: Some("https://example.com/pr/42".into()),
        checked_at: "2026-01-01T00:00:00.000Z".into(),
        error: None,
        pr_branch: Some("branch-w1".into()),
    });
    let mut other = make_session("s-other", "p1");
    other.worktree_id = Some("w1".into());
    other.sort_order = 2.0;
    w.sessions.push(main);
    w.sessions.push(other);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.delete_session("s-main").await.unwrap();
    assert_eq!(res.promoted_session_id.as_deref(), Some("s-other"));

    let project = store.get_project("p1").await.unwrap();
    let sessions = &project.worktrees[0].sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "s-other");
    assert!(sessions[0].is_main);
    // Old main's PR is carried onto the promoted session.
    assert_eq!(sessions[0].pr.as_ref().unwrap().number, Some(42));
}

#[tokio::test]
async fn delete_worktree_main_sole_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-main", "p1");
    main.is_main = true;
    w.sessions.push(main);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.delete_session("s-main").await.unwrap_err();
    assert!(matches!(err, DeleteError::NoEligibleSibling(_)));
}

#[tokio::test]
async fn delete_worktree_main_with_only_terminal_sibling_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-main", "p1");
    main.is_main = true;
    main.sort_order = 1.0;
    let mut term = make_session("s-term", "p1");
    term.r#type = SessionType::Terminal;
    term.sort_order = 2.0;
    w.sessions.push(main);
    w.sessions.push(term);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.delete_session("s-main").await.unwrap_err();
    assert!(matches!(err, DeleteError::NoEligibleSibling(_)));
}

#[tokio::test]
async fn delete_worktree_main_with_only_drafting_sibling_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-main", "p1");
    main.is_main = true;
    main.sort_order = 1.0;
    let mut draft = drafting_session("s-draft", "p1", Some("w1"));
    draft.sort_order = 2.0;
    w.sessions.push(main);
    w.sessions.push(draft);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.delete_session("s-main").await.unwrap_err();
    assert!(matches!(err, DeleteError::NoEligibleSibling(_)));
}

#[tokio::test]
async fn delete_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.delete_session("nope").await.unwrap_err();
    assert!(matches!(err, DeleteError::NotFound(_)));
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/draft
// ---------------------------------------------------------------------------

#[tokio::test]
async fn patch_draft_global_updates_and_renames() {
    let (_d, store) = store();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: Some("old".into()),
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("build a todo app".into()),
        draft_config: Some(serde_json::json!({"entryPoint": "global"})),
    };
    let res = r.patch_session_draft("gd1", &body).await.unwrap();
    assert!(res.ok);
    assert!(res.name.is_some());

    let row = store.get_global_draft("gd1").await.unwrap();
    assert_eq!(row.draft_prompt.as_deref(), Some("build a todo app"));
    assert!(row.draft_config.is_some());
    assert_eq!(row.name_source.as_deref(), Some("auto"));
}

#[tokio::test]
async fn patch_draft_global_no_rename_when_user_named() {
    let (_d, store) = store();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: Some("old".into()),
            draft_config: None,
            name: Some("Keep Me".into()),
            name_source: Some("user".into()),
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("build a todo app".into()),
        draft_config: None,
    };
    let res = r.patch_session_draft("gd1", &body).await.unwrap();
    assert!(res.ok);
    assert_eq!(res.name, None);
    let row = store.get_global_draft("gd1").await.unwrap();
    assert_eq!(row.name.as_deref(), Some("Keep Me"));
}

#[tokio::test]
async fn patch_draft_worktree_updates_session() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions
        .push(drafting_session("s-draft", "p1", Some("w1")));
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("a brand new prompt".into()),
        draft_config: Some(serde_json::json!({"entryPoint": "tab"})),
    };
    let res = r.patch_session_draft("s-draft", &body).await.unwrap();
    assert!(res.ok);
    assert!(res.name.is_some());

    let project = store.get_project("p1").await.unwrap();
    let s = &project.worktrees[0].sessions[0];
    assert_eq!(s.draft_prompt.as_deref(), Some("a brand new prompt"));
    assert!(s.draft_config.is_some());
    assert_eq!(s.name_source, Some(SessionNameSource::Auto));
}

#[tokio::test]
async fn patch_draft_direct_updates_direct_session() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("direct prompt".into()),
        draft_config: None,
    };
    r.patch_session_draft("s-draft", &body).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        project.direct_sessions[0].draft_prompt.as_deref(),
        Some("direct prompt")
    );
}

#[tokio::test]
async fn patch_draft_not_drafting_403() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s-running", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("x".into()),
        draft_config: None,
    };
    let err = r.patch_session_draft("s-running", &body).await.unwrap_err();
    assert!(matches!(err, DraftError::NotDrafting(_)));
}

#[tokio::test]
async fn patch_draft_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let body = PatchDraftBody {
        draft_prompt: Some("x".into()),
        draft_config: None,
    };
    let err = r.patch_session_draft("nope", &body).await.unwrap_err();
    assert!(matches!(err, DraftError::NotFound(_)));
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/start
// ---------------------------------------------------------------------------

#[tokio::test]
async fn start_global_draft_400() {
    let (_d, store) = store();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: Some("hi".into()),
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "hi".into(),
        draft_config: draft_config(DraftEntryPoint::Global, "m"),
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("gd1", &body).await.unwrap_err();
    assert!(matches!(err, StartError::Validation(_)));
}

#[tokio::test]
async fn start_not_drafting_403() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s-running", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "x".into(),
        draft_config: draft_config(DraftEntryPoint::Direct, "m"),
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-running", &body).await.unwrap_err();
    assert!(matches!(err, StartError::NotDrafting(_)));
}

#[tokio::test]
async fn start_empty_prompt_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "   ".into(),
        draft_config: draft_config(DraftEntryPoint::Direct, "m"),
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-draft", &body).await.unwrap_err();
    assert!(matches!(err, StartError::Validation(_)));
}

#[tokio::test]
async fn start_missing_mode_id_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut cfg = draft_config(DraftEntryPoint::Direct, "m");
    cfg.mode_id = None;
    let body = StartDraftBody {
        draft_prompt: "x".into(),
        draft_config: cfg,
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-draft", &body).await.unwrap_err();
    assert!(matches!(err, StartError::Validation(_)));
}

#[tokio::test]
async fn start_direct_entry_promotes_to_direct() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "do the thing".into(),
        draft_config: draft_config(DraftEntryPoint::Direct, "my-mode"),
        skip_auto_turn: Some(true),
    };
    let res = r.start_session("s-draft", &body).await.unwrap();
    assert_eq!(
        res,
        StartDraftResult {
            ok: true,
            worktree_id: None
        }
    );

    let project = store.get_project("p1").await.unwrap();
    let s = &project.direct_sessions[0];
    assert_eq!(s.lifecycle.state, LifecycleState::NotStarted);
    assert_eq!(s.mode_id.as_deref(), Some("my-mode"));
    assert_eq!(s.worktree_id, None);
    assert!(s.initial_prompt.as_deref() == Some("do the thing"));
    assert_eq!(s.draft_prompt, None);
    assert_eq!(s.draft_config, None);
}

#[tokio::test]
async fn start_tab_entry_promotes_into_worktree() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(drafting_session("s-tab", "p1", Some("w1")));
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "tab task".into(),
        draft_config: draft_config(DraftEntryPoint::Tab, "my-mode"),
        skip_auto_turn: Some(true),
    };
    let res = r.start_session("s-tab", &body).await.unwrap();
    assert_eq!(res.worktree_id, None);

    let project = store.get_project("p1").await.unwrap();
    let s = &project.worktrees[0].sessions[0];
    assert_eq!(s.id, "s-tab");
    assert_eq!(s.worktree_id.as_deref(), Some("w1"));
    assert_eq!(s.lifecycle.state, LifecycleState::NotStarted);
    assert!(!s.is_main);
}

#[tokio::test]
async fn start_unknown_entry_point_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut cfg = draft_config(DraftEntryPoint::Global, "m");
    cfg.use_worktree = None; // neither true (worktree-new) nor false (direct)
    let body = StartDraftBody {
        draft_prompt: "x".into(),
        draft_config: cfg,
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-draft", &body).await.unwrap_err();
    assert!(matches!(err, StartError::Validation(_)));
}

#[tokio::test]
#[ignore = "requires a live git repo (git worktree add)"]
async fn start_worktree_new_promotes_into_new_worktree() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions
        .push(drafting_session("s-draft", "p1", None));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut cfg = draft_config(DraftEntryPoint::Worktree, "my-mode");
    cfg.worktree_choice = Some(WorktreeChoice::New);
    let body = StartDraftBody {
        draft_prompt: "new worktree task".into(),
        draft_config: cfg,
        skip_auto_turn: Some(true),
    };
    let res = r.start_session("s-draft", &body).await.unwrap();
    assert!(res.worktree_id.is_some());

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.worktrees.len(), 1);
    let w = &project.worktrees[0];
    assert_eq!(w.sessions.len(), 1);
    assert!(w.sessions[0].is_main);
    assert!(project.direct_sessions.is_empty());
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/pin
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pin_toggles_and_is_idempotent() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let pin1: PinResult = r.pin_session("s1", true).await.unwrap();
    assert!(pin1.ok);
    assert!(pin1.pinned_at.is_some());

    // Idempotent — same value returns unchanged pinnedAt.
    let project = store.get_project("p1").await.unwrap();
    let pinned_at = project.direct_sessions[0].pinned_at.clone();
    let pin2 = r.pin_session("s1", true).await.unwrap();
    assert_eq!(pin2.pinned_at, pinned_at);

    // Unpin clears.
    let unpin = r.pin_session("s1", false).await.unwrap();
    assert!(unpin.pinned_at.is_none());
    let project = store.get_project("p1").await.unwrap();
    assert!(project.direct_sessions[0].pinned_at.is_none());
}

#[tokio::test]
async fn pin_missing_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.pin_session("nope", true).await.unwrap_err();
    assert!(matches!(err, MutateError::NotFound(_)));
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/rename
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rename_sets_user_name_and_clears_with_empty() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.worktrees.push(make_worktree("w1"));
    let mut w = p.worktrees[0].clone();
    w.sessions.push(make_session("s1", "p1"));
    p.worktrees[0] = w;
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res: RenameSessionResult = r.rename_session("s1", "My Renamed Agent").await.unwrap();
    assert_eq!(res.name.as_deref(), Some("My Renamed Agent"));

    let project = store.get_project("p1").await.unwrap();
    let s = &project.worktrees[0].sessions[0];
    assert_eq!(s.name.as_deref(), Some("My Renamed Agent"));
    assert_eq!(s.name_source, Some(SessionNameSource::User));

    // Empty clears back to None.
    let cleared = r.rename_session("s1", "   ").await.unwrap();
    assert_eq!(cleared.name, None);
    let project = store.get_project("p1").await.unwrap();
    assert!(project.worktrees[0].sessions[0].name.is_none());
}

#[tokio::test]
async fn rename_truncates_to_60_chars() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let long = "a".repeat(100);
    let r = routes(store.clone());
    let res = r.rename_session("s1", &long).await.unwrap();
    assert_eq!(res.name.as_deref().unwrap().chars().count(), 60);
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/reorder
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reorder_persists_worktree_sort_order() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(make_session("s1", "p1"));
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res: ReorderSessionResult = r.reorder_session("s1", 12.5).await.unwrap();
    assert_eq!(res.sort_order, 12.5);
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.worktrees[0].sessions[0].sort_order, 12.5);
}

#[tokio::test]
async fn reorder_persists_global_draft_sort_order() {
    let (_d, store) = store();
    store
        .add_global_draft(&vst_store::global_drafts::GlobalDraftRow {
            id: "gd1".into(),
            draft_prompt: None,
            draft_config: None,
            name: None,
            name_source: None,
            sort_order: Some(1.0),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();

    let r = routes(store.clone());
    let res = r.reorder_session("gd1", 99.0).await.unwrap();
    assert_eq!(res.sort_order, 99.0);
    let row = store.get_global_draft("gd1").await.unwrap();
    assert_eq!(row.sort_order, Some(99.0));
}

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/delink
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delink_clears_parent_session_id() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s-child", "p1");
    s.parent_session_id = Some("s-parent".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res: DelinkResult = r.delink_session("s-child").await.unwrap();
    let _ = res;
    let project = store.get_project("p1").await.unwrap();
    assert!(project.direct_sessions[0].parent_session_id.is_none());
}

#[tokio::test]
async fn delink_archived_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s-archived", "p1");
    s.archived_at = Some("2026-01-01T00:00:00.000Z".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.delink_session("s-archived").await.unwrap_err();
    assert!(matches!(err, MutateError::Archived(_)));
}

// ---------------------------------------------------------------------------
// Re-exports of group-A helpers stay reachable (compile sanity)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn find_session_context_and_worktree_still_work() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    w.sessions.push(make_session("s1", "p1"));
    p.worktrees.push(w);
    add_project(&store, p).await;

    let c = find_session_context(&store, "s1").await.unwrap();
    match c {
        SessionContext::Worktree { .. } => {}
        other => panic!("unexpected {:?}", std::mem::discriminant(&other)),
    }
    let (_, w) = find_worktree_context(&store, "w1").await.unwrap();
    assert_eq!(w.id, "w1");
}
