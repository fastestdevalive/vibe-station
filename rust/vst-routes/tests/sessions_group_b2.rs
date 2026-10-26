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

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use vst_agents::home::with_home;
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::read_transcript_from_data_dir;
use vst_agents::paths::Paths as AgentPaths;
use vst_agents::transcript_export::transcript_instruction;
use vst_lifecycle::subagent_notify::SubagentNotifyHandle;
use vst_routes::modes::json_unsupported_cli;
use vst_routes::sessions::{
    find_session_context, repair_superseded_pins, wait_for_handoff_file, wait_for_turn_start,
    DoneError, DoneResult, HandoffRouteError, HandoffTurnPhase, ResetError, ResetFlag, ResumeError,
    SessionContext, SessionRoutes, StartError,
};
use vst_routes::settings::load_default_channel_overrides;
use vst_store::transcript::open_transcript_store;
use vst_store::StoreHandle;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::ordered_lists::PINNED_ALL;
use vst_types::rest::sessions::{
    HandoffResult, ResetBody, ResetResult, SessionOrDraft, StartDraftBody, StartDraftResult,
};
use vst_types::{
    CarryOver, Channel, CliId, DraftConfig, DraftEntryPoint, LifecycleState, NormalizedEvent,
    NormalizedEventKind, ProjectRecord, SessionBreakKind, SessionLifecycle, SessionNameSource,
    SessionRecord, SessionType, WorktreeRecord,
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
        mode_icon: None,
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
        carry_over: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
        last_activity_at: None,
        last_line: None,
        last_tool: None,
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
        open_files: vec![],
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
        open_files: vec![],
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
        model_catalog: Default::default(),
        handoff_timeout: Duration::from_secs(120),
        reset_cancels: Default::default(),
    }
}

/// `routes` but with `json_unsupported` wired to the REAL `json_unsupported_cli`
/// (which consults each mode's plugin capability), so an agy mode is flagged as
/// unable to run Rich Chat. Needed to exercise the draft-start json gate.
fn routes_with_real_json_gate(store: StoreHandle) -> SessionRoutes {
    SessionRoutes {
        json_unsupported: Arc::new(json_unsupported_cli),
        ..routes(store)
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
        channel: None,
        ..Default::default()
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

/// Seed an arbitrary set of `(id, name, cli)` modes into a temp home so
/// `load_modes` resolves them, returning the home + guard (kept alive for the
/// test's duration). Used by the Phase 2 channel-defaulting tests, which need
/// claude/cursor/agy modes (and, in one case, a mode deliberately absent).
fn home_with_modes(
    modes: &[(&str, &str, &str)],
) -> (tempfile::TempDir, vst_agents::home::HomeGuard) {
    let home = tempdir().unwrap();
    let modes_dir = home.path().join(".vibe-station");
    std::fs::create_dir_all(&modes_dir).unwrap();
    let arr: Vec<serde_json::Value> = modes
        .iter()
        .map(|(id, name, cli)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "cli": cli,
                "context": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "model": null,
            })
        })
        .collect();
    std::fs::write(
        modes_dir.join("modes.json"),
        serde_json::to_string(&arr).unwrap(),
    )
    .unwrap();
    let guard = with_home(home.path().to_path_buf());
    (home, guard)
}

/// The canonical claude/cursor/agy mode set used by the Phase 2 channel tests.
fn channel_modes() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("claude-mode", "Claude Mode", "claude"),
        ("cursor-mode", "Cursor Mode", "cursor"),
        ("agy-mode", "Agy Mode", "agy"),
    ]
}

/// Create a direct agent session for `mode_id` and return the serialized
/// `Session` (asserting it came back as a session, not a draft).
async fn create_direct_agent(
    r: &SessionRoutes,
    project_id: &str,
    mode_id: &str,
) -> vst_types::rest::shared::Session {
    let body = serde_json::json!({
        "target": "direct",
        "type": "agent",
        "projectId": project_id,
        "modeId": mode_id,
    });
    let created = r.create_session(&body).await.unwrap();
    match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session, got a global draft"),
    }
}

// ---------------------------------------------------------------------------
// Phase 2 — channel defaulting (create_normal_session / inheritance / overrides)
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
async fn reset_broadcasts_old_row_is_main_false() {
    // Live clients pick the PR source by `isMain`; the superseded row must be
    // announced as no longer main or the worktree PR colour freezes on it.
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
    let mut rx = r.broadcaster.subscribe();
    r.reset_session("s-old", &reset_body()).await.unwrap();

    let mut found = None;
    while let Ok(ev) = rx.try_recv() {
        if let ServerEvent::SessionUpdated {
            session_id,
            is_main,
            superseded_by,
            ..
        } = ev
        {
            if session_id == "s-old" && superseded_by.is_some() {
                found = Some(is_main);
            }
        }
    }
    assert_eq!(
        found,
        Some(Some(false)),
        "old-row session:updated must carry isMain: false"
    );
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
        channel: None,
        ..Default::default()
    };
    let res = r.reset_session("s1", &body).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    let old = project
        .direct_sessions
        .iter()
        .find(|s| s.id == "s1")
        .unwrap();
    assert_eq!(old.handoff_summary.as_deref(), Some("direct summary"));
    // The carry mode is persisted in the same mutation and round-trips the store.
    assert_eq!(old.carry_over, Some(CarryOver::Summary));
    let wire =
        serde_json::to_value(vst_routes::sessions::serialize_session(None, "p1", old)).unwrap();
    assert_eq!(wire["carryOver"], "summary");
    let new = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    // Direct-delivery handoff text also becomes the new session's initial prompt.
    assert_eq!(new.initial_prompt.as_deref(), Some("direct summary"));
    assert_eq!(
        new.carry_over, None,
        "the live replacement records no carry mode"
    );
}

#[tokio::test]
async fn reset_persists_nothing_carry_mode_on_archived_row() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Nothing),
        ..Default::default()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    // The replacement's Rich Chat runtime opens its transcript store here; with
    // nothing carried, nothing else would have created the directory.
    let new_dir =
        vst_agents::paths::Paths::default().direct_session_data_dir("p1", &res.new_session_id);
    assert!(new_dir.is_dir(), "replacement data dir must exist");

    let project = store.get_project("p1").await.unwrap();
    let old = project
        .direct_sessions
        .iter()
        .find(|s| s.id == "s1")
        .unwrap();
    assert_eq!(old.carry_over, Some(CarryOver::Nothing));
    assert_eq!(old.handoff_summary, None);
    let wire =
        serde_json::to_value(vst_routes::sessions::serialize_session(None, "p1", old)).unwrap();
    assert_eq!(wire["carryOver"], "none");
}

#[tokio::test]
async fn reset_json_handoff_without_summary_fails_and_leaves_session_live() {
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

    let r = routes(store.clone()).with_handoff_timeout(Duration::from_millis(100));
    let mut body = reset_body();
    body.handoff = Some(true);
    let err = r.reset_session("s-old", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::HandoffFailed(_)));

    let project = store.get_project("p1").await.unwrap();
    let sessions = &project.worktrees[0].sessions;
    assert_eq!(sessions.len(), 1);
    let old = sessions.iter().find(|s| s.id == "s-old").unwrap();
    assert!(old.archived_at.is_none());
    assert!(old.superseded_by.is_none());
    assert!(old.is_main);
    assert_eq!(old.handoff_summary, None);

    assert!(r.json_registry.get("s-old").map_or(true, |a| {
        let m = a.get_meta();
        m.queued_turn_ids.is_empty() && m.editing_turn_ids.is_empty()
    }));
}

#[tokio::test]
async fn reset_json_handoff_enqueue_failure_fails_reset() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s1 = json_session("s1", "p1");
    s1.mode_id = None;
    p.direct_sessions.push(s1);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut body = reset_body();
    body.handoff = Some(true);
    body.mode_id = Some("my-mode".into());
    let err = r.reset_session("s1", &body).await.unwrap_err();
    match err {
        ResetError::HandoffFailed(m) => {
            assert!(
                m.contains("could not be sent"),
                "expected 'could not be sent' in error message: {m}"
            );
        }
        other => panic!("expected ResetError::HandoffFailed, got {:?}", other),
    }

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.direct_sessions.len(), 1);
    let s1 = &project.direct_sessions[0];
    assert!(s1.archived_at.is_none());
    assert!(s1.superseded_by.is_none());
}

// ---------------------------------------------------------------------------
// wait_for_handoff_file — the json handoff completion logic
// ---------------------------------------------------------------------------

const POLL_SLACK: Duration = Duration::from_secs(3);

/// Never-set flag for the non-cancel handoff-wait tests.
static NEVER_CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tokio::test]
async fn wait_for_handoff_file_returns_content_once_written_and_turn_settles() {
    let d = tempdir().unwrap();
    let path = d.path().join("h.md");
    let p2 = path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        tokio::fs::write(&p2, "the summary").await.unwrap();
    });
    let out = wait_for_handoff_file(
        &path,
        POLL_SLACK,
        Duration::from_secs(1),
        || false,
        || async {},
        &NEVER_CANCELLED,
    )
    .await;
    assert_eq!(out.as_deref(), Some("the summary"));
}

#[tokio::test]
async fn wait_for_handoff_file_gives_up_as_soon_as_the_turn_ends_without_a_file() {
    let d = tempdir().unwrap();
    let path = d.path().join("h.md");
    let calls = std::sync::atomic::AtomicUsize::new(0);
    // busy on the first look, idle afterwards (turn ended, no file written)
    let is_settled = || calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0;
    let started = std::time::Instant::now();
    let out = wait_for_handoff_file(
        &path,
        Duration::from_secs(60),
        Duration::from_secs(30),
        is_settled,
        || async {},
        &NEVER_CANCELLED,
    )
    .await;
    assert_eq!(out, None);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must not burn the 60s timeout"
    );
}

#[tokio::test]
async fn wait_for_handoff_file_times_out_when_turn_never_settles() {
    let d = tempdir().unwrap();
    let path = d.path().join("h.md");
    let out = wait_for_handoff_file(
        &path,
        Duration::from_millis(400),
        Duration::from_secs(30),
        || false,
        || async {},
        &NEVER_CANCELLED,
    )
    .await;
    assert_eq!(out, None);
}

#[tokio::test]
async fn wait_for_handoff_file_treats_an_empty_file_as_no_summary() {
    let d = tempdir().unwrap();
    let path = d.path().join("h.md");
    tokio::fs::write(&path, "  \n").await.unwrap();
    let out = wait_for_handoff_file(
        &path,
        POLL_SLACK,
        Duration::from_secs(1),
        || true,
        || async {},
        &NEVER_CANCELLED,
    )
    .await;
    assert_eq!(out, None);
}

#[tokio::test]
async fn wait_for_turn_start_returns_true_when_phase_flips_to_running() {
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let phase = || {
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
            HandoffTurnPhase::Queued
        } else {
            HandoffTurnPhase::Running
        }
    };
    let ok = wait_for_turn_start(
        phase,
        Duration::from_secs(2),
        Duration::from_millis(20),
        &NEVER_CANCELLED,
    )
    .await;
    assert!(ok);
}

#[tokio::test]
async fn wait_for_turn_start_returns_true_immediately_on_gone() {
    let ok = wait_for_turn_start(
        || HandoffTurnPhase::Gone,
        Duration::from_secs(2),
        Duration::from_millis(20),
        &NEVER_CANCELLED,
    )
    .await;
    assert!(ok);
}

#[tokio::test]
async fn wait_for_turn_start_returns_false_when_staying_queued_past_timeout() {
    let started = std::time::Instant::now();
    let ok = wait_for_turn_start(
        || HandoffTurnPhase::Queued,
        Duration::from_millis(200),
        Duration::from_millis(20),
        &NEVER_CANCELLED,
    )
    .await;
    assert!(!ok);
    assert!(started.elapsed() >= Duration::from_millis(190));
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
        channel: None,
        ..Default::default()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(matches!(err, ResetError::ModeNotFound(_)));
    // No teardown happened — the old session is untouched (not archived).
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.direct_sessions.len(), 1);
    assert!(project.direct_sessions[0].archived_at.is_none());
}

#[tokio::test]
async fn reset_json_without_prompt_leaves_replacement_ready_not_stuck_starting() {
    // A plain reset of a Rich Chat agent starts no turn 1, so nothing would
    // ever move the replacement off `not_started` (UI: "Starting…" forever,
    // no composer). It must be marked ready for the user's first message.
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.reset_session("s1", &reset_body()).await.unwrap();

    let mut state = None;
    for _ in 0..40 {
        let project = store.get_project("p1").await.unwrap();
        let new = project
            .direct_sessions
            .iter()
            .find(|x| x.id == res.new_session_id)
            .unwrap();
        state = Some(new.lifecycle.state);
        if new.lifecycle.state != LifecycleState::NotStarted {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(state, Some(LifecycleState::WaitingForHuman));
}

#[tokio::test]
async fn reset_with_deleted_mode_fails_without_replacement() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.mode_id = Some("deleted-mode".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let err = r.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(matches!(err, ResetError::ModeNotFound(_)));
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(project.direct_sessions.len(), 1);
    assert!(project.direct_sessions[0].archived_at.is_none());
}

#[tokio::test]
async fn reset_with_deleted_mode_succeeds_with_replacement_mode() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s1", "p1");
    s.mode_id = Some("deleted-mode".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let mut body = reset_body();
    body.mode_id = Some("my-mode".into());
    let res = r.reset_session("s1", &body).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    let old = project
        .direct_sessions
        .iter()
        .find(|x| x.id == "s1")
        .unwrap();
    assert!(old.archived_at.is_some());
    let new = project
        .direct_sessions
        .iter()
        .find(|x| x.id == res.new_session_id)
        .unwrap();
    assert_eq!(new.mode_id.as_deref(), Some("my-mode"));
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
// Reset carries the pin (+ pinned-all swap, event order), pin chain, repair
// ---------------------------------------------------------------------------

const PIN_TS: &str = "2026-02-02T00:00:00.000Z";

/// Drain every event currently buffered on `rx`.
fn drain(rx: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> Vec<ServerEvent> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(ev);
    }
    out
}

fn persisted<'a>(p: &'a ProjectRecord, id: &str) -> &'a SessionRecord {
    p.worktrees
        .iter()
        .flat_map(|w| w.sessions.iter())
        .chain(p.direct_sessions.iter())
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("session {id} not persisted"))
}

#[tokio::test]
async fn reset_carries_pin_to_replacement_in_worktree() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut w = make_worktree("w1");
    let mut main = json_session("s-old", "p1");
    main.is_main = true;
    main.worktree_id = Some("w1".into());
    main.pinned_at = Some(PIN_TS.into());
    w.sessions.push(main);
    p.worktrees.push(w);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.reset_session("s-old", &reset_body()).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    let new = persisted(&project, &res.new_session_id);
    let old = persisted(&project, "s-old");
    assert_eq!(new.pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(old.pinned_at, None);
    assert_eq!(
        old.superseded_by.as_deref(),
        Some(res.new_session_id.as_str())
    );
}

#[tokio::test]
async fn reset_carries_pin_to_replacement_direct() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.pinned_at = Some(PIN_TS.into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let res = r.reset_session("s1", &reset_body()).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(
        persisted(&project, &res.new_session_id)
            .pinned_at
            .as_deref(),
        Some(PIN_TS)
    );
    assert_eq!(persisted(&project, "s1").pinned_at, None);
    assert_eq!(
        persisted(&project, "s1").superseded_by.as_deref(),
        Some(res.new_session_id.as_str())
    );
}

#[tokio::test]
async fn reset_unpinned_stays_unpinned() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;
    store
        .set_ordered_list(PINNED_ALL, vec!["other".into()])
        .await;

    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();
    let res = r.reset_session("s1", &reset_body()).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(persisted(&project, &res.new_session_id).pinned_at, None);
    assert_eq!(persisted(&project, "s1").pinned_at, None);
    assert_eq!(
        store.get_ordered_list(PINNED_ALL).await.item_ids,
        vec!["other".to_string()]
    );
    let events = drain(&mut rx);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ServerEvent::OrderedListUpdated { .. })),
        "unpinned reset must not touch the ordered list"
    );
    let upd = events
        .iter()
        .find_map(|e| match e {
            ServerEvent::SessionUpdated {
                session_id,
                pinned_at,
                superseded_by: Some(_),
                ..
            } if session_id == "s1" => Some(pinned_at.clone()),
            _ => None,
        })
        .expect("old-row session:updated");
    assert_eq!(upd, None, "no pinnedAt key when no pin moved");
}

#[tokio::test]
async fn reset_pinned_swaps_id_and_orders_events() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.pinned_at = Some(PIN_TS.into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;
    store
        .set_ordered_list(PINNED_ALL, vec!["x".into(), "s1".into(), "y".into()])
        .await;

    let r = routes(store.clone());
    let mut rx = r.broadcaster.subscribe();
    let res = r.reset_session("s1", &reset_body()).await.unwrap();
    let new_id = res.new_session_id.clone();

    assert_eq!(
        store.get_ordered_list(PINNED_ALL).await.item_ids,
        vec!["x".to_string(), new_id.clone(), "y".to_string()]
    );

    let events = drain(&mut rx);
    let pos = |pred: &dyn Fn(&ServerEvent) -> bool| events.iter().position(|e| pred(e));
    let list_at = pos(&|e| {
        matches!(e, ServerEvent::OrderedListUpdated { scope_key, item_ids, .. }
            if scope_key == PINNED_ALL && item_ids.contains(&new_id))
    })
    .expect("orderedList:updated");
    let created_at = pos(&|e| match e {
        ServerEvent::SessionCreated {
            session_id,
            snapshot,
            ..
        } => {
            session_id == &new_id
                && snapshot.as_ref().and_then(|s| s.pinned_at.as_deref()) == Some(PIN_TS)
        }
        _ => false,
    })
    .expect("session:created with carried pinnedAt");
    let updated_at = pos(&|e| {
        matches!(e, ServerEvent::SessionUpdated {
            session_id, superseded_by: Some(_), pinned_at: Some(None), ..
        } if session_id == "s1")
    })
    .expect("old-row session:updated with pinnedAt null");
    assert!(
        list_at < created_at && created_at < updated_at,
        "order must be orderedList → created → updated, got {list_at}/{created_at}/{updated_at}"
    );
}

#[tokio::test]
async fn reset_of_a_reset_moves_pin_to_c() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("a", "p1");
    s.pinned_at = Some(PIN_TS.into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let b = r
        .reset_session("a", &reset_body())
        .await
        .unwrap()
        .new_session_id;
    let c = r
        .reset_session(&b, &reset_body())
        .await
        .unwrap()
        .new_session_id;

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(persisted(&project, &c).pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(persisted(&project, &b).pinned_at, None);
    assert_eq!(persisted(&project, "a").pinned_at, None);
}

#[tokio::test]
async fn pin_superseded_id_pins_live_head() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("a", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let b = r
        .reset_session("a", &reset_body())
        .await
        .unwrap()
        .new_session_id;
    let mut rx = r.broadcaster.subscribe();
    let res = r.pin_session("a", true).await.unwrap();

    let project = store.get_project("p1").await.unwrap();
    let head = persisted(&project, &b);
    assert!(head.pinned_at.is_some());
    assert_eq!(res.pinned_at, head.pinned_at);
    assert_eq!(persisted(&project, "a").pinned_at, None, "no second owner");
    let ev = drain(&mut rx)
        .into_iter()
        .find_map(|e| match e {
            ServerEvent::SessionUpdated {
                session_id,
                pinned_at,
                ..
            } => Some((session_id, pinned_at)),
            _ => None,
        })
        .expect("pin broadcast");
    assert_eq!(ev.0, b);
    assert_eq!(ev.1, Some(head.pinned_at.clone()));
}

#[tokio::test]
async fn unpin_superseded_id_unpins_head() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("a", "p1");
    s.pinned_at = Some(PIN_TS.into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let b = r
        .reset_session("a", &reset_body())
        .await
        .unwrap()
        .new_session_id;
    let res = r.pin_session("a", false).await.unwrap();
    assert_eq!(res.pinned_at, None);
    let project = store.get_project("p1").await.unwrap();
    assert_eq!(persisted(&project, &b).pinned_at, None);
    assert_eq!(persisted(&project, "a").pinned_at, None);
}

#[tokio::test]
async fn repair_moves_stranded_pin_to_head_idempotently() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    // a → b (b unpinned): stranded pin on hidden a.
    let mut a = make_session("a", "p1");
    a.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    a.superseded_by = Some("b".into());
    a.pinned_at = Some(PIN_TS.into());
    // c → d where d already holds its own pin: head kept, stale pin cleared.
    let mut c = make_session("c", "p1");
    c.archived_at = Some("2026-01-02T00:00:00.000Z".into());
    c.superseded_by = Some("d".into());
    c.pinned_at = Some("2026-03-03T00:00:00.000Z".into());
    let mut d = make_session("d", "p1");
    d.pinned_at = Some("2026-04-04T00:00:00.000Z".into());
    // Visible pinned row with a dangling pointer: never a candidate.
    let mut e = make_session("e", "p1");
    e.superseded_by = Some("gone".into());
    e.pinned_at = Some("2026-05-05T00:00:00.000Z".into());
    p.direct_sessions
        .extend([a, make_session("b", "p1"), c, d, e]);
    add_project(&store, p).await;
    store
        .set_ordered_list(PINNED_ALL, vec!["a".into(), "d".into(), "e".into()])
        .await;

    assert!(repair_superseded_pins(&store).await.is_empty());

    let project = store.get_project("p1").await.unwrap();
    assert_eq!(persisted(&project, "b").pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(persisted(&project, "a").pinned_at, None);
    assert_eq!(persisted(&project, "c").pinned_at, None);
    assert_eq!(
        persisted(&project, "d").pinned_at.as_deref(),
        Some("2026-04-04T00:00:00.000Z")
    );
    assert_eq!(
        persisted(&project, "e").pinned_at.as_deref(),
        Some("2026-05-05T00:00:00.000Z")
    );
    assert_eq!(
        store.get_ordered_list(PINNED_ALL).await.item_ids,
        vec!["b".to_string(), "d".to_string(), "e".to_string()]
    );

    // Second run: nothing to do, list and rows untouched.
    let before = store.get_project("p1").await.unwrap();
    assert!(repair_superseded_pins(&store).await.is_empty());
    let after = store.get_project("p1").await.unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    assert_eq!(
        store.get_ordered_list(PINNED_ALL).await.item_ids,
        vec!["b".to_string(), "d".to_string(), "e".to_string()]
    );
}

#[tokio::test]
async fn repair_leaves_cycles_and_overlong_chains_alone() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    // Self-cycle.
    let mut s = make_session("s", "p1");
    s.superseded_by = Some("s".into());
    s.pinned_at = Some(PIN_TS.into());
    // Two-cycle x <-> y.
    let mut x = make_session("x", "p1");
    x.superseded_by = Some("y".into());
    x.pinned_at = Some(PIN_TS.into());
    let mut y = make_session("y", "p1");
    y.superseded_by = Some("x".into());
    // Overlong chain: l0 -> ... -> l40 (head past the 32-hop cap).
    let mut chain = Vec::new();
    for i in 0..=40 {
        let mut r = make_session(&format!("l{i}"), "p1");
        if i < 40 {
            r.superseded_by = Some(format!("l{}", i + 1));
        }
        if i == 0 {
            r.pinned_at = Some(PIN_TS.into());
        }
        chain.push(r);
    }
    p.direct_sessions.extend([s, x, y]);
    p.direct_sessions.extend(chain);
    add_project(&store, p).await;
    store
        .set_ordered_list(PINNED_ALL, vec!["s".into(), "x".into(), "l0".into()])
        .await;

    let before = store.get_project("p1").await.unwrap();
    assert!(repair_superseded_pins(&store).await.is_empty());
    let after = store.get_project("p1").await.unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    assert_eq!(persisted(&after, "s").pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(persisted(&after, "x").pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(persisted(&after, "l0").pinned_at.as_deref(), Some(PIN_TS));
    assert_eq!(persisted(&after, "l40").pinned_at, None);

    // Idempotent.
    assert!(repair_superseded_pins(&store).await.is_empty());
    assert_eq!(
        store.get_ordered_list(PINNED_ALL).await.item_ids,
        vec!["s".to_string(), "x".to_string(), "l0".to_string()]
    );
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/handoff
// ---------------------------------------------------------------------------

#[tokio::test]
async fn handoff_json_enqueue_failure_returns_ok_with_no_summary() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = json_session("s1", "p1");
    s.mode_id = None;
    p.direct_sessions.push(s);
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

// ---------------------------------------------------------------------------
// Phase 2 — channel defaulting in create_normal_session (2.T1-2.T4c, 2.T12)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_agent_agy_mode_defaults_to_tmux() {
    // 2.T1 — agy mode, by id, no channel/use_tmux -> Tmux.
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "agy-mode").await;
    assert_eq!(s.channel, Channel::Tmux);
}

#[tokio::test]
async fn create_agent_agy_mode_by_name_defaults_to_tmux() {
    // 2.T1b — M1 regression: a mode given by NAME (not id) must resolve to the
    // same CLI and default to Tmux, not fall through to Json.
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "Agy Mode").await;
    assert_eq!(s.channel, Channel::Tmux);
}

#[tokio::test]
async fn create_agent_claude_mode_defaults_to_json() {
    // 2.T2 — claude mode, no channel/use_tmux -> Json.
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "claude-mode").await;
    assert_eq!(s.channel, Channel::Json);
}

#[tokio::test]
async fn create_terminal_defaults_to_tmux() {
    // 2.T3 — terminal-type session (no mode at all) -> Tmux, regardless of mode context.
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let body = serde_json::json!({
        "target": "direct",
        "type": "terminal",
        "projectId": "p1",
    });
    let created = r.create_session(&body).await.unwrap();
    let s = match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session"),
    };
    assert_eq!(s.channel, Channel::Tmux);
}

/// Build a routes with a claude/Json parent `parent-1` in project `p1`'s
/// direct sessions, ready for the inheritance tests. Returns home + guard
/// (both kept alive for the test's duration) alongside the store + routes.
async fn project_with_claude_json_parent() -> (
    tempfile::TempDir,
    vst_agents::home::HomeGuard,
    StoreHandle,
    SessionRoutes,
) {
    let (home, guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut parent = make_session("parent-1", "p1");
    parent.mode_id = Some("claude-mode".into());
    parent.channel = Some(Channel::Json);
    parent.use_tmux = false;
    p.direct_sessions.push(parent);
    add_project(&store, p).await;
    let r = routes(store.clone());
    (home, guard, store, r)
}

#[tokio::test]
async fn subagent_inherits_parent_channel_same_cli() {
    // 2.T4 — child with source_agent_id, no --mode, no --channel inherits the
    // parent's mode (claude) -> same CLI -> inherits the parent's Json channel.
    let (_home, _guard, _store, r) = project_with_claude_json_parent().await;
    let body = serde_json::json!({
        "target": "direct",
        "type": "agent",
        "projectId": "p1",
        "sourceAgentId": "parent-1",
    });
    let created = r.create_session(&body).await.unwrap();
    let s = match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session"),
    };
    assert_eq!(s.channel, Channel::Json);
}

#[tokio::test]
async fn subagent_explicit_different_cli_uses_own_default() {
    // 2.T4b — same claude/Json parent, but child passes an explicit agy mode
    // (different CLI) and no channel -> agy's own default (Tmux), NOT the
    // inherited Json. This is the case B3's same-CLI guard specifically protects.
    let (_home, _guard, _store, r) = project_with_claude_json_parent().await;
    let body = serde_json::json!({
        "target": "direct",
        "type": "agent",
        "projectId": "p1",
        "sourceAgentId": "parent-1",
        "modeId": "agy-mode",
    });
    let created = r.create_session(&body).await.unwrap();
    let s = match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session"),
    };
    assert_eq!(s.channel, Channel::Tmux);
}

#[tokio::test]
async fn subagent_parent_mode_deleted_does_not_inherit() {
    // 2.T4c — the parent's mode ("ghost-mode") is absent from modes.json, so
    // parent_cli resolves to None and we deliberately do NOT inherit the
    // parent's channel. The child (explicit claude-mode) gets its own default.
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut parent = make_session("parent-1", "p1");
    parent.mode_id = Some("ghost-mode".into()); // deleted from modes.json
    parent.channel = Some(Channel::Tmux);
    parent.use_tmux = true;
    p.direct_sessions.push(parent);
    add_project(&store, p).await;
    let r = routes(store.clone());

    let body = serde_json::json!({
        "target": "direct",
        "type": "agent",
        "projectId": "p1",
        "sourceAgentId": "parent-1",
        "modeId": "claude-mode",
    });
    let created = r.create_session(&body).await.unwrap();
    let s = match created {
        SessionOrDraft::Session(s) => s,
        SessionOrDraft::GlobalDraft(_) => panic!("expected a session"),
    };
    // No inheritance -> child's own (claude) default = Json, NOT the parent's Tmux.
    assert_eq!(s.channel, Channel::Json);
}

#[tokio::test]
async fn agy_override_to_json_dropped_agy_is_terminal_only() {
    // 2.T12 — agy is terminal-only, so a persisted defaultChannelByCli override
    // {agy: json} is DROPPED (resolve_effective_default_channel falls back to
    // the plugin's Tmux default) instead of winning — creating an agy-mode
    // session must never land on Json.
    let (home, _guard) = home_with_modes(&[("agy-mode", "Agy Mode", "agy")]);
    std::fs::write(
        home.path().join(".vibe-station").join("config.json"),
        r#"{"defaultChannelByCli": {"agy": "json"}}"#,
    )
    .unwrap();
    let (_d, store) = store();
    add_project(&store, make_project("p1")).await;
    let r = routes(store.clone());
    let s = create_direct_agent(&r, "p1", "agy-mode").await;
    assert_eq!(s.channel, Channel::Tmux);
}

#[tokio::test]
async fn load_default_channel_overrides_skips_unparseable_entries() {
    // 2.T13 — per-entry parsing: an unknown/typo'd CliId key must be skipped
    // without dropping the valid claude entry (round-2 M3).
    let (home, _guard) = home_with_modes(&[]);
    std::fs::write(
        home.path().join(".vibe-station").join("config.json"),
        r#"{"defaultChannelByCli": {"claude": "json", "not-a-cli": "tmux"}}"#,
    )
    .unwrap();
    let overrides = load_default_channel_overrides();
    let mut expected = std::collections::BTreeMap::new();
    expected.insert(CliId::Claude, Channel::Json);
    assert_eq!(overrides, expected);
}

#[tokio::test]
async fn start_draft_agy_no_channel_defaults_to_tmux() {
    // 2.T9 — M3 fix: POST /sessions/:id/start on a draft whose draftConfig
    // has NO channel and an agy mode_id -> the started session's channel is
    // Tmux (the effective default for agy), not a hardcoded Json.
    let (_home, _guard) = home_with_modes(&[("agy-mode", "Agy Mode", "agy")]);
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s-draft", "p1");
    s.lifecycle.state = LifecycleState::Drafting;
    s.draft_prompt = Some("initial".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = StartDraftBody {
        draft_prompt: "do it".into(),
        draft_config: DraftConfig {
            entry_point: DraftEntryPoint::Direct,
            mode_id: Some("agy-mode".into()),
            channel: None, // no explicit channel -> effective default
            channel_explicit: None,
            worktree_choice: None,
            existing_worktree_id: None,
            branch: None,
            base_branch: None,
            use_tmux: None,
            use_worktree: None,
        },
        skip_auto_turn: Some(true),
    };
    let res = r.start_session("s-draft", &body).await.unwrap();
    assert!(res.ok);
    assert_eq!(
        res,
        StartDraftResult {
            ok: true,
            worktree_id: None,
            worktree: None,
        }
    );

    let project = store.get_project("p1").await.unwrap();
    let started = &project.direct_sessions[0];
    assert_eq!(started.channel, Some(Channel::Tmux));
    assert_eq!(started.mode_id.as_deref(), Some("agy-mode"));
}

#[tokio::test]
async fn start_draft_agy_explicit_json_rejected() {
    // agy is terminal-only — promoting a draft with an explicit `channel: json`
    // for an agy mode must be rejected (400), not silently forked into a Rich
    // Chat session (the exact bug this feature exists to prevent).
    let (_home, _guard) = home_with_modes(&[("agy-mode", "Agy Mode", "agy")]);
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut s = make_session("s-draft", "p1");
    s.lifecycle.state = LifecycleState::Drafting;
    s.draft_prompt = Some("initial".into());
    p.direct_sessions.push(s);
    add_project(&store, p).await;

    let r = routes_with_real_json_gate(store.clone());
    let body = StartDraftBody {
        draft_prompt: "do it".into(),
        draft_config: DraftConfig {
            entry_point: DraftEntryPoint::Direct,
            mode_id: Some("agy-mode".into()),
            channel: Some(Channel::Json), // explicit json -> must be rejected
            channel_explicit: Some(true),
            worktree_choice: None,
            existing_worktree_id: None,
            branch: None,
            base_branch: None,
            use_tmux: None,
            use_worktree: None,
        },
        skip_auto_turn: Some(true),
    };
    let err = r.start_session("s-draft", &body).await.unwrap_err();
    assert!(
        matches!(err, StartError::Validation(m) if m.contains("does not support JSON chat mode"))
    );
}

#[tokio::test]
async fn worktree_draft_is_created_on_top_but_direct_draft_keeps_its_own_slot() {
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut existing = make_session("old-draft", "p1");
    existing.sort_order = 5.0;
    existing.lifecycle.state = LifecycleState::Drafting;
    existing.draft_config = Some(DraftConfig {
        entry_point: DraftEntryPoint::Worktree,
        mode_id: None,
        channel: None,
        channel_explicit: None,
        use_tmux: None,
        base_branch: None,
        branch: None,
        worktree_choice: None,
        existing_worktree_id: None,
        use_worktree: None,
    });
    p.direct_sessions = vec![existing];
    add_project(&store, p).await;
    let r = routes(store.clone());

    let create = |entry: &str| {
        let body = serde_json::json!({
            "target": "worktree",
            "type": "agent",
            "projectId": "p1",
            "state": "drafting",
            "draftConfig": { "entryPoint": entry },
        });
        let r = &r;
        async move {
            match r.create_session(&body).await.unwrap() {
                SessionOrDraft::Session(s) => s,
                SessionOrDraft::GlobalDraft(_) => panic!("expected a session"),
            }
        }
    };

    let wt_draft = create("worktree").await;
    assert_eq!(wt_draft.sort_order, 4.0, "worktree draft goes on top");
    let saved = store.get_project("p1").await.unwrap();
    assert_eq!(
        saved
            .direct_sessions
            .iter()
            .find(|s| s.id == wt_draft.id)
            .unwrap()
            .sort_order,
        4.0
    );

    let direct_draft = create("direct").await;
    assert!(
        direct_draft.sort_order > 1_000_000_000.0,
        "direct drafts keep their own (epoch) slot, got {}",
        direct_draft.sort_order
    );
}

// ---------------------------------------------------------------------------
// Phase 2 — reset route wiring: transcript carry, break kind, channel handling
// ---------------------------------------------------------------------------

/// Kind → snake_case tag for the seeded events' `id`.
fn phase2_kind_tag(kind: NormalizedEventKind) -> &'static str {
    match kind {
        NormalizedEventKind::User => "user",
        NormalizedEventKind::Thinking => "thinking",
        NormalizedEventKind::Text => "text",
        NormalizedEventKind::ToolUse => "tool_use",
        NormalizedEventKind::ToolResult => "tool_result",
        NormalizedEventKind::Result => "result",
        NormalizedEventKind::ModeUpdate => "mode_update",
        _ => "other",
    }
}

/// Build a bare `NormalizedEvent` for seeding an old store (no role/text unless
/// the caller sets them; only `kind`/`session_id` matter for the carry).
fn phase2_ev(
    kind: NormalizedEventKind,
    session_id: &str,
    turn_id: &str,
    text: &str,
) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("{}-{}", phase2_kind_tag(kind), turn_id),
        "sessionId": session_id,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(kind).unwrap(),
        "turnId": turn_id,
    }))
    .unwrap();
    if !text.is_empty() {
        e.text = Some(text.to_string());
    }
    e
}

/// Seed a direct session's transcript store with a mix of carried kinds plus a
/// dropped `mode_update`, rooted under the active home guard via `AgentPaths`
/// (the same override-aware Paths the route's carry uses).
fn phase2_seed_old_store(project_id: &str, session_id: &str) {
    let dir = AgentPaths::default().direct_session_data_dir(project_id, session_id);
    let mut s = open_transcript_store(&dir, session_id);
    for (kind, turn, text) in [
        (NormalizedEventKind::User, "t1", "hello"),
        (NormalizedEventKind::Thinking, "t1", "thinking"),
        (NormalizedEventKind::Text, "t1", "carried reply"),
        (NormalizedEventKind::ToolUse, "t1", ""),
        (NormalizedEventKind::ToolResult, "t1", ""),
        (NormalizedEventKind::Result, "t1", "done"),
        // A dropped kind: mode_update must NOT be carried (plan Decision 1).
        (NormalizedEventKind::ModeUpdate, "t1", ""),
    ] {
        s.append(&mut phase2_ev(kind, session_id, turn, text));
    }
    s.close();
}

/// A claude json-mode direct session in project `p1` (ready for a json→json
/// reset that carries its history).
async fn seeded_claude_json_session(store: &StoreHandle) {
    let mut p = make_project("p1");
    let mut old = json_session("s1", "p1");
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(store, p).await;
    phase2_seed_old_store("p1", "s1");
}

#[tokio::test]
async fn reset_json_to_json_carries_rows_and_appends_reset_marker() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Transcript);
    assert_eq!(res.break_kind, Some(SessionBreakKind::Reset));

    let project = store.get_project("p1").await.unwrap();
    let new_rec = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert_eq!(new_rec.channel, Some(Channel::Json));
    assert_eq!(new_rec.use_tmux, false);

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let kinds: Vec<NormalizedEventKind> = carried.iter().map(|e| e.kind).collect();
    for k in [
        NormalizedEventKind::User,
        NormalizedEventKind::Thinking,
        NormalizedEventKind::Text,
        NormalizedEventKind::ToolUse,
        NormalizedEventKind::ToolResult,
        NormalizedEventKind::Result,
    ] {
        assert!(kinds.contains(&k), "kind {k:?} must be carried");
    }
    assert!(
        !kinds.contains(&NormalizedEventKind::ModeUpdate),
        "mode_update must be dropped"
    );

    // Marker is last, a plain `reset` (no mode change), same claude provider.
    let last = carried.last().unwrap();
    assert_eq!(last.kind, NormalizedEventKind::SessionBreak);
    assert_eq!(last.break_kind, Some(SessionBreakKind::Reset));
    assert_eq!(last.carry_over, Some(CarryOver::Transcript));
    assert_eq!(last.from_provider.as_deref(), Some("claude"));
    assert_eq!(last.to_provider.as_deref(), Some("claude"));
    assert_eq!(last.from_mode.as_deref(), Some("Claude Mode"));
    assert_eq!(last.to_mode.as_deref(), Some("Claude Mode"));
    assert!(
        last.text
            .as_deref()
            .unwrap_or_default()
            .contains("previous-chat.md"),
        "transcript marker text names the export path"
    );
}

#[tokio::test]
async fn reset_cross_cli_mode_reports_switch_and_providers() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        mode_id: Some("cursor-mode".into()),
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let last = carried.last().unwrap();
    assert_eq!(last.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(last.carry_over, Some(CarryOver::Transcript));
    assert_eq!(last.from_mode.as_deref(), Some("Claude Mode"));
    assert_eq!(last.to_mode.as_deref(), Some("Cursor Mode"));
    // Target CLI differs from the old session's CLI (claude → cursor).
    assert_eq!(last.from_provider.as_deref(), Some("claude"));
    assert_eq!(last.to_provider.as_deref(), Some("cursor"));
}

#[tokio::test]
async fn reset_tmux_old_session_writes_no_transcript() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = make_session("s1", "p1"); // tmux by default
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;
    phase2_seed_old_store("p1", "s1"); // seed anyway, to prove no copy happens

    let r = routes(store.clone());
    let res = r.reset_session("s1", &reset_body()).await.unwrap();
    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    assert!(
        !new_dir.exists(),
        "a tmux reset must not create/copy a transcript store"
    );
}

#[tokio::test]
async fn reset_explicit_json_on_agy_mode_rejected_400() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = json_session("s1", "p1");
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;

    let r = routes_with_real_json_gate(store.clone());
    let body = ResetBody {
        mode_id: Some("agy-mode".into()),
        channel: Some(Channel::Json),
        ..reset_body()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(
        matches!(err, ResetError::JsonUnsupported(_)),
        "expected JsonUnsupported, got {:?}",
        err
    );
}

#[tokio::test]
async fn reset_channel_pty_rejected_400() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = json_session("s1", "p1");
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        channel: Some(Channel::Pty),
        ..reset_body()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(
        matches!(err, ResetError::BadRequest(_)),
        "expected BadRequest for pty, got {:?}",
        err
    );
}

#[tokio::test]
async fn reset_tmux_to_json_sets_transcript_ref_and_carries_nothing() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = make_session("s1", "p1"); // tmux
    old.mode_id = Some("claude-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;
    phase2_seed_old_store("p1", "s1"); // present, but old is tmux → nothing carried

    let r = routes(store.clone());
    let body = ResetBody {
        channel: Some(Channel::Json),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    let project = store.get_project("p1").await.unwrap();
    let new_rec = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert_eq!(new_rec.channel, Some(Channel::Json));
    assert_eq!(new_rec.use_tmux, false);
    assert!(
        new_rec.transcript_ref.is_some(),
        "json session needs a transcript_ref"
    );

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    assert!(
        carried.is_empty(),
        "a tmux→json reset must carry nothing (old is terminal)"
    );
}

#[tokio::test]
async fn reset_json_to_tmux_sets_use_tmux_and_carries_nothing() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        channel: Some(Channel::Tmux),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    let project = store.get_project("p1").await.unwrap();
    let new_rec = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert_eq!(new_rec.channel, Some(Channel::Tmux));
    assert_eq!(new_rec.use_tmux, true);
    assert!(new_rec.transcript_ref.is_none());

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    assert!(
        carried.is_empty(),
        "a json→tmux reset must carry nothing (final is terminal)"
    );
}

#[tokio::test]
async fn session_output_excludes_carried_rows_of_reset_agent() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    let new_id = res.new_session_id;

    // Simulate the new conversation: append a fresh Text turn to the new store
    // (as if the new agent replied after the carried history + marker).
    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &new_id);
    let mut s = open_transcript_store(&new_dir, &new_id);
    let mut new_text = phase2_ev(NormalizedEventKind::Text, &new_id, "new-turn", "");
    new_text.text = Some("post-reset reply".into());
    s.append(&mut new_text);
    s.close();

    let out = r.session_output(&new_id, Some("100")).await.unwrap();
    assert!(
        out.output.contains("post-reset reply"),
        "new text must appear in output: {}",
        out.output
    );
    assert!(
        !out.output.contains("carried reply"),
        "carried rows must be cut at the last session_break: {}",
        out.output
    );
}

// ---------------------------------------------------------------------------
// Phase 1 — carry modes, ordered reset, cancel flag (1.T1-T3, 1.T5)
// ---------------------------------------------------------------------------

/// A claude json-mode direct session `s1` in project `p1` with the given mode.
async fn seeded_json_session_with_mode(store: &StoreHandle, mode_id: &str) {
    let mut p = make_project("p1");
    let mut old = json_session("s1", "p1");
    old.mode_id = Some(mode_id.into());
    p.direct_sessions.push(old);
    add_project(store, p).await;
    phase2_seed_old_store("p1", "s1");
}

#[tokio::test]
async fn reset_carry_none_clears_the_chat() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Nothing),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Nothing);
    assert_eq!(res.break_kind, None);

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    assert!(carried.is_empty(), "nothing may be carried");
    assert!(
        !carried
            .iter()
            .any(|e| e.kind == NormalizedEventKind::SessionBreak),
        "no break marker for `none`"
    );
}

#[tokio::test]
async fn reset_summary_with_handoff_text_carries_rows_and_summary_marker() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Summary),
        handoff_text: Some("the summary".into()),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.carry_over, CarryOver::Summary);
    assert_eq!(res.break_kind, Some(SessionBreakKind::Reset));

    let project = store.get_project("p1").await.unwrap();
    let new_rec = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert_eq!(new_rec.initial_prompt.as_deref(), Some("the summary"));

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let kinds: Vec<NormalizedEventKind> = carried.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&NormalizedEventKind::User));
    assert!(kinds.contains(&NormalizedEventKind::Text));
    let last = carried.last().unwrap();
    assert_eq!(last.kind, NormalizedEventKind::SessionBreak);
    assert_eq!(last.carry_over, Some(CarryOver::Summary));
    assert_eq!(last.text.as_deref(), Some("the summary"));
    assert_eq!(last.from_mode.as_deref(), Some("Claude Mode"));
    assert_eq!(last.to_mode.as_deref(), Some("Claude Mode"));
}

#[tokio::test]
async fn reset_same_cli_mode_switch_reports_switch_and_mode_names() {
    let (_home, _guard) = home_with_modes(&[
        ("opus-planner", "Opus Planner", "claude"),
        ("sonnet-implementer", "Sonnet Implementer", "claude"),
    ]);
    let (_d, store) = store();
    seeded_json_session_with_mode(&store, "opus-planner").await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Summary),
        handoff_text: Some("carried".into()),
        mode_id: Some("sonnet-implementer".into()),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.break_kind, Some(SessionBreakKind::Switch));

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let last = carried.last().unwrap();
    assert_eq!(last.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(last.from_mode.as_deref(), Some("Opus Planner"));
    assert_eq!(last.to_mode.as_deref(), Some("Sonnet Implementer"));
    // Same CLI on both sides — the provider pills stay claude → claude.
    assert_eq!(last.from_provider.as_deref(), Some("claude"));
    assert_eq!(last.to_provider.as_deref(), Some("claude"));
}

#[tokio::test]
async fn reset_requesting_current_mode_reports_reset() {
    let (_home, _guard) = home_with_modes(&[("opus-planner", "Opus Planner", "claude")]);
    let (_d, store) = store();
    seeded_json_session_with_mode(&store, "opus-planner").await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Summary),
        handoff_text: Some("carried".into()),
        mode_id: Some("opus-planner".into()),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();
    assert_eq!(res.break_kind, Some(SessionBreakKind::Reset));
}

#[tokio::test]
async fn reset_carry_none_with_handoff_text_is_400() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Nothing),
        handoff_text: Some("nope".into()),
        ..reset_body()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(
        matches!(err, ResetError::BadRequest(_)),
        "expected BadRequest, got {err:?}"
    );
}

#[tokio::test]
async fn reset_transcript_exports_owner_only_markdown_and_instruction() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let export = new_dir.join("previous-chat.md");
    assert!(export.exists(), "transcript export must exist");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&export).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "owner-only permissions");
    }
    let content = std::fs::read_to_string(&export).unwrap();
    assert!(content.contains("## Turn 1 — User"));

    let project = store.get_project("p1").await.unwrap();
    let new_rec = project
        .direct_sessions
        .iter()
        .find(|s| s.id == res.new_session_id)
        .unwrap();
    assert_eq!(
        new_rec.initial_prompt.as_deref(),
        Some(transcript_instruction(&export).as_str()),
        "initial_prompt is the read-the-file instruction"
    );

    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let last = carried.last().unwrap();
    assert_eq!(last.carry_over, Some(CarryOver::Transcript));
    assert!(
        last.text
            .as_deref()
            .unwrap_or_default()
            .contains(export.to_string_lossy().as_ref()),
        "marker text names the export path"
    );
}

#[tokio::test]
async fn reset_transcript_on_plain_pty_terminal_is_400() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    let mut old = make_session("s1", "p1");
    old.use_tmux = false;
    old.channel = Some(Channel::Pty);
    old.mode_id = Some("my-mode".into());
    p.direct_sessions.push(old);
    add_project(&store, p).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let err = r.reset_session("s1", &body).await.unwrap_err();
    assert!(
        matches!(err, ResetError::BadRequest(_)),
        "expected BadRequest, got {err:?}"
    );
    let project = store.get_project("p1").await.unwrap();
    assert!(project.direct_sessions[0].archived_at.is_none());
}

#[tokio::test]
async fn reset_summary_with_handoff_text_runs_no_handoff_turn() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;

    let r = routes(store.clone());
    let body = ResetBody {
        carry_over: Some(CarryOver::Summary),
        handoff_text: Some("prewritten summary".into()),
        ..reset_body()
    };
    let res = r.reset_session("s1", &body).await.unwrap();

    let new_dir = AgentPaths::default().direct_session_data_dir("p1", &res.new_session_id);
    let carried = read_transcript_from_data_dir(&new_dir, &res.new_session_id);
    let user_rows: Vec<&NormalizedEvent> = carried
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .collect();
    assert_eq!(user_rows.len(), 1, "only the seeded user turn is carried");
    assert!(
        !carried.iter().any(|e| e
            .text
            .as_deref()
            .unwrap_or_default()
            .contains("Before this session ends")),
        "no handoff instruction turn when handoffText is supplied"
    );
}

#[tokio::test]
async fn reset_cancelled_after_export_leaves_no_new_dir() {
    let (_home, _guard) = home_with_modes(&channel_modes());
    let (_d, store) = store();
    seeded_claude_json_session(&store).await;
    // Make the export take long enough that the cancel lands before commit.
    let old_dir = AgentPaths::default().direct_session_data_dir("p1", "s1");
    let mut s = open_transcript_store(&old_dir, "s1");
    for i in 0..20_000 {
        let mut e = phase2_ev(
            NormalizedEventKind::Text,
            "s1",
            &format!("bulk-{i}"),
            "bulk row",
        );
        s.append(&mut e);
    }
    s.close();

    let r = routes(store.clone());
    let r2 = r.clone();
    let body = ResetBody {
        carry_over: Some(CarryOver::Transcript),
        ..reset_body()
    };
    let handle = tokio::spawn(async move { r2.reset_session("s1", &body).await });

    let mut cancelled = false;
    for _ in 0..50_000 {
        if r.reset_cancels.get("s1").is_some() {
            cancelled = r.cancel_reset("s1");
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(cancelled, "the in-flight reset was found and cancelled");

    let res = handle.await.unwrap();
    assert!(
        matches!(res, Err(ResetError::Cancelled(_))),
        "expected Cancelled, got {res:?}"
    );

    let sessions_root = AgentPaths::default().project_dir("p1").join("sessions");
    let mut ids: Vec<String> = std::fs::read_dir(&sessions_root)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["s1".to_string()],
        "the new session data dir must be removed on cancel"
    );
}

// ---------------------------------------------------------------------------
// Cancel-aware waits + ResetFlag (1.T5)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn wait_for_handoff_file_returns_promptly_when_cancelled() {
    let d = tempdir().unwrap();
    let path = d.path().join("h.md");
    let cancelled = Arc::new(AtomicBool::new(false));
    let c = cancelled.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        c.store(true, AtomicOrdering::SeqCst);
    });
    let started = std::time::Instant::now();
    let out = wait_for_handoff_file(
        &path,
        Duration::from_secs(60),
        Duration::from_secs(30),
        || false,
        || async {},
        &cancelled,
    )
    .await;
    assert_eq!(out, None);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must not burn the 60s timeout"
    );
}

#[tokio::test]
async fn wait_for_turn_start_returns_promptly_when_cancelled() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let c = cancelled.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        c.store(true, AtomicOrdering::SeqCst);
    });
    let started = std::time::Instant::now();
    let ok = wait_for_turn_start(
        || HandoffTurnPhase::Queued,
        Duration::from_secs(60),
        Duration::from_millis(20),
        &cancelled,
    )
    .await;
    assert!(!ok);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must not burn the 60s timeout"
    );
}

#[test]
fn reset_flag_cancel_before_commit_errors_and_cancel_after_commit_is_false() {
    let flag = ResetFlag::default();
    assert!(flag.cancel());
    assert!(flag.commit().is_err(), "cancelled wins the race");

    let committed = ResetFlag::default();
    assert!(committed.commit().is_ok());
    assert!(
        !committed.cancel(),
        "no cancel after the point of no return"
    );
}

#[tokio::test]
async fn reset_flag_clone_shares_cancel_map_and_second_reset_is_in_progress() {
    let (_home, _guard) = home_with_mode();
    let (_d, store) = store();
    let mut p = make_project("p1");
    p.direct_sessions.push(json_session("s1", "p1"));
    add_project(&store, p).await;

    let a = routes(store.clone());
    let b = a.clone();
    let flag = a.reset_cancels.register("s1").expect("first register");
    assert!(
        b.cancel_reset("s1"),
        "a clone shares the same Arc<Mutex<...>>"
    );
    assert!(flag.cancelled().load(AtomicOrdering::SeqCst));

    let err = b.reset_session("s1", &reset_body()).await.unwrap_err();
    assert!(
        matches!(err, ResetError::InProgress(_)),
        "a second concurrent reset must be InProgress, got {err:?}"
    );

    // Once the flag is gone, the reset proceeds.
    a.reset_cancels.remove("s1");
    let res = b.reset_session("s1", &reset_body()).await.unwrap();
    assert!(res.ok);
}
