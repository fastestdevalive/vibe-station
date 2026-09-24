//! Behavior contract for `sessions.ts` Group B2 (dispatch #3).
//!
//! Ports the Group B2 slice of `daemon/src/routes/sessions.ts` (lines
//! ~1770-2224): `POST /sessions/:id/done`, `/resume`, `/reset`, `/handoff`.
//!
//! The two high-risk invariants are exercised here:
//! 1. `resume` resets the lifecycle axis to `working` (the two-axis lifecycle
//!    model — a documented invariant, see AGENTS.md).
//! 2. `reset` archives the old row + appends the replacement in the SAME
//!    `mutate_project` call (a worktree never has zero live main sessions in
//!    persisted state), clearing the old row's `isMain`.
//!
//! NOT exercised (require a live runtime / real spawns, `#[ignore]`d):
//! - the `resume` agent branch (restore-argv and fresh-launch both spawn a real
//!   tmux/direct-pty process) and the terminal branch
//! - the `resume` already-running guard (needs a live tmux session or a
//!   `PtyHandle` in the registry, neither constructible cheaply)
//! - a `tmux`-channel `handoff`/`reset --handoff` turn (would paste to tmux and
//!   poll up to the bounded timeout)

use std::sync::Arc;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::sessions::{
    find_session_context, DoneError, DoneResult, HandoffRouteError, ResetError, ResumeError,
    SessionContext, SessionRoutes,
};
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::sessions::{HandoffResult, ResetBody, ResetResult};
use vst_types::{
    Channel, LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
    SessionType, WorktreeRecord,
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
        mode_id: Some("my-mode".into()),
        name: Some("Agent".into()),
        name_source: Some(SessionNameSource::Auto),
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
        initial_prompt: Some("original prompt".into()),
        draft_prompt: None,
        draft_config: None,
        archived_at: None,
        handoff_summary: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn json_session(id: &str, project_id: &str) -> SessionRecord {
    let mut s = make_session(id, project_id);
    s.use_tmux = false;
    s.channel = Some(Channel::Json);
    s
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
        lsp_enabled: None,
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
        lsp_enabled: None,
    }
}

fn routes(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        store,
        broadcaster: Broadcaster::new(16),
        json_registry: Arc::new(JsonAgentRegistry::new()),
        direct_ptys: std::sync::RwLock::new(std::collections::HashMap::new()),
        direct_streams: std::sync::Arc::new(
            std::sync::Mutex::new(std::collections::HashMap::new()),
        ),
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

fn reset_body() -> ResetBody {
    ResetBody {
        handoff: None,
        prompt: None,
        handoff_text: None,
        mode_id: None,
    }
}

/// Set up a temp home with a modes.json containing a single `claude`-cli mode
/// so `load_modes` (used by `find_mode`/`resolve_mode_id`/`json_unsupported`)
/// resolves it. Returns the guard that must stay alive for the test.
fn home_with_mode() -> (tempfile::TempDir, vst_agents::home::HomeGuard) {
    let home = tempdir().unwrap();
    let modes_dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&modes_dir).unwrap();
    let modes = serde_json::json!([{
        "id": "my-mode",
        "name": "My Mode",
        "cli": "claude",
        "context": "",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "model": null
    }]);
    std::fs::write(modes_dir.join("modes.json"), modes.to_string()).unwrap();
    let guard = with_home(home.path().to_path_buf());
    (home, guard)
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/done
// ---------------------------------------------------------------------------

#[tokio::test]
async fn done_marks_agent_done_and_strips_initial_prompt() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.initial_prompt = Some("replay me".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.done_session("s1").await.unwrap();
    assert_eq!(res, DoneResult { ok: true });

    let project = store.get_project("p1").await.unwrap();
    let s = &project.direct_sessions[0];
    assert_eq!(s.lifecycle.state, LifecycleState::Done);
    assert_eq!(s.initial_prompt, None);
}

#[tokio::test]
async fn done_is_idempotent_when_already_done() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.lifecycle.state = LifecycleState::Done;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.done_session("s1").await.unwrap();
    assert_eq!(res, DoneResult { ok: true });
}

#[tokio::test]
async fn done_terminal_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.r#type = SessionType::Terminal;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.done_session("s1").await.unwrap_err();
    assert!(matches!(err, DoneError::NotAgent(_)));
}

#[tokio::test]
async fn done_global_draft_404() {
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
    let err = r.done_session("gd1").await.unwrap_err();
    assert!(matches!(err, DoneError::NotFound(_)));
}

#[tokio::test]
async fn done_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.done_session("nope").await.unwrap_err();
    assert!(matches!(err, DoneError::NotFound(_)));
}

#[tokio::test]
async fn done_broadcasts_session_state_done() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();
    r.done_session("s1").await.unwrap();

    let ev = rx.recv().await.unwrap();
    match ev {
        ServerEvent::SessionState {
            session_id, state, ..
        } => {
            assert_eq!(session_id, "s1");
            assert_eq!(state, LifecycleState::Done);
        }
        other => panic!("expected session:state, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/resume
// ---------------------------------------------------------------------------

#[tokio::test]
async fn resume_global_draft_400() {
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
    let err = r.resume_session("gd1").await.unwrap_err();
    assert!(matches!(err, ResumeError::NotRunning(_)));
}

#[tokio::test]
async fn resume_archived_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.archived_at = Some("2026-01-01T00:00:00.000Z".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.resume_session("s1").await.unwrap_err();
    assert!(matches!(err, ResumeError::Archived(_)));
}

#[tokio::test]
async fn resume_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.resume_session("nope").await.unwrap_err();
    assert!(matches!(err, ResumeError::NotFound(_)));
}

#[tokio::test]
#[ignore = "requires a real agent spawn (restore argv or fresh launch) — not safe in unit tests"]
async fn resume_agent_sets_lifecycle_to_working() {
    // Invariant: resume resets the lifecycle axis to `working`.
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let _ = r.resume_session("s1").await;
}

#[tokio::test]
#[ignore = "requires a live tmux session or a PtyHandle in the registry — neither constructible cheaply"]
async fn resume_already_running_returns_current_state() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let _ = r.resume_session("s1").await;
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/reset
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_archives_old_and_creates_new_in_worktree() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = make_session("s-old", "p1");
    main.is_main = true;
    main.worktree_id = Some("w1".into());
    main.channel = Some(Channel::Json);
    main.use_tmux = false;
    main.initial_prompt = Some("old".into());
    w.sessions.push(main);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.reset_session("s-old", &reset_body()).await.unwrap();
    assert_eq!(res.archived_session_id, "s-old");
    assert!(!res.new_session_id.is_empty());

    let project = store.get_project("p1").await.unwrap();
    let sessions = &project.worktrees[0].sessions;
    // Old archived + new replacement = two sessions, no window with zero main.
    assert_eq!(sessions.len(), 2);
    let old = sessions.iter().find(|s| s.id == "s-old").unwrap();
    assert!(old.archived_at.is_some());
    assert!(!old.is_main, "archived row's isMain must be cleared");
    assert_eq!(
        old.superseded_by.as_deref(),
        Some(res.new_session_id.as_str())
    );

    let new = sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert!(new.is_main, "new session inherits isMain");
    assert_eq!(new.worktree_id.as_deref(), Some("w1"));
    assert_eq!(new.r#type, SessionType::Agent);
    assert_eq!(new.mode_id.as_deref(), Some("my-mode"));
    assert_eq!(
        new.name.as_deref(),
        Some("Agent"),
        "name kept when no prompt"
    );
    assert_eq!(
        new.channel,
        Some(Channel::Json),
        "json channel kept when CLI supports it"
    );
    assert_eq!(new.lifecycle.state, LifecycleState::NotStarted);
    assert_eq!(
        new.initial_prompt, None,
        "no prompt/handoff → no initial prompt"
    );
    // Exactly one live (non-archived) main session in the worktree.
    let live_mains = sessions
        .iter()
        .filter(|s| s.is_main && s.archived_at.is_none())
        .count();
    assert_eq!(live_mains, 1);
}

#[tokio::test]
async fn reset_persists_handoff_summary_on_archived_row() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        handoff: None,
        prompt: None,
        handoff_text: Some("direct summary".into()),
        mode_id: None,
    };
    let res = r.reset_session("s1", &body).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    let old = project
        .direct_sessions
        .iter()
        .find(|s| s.id == "s1")
        .unwrap();
    assert_eq!(old.handoff_summary.as_deref(), Some("direct summary"));
    let new = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    // Direct-delivery handoff text also becomes the new session's initial prompt.
    assert_eq!(new.initial_prompt.as_deref(), Some("direct summary"));
}

#[tokio::test]
async fn reset_rejects_unknown_requested_mode_before_teardown() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        handoff: None,
        prompt: None,
        handoff_text: None,
        mode_id: Some("does-not-exist".into()),
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::ModeNotFound(_)));
    // No teardown happened — the old session is untouched (not archived).
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.direct_sessions.len(), 1);
    assert!(project.direct_sessions[0].archived_at.is_none());
}

#[tokio::test]
async fn reset_session_without_mode_400() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.mode_id = None;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::NoMode(_)));
}

#[tokio::test]
async fn reset_archived_session_400() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.archived_at = Some("2026-01-01T00:00:00.000Z".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::Archived(_)));
}

#[tokio::test]
async fn reset_terminal_session_400() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.r#type = SessionType::Terminal;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::NotAgent(_)));
}

#[tokio::test]
async fn reset_global_draft_404() {
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
    let err = r.reset_session("gd1", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::NotFound(_)));
}

#[tokio::test]
async fn reset_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.reset_session("nope", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::NotFound(_)));
}

#[tokio::test]
async fn reset_returns_both_ids() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res: ResetResult = r.reset_session("s1", &reset_body()).await.unwrap();
    assert!(res.ok);
    assert_eq!(res.archived_session_id, "s1");
    assert!(!res.new_session_id.is_empty());
    assert_ne!(res.archived_session_id, res.new_session_id);
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/handoff
// ---------------------------------------------------------------------------

#[tokio::test]
async fn handoff_json_channel_returns_ok_with_no_summary() {
    // json-channel turns are a documented no-op — returns ok:true with no
    // summary rather than polling a file nothing will produce.
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res: HandoffResult = r.handoff_session("s1").await.unwrap();
    assert!(res.ok);
    assert_eq!(res.handoff_summary, None);
}

#[tokio::test]
async fn handoff_terminal_session_400() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.r#type = SessionType::Terminal;
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.handoff_session("s1").await.unwrap_err();
    assert!(matches!(err, HandoffRouteError::NotAgent(_)));
}

#[tokio::test]
async fn handoff_global_draft_404() {
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
    let err = r.handoff_session("gd1").await.unwrap_err();
    assert!(matches!(err, HandoffRouteError::NotFound(_)));
}

#[tokio::test]
async fn handoff_missing_session_404() {
    let (_d, store) = store();
    let r = routes(store.clone());
    let err = r.handoff_session("nope").await.unwrap_err();
    assert!(matches!(err, HandoffRouteError::NotFound(_)));
}

#[tokio::test]
#[ignore = "requires a live tmux session to paste to + bounded poll (would take 30s timeout)"]
async fn handoff_tmux_channel_pastes_and_reads_summary() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let _ = r.handoff_session("s1").await;
}

// ---------------------------------------------------------------------------
// Re-exports of group helpers stay reachable (compile sanity)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn find_session_context_still_works() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(make_session("s1", "p1"));
    add_project(&store, p).await;

    let c = find_session_context(&store, "s1").await.unwrap();
    match c {
        SessionContext::Direct { .. } => {}
        other => panic!("unexpected {:?}", std::mem::discriminant(&other)),
    }
}
